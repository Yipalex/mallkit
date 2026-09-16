// 云函数接口频率限制工具
// 使用云数据库实现简单的频率限制（无需 Redis）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function checkRateLimit(userId, action, options = {}) {
  const {
    maxRequests = 10,
    windowSeconds = 60
  } = options;

  try {
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);
    const key = `${userId}_${action}`;

    const collection = db.collection('rate_limits');
    const recordRes = await collection.where({ key }).get();

    if (recordRes.data.length === 0) {
      await collection.add({
        data: {
          key,
          userId,
          action,
          requests: [now],
          windowStart,
          expireAt: new Date(now + (windowSeconds * 1000) + 60000),
          createTime: new Date(),
        }
      });
      return { allowed: true };
    }

    const record = recordRes.data[0];
    const validRequests = record.requests.filter(t => t > windowStart);

    if (validRequests.length >= maxRequests) {
      const oldestRequest = Math.min(...validRequests);
      const retryAfter = Math.ceil((oldestRequest + windowSeconds * 1000 - now) / 1000);
      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }

    validRequests.push(now);
    await collection.doc(record._id).update({
      data: { requests: validRequests, windowStart }
    });

    return { allowed: true };

  } catch (err) {
    console.error('checkRateLimit error:', err);
    return { allowed: true };
  }
}

module.exports = { checkRateLimit };
