// 云函数缓存工具
// 使用云数据库实现简单的缓存机制

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 获取缓存数据
 * @param {string} key - 缓存键
 * @returns {Promise<{found: boolean, data?: any, ttl?: number}>}
 */
async function get(key) {
  try {
    const res = await db.collection('cache').where({ key }).limit(1).get();

    if (res.data.length === 0) {
      return { found: false };
    }

    const cacheItem = res.data[0];
    const now = Date.now();

    // 检查是否过期
    if (cacheItem.expireAt && now > new Date(cacheItem.expireAt).getTime()) {
      // 过期了，删除缓存
      await db.collection('cache').doc(cacheItem._id).remove();
      return { found: false };
    }

    // 计算剩余TTL（秒）
    const ttl = cacheItem.expireAt
      ? Math.ceil((new Date(cacheItem.expireAt).getTime() - now) / 1000)
      : -1;

    return {
      found: true,
      data: cacheItem.data,
      ttl
    };

  } catch (err) {
    console.error('cache.get error:', err);
    return { found: false };
  }
}

/**
 * 设置缓存数据
 * @param {string} key - 缓存键
 * @param {any} data - 缓存数据
 * @param {number} ttlSeconds - 过期时间（秒），0表示永不过期
 * @returns {Promise<boolean>}
 */
async function set(key, data, ttlSeconds = 300) {
  try {
    const expireAt = ttlSeconds > 0
      ? new Date(Date.now() + ttlSeconds * 1000)
      : null;

    // 查找是否已存在
    const existing = await db.collection('cache').where({ key }).limit(1).get();

    if (existing.data.length > 0) {
      // 更新现有缓存
      await db.collection('cache').doc(existing.data[0]._id).update({
        data: {
          data,
          expireAt,
          updateTime: new Date()
        }
      });
    } else {
      // 创建新缓存
      await db.collection('cache').add({
        data: {
          key,
          data,
          expireAt,
          createTime: new Date(),
          updateTime: new Date()
        }
      });
    }

    return true;

  } catch (err) {
    console.error('cache.set error:', err);
    return false;
  }
}

/**
 * 删除缓存
 * @param {string} key - 缓存键
 * @returns {Promise<boolean>}
 */
async function remove(key) {
  try {
    const existing = await db.collection('cache').where({ key }).limit(1).get();

    if (existing.data.length > 0) {
      await db.collection('cache').doc(existing.data[0]._id).remove();
    }

    return true;

  } catch (err) {
    console.error('cache.remove error:', err);
    return false;
  }
}

/**
 * 包装函数，自动缓存结果
 * @param {string} key - 缓存键前缀
 * @param {Function} fn - 要执行的函数
 * @param {number} ttlSeconds - 缓存时间（秒）
 * @param {Function} keyGenerator - 自定义键生成函数
 */
async function withCache(key, fn, ttlSeconds = 300, keyGenerator = null) {
  // 生成完整缓存键
  const fullKey = keyGenerator ? keyGenerator(key) : key;

  // 尝试从缓存获取
  const cached = await get(fullKey);
  if (cached.found) {
    console.log('缓存命中:', fullKey, '剩余TTL:', cached.ttl, '秒');
    return { data: cached.data, fromCache: true };
  }

  // 缓存未命中，执行函数
  console.log('缓存未命中，执行函数:', fullKey);
  const result = await fn();

  // 存入缓存
  await set(fullKey, result, ttlSeconds);

  return { data: result, fromCache: false };
}

module.exports = {
  get,
  set,
  remove,
  withCache
};
