// AI 助手 - 会话持久化（CloudBase 集合 assistant_sessions）
// 一条消息一个文档：{ conversationId, role, content, tool?, args?, createTime, expireAt }
// expireAt 为 +30 天（集合上建 TTL 索引后自动清理）。
// ⚠️ 所有 DB 操作失败都降级为「无上下文」，绝不阻断对话。

const { db } = require('../../config/cloud');

const COLLECTION = 'assistant_sessions';
const MAX_HISTORY = 50;
const TTL_MS = 30 * 24 * 3600 * 1000;
// 过期清理：CloudBase 控制台/MCP 都建不了 TTL 索引，改为代码惰性清理——
// 每次写消息时以 1/40 概率顺手删掉 expireAt 已过期的记录（多删一次也无害）。
const PURGE_PROBABILITY = 1 / 40;
const _ = db.command;

async function purgeExpired() {
  try {
    const res = await db.collection(COLLECTION).where({ expireAt: _.lt(new Date()) }).remove();
    const n = res && res.deleted;
    if (n) console.log(`[assistant/session] 清理过期会话记录 ${n} 条`);
  } catch (e) {
    console.error('[assistant/session] 清理过期记录失败:', e.message);
  }
}

// 取最近 MAX_HISTORY 条 user/assistant 消息，按时间升序返回（OpenAI messages 格式）。
async function getHistory(conversationId) {
  if (!conversationId) return [];
  try {
    const res = await db.collection(COLLECTION)
      .where({ conversationId, role: db.command.in(['user', 'assistant']) })
      .orderBy('createTime', 'desc')
      .limit(MAX_HISTORY)
      .get();
    const list = res.data || [];
    return list
      .slice()
      .sort((a, b) => (a.createTime || 0) - (b.createTime || 0))
      .map((m) => ({ role: m.role, content: m.content || '' }));
  } catch (e) {
    console.error('[assistant/session] 读历史失败:', e.message);
    return [];
  }
}

// 追加一条消息。extra 可带 { tool, args }（写操作审计用）。
async function appendMessage(conversationId, role, content, extra = {}) {
  if (!conversationId) return '';
  try {
    const now = Date.now();
    const doc = {
      conversationId,
      role,
      content: content || '',
      createTime: now,
      expireAt: new Date(now + TTL_MS),
    };
    if (extra.tool) doc.tool = extra.tool;
    if (extra.args !== undefined) doc.args = extra.args;
    const res = await db.collection(COLLECTION).add(doc);
    if (Math.random() < PURGE_PROBABILITY) purgeExpired(); // 不 await，不阻塞对话
    return (res && res.id) || '';
  } catch (e) {
    console.error('[assistant/session] 写消息失败:', e.message);
    return '';
  }
}

const saveUserMessage = (cid, content) => appendMessage(cid, 'user', content);
const saveAssistantMessage = (cid, content) => appendMessage(cid, 'assistant', content);

// 写操作审计：记录实际执行的工具名与参数，便于事后追溯。
const saveToolWrite = (cid, tool, args) =>
  appendMessage(cid, 'tool_write', `执行写操作 ${tool}`, { tool, args });

// 进程启动时也清一次（延迟 10 秒，避开冷启动期的 DB 初始化）
setTimeout(purgeExpired, 10 * 1000).unref();

module.exports = {
  purgeExpired,
  COLLECTION,
  MAX_HISTORY,
  getHistory,
  appendMessage,
  saveUserMessage,
  saveAssistantMessage,
  saveToolWrite,
};
