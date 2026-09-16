// 分销员自己的 API（/api/my/*）：统计数据、申请提现
// 这些接口的鉴权方式比较特殊（角色必须是 distributor），不走 requireLogin
const express = require('express');
const router = express.Router();

const { db, _ } = require('../config/cloud');
const { verifyToken, getTokenFromReq } = require('../lib/auth');

// ===== API：分销员自己的数据（专属接口）=====
router.get('/api/my/stats', async (req, res) => {
  const token = getTokenFromReq(req);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'distributor') return res.status(401).json({ error: '未登录' });
  try {
    const distRes = await db.collection('distributors').doc(payload.distributorId).get();
    const dist = distRes.data;
    if (!dist) return res.json({ error: '分销员不存在' });

    const ordersRes = await db.collection('orders')
      .where({ referrerId: dist.userId, status: _.neq('cancelled') })
      .orderBy('createTime', 'desc').limit(50).get();

    res.json({
      referralCode: dist.referralCode,
      nickname: dist.nickname || dist.userId,
      stats: dist.stats || {},
      withdrawal: dist.withdrawal || {},
      orders: ordersRes.data.map(o => ({
        _id: o._id,
        createTime: o.createTime,
        finalPrice: o.finalPrice,
        status: o.status,
        commission: o.referrerCommission || 0,
      }))
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== API：分销员申请提现 =====
router.post('/api/my/withdraw', async (req, res) => {
  const token = getTokenFromReq(req);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'distributor') return res.status(401).json({ error: '未登录' });
  const amt = Number(req.body.amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.json({ success: false, error: '提现金额无效' });
  try {
    const distRes = await db.collection('distributors').doc(payload.distributorId).get();
    const dist = distRes.data;
    // 最低提现额：全局设置优先，回落到分销员个人，再回落默认 50
    let minAmount = dist.withdrawal?.minWithdrawalAmount || 50;
    try {
      const sr = await db.collection('settings').where({ key: 'distribution_settings' }).limit(1).get();
      const gMin = sr.data?.[0]?.value?.minWithdrawalAmount;
      if (gMin != null) minAmount = Number(gMin);
    } catch (e) {}
    const available = dist.withdrawal?.settledAmount || 0;
    if (amt < minAmount) return res.json({ success: false, error: `最低提现 ¥${minAmount}` });
    if (amt > available) return res.json({ success: false, error: `可提现余额不足（当前 ¥${available}）` });

    const withdrawalId = 'W' + Date.now();
    await db.collection('withdrawals').add({
      _id: withdrawalId, distributorId: dist._id, userId: dist.userId,
      amount: amt, status: 'pending', requestTime: new Date(), remarks: '',
    });
    await db.collection('distributors').doc(dist._id).update({
      'withdrawal.settledAmount': _.inc(-amt),
      'withdrawal.appliedAmount': _.inc(amt),
      updateTime: new Date(),
    });
    res.json({ success: true, message: '提现申请已提交' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
