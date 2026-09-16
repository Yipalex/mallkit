// AI 运营助手：SSE 对话 + 停止 + 历史 + 独立移动页
// SSE 事件：text_delta / tool_called / tool_debug / error / done / session
const express = require('express');
const path = require('path');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const { getModelConfig, streamChat } = require('../lib/assistant/model');
const { buildTools, stringifyResult } = require('../lib/assistant/tools');
const session = require('../lib/assistant/session');
const { buildSystemPrompt } = require('../lib/assistant/prompt');
const runs = require('../lib/assistant/runs');

// 工具轮数上限：每一轮 = 一次模型请求 + 一次工具执行。默认 3 轮，够覆盖「查用户→设分销员」。
const MAX_TOOL_ROUNDS = Number(process.env.ASSISTANT_MAX_TOOL_ROUNDS) || 3;
// 软超时：云托管网关约 60 秒硬切，提前 55 秒自己收尾，保证前端能收到 done。
const HARD_TIMEOUT_MS = Number(process.env.ASSISTANT_TIMEOUT_MS) || 55000;
const HEARTBEAT_MS = 15000;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// 结果预览截断（tool_debug 用，避免把整个 CSV 塞进 SSE）。
function safePreview(value, maxLength = 1200) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
}

function newConversationId() {
  return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

// 把 toolCalls 拼成下一轮要回传给模型的 assistant 消息。
function assistantToolMessage(content, toolCalls) {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    })),
  };
}

// ===== 页面：手机端独立助手页（未登录由 requireLogin 自动 302 /login）=====
router.get('/assistant', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/assistant.html'));
});

// ===== API：流式对话（SSE）=====
router.post('/api/assistant/chat', requireLogin, async (req, res) => {
  const rawMessage = req.body && req.body.message;
  let conversationId = (req.body && req.body.conversationId) || '';

  res.writeHead(200, SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      closed = true;
    }
  };

  // 会话 id 由服务端兜底生成，并在首帧告诉前端（前端会存进 localStorage）。
  if (!conversationId) {
    conversationId = newConversationId();
    send('session', { conversationId });
  }

  if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
    send('error', { message: '消息不能为空' });
    send('done', { stopped: false });
    return res.end();
  }
  const message = rawMessage.slice(0, 10000);

  const modelConfig = getModelConfig(process.env);
  if (!modelConfig.apiKey || !modelConfig.baseUrl) {
    send('error', { message: 'AI 助手未配置，请在云托管环境变量设置 AI_GATEWAY_BASE_URL / AI_GATEWAY_API_KEY' });
    send('done', { stopped: false });
    return res.end();
  }

  // 心跳：注释帧，防止中间网关因为长时间无数据把连接掐掉。
  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch (e) { closed = true; }
  }, HEARTBEAT_MS);

  const controller = new AbortController();
  const signal = controller.signal;
  runs.register(conversationId, controller);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HARD_TIMEOUT_MS);

  // ⚠️ 必须监听 res 而不是 req：Node 16+ 里 req 的 close 在请求体被 express.json 读完后就会触发，
  // 挂在 req 上会在首帧前就 abort，导致 SSE 秒断、0 字节（2026-09-08 上线首测踩坑）。
  res.on('close', () => {
    closed = true;
    controller.abort();
  });

  let assistantContent = '';
  let stopped = false;

  try {
    // 读历史 + 落库本轮用户消息（DB 失败已在 session 里降级，不阻断）
    // ⚠️ 必须先读后存：并行时历史里可能已含本轮用户消息，会给模型重复两遍
    const history = await session.getHistory(conversationId);
    await session.saveUserMessage(conversationId, message);

    const toolRegistry = buildTools({ req, conversationId });
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...history,
      { role: 'user', content: message },
    ];

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) { stopped = true; break; }

      const payload = {
        model: modelConfig.model,
        messages,
        stream: true,
      };
      if (toolRegistry.hasTools()) {
        payload.tools = toolRegistry.tools;
        payload.tool_choice = 'auto';
      }

      const result = await streamChat(modelConfig, payload, {
        signal,
        onTextDelta(delta) {
          assistantContent += delta;
          send('text_delta', { delta });
        },
      });

      if (signal.aborted) { stopped = true; break; }
      if (!result.toolCalls || !result.toolCalls.length) break;

      messages.push(assistantToolMessage(result.content, result.toolCalls));

      for (const tc of result.toolCalls) {
        send('tool_called', { tool: tc.name });
        send('tool_debug', {
          phase: 'call',
          tool: tc.name,
          id: tc.id,
          argumentsPreview: safePreview(tc.arguments),
        });

        const startedAt = Date.now();
        const raw = await toolRegistry.executeRaw(tc.name, tc.arguments);
        const text = stringifyResult(raw);
        const durationMs = Date.now() - startedAt;
        const resultPreview = safePreview(text, 2000);
        const isError = text.includes('"error"');

        send('tool_debug', Object.assign({
          phase: 'result',
          tool: tc.name,
          id: tc.id,
          resultPreview,
          durationMs,
        }, isError ? { error: resultPreview } : {}));

        messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
      }
    }
  } catch (e) {
    if (timedOut) {
      send('error', { message: '本轮回复超时，请把问题拆细一点再试' });
      stopped = true;
    } else if (e.name === 'AbortError' || signal.aborted) {
      stopped = true;
    } else {
      console.error('[assistant] 对话失败:', e);
      send('error', { message: String(e.message || e) });
    }
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    runs.unregister(conversationId, controller);

    if (assistantContent) {
      await session.saveAssistantMessage(conversationId, assistantContent);
    }
    send('done', { stopped });
    try { res.end(); } catch (e) { /* 客户端已断开 */ }
  }
});

// ===== API：停止当前会话的生成 =====
// 多实例部署时可能落到别的实例（返回 aborted:false），前端还有本地 abort 兜底。
router.post('/api/assistant/stop', requireLogin, (req, res) => {
  const conversationId = (req.body && req.body.conversationId) || '';
  if (!conversationId) return res.status(400).json({ error: '缺少 conversationId' });
  res.json({ aborted: runs.abortActiveRun(conversationId) });
});

// ===== API：拉取会话历史（前端刷新后回填）=====
router.get('/api/assistant/history', requireLogin, async (req, res) => {
  const conversationId = req.query.conversationId || '';
  if (!conversationId) return res.json({ messages: [] });
  const messages = await session.getHistory(conversationId);
  res.json({ messages });
});

module.exports = router;
