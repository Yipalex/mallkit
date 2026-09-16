// AI 助手 - 进程内运行态注册表（对应 upstream agent/agents/chat/stop.ts 的 abortActiveRun）
// ⚠️ 只在单个 Node 进程内有效。云托管多实例时 stop 请求可能落到别的实例，
//    此时属于「尽力而为」——前端还有本地 AbortController 兜底。

const runs = new Map();   // conversationId -> AbortController

function register(conversationId, controller) {
  if (!conversationId) return;
  runs.set(conversationId, controller);
}

function unregister(conversationId, controller) {
  if (!conversationId) return;
  // 只在还是自己那把 controller 时才删，避免误删同 cid 的新一轮
  if (!controller || runs.get(conversationId) === controller) {
    runs.delete(conversationId);
  }
}

// 中断指定会话，返回是否真的中断了。
function abortActiveRun(conversationId) {
  const controller = runs.get(conversationId);
  if (!controller) return false;
  try {
    controller.abort();
  } catch (e) {
    console.error('[assistant/runs] abort 失败:', e.message);
  }
  runs.delete(conversationId);
  return true;
}

module.exports = { register, unregister, abortActiveRun };
