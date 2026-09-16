// cloudfunctions/gift/index.js
// 积分礼品兑换云函数

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();
  switch (action) {
    case 'list':          return await listGifts(event);
    case 'exchange':      return await exchangeGift(OPENID, event);
    case 'updateAddress': return await updateExchangeAddress(OPENID, event);
    default: return { code: 400, message: '未知操作' };
  }
};

// ===== 获取礼品列表 =====
async function listGifts(event) {
  const { page = 1, pageSize = 20 } = event;
  try {
    const res = await db.collection('gifts')
      .where({ status: 'active' })
      .orderBy('pointsCost', 'asc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
    const total = await db.collection('gifts').where({ status: 'active' }).count();
    // 统一字段：DB 存 pointsCost，小程序展示用 points，做兼容映射
    const data = res.data.map(g => ({
      ...g,
      points: g.pointsCost || g.points || 0,
    }));
    return { code: 200, data, total: total.total };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 补填兑换收货地址 =====
async function updateExchangeAddress(openid, event) {
  const { logId, address } = event;
  if (!logId || !address) return { code: 400, message: '缺少参数' };
  try {
    // 验证该记录属于当前用户
    const logRes = await db.collection('exchange_logs').doc(logId).get();
    if (!logRes.data || logRes.data.userId !== openid) {
      return { code: 403, message: '无权操作' };
    }
    await db.collection('exchange_logs').doc(logId).update({
      data: { address, updatedAt: new Date() }
    });
    return { code: 200, message: '地址已保存' };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 兑换礼品 =====
async function exchangeGift(openid, event) {
  const { giftId } = event;
  try {
    // 1. 获取礼品信息
    const giftRes = await db.collection('gifts').doc(giftId).get();
    const gift = giftRes.data;
    if (!gift || gift.status !== 'active') {
      return { code: 400, message: '礼品不存在或已下架' };
    }
    if (gift.stock <= 0) {
      return { code: 400, message: '礼品库存不足' };
    }

    // 2. 获取用户积分（pointsCost 是数据库存储字段名）
    const giftCost = gift.pointsCost || gift.points || 0;
    const userRes = await db.collection('users').doc(openid).get();
    const user = userRes.data;
    const currentPoints = user?.memberLevel?.points || 0;

    if (currentPoints < giftCost) {
      return { code: 400, message: `积分不足，还差 ${giftCost - currentPoints} 积分` };
    }

    // 3. 扣除积分 + 扣减库存
    await db.collection('users').doc(openid).update({
      data: { 'memberLevel.points': _.inc(-giftCost) }
    });
    await db.collection('gifts').doc(giftId).update({
      data: { stock: _.inc(-1) }
    });
    const remainingPoints = currentPoints - giftCost;
    db.collection('point_logs').add({
      data: {
        userId: openid,
        type: 'exchange',
        points: -giftCost,
        description: `兑换礼品：${gift.name}`,
        balance: remainingPoints,
        createdAt: new Date(),
      }
    }).catch(e => console.warn('写入point_logs失败:', e.message));

    // 4. 写入兑换记录（address 可在兑换成功后通过 updateAddress 补填）
    const logRes = await db.collection('exchange_logs').add({
      data: {
        userId: openid,
        giftId,
        giftName: gift.name,
        pointsCost: giftCost,
        address: event.address || null,
        status: 'pending',   // 待发货
        createdAt: new Date(),
      }
    });

    return {
      code: 200,
      message: `兑换成功，已扣除 ${giftCost} 积分`,
      data: { logId: logRes.id },
    };
  } catch (err) {
    console.error('exchangeGift error:', err);
    return { code: 500, message: err.message };
  }
}
