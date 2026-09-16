// 用户列表 + 积分 + 客户分析
const express = require('express');
const router = express.Router();

const { db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { toMs, fmtDateTime } = require('../lib/utils');

// ===== API：用户列表 =====
router.get('/api/users', requireLogin, async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 15;
    const keyword = (req.query.keyword || '').trim();

    // 搜索条件下推到数据库（旧实现先分页再内存过滤，导致只能搜到当前页，已修复）：
    //  - 纯数字关键词：按手机号模糊匹配（支持只输后 4 位定位用户）
    //  - 含非数字关键词：按昵称模糊匹配
    let where = {};
    if (keyword) {
      where = /^\d+$/.test(keyword)
        ? { phone: db.RegExp({ regexp: keyword, options: 'i' }) }
        : { nickName: db.RegExp({ regexp: keyword, options: 'i' }) };
    }

    const base = db.collection('users').where(where);
    const [result, count] = await Promise.all([
      base.orderBy('createTime', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
      base.count(),
    ]);
    res.json({ list: result.data, total: count.total });
  } catch (e) { res.json({ error: e.message }); }
});

// ===== API：客户分析统计 =====
router.get('/api/customers/stats', requireLogin, async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalRes, new7Res, membersRes, distRes, recentRes] = await Promise.all([
      db.collection('users').count(),
      db.collection('users').where({ createTime: _.gte(sevenDaysAgo) }).count(),
      db.collection('users').where({ 'memberLevel.level': _.gte(1) }).count(),
      db.collection('distributors').count(),
      db.collection('users').orderBy('createTime', 'desc').limit(10).get(),
    ]);

    const levelCounts = [0, 0, 0, 0];
    const allUsersRes = await db.collection('users').field({ 'memberLevel.level': true }).limit(1000).get();
    for (const u of allUsersRes.data) {
      const lvl = u.memberLevel?.level || 0;
      if (lvl >= 0 && lvl <= 3) levelCounts[lvl]++;
    }

    res.json({
      data: {
        total: totalRes.total,
        new7Days: new7Res.total,
        members: membersRes.total,
        distributors: distRes.total,
        levelDistribution: levelCounts.map(count => ({ count })),
        recentUsers: recentRes.data,
        topCustomers: [],
      }
    });
  } catch (e) {
    res.json({ data: {}, error: e.message });
  }
});

// ===== API：积分 / 用户管理 =====
router.get('/api/users/points', requireLogin, async (req, res) => {
  try {
    const { page = 1, limit = 20, keyword } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    let query = {};
    if (keyword) query.nickName = db.RegExp({ regexp: keyword, options: 'i' });
    const countRes = await db.collection('users').where(query).count();
    const listRes = await db.collection('users').where(query)
      .orderBy('points', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    const allRes = await db.collection('users').where({}).field({ points: true, memberLevel: true }).get();
    const allUsers = allRes.data;
    const stats = {
      totalUsers: countRes.total,
      hasPoints: allUsers.filter(u => (u.points || 0) > 0).length,
      totalPoints: allUsers.reduce((s, u) => s + (u.points || 0), 0),
      members: allUsers.filter(u => u.memberLevel && u.memberLevel !== 'normal').length,
    };
    res.json({ success: true, data: listRes.data, total: countRes.total, stats });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/users/:id/points', requireLogin, async (req, res) => {
  try {
    const { delta, reason } = req.body;
    if (!delta || delta === 0) return res.json({ success: false, error: '积分变化量不能为0' });
    const userRes = await db.collection('users').doc(req.params.id).get();
    if (!userRes.data) return res.json({ success: false, error: '用户不存在' });
    const current = userRes.data.memberLevel?.points || 0;
    const newPoints = Math.max(0, current + delta);
    await db.collection('users').doc(req.params.id).update({
      'memberLevel.points': newPoints,
      updatedAt: new Date()
    });
    await db.collection('point_logs').add({
      userId: req.params.id,
      delta,
      before: current,
      after: newPoints,
      points: delta,
      description: reason || '管理员手动调整',
      type: 'admin_adjust',
      balance: newPoints,
      createdAt: new Date(),
    });
    res.json({ success: true, before: current, after: newPoints });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== API：用户详情（基本信息 + 历史订单 + 汇总）=====
// 用于订单列表/订单详情/营销榜单点击下钻，看某用户的全部历史订单（含收货人/电话/地址）。
router.get('/api/users/:id/detail', requireLogin, async (req, res) => {
  try {
    const id = req.params.id;
    const userRes = await db.collection('users').doc(id).get();
    const u = Array.isArray(userRes.data) ? userRes.data[0] : userRes.data;
    if (!u) return res.json({ success: false, error: '用户不存在' });

    const ordersRes = await db.collection('orders').where({ userId: id })
      .orderBy('createTime', 'desc').limit(200).get();

    let totalSpent = 0;
    let validCount = 0;
    const orders = ordersRes.data.map(o => {
      const amount = Number(o.finalPrice ?? o.totalAmount ?? 0);
      if (['paid', 'shipped', 'completed'].includes(o.status)) { totalSpent += amount; validCount++; }
      const addr = o.shippingAddress || {};
      return {
        _id: o._id,
        status: o.status,
        amount: Math.round(amount * 100) / 100,
        createTimeStr: fmtDateTime(o.createTime),
        createTimeMs: toMs(o.createTime),
        receiverName: addr.name || addr.userName || '',
        receiverPhone: addr.phone || addr.telNumber || '',
        receiverAddress: [
          addr.province || addr.provinceName || '',
          addr.city || addr.cityName || '',
          addr.district || addr.countyName || '',
          addr.detail || addr.detailInfo || '',
        ].filter(Boolean).join(' '),
        itemsSummary: (o.items || []).map(i => (i.productName || i.name || '商品') + ' x' + (i.quantity || 1)).join('、'),
      };
    });

    const times = orders.map(o => o.createTimeMs).filter(Boolean);
    res.json({
      success: true,
      user: {
        _id: u._id,
        nickName: u.nickName || '微信用户',
        avatarUrl: u.avatarUrl || '',
        phone: u.phone || '',
        memberLevel: u.memberLevel?.level || 0,
        isDistributor: !!u.isDistributor,
        createTimeStr: fmtDateTime(u.createTime),
      },
      summary: {
        orderCount: ordersRes.data.length,
        validCount,
        totalSpent: Math.round(totalSpent * 100) / 100,
        firstOrderStr: times.length ? fmtDateTime(Math.min(...times)) : '',
        lastOrderStr: times.length ? fmtDateTime(Math.max(...times)) : '',
      },
      orders,
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
