// 优惠券 + 评价 + 礼品库
const express = require('express');
const router = express.Router();

const { db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { toMs } = require('../lib/utils');

// ===== API：优惠券管理 =====
router.get('/api/coupons', requireLogin, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    let query = {};
    if (status && status !== 'all') query.status = status;
    const countRes = await db.collection('coupons').where(query).count();
    const listRes = await db.collection('coupons').where(query)
      .orderBy('_id', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    const coupons = listRes.data;
    res.json({ success: true, data: coupons, total: countRes.total, page: pageNum });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/coupons', requireLogin, async (req, res) => {
  try {
    const { name, type, value, minAmount, totalQuantity, validDays, validFrom, validTo, description } = req.body;
    if (!name || !type || !value || !totalQuantity) return res.json({ success: false, error: '参数缺失' });
    const now = new Date();
    const doc = {
      name, type, value: parseFloat(value),
      minAmount: parseFloat(minAmount) || 0,
      totalQuantity: parseInt(totalQuantity),
      receivedQuantity: 0,
      usedQuantity: 0,
      validDays: parseInt(validDays) || 30,
      validFrom: validFrom ? new Date(validFrom) : now,
      validTo: validTo ? new Date(validTo) : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      description: description || '',
      status: 'active',
      priority: 0,
      createdAt: now,
      updatedAt: now
    };
    const r = await db.collection('coupons').add(doc);
    res.json({ success: true, id: r.id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/coupons/:id', requireLogin, async (req, res) => {
  try {
    const { name, value, minAmount, totalQuantity, validDays, validFrom, validTo, description, priority } = req.body;

    // 先读出原文档，判断用的是哪套字段名
    const oldRes = await db.collection('coupons').doc(req.params.id).get();
    const old = Array.isArray(oldRes.data) ? oldRes.data[0] : oldRes.data;

    const update = { updatedAt: new Date() };

    if (name !== undefined) {
      update.name = name;
      update.title = name; // 兼容 title 字段
    }
    if (value !== undefined) {
      const num = parseFloat(value);
      update.value = num;
      update.discount = num;       // 兼容早期 discount 字段
      update.discountValue = num;  // 兼容分销券 discountValue 字段
      // 如果原文档用 discountPercent（折扣券），也同步更新
      if (old && old.discountPercent !== undefined) update.discountPercent = num;
    }
    if (minAmount !== undefined) update.minAmount = parseFloat(minAmount);
    if (totalQuantity !== undefined) {
      update.totalQuantity = parseInt(totalQuantity);
      update.stock = parseInt(totalQuantity); // 兼容 stock 字段
    }
    if (validDays !== undefined) update.validDays = parseInt(validDays);
    if (validFrom !== undefined) update.validFrom = new Date(validFrom);
    if (validTo !== undefined) update.validTo = new Date(validTo);
    if (description !== undefined) update.description = description;
    if (priority !== undefined) update.priority = parseInt(priority);

    await db.collection('coupons').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/coupons/:id/toggle', requireLogin, async (req, res) => {
  try {
    const r = await db.collection('coupons').doc(req.params.id).get();
    const docData = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!docData) return res.json({ success: false, error: '不存在' });
    const current = docData.status || (docData.isActive ? 'active' : 'inactive');
    const newStatus = current === 'active' ? 'inactive' : 'active';
    await db.collection('coupons').doc(req.params.id).update({
      status: newStatus,
      isActive: newStatus === 'active',
      updatedAt: new Date(),
    });
    res.json({ success: true, status: newStatus });
  } catch (e) {
    console.error('toggle coupon error:', e);
    res.json({ success: false, error: e.message });
  }
});

router.delete('/api/coupons/:id', requireLogin, async (req, res) => {
  try {
    const r = await db.collection('coupons').doc(req.params.id).get();
    if (!r.data) return res.json({ success: false, error: '不存在' });
    if (r.data.receivedQuantity > 0) return res.json({ success: false, error: '已有用户领取，不可删除，请停用' });
    await db.collection('coupons').doc(req.params.id).remove();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.get('/api/coupons/:id/records', requireLogin, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    const countRes = await db.collection('user_coupons').where({ couponId: req.params.id }).count();
    const listRes = await db.collection('user_coupons').where({ couponId: req.params.id })
      .orderBy('receivedAt', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    res.json({ success: true, data: listRes.data, total: countRes.total });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== API：定向发放优惠券给指定用户 =====
// 给一个或多个用户直接发券（写入 user_coupons），不占用公开库存、不与领券中心互斥。
// 字段写法与小程序 product/receiveCoupon 完全对齐，保证小程序端零改动即可识别/展示/核销。
router.post('/api/coupons/:id/grant', requireLogin, async (req, res) => {
  try {
    let { userIds } = req.body;
    // 兼容单个字符串传参
    if (typeof userIds === 'string') userIds = [userIds];
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.json({ success: false, error: '请至少选择一个用户' });
    }
    // 去重 + 过滤空值
    userIds = [...new Set(userIds.filter(id => typeof id === 'string' && id.trim()))];
    if (userIds.length === 0) return res.json({ success: false, error: '用户ID无效' });

    // 1. 读出优惠券模板，校验存在且为 active（停用券不允许发）
    const couponRes = await db.collection('coupons').doc(req.params.id).get();
    const coupon = Array.isArray(couponRes.data) ? couponRes.data[0] : couponRes.data;
    if (!coupon) return res.json({ success: false, error: '优惠券不存在' });
    const isActive = coupon.status ? coupon.status === 'active' : coupon.isActive !== false;
    if (!isActive) return res.json({ success: false, error: '优惠券已停用，无法发放' });

    const couponId = coupon._id || req.params.id;
    const now = new Date();
    const validDays = parseInt(coupon.validDays) || 30;
    const expireAt = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);

    let granted = 0, skipped = 0;
    for (const userId of userIds) {
      // 重复发放保护：该用户已有同券未使用记录则跳过，避免误点重复发
      const existed = await db.collection('user_coupons')
        .where({ userId, couponId, status: 'unused' }).count();
      if (existed.total > 0) { skipped++; continue; }

      await db.collection('user_coupons').add({
        data: {
          userId,
          couponId,
          couponTitle: coupon.name || coupon.title || '',
          couponType: coupon.discountType || coupon.type || '',
          discountValue: coupon.value || coupon.discountValue || 0,
          minAmount: coupon.minAmount || 0,
          status: 'unused',
          receivedAt: now,
          expireAt,
          createdAt: now,
          grantedByAdmin: true,
        },
      });
      granted++;
    }

    res.json({ success: true, granted, skipped });
  } catch (e) {
    console.error('grant coupon error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ===== API：评价管理 =====
router.get('/api/reviews', requireLogin, async (req, res) => {
  try {
    const { page = 1, limit = 20, ratings } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    let query = {};
    if (ratings && ratings !== 'all') {
      const ratingNums = ratings.split(',').map(Number);
      query.rating = _.in(ratingNums);
    }
    const countRes = await db.collection('reviews').where(query).count();
    const listRes = await db.collection('reviews').where(query)
      .orderBy('createdAt', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    res.json({ success: true, data: listRes.data, total: countRes.total });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/reviews/:id', requireLogin, async (req, res) => {
  try {
    let productId = req.body?.productId;
    if (!productId) {
      const r = await db.collection('reviews').doc(req.params.id).get();
      productId = r.data?.productId;
    }

    await db.collection('reviews').doc(req.params.id).remove();

    if (productId) {
      try {
        const allReviews = await db.collection('reviews')
          .where({ productId })
          .field({ rating: true })
          .get();
        const ratings = (allReviews.data || []).map(r => r.rating);
        const reviewCount = ratings.length;
        const averageRating = reviewCount > 0
          ? Math.round((ratings.reduce((s, r) => s + r, 0) / reviewCount) * 10) / 10
          : 0;
        await db.collection('products').doc(productId).update({
          data: { averageRating, reviewCount }
        });
      } catch (aggErr) {
        console.error('删除后重算评分失败（不影响删除结果）:', aggErr.message);
      }
    }

    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== API：礼品库管理 =====
router.get('/api/gifts', requireLogin, async (req, res) => {
  try {
    const res2 = await db.collection('gifts').orderBy('_id', 'desc').get();
    res.json({ success: true, data: res2.data });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/gifts', requireLogin, async (req, res) => {
  try {
    const { name, pointsCost, stock, description } = req.body;
    if (!name || !pointsCost) return res.json({ success: false, error: '参数缺失' });
    const r = await db.collection('gifts').add({
      name, pointsCost: parseInt(pointsCost), stock: parseInt(stock) || 0,
      exchangedCount: 0, description: description || '',
      status: 'active', createdAt: new Date(), updatedAt: new Date()
    });
    res.json({ success: true, id: r.id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/gifts/:id', requireLogin, async (req, res) => {
  try {
    const { name, pointsCost, stock, description } = req.body;
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (pointsCost !== undefined) update.pointsCost = parseInt(pointsCost);
    if (stock !== undefined) update.stock = parseInt(stock);
    if (description !== undefined) update.description = description;
    await db.collection('gifts').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/gifts/:id/stock', requireLogin, async (req, res) => {
  try {
    const { delta } = req.body;
    const r = await db.collection('gifts').doc(req.params.id).get();
    if (!r.data) return res.json({ success: false, error: '礼品不存在' });
    const newStock = Math.max(0, (r.data.stock || 0) + parseInt(delta));
    await db.collection('gifts').doc(req.params.id).update({ stock: newStock, updatedAt: new Date() });
    res.json({ success: true, stock: newStock });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/gifts/:id/toggle', requireLogin, async (req, res) => {
  try {
    const r = await db.collection('gifts').doc(req.params.id).get();
    if (!r.data) return res.json({ success: false, error: '不存在' });
    const newStatus = r.data.status === 'inactive' ? 'active' : 'inactive';
    await db.collection('gifts').doc(req.params.id).update({ status: newStatus, updatedAt: new Date() });
    res.json({ success: true, status: newStatus });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== API：营销榜单（单王 / 复购王）=====
// range: today | week | month | all
// 实时聚合 orders（只算有效订单 paid/shipped/completed），不建集合、不用定时任务。
// 时区：容器为 UTC，按北京时间（UTC+8）算"自然日/周/月"边界与下单日期，避免少 8 小时。
const RANGE_LABELS = { today: '今日', week: '本周', month: '本月', all: '全部' };

// 北京时间下某毫秒时间戳对应的 YYYY-MM-DD（用于"下单天数"去重）
function beijingDayKey(ms) {
  const d = new Date(ms + 8 * 60 * 60 * 1000); // 平移到北京时间再取 UTC 各字段
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 计算 range 起始时间（毫秒）。all 返回 0。
function rangeSince(range) {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000); // 北京"现在"
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  if (range === 'today') return Date.UTC(y, m, d) - 8 * 60 * 60 * 1000;
  if (range === 'month') return Date.UTC(y, m, 1) - 8 * 60 * 60 * 1000;
  if (range === 'week') {
    // 周一为一周起点；getUTCDay 0=周日 → 换算到距本周一的天数
    const dow = now.getUTCDay();
    const backDays = dow === 0 ? 6 : dow - 1;
    return Date.UTC(y, m, d - backDays) - 8 * 60 * 60 * 1000;
  }
  return 0; // all
}

router.get('/api/marketing/rankings', requireLogin, async (req, res) => {
  try {
    const range = ['today', 'week', 'month', 'all'].includes(req.query.range) ? req.query.range : 'today';
    const since = rangeSince(range);

    let where = { status: _.in(['paid', 'shipped', 'completed']) };
    if (since > 0) where.createTime = _.gte(new Date(since));

    const ordersRes = await db.collection('orders').where(where)
      .field({ userId: true, finalPrice: true, totalAmount: true, createTime: true })
      .limit(1000).get();

    // 按 userId 聚合
    const agg = {}; // userId -> { orderCount, totalSpent, days:Set }
    let totalOrders = 0;
    for (const o of ordersRes.data) {
      if (!o.userId) continue;
      totalOrders++;
      const a = agg[o.userId] || (agg[o.userId] = { orderCount: 0, totalSpent: 0, days: new Set() });
      a.orderCount++;
      a.totalSpent += Number(o.finalPrice ?? o.totalAmount ?? 0);
      const ms = toMs(o.createTime);
      if (ms) a.days.add(beijingDayKey(ms));
    }

    const userIds = Object.keys(agg);
    // 联表用户昵称/头像/手机
    const userMap = {};
    if (userIds.length > 0) {
      const usersRes = await db.collection('users').where({ _id: _.in(userIds) })
        .field({ nickName: true, avatarUrl: true, phone: true }).get();
      usersRes.data.forEach(u => { userMap[u._id] = u; });
    }

    const rows = userIds.map(uid => {
      const a = agg[uid];
      const u = userMap[uid] || {};
      return {
        userId: uid,
        nickName: u.nickName || '微信用户',
        avatar: u.avatarUrl || '',
        phone: u.phone || '',
        orderCount: a.orderCount,
        totalSpent: Math.round(a.totalSpent * 100) / 100,
        activeDays: a.days.size,
      };
    });

    // 单王：笔数降序（并列按消费额）；复购王：下单天数降序（并列按笔数）
    const kingOrders = [...rows].sort((x, y) => y.orderCount - x.orderCount || y.totalSpent - x.totalSpent).slice(0, 10);
    const kingRepurchase = [...rows].sort((x, y) => y.activeDays - x.activeDays || y.orderCount - x.orderCount).slice(0, 10);

    res.json({
      success: true,
      rangeLabel: RANGE_LABELS[range],
      totalUsers: userIds.length,
      totalOrders,
      kingOrders,
      kingRepurchase,
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
