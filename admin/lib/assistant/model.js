// AI 助手 - 模型网关配置 + OpenAI 兼容 SSE 流解析
// 网关默认是 EdgeOne Makers 的 AI Gateway（OpenAI 兼容），Node 20 自带 fetch。

// 读取网关配置。未配置 apiKey/baseUrl 时由调用方给出提示，不在这里抛错。
function getModelConfig(env) {
  const e = env || process.env;
  return {
    apiKey: e.AI_GATEWAY_API_KEY || '',
    baseUrl: e.AI_GATEWAY_BASE_URL || '',
    model: e.AI_GATEWAY_MODEL || '@makers/deepseek-v4-flash',
  };
}

// 安全 JSON.parse，坏帧直接丢弃（网关偶尔发半截帧）。
function parseSseJson(json) {
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// 按 tool_calls[i].index 增量拼接 id / name / arguments。
// OpenAI 流式协议里 arguments 是一个字符一个字符地发过来的。
function collectToolCallDeltas(toolCalls, deltas) {
  if (!deltas) return;
  for (const delta of deltas) {
    const index = (delta && delta.index != null) ? delta.index : 0;
    const toolCall = toolCalls.get(index) || { id: '', name: '', arguments: '' };
    if (delta && delta.id) toolCall.id = delta.id;
    if (delta && delta.function && delta.function.name) toolCall.name = delta.function.name;
    if (delta && delta.function && delta.function.arguments) {
      toolCall.arguments += delta.function.arguments;
    }
    toolCalls.set(index, toolCall);
  }
}

/**
 * SSE 帧解析器（可单测：喂文本块，回调吐增量）。
 * 用法：const p = createStreamParser(); p.push(text); ... ; const r = p.finish();
 * 只取 delta.content，忽略 deepseek 的 reasoning_content（思考过程不给用户看）。
 */
function createStreamParser(onTextDelta) {
  const toolCalls = new Map();
  let buffer = '';
  let content = '';
  let finishReason = '';
  let streamDone = false;

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === 'data: [DONE]') {
      streamDone = true;
      return;
    }
    if (!trimmed.startsWith('data:')) return;   // 注释帧 `: ping` 与 event: 行直接跳过

    const chunk = parseSseJson(trimmed.slice(5).trim());
    const choice = chunk && chunk.choices && chunk.choices[0];
    if (!choice) return;

    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      if (onTextDelta) onTextDelta(delta.content);
    }
    collectToolCallDeltas(toolCalls, delta.tool_calls);
  }

  return {
    // 喂一段文本；返回是否已收到 [DONE]
    push(text) {
      buffer += text;
      // 网关的帧分隔可能是 \n\n 也可能是 \n，统一按 \n 切、最后一段留在 buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (streamDone) break;
        handleLine(line);
      }
      return streamDone;
    },
    // 收尾：处理 buffer 里的残留行，返回本轮结果
    finish() {
      if (buffer.trim() && !streamDone) handleLine(buffer);
      buffer = '';
      // 不变式（同 upstream agent index.ts:234）：只有 finish_reason === 'tool_calls'
      // 且确实拼出了工具调用，才算这一轮要执行工具；否则一律当纯文本回复。
      const calls = (toolCalls.size > 0 && finishReason === 'tool_calls')
        ? [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map((kv) => kv[1])
        : null;
      return { content, toolCalls: calls, finishReason };
    },
  };
}

/**
 * 向网关发一轮流式对话。
 * @param {object} cfg  getModelConfig() 的返回
 * @param {object} payload  OpenAI chat/completions body（含 stream: true）
 * @param {object} opts  { signal, onTextDelta }
 * @returns {Promise<{content:string, toolCalls:Array|null, finishReason:string}>}
 */
async function streamChat(cfg, payload, opts = {}) {
  const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型网关返回 ${res.status}：${String(body).slice(0, 300)}`);
  }

  const parser = createStreamParser(opts.onTextDelta);
  const decoder = new TextDecoder();
  // Node 18+ 的 res.body 是异步可迭代的 Web ReadableStream
  for await (const chunk of res.body) {
    if (opts.signal && opts.signal.aborted) break;
    const done = parser.push(decoder.decode(chunk, { stream: true }));
    if (done) break;
  }
  return parser.finish();
}

module.exports = { getModelConfig, streamChat, createStreamParser };
