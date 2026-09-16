// 云函数接口频率限制工具
// 使用云数据库实现简单的频率限制（无需 Redis）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 检查用户请求频率是否超限
 * @param {string} userId - 用户ID（openid）
 * @param {string} action - 操作类型（如 'order', 'checkin'）
 * @param {object} options - 配置选项
 * @param {number} options.maxRequests - 时间窗口内最大请求数（默认 10）
 * @param {number} options.windowSeconds - 时间窗口（秒，默认 60）
 * @returns {Promise<{allowed: boolean, retryAfter?: number}>}
 */
async function checkRateLimit(userId, action, options = {}) {
  const {
    maxRequests = 10,
    windowSeconds = 60
  } = options;

  try {
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);
    const key = `${userId}_${action}`;

    // 查询该用户在该时间窗口内的请求记录
    const collection = db.collection('rate_limits');
    const recordRes = await collection.where({ key }).get();

    if (recordRes.data.length === 0) {
      // 首次请求，创建记录
      await collection.add({
        data: {
          key,
          userId,
          action,
          requests: [now],
          windowStart,
          expireAt: new Date(now + (windowSeconds * 1000) + 60000), // 窗口结束后1分钟过期
          createTime: new Date(),
        }
      });
      return { allowed: true };
    }

    const record = recordRes.data[0];

    // 清理过期记录
    const validRequests = record.requests.filter(t => t > windowStart);

    if (validRequests.length >= maxRequests) {
      // 超出限制，计算需要等待的时间
      const oldestRequest = Math.min(...validRequests);
      const retryAfter = Math.ceil((oldestRequest + windowSeconds * 1000 - now) / 1000);
      return {
        allowed: false,
        retryAfter: Math.max(1, retryAfter)
      };
    }

    // 未超限，更新记录
    validRequests.push(now);
    await collection.doc(record._id).update({
      data: {
        requests: validRequests,
        windowStart,
      }
    });

    return { allowed: true };

  } catch (err) {
    console.error('checkRateLimit error:', err);
    // 频率限制检查失败时，默认放行（避免影响正常用户）
    return { allowed: true };
  }
}

/**
 * 包装云函数，自动应用频率限制
 * @param {string} action - 操作类型
 * @param {Function} handler - 云函数主逻辑
 * @param {object} options - 频率限制配置
 */
function withRateLimit(action, handler, options = {}) {
  return async (event, context) => {
    const { OPENID } = cloud.getWXContext();

    // 检查频率限制
    const limitResult = await checkRateLimit(OPENID, action, options);

    if (!limitResult.allowed) {
      return {
        code: 429,
        message: `请求过于频繁，请${limitResult.retryAfter}秒后再试`
      };
    }

    // 执行主逻辑
    return await handler(event, context);
  };
}

module.exports = {
  checkRateLimit,
  withRateLimit
};
