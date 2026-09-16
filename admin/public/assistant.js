/*!
 * mallkit-admin 运营助手前端 (assistant.js)
 * 用法：ShopAssistant.mount(rootEl, { mode: 'panel' | 'page' })
 *
 * SSE 协议（与 routes/assistant.js 约定）：
 *   POST /api/assistant/chat  { message, conversationId? }  -> text/event-stream
 *     event: session      data: { conversationId }
 *     event: text_delta   data: { delta }
 *     event: tool_called  data: { tool }
 *     event: tool_debug   data: { phase:'call'|'result', tool, id, durationMs?, error? }
 *     event: error        data: { message }
 *     event: done         data: { stopped }
 *   POST /api/assistant/stop  { conversationId } -> { aborted }
 *   GET  /api/assistant/history?conversationId=xxx -> { messages:[{role,content}] }
 */
(function (global) {
  'use strict';

  // ===== 常量 =====
  var API_CHAT = '/api/assistant/chat';
  var API_STOP = '/api/assistant/stop';
  var API_HISTORY = '/api/assistant/history';
  var LS_CID = 'shop_assistant_cid';
  var LS_OPEN = 'shop_assistant_open';

  // 13 个工具的中文名（与 upstream agent agents/_tools.ts 对齐）
  var TOOL_LABELS = {
    overview: '查看今日概览',
    list_pending_orders: '查询待发货订单',
    get_order: '查订单详情',
    today_revenue: '查看今日营收',
    user_count: '统计用户数据',
    ship_order: '订单发货',
    list_reviews: '查看商品评价',
    monthly_finance: '查询月度财务',
    export_finance_csv: '导出财务报表',
    rankings: '查看营销榜单',
    find_user: '搜索用户',
    set_distributor: '设置分销员',
    list_distributors: '查看分销员列表'
  };

  var SUGGESTIONS = ['今天有什么要处理的', '待发货订单', '本月营收'];

  // ===== localStorage 安全读写 =====
  function lsGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { global.localStorage.setItem(key, val); } catch (e) { /* 隐私模式 / 被禁用 */ }
  }
  function lsRemove(key) {
    try { global.localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  // ===== 轻量 Markdown 渲染（无第三方库，先转义再套标记，无 XSS 面）=====
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inlineLite(escaped) {
    // 行内代码优先（避免 ** 落进 code 里被再解析）
    var out = escaped.replace(/`([^`\n]+)`/g, '<code class="fa-code">$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    return out;
  }

  /**
   * renderLite(text) -> 安全 HTML
   * 支持：**粗体**、`行内代码`、`- ` 无序列表、`1. ` 有序列表、换行 -> <br>
   */
  function renderLite(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var html = '';
    var listType = null; // 'ul' | 'ol' | null

    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var esc = escapeHtml(raw);
      var ul = /^\s*[-*]\s+(.*)$/.exec(raw);
      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);

      if (ul) {
        if (listType !== 'ul') { closeList(); html += '<ul class="fa-list">'; listType = 'ul'; }
        html += '<li>' + inlineLite(escapeHtml(ul[1])) + '</li>';
      } else if (ol) {
        if (listType !== 'ol') { closeList(); html += '<ol class="fa-list">'; listType = 'ol'; }
        html += '<li>' + inlineLite(escapeHtml(ol[1])) + '</li>';
      } else if (!raw.trim()) {
        closeList();
        html += '<br>';
      } else {
        closeList();
        html += inlineLite(esc) + '<br>';
      }
    }
    closeList();
    return html.replace(/(<br>)+$/, '');
  }

  // ===== SSE 帧解析（翻译自 upstream agent src/api.ts dispatchSseChunk）=====
  /**
   * 解析单个 SSE 帧文本，返回 { eventType, data } 或 null。
   * 以 ':' 开头的心跳注释行忽略。
   */
  function parseSseChunk(part) {
    var eventType = '';
    var data = '';
    var lines = part.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') continue; // 心跳/注释
      if (line.indexOf('event:') === 0) {
        eventType = line.slice(6).trim();
      } else if (line.indexOf('data:') === 0) {
        var d = line.slice(5);
        if (d.charAt(0) === ' ') d = d.slice(1);
        data += (data ? '\n' : '') + d;
      }
    }
    if (!eventType || !data) return null;
    var parsed;
    try { parsed = JSON.parse(data); } catch (e) { return null; }
    return { eventType: eventType, data: parsed };
  }

  /** 把 SSE 帧分发到回调 */
  function dispatchSseChunk(part, cb, markDone) {
    var evt = parseSseChunk(part);
    if (!evt) return;
    var p = evt.data || {};
    switch (evt.eventType) {
      case 'session':
        if (p.conversationId && cb.onSession) cb.onSession(p.conversationId);
        break;
      case 'text_delta':
        if (typeof p.delta === 'string' && cb.onTextDelta) cb.onTextDelta(p.delta);
        break;
      case 'tool_called':
        if (cb.onToolCalled) cb.onToolCalled(p.tool);
        break;
      case 'tool_debug':
        if (cb.onToolDebug) cb.onToolDebug(p);
        break;
      case 'error':
        if (cb.onError) cb.onError(new Error(p.message || '助手返回错误'));
        break;
      case 'done':
        if (markDone) markDone();
        if (cb.onDone) cb.onDone(!!p.stopped);
        break;
      default:
        break;
    }
  }

  /**
   * 流式发送一条消息，返回 AbortController。
   * 翻译自 upstream agent src/api.ts sendMessageStream（路径改为 /api/assistant/*，鉴权走同源 cookie）。
   */
  function sendMessageStream(message, conversationId, cb) {
    var ctrl = new AbortController();

    (function () {
      var doneReceived = false;
      fetch(API_CHAT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message: message, conversationId: conversationId || undefined }),
        signal: ctrl.signal
      }).then(function (res) {
        if (res.status === 401) {
          if (cb.onUnauthorized) cb.onUnauthorized();
          return null;
        }
        if (!res.ok) {
          return res.text().catch(function () { return ''; }).then(function (t) {
            if (cb.onError) cb.onError(new Error('HTTP ' + res.status + (t ? '：' + t.slice(0, 200) : '')));
            return null;
          });
        }
        if (!res.body || !res.body.getReader) {
          if (cb.onError) cb.onError(new Error('当前浏览器不支持流式响应'));
          return null;
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buffer += decoder.decode(r.value, { stream: true });
            var parts = buffer.split('\n\n');
            buffer = parts.pop() || '';
            for (var i = 0; i < parts.length; i++) {
              if (!parts[i].trim()) continue;
              dispatchSseChunk(parts[i], cb, function () { doneReceived = true; });
            }
            return pump();
          });
        }
        return pump();
      }).then(function () {
        if (!doneReceived && !ctrl.signal.aborted && cb.onDone) cb.onDone(false);
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (cb.onError) cb.onError(err instanceof Error ? err : new Error(String(err)));
        if (cb.onDone) cb.onDone(false);
      });
    })();

    return ctrl;
  }

  /** 请求服务端中止当前会话的运行（尽力而为，前端还有本地 abort 兜底） */
  function stopAgent(conversationId) {
    return fetch(API_STOP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ conversationId: conversationId })
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  /** 拉取历史消息，用于刷新后回填 */
  function fetchHistory(conversationId) {
    return fetch(API_HISTORY + '?conversationId=' + encodeURIComponent(conversationId), {
      credentials: 'same-origin'
    }).then(function (r) {
      if (!r.ok) return [];
      return r.json().catch(function () { return null; });
    }).then(function (d) {
      return d && Array.isArray(d.messages) ? d.messages : [];
    }).catch(function () { return []; });
  }

  // ===== DOM 小工具 =====
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ===== 挂载 =====
  function mount(rootEl, options) {
    if (!rootEl) throw new Error('ShopAssistant.mount: rootEl 不能为空');
    var opts = options || {};
    var mode = opts.mode === 'page' ? 'page' : 'panel';

    var state = {
      conversationId: lsGet(LS_CID) || '',
      messages: [],          // { role:'user'|'assistant'|'tool'|'error', ... }
      streaming: false,
      ctrl: null,
      current: null          // 当前流式 assistant 消息对象
    };

    // --- 结构 ---
    rootEl.classList.add('fa-root');
    rootEl.setAttribute('data-mode', mode);
    rootEl.innerHTML = '';

    var listEl = el('div', 'fa-list-wrap');
    var inputWrap = el('div', 'fa-input-wrap');
    var textarea = document.createElement('textarea');
    textarea.className = 'fa-textarea';
    textarea.rows = 1;
    textarea.placeholder = '问点什么…（Enter 发送，Shift+Enter 换行）';
    var sendBtn = el('button', 'fa-send-btn');
    sendBtn.type = 'button';
    sendBtn.innerHTML = '<span class="material-symbols-outlined">send</span>';
    sendBtn.title = '发送';

    inputWrap.appendChild(textarea);
    inputWrap.appendChild(sendBtn);
    rootEl.appendChild(listEl);
    rootEl.appendChild(inputWrap);

    function scrollToBottom() {
      try { listEl.scrollTop = listEl.scrollHeight; } catch (e) { /* noop */ }
    }

    // --- 渲染 ---
    function renderWelcome() {
      var w = el('div', 'fa-welcome');
      w.appendChild(el('div', 'fa-welcome-title', '运营助手'));
      w.appendChild(el('div', 'fa-welcome-sub', '用一句话问后台数据，或让我帮你处理订单。'));
      var chips = el('div', 'fa-chips');
      SUGGESTIONS.forEach(function (s) {
        var b = el('button', 'fa-chip', s);
        b.type = 'button';
        b.addEventListener('click', function () {
          if (state.streaming) return;
          send(s);
        });
        chips.appendChild(b);
      });
      w.appendChild(chips);
      listEl.appendChild(w);
    }

    function render() {
      listEl.innerHTML = '';
      if (!state.messages.length) {
        renderWelcome();
        return;
      }
      state.messages.forEach(function (m) {
        listEl.appendChild(renderMessage(m));
      });
      scrollToBottom();
    }

    function renderMessage(m) {
      if (m.role === 'user') {
        var row = el('div', 'fa-row fa-row-user');
        var b = el('div', 'fa-bubble fa-bubble-user');
        b.textContent = m.content;
        row.appendChild(b);
        return row;
      }
      if (m.role === 'tool') {
        var t = el('div', 'fa-row fa-row-tool');
        var chip = el('div', 'fa-tool' + (m.error ? ' fa-tool-error' : (m.done ? ' fa-tool-done' : '')));
        var icon = el('span', 'fa-tool-icon', m.error ? '✕' : (m.done ? '✓' : '•'));
        chip.appendChild(icon);
        chip.appendChild(el('span', 'fa-tool-name', TOOL_LABELS[m.tool] || m.tool || '调用工具'));
        if (m.done && typeof m.durationMs === 'number') {
          chip.appendChild(el('span', 'fa-tool-ms', formatMs(m.durationMs)));
        }
        if (m.error) {
          chip.appendChild(el('span', 'fa-tool-ms', String(m.error).slice(0, 60)));
        }
        t.appendChild(chip);
        return t;
      }
      if (m.role === 'error') {
        var e = el('div', 'fa-row fa-row-error');
        var eb = el('div', 'fa-bubble fa-bubble-error');
        eb.textContent = m.content;
        e.appendChild(eb);
        return e;
      }
      // assistant
      var ar = el('div', 'fa-row fa-row-assistant');
      var ab = el('div', 'fa-bubble fa-bubble-assistant');
      ab.innerHTML = renderLite(m.content || '');
      if (m.streaming) {
        var caret = el('span', 'assistant-caret');
        ab.appendChild(caret);
      }
      ar.appendChild(ab);
      return ar;
    }

    function formatMs(ms) {
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(1) + 's';
    }

    // 只更新最后一条（流式高频调用时避免整表重绘）
    function repaintLast() {
      var last = listEl.lastElementChild;
      var m = state.messages[state.messages.length - 1];
      if (!m) return;
      var fresh = renderMessage(m);
      if (last) listEl.replaceChild(fresh, last);
      else listEl.appendChild(fresh);
      scrollToBottom();
    }

    function pushMessage(m) {
      var wasEmpty = state.messages.length === 0;
      state.messages.push(m);
      if (wasEmpty) listEl.innerHTML = '';
      listEl.appendChild(renderMessage(m));
      scrollToBottom();
    }

    // --- 按钮状态 ---
    function setStreaming(on) {
      state.streaming = on;
      if (on) {
        sendBtn.classList.add('fa-stop');
        sendBtn.innerHTML = '<span class="material-symbols-outlined">stop</span>';
        sendBtn.title = '停止';
      } else {
        sendBtn.classList.remove('fa-stop');
        sendBtn.innerHTML = '<span class="material-symbols-outlined">send</span>';
        sendBtn.title = '发送';
      }
    }

    function handleUnauthorized() {
      pushMessage({ role: 'error', content: '登录已过期，正在跳转登录页…' });
      setStreaming(false);
      setTimeout(function () {
        try { global.location.href = '/login'; } catch (e) { /* noop */ }
      }, 1200);
    }

    // --- 发送 ---
    function send(text) {
      var msg = String(text == null ? '' : text).trim();
      if (!msg || state.streaming) return;

      pushMessage({ role: 'user', content: msg });
      textarea.value = '';
      autoGrow();

      var assistantMsg = { role: 'assistant', content: '', streaming: true };
      state.current = assistantMsg;
      pushMessage(assistantMsg);
      setStreaming(true);

      state.ctrl = sendMessageStream(msg, state.conversationId, {
        onSession: function (cid) {
          state.conversationId = cid;
          lsSet(LS_CID, cid);
        },
        onTextDelta: function (delta) {
          // 若中间插过工具行，需要新开一条 assistant 消息承接后续文字
          if (state.messages[state.messages.length - 1] !== state.current) {
            state.current = { role: 'assistant', content: '', streaming: true };
            pushMessage(state.current);
          }
          state.current.content += delta;
          repaintLast();
        },
        onToolCalled: function (tool) {
          if (state.current) state.current.streaming = false;
          // 当前 assistant 气泡如果还是空的，直接替换掉，避免留空气泡
          var lastIdx = state.messages.length - 1;
          if (state.messages[lastIdx] === state.current && !state.current.content) {
            state.messages.pop();
            if (listEl.lastElementChild) listEl.removeChild(listEl.lastElementChild);
          } else {
            repaintLast();
          }
          state.current = null;
          pushMessage({ role: 'tool', tool: tool, done: false });
        },
        onToolDebug: function (p) {
          if (!p) return;
          if (p.phase === 'call') {
            // tool_called 不带 id，这里补上，便于同名工具多次调用时精确匹配
            for (var j = state.messages.length - 1; j >= 0; j--) {
              var tm = state.messages[j];
              if (tm.role === 'tool' && !tm.done && !tm.id && tm.tool === p.tool) { tm.id = p.id; break; }
            }
            return;
          }
          if (p.phase !== 'result') return;
          // 从后往前找同名（或同 id）未完成的工具行
          for (var i = state.messages.length - 1; i >= 0; i--) {
            var m = state.messages[i];
            if (m.role !== 'tool' || m.done) continue;
            if (p.id && m.id && p.id !== m.id) continue;
            if (p.tool && m.tool && p.tool !== m.tool) continue;
            m.done = true;
            m.durationMs = typeof p.durationMs === 'number' ? p.durationMs : undefined;
            m.error = p.error || null;
            if (i === state.messages.length - 1) repaintLast();
            else render();
            return;
          }
        },
        onError: function (err) {
          if (state.current) {
            state.current.streaming = false;
            if (!state.current.content) {
              state.messages.pop();
              if (listEl.lastElementChild) listEl.removeChild(listEl.lastElementChild);
            } else {
              repaintLast();
            }
            state.current = null;
          }
          pushMessage({ role: 'error', content: (err && err.message) || '请求失败' });
        },
        onUnauthorized: handleUnauthorized,
        onDone: function () {
          if (state.current) {
            state.current.streaming = false;
            repaintLast();
            state.current = null;
          }
          state.ctrl = null;
          setStreaming(false);
        }
      });
    }

    function stop() {
      if (state.ctrl) {
        try { state.ctrl.abort(); } catch (e) { /* noop */ }
        state.ctrl = null;
      }
      if (state.conversationId) stopAgent(state.conversationId);
      if (state.current) {
        state.current.streaming = false;
        repaintLast();
        state.current = null;
      }
      setStreaming(false);
    }

    // --- 输入交互 ---
    function autoGrow() {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    textarea.addEventListener('input', autoGrow);
    textarea.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        if (state.streaming) return;
        send(textarea.value);
      }
    });
    sendBtn.addEventListener('click', function () {
      if (state.streaming) stop();
      else send(textarea.value);
    });

    // --- 新建会话 ---
    function newConversation() {
      if (state.streaming) stop();
      state.conversationId = '';
      state.messages = [];
      state.current = null;
      lsRemove(LS_CID);
      render();
    }

    // --- 初始：按 cid 拉历史回填 ---
    render();
    if (state.conversationId) {
      fetchHistory(state.conversationId).then(function (msgs) {
        if (!msgs.length || state.messages.length) return;
        state.messages = msgs.filter(function (m) {
          return m && (m.role === 'user' || m.role === 'assistant') && m.content;
        }).map(function (m) {
          return { role: m.role, content: String(m.content) };
        });
        render();
      });
    }

    return {
      send: send,
      stop: stop,
      newConversation: newConversation,
      focus: function () { try { textarea.focus(); } catch (e) { /* noop */ } },
      get conversationId() { return state.conversationId; }
    };
  }

  global.ShopAssistant = {
    mount: mount,
    renderLite: renderLite,
    escapeHtml: escapeHtml,
    parseSseChunk: parseSseChunk,
    dispatchSseChunk: dispatchSseChunk,
    TOOL_LABELS: TOOL_LABELS,
    LS_CID: LS_CID,
    LS_OPEN: LS_OPEN,
    lsGet: lsGet,
    lsSet: lsSet
  };

  // 供 Node 单测使用（浏览器里 module 未定义，走 catch）
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = global.ShopAssistant;
    }
  } catch (e) { /* noop */ }
})(typeof window !== 'undefined' ? window : globalThis);
