// 分销员管理：设/取消分销员、邀请、列表、设置、全局分销设置
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { getWxAccessToken, getWxacodeBuffer } = require('../lib/wx-api');

// ===== API：设某用户为分销员（从已有微信用户）=====
router.post('/api/users/:openid/set-distributor', requireLogin, async (req, res) => {
  const { openid } = req.params;
  try {
    const existRes = await db.collection('distributors').where({ userId: openid }).limit(1).get();
    if (existRes.data.length > 0) {
      const existing = existRes.data[0];
      if (existing.status === 'active') {
        await db.collection('users').doc(openid).update({ isDistributor: true, updateTime: new Date() });
        return res.json({ success: true, alreadyExists: true, referralCode: existing.referralCode });
      }
      await db.collection('distributors').doc(existing._id).update({
        status: 'active', source: 'admin', updateTime: new Date()
      });
      await db.collection('users').doc(openid).update({ isDistributor: true, updateTime: new Date() });
      return res.json({ success: true, referralCode: existing.referralCode });
    }

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let referralCode = '';
    let isUnique = false;
    while (!isUnique) {
      referralCode = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      const existing = await db.collection('distributors').where({ referralCode }).count();
      if (existing.total === 0) isUnique = true;
    }

    await db.collection('distributors').add({
      userId: openid, referralCode, registrationDate: new Date(), source: 'admin',
      parentId: null, lineage: [openid], depth: 1,
      stats: { directInvitedCount: 0, totalInvitedCount: 0, totalSalesAmount: 0, totalCommissionEarned: 0, monthlyCommission: 0 },
      withdrawal: { totalWithdrawn: 0, pendingAmount: 0, settledAmount: 0, appliedAmount: 0, minWithdrawalAmount: 50 },
      status: 'active', lastActivityTime: new Date(),
    });

    await db.collection('users').doc(openid).update({ isDistributor: true, updateTime: new Date() });

    // 注：分销归属已改为"扫码/分享自动绑定"，不再创建可填写的分销/积分码

    res.json({ success: true, referralCode });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== API：取消分销员资格 =====
router.delete('/api/users/:openid/set-distributor', requireLogin, async (req, res) => {
  const { openid } = req.params;
  try {
    await db.collection('users').doc(openid).update({ isDistributor: false, updateTime: new Date() });
    await db.collection('distributors').where({ userId: openid }).update({ status: 'inactive', updateTime: new Date() });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== API：一键取消所有分销员资格 =====
router.post('/api/users/clear-all-distributors', requireLogin, async (req, res) => {
  try {
    const distRes = await db.collection('users').where({ isDistributor: true }).limit(1000).field({ _id: true }).get();
    const ids = distRes.data.map(u => u._id);
    let cleared = 0;
    for (const id of ids) {
      try {
        await db.collection('users').doc(id).update({ isDistributor: false, updateTime: new Date() });
        cleared++;
      } catch (e) {}
    }
    await db.collection('distributors').where({ status: 'active' }).update({ status: 'inactive', updateTime: new Date() });
    res.json({ success: true, cleared });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ===== API：生成分销员邀请链接（24小时有效）=====
router.post('/api/distributors/invite', requireLogin, async (req, res) => {
  try {
    const { note = '' } = req.body;
    const token = crypto.randomBytes(16).toString('hex');
    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.collection('distributor_invites').add({
      token, note,
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      expireAt,
      createTime: new Date(),
      updateTime: new Date(),
    });
    const scene = `invite_token=${token.slice(0, 24)}`;
    res.json({ success: true, token: token.slice(0, 24), scene, expireAt });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：查询待确认的分销员邀请列表 =====
router.get('/api/distributors/invites', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('distributor_invites')
      .where({ status: 'claimed' })
      .orderBy('claimedAt', 'desc')
      .limit(50).get();
    const openids = result.data.map(i => i.claimedBy).filter(Boolean);
    const userMap = {};
    if (openids.length > 0) {
      const users = await db.collection('users')
        .where({ _id: _.in(openids) })
        .field({ _id: true, nickName: true, phone: true, avatarUrl: true })
        .get();
      users.data.forEach(u => { userMap[u._id] = u; });
    }
    const list = result.data.map(i => ({ ...i, user: userMap[i.claimedBy] || null }));
    res.json({ success: true, list });
  } catch (e) {
    res.json({ success: false, error: e.message, list: [] });
  }
});

// ===== API：确认邀请 → 正式设为分销员 =====
router.post('/api/distributors/invites/:id/confirm', requireLogin, async (req, res) => {
  try {
    const inviteRes = await db.collection('distributor_invites').doc(req.params.id).get();
    const invite = Array.isArray(inviteRes.data) ? inviteRes.data[0] : inviteRes.data;
    if (!invite || invite.status !== 'claimed') {
      return res.json({ success: false, error: '邀请记录不存在或状态不对' });
    }
    const openid = invite.claimedBy;
    const existRes = await db.collection('distributors').where({ userId: openid }).limit(1).get();
    let referralCode;
    if (existRes.data.length > 0) {
      referralCode = existRes.data[0].referralCode;
      await db.collection('distributors').doc(existRes.data[0]._id).update({ status: 'active', updateTime: new Date() });
    } else {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      referralCode = '';
      let isUnique = false;
      while (!isUnique) {
        referralCode = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const chk = await db.collection('distributors').where({ referralCode }).count();
        if (chk.total === 0) isUnique = true;
      }
      await db.collection('distributors').add({
        userId: openid, referralCode, registrationDate: new Date(), source: 'invite',
        parentId: null, lineage: [openid], depth: 1,
        stats: { directInvitedCount: 0, totalInvitedCount: 0, totalSalesAmount: 0, totalCommissionEarned: 0, monthlyCommission: 0 },
        withdrawal: { totalWithdrawn: 0, pendingAmount: 0, settledAmount: 0, appliedAmount: 0, minWithdrawalAmount: 50 },
        status: 'active', lastActivityTime: new Date(),
      });
      // 注：分销归属已改为"扫码/分享自动绑定"，不再创建可填写的分销/积分码
    }
    await db.collection('users').doc(openid).update({ isDistributor: true, updateTime: new Date() });
    await db.collection('distributor_invites').doc(req.params.id).update({
      status: 'confirmed', confirmedAt: new Date(), updateTime: new Date()
    });
    res.json({ success: true, referralCode });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：拒绝邀请 =====
router.post('/api/distributors/invites/:id/reject', requireLogin, async (req, res) => {
  try {
    await db.collection('distributor_invites').doc(req.params.id).update({
      status: 'rejected', updateTime: new Date()
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：后台手动新增分销员 =====
router.post('/api/distributors', requireLogin, async (req, res) => {
  const { nickname, phone } = req.body;
  if (!nickname) return res.json({ success: false, error: '请填写分销员名称' });
  try {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let referralCode = '';
    let isUnique = false;
    while (!isUnique) {
      referralCode = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      const existing = await db.collection('distributors').where({ referralCode }).count();
      if (existing.total === 0) isUnique = true;
    }

    const distributorId = 'D' + Date.now();
    const distributorData = {
      _id: distributorId,
      userId: `manual_${distributorId}`,
      nickname,
      phone: phone || '',
      referralCode,
      registrationDate: new Date(),
      source: 'manual',
      parentId: null,
      lineage: [],
      depth: 1,
      stats: { directInvitedCount: 0, totalInvitedCount: 0, totalSalesAmount: 0, totalCommissionEarned: 0, monthlyCommission: 0 },
      withdrawal: { totalWithdrawn: 0, pendingAmount: 0, settledAmount: 0, appliedAmount: 0, minWithdrawalAmount: 50 },
      status: 'active',
      lastActivityTime: new Date(),
    };
    await db.collection('distributors').add(distributorData);

    // 注：分销归属已改为"扫码/分享自动绑定"，不再创建可填写的分销/积分码

    res.json({ success: true, data: { referralCode, distributorId } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：分销员列表（含统计）=====
router.get('/api/distributors', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('distributors').where({ status: 'active' }).get();
    console.log('[distributors] raw count:', result.data.length);
    const list = result.data;

    const userIds = [...new Set(list.map(d => d.userId))];
    let nicknameMap = {};
    if (userIds.length > 0) {
      const users = await db.collection('users').where({ _id: _.in(userIds) }).field({ _id: true, nickName: true }).get();
      users.data.forEach(u => { nicknameMap[u._id] = u.nickName; });
    }

    const enriched = [];
    for (const d of list) {
      try {
        const item = { ...d, nickname: nicknameMap[d.userId] || '', stats: { ...(d.stats || {}) } };
        const orders = await db.collection('orders')
          .where({ referrerId: d.userId, status: _.neq('cancelled') })
          .field({ finalPrice: true }).get();
        item.stats.orderCount = orders.data.length;
        item.stats.totalSalesAmount = orders.data.reduce((s, o) => s + (o.finalPrice || 0), 0);
        const commLogs = await db.collection('commission_logs')
          .where({ distributorId: d.userId })
          .field({ commissionAmount: true }).get();
        item.stats.totalCommission = commLogs.data.reduce((s, c) => s + (c.commissionAmount || 0), 0);
        // 绑定下线数：users 集合中 distributorInfo.referrerId 指向该分销员的用户数
        try {
          const boundRes = await db.collection('users')
            .where({ 'distributorInfo.referrerId': d.userId }).count();
          item.stats.boundUserCount = boundRes.total || 0;
        } catch (e) { item.stats.boundUserCount = 0; }
        enriched.push(item);
      } catch (innerErr) {
        console.error('[distributors] enrich error for', d.userId, innerErr.message);
        enriched.push({ ...d, nickname: nicknameMap[d.userId] || '', stats: { orderCount: 0, totalSalesAmount: 0, totalCommission: 0, boundUserCount: 0 } });
      }
    }
    console.log('[distributors] enriched count:', enriched.length);
    res.json({ list: enriched });
  } catch (e) {
    res.json({ error: e.message, list: [] });
  }
});

// ===== API：设置分销员提成比例（旧，保留兼容）=====
router.put('/api/distributors/:id/commission-rate', requireLogin, async (req, res) => {
  try {
    const { commissionRate } = req.body;
    await db.collection('distributors').doc(req.params.id).update({ commissionRate: Number(commissionRate), updatedAt: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：分销员个人提成设置（commissionPercent null = 使用全局）=====
router.put('/api/distributors/:id/settings', requireLogin, async (req, res) => {
  try {
    const { commissionPercent } = req.body;
    const update = { updatedAt: new Date() };
    if (commissionPercent === null) {
      update.commissionPercent = _.remove();
      update.commissionRate = _.remove();
    } else if (commissionPercent != null) {
      update.commissionPercent = Number(commissionPercent);
      update.commissionRate = Number(commissionPercent) / 100;
    }
    await db.collection('distributors').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：全局分销设置 GET/POST（提成比例打底，单品返佣额在商品上单独配）=====
router.get('/api/settings/distribution', requireLogin, async (req, res) => {
  try {
    const r = await db.collection('settings').where({ key: 'distribution_settings' }).limit(1).get();
    if (r.data && r.data.length > 0) {
      res.json({ data: r.data[0].value });
    } else {
      res.json({ data: { commissionPercent: 5, minWithdrawalAmount: 50 } });
    }
  } catch (e) {
    res.json({ data: { commissionPercent: 5, minWithdrawalAmount: 50 } });
  }
});

router.post('/api/settings/distribution', requireLogin, async (req, res) => {
  try {
    const { commissionPercent, minWithdrawalAmount } = req.body;
    const value = { commissionPercent: Number(commissionPercent) };
    if (minWithdrawalAmount != null && minWithdrawalAmount !== '') {
      value.minWithdrawalAmount = Number(minWithdrawalAmount);
    }
    const existing = await db.collection('settings').where({ key: 'distribution_settings' }).limit(1).get();
    if (existing.data && existing.data.length > 0) {
      await db.collection('settings').doc(existing.data[0]._id).update({ value, updatedAt: new Date() });
    } else {
      await db.collection('settings').add({ key: 'distribution_settings', value, createdAt: new Date() });
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：生成分销员专属带货小程序码（扫码即绑定该分销员）=====
// 返回 PNG 图片流，前端直接 <img> 展示 + 下载，可放快团团/海报
router.get('/api/distributors/:id/qrcode', requireLogin, async (req, res) => {
  try {
    // 1. 取分销员的 referralCode
    const distRes = await db.collection('distributors').doc(String(req.params.id)).get();
    const dist = Array.isArray(distRes.data) ? distRes.data[0] : distRes.data;
    if (!dist || !dist.referralCode) {
      return res.status(404).json({ success: false, error: '分销员不存在或无专属码' });
    }
    const referralCode = dist.referralCode;

    // 2. 调微信 getwxacodeunlimit 生成小程序码（scene = referralCode，≤32 字符无需编码）
    let buf;
    try {
      buf = await getWxacodeBuffer({ scene: referralCode, page: 'pages/index/index', width: 430 });
    } catch (err) {
      console.error('[qrcode] getwxacodeunlimit 失败:', err.message);
      // 不回显微信原始错误（含内部配置线索），只回通用文案 + errcode 便于排查
      return res.status(502).json({ success: false, error: err.message });
    }
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="qrcode-${referralCode}.png"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== API：分销员的下线名单（绑定了哪些用户）=====
router.get('/api/distributors/:id/downline', requireLogin, async (req, res) => {
  try {
    const distRes = await db.collection('distributors').doc(String(req.params.id)).get();
    const dist = Array.isArray(distRes.data) ? distRes.data[0] : distRes.data;
    if (!dist) return res.json({ success: false, error: '分销员不存在', list: [] });

    // 1. 查所有绑定到该分销员的用户
    const usersRes = await db.collection('users')
      .where({ 'distributorInfo.referrerId': dist.userId })
      .field({ _id: true, nickName: true, avatarUrl: true, 'distributorInfo.boundAt': true })
      .limit(200)
      .get();
    const users = usersRes.data || [];

    // 2. 统计每个下线在该分销员名下的有效订单数
    const list = [];
    for (const u of users) {
      let orderCount = 0;
      try {
        const oc = await db.collection('orders')
          .where({ userId: u._id, referrerId: dist.userId, status: _.neq('cancelled') })
          .count();
        orderCount = oc.total || 0;
      } catch (e) {}
      list.push({
        openid: u._id,
        nickName: u.nickName || '微信用户',
        avatarUrl: u.avatarUrl || '',
        boundAt: u.distributorInfo?.boundAt || null,
        orderCount,
      });
    }
    // 按绑定时间倒序（新绑的在前）
    list.sort((a, b) => new Date(b.boundAt || 0) - new Date(a.boundAt || 0));
    res.json({ success: true, total: list.length, list });
  } catch (e) {
    res.json({ success: false, error: e.message, list: [] });
  }
});

module.exports = router;
