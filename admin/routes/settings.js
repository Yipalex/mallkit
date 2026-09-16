// 仪表盘 + 店铺设置 + 仓储物流统计
const express = require('express');
const router = express.Router();

const { db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');

// 汇总仪表盘核心指标（商品/订单/用户总数、待办计数、今日营收）。
// 被 /api/dashboard 与 /api/overview 共用，避免重复查询逻辑。
async function buildDashboard() {
  const [products, orders, users, withdrawals, pendingShip] = await Promise.all([
    db.collection('products').count(),
    db.collection('orders').count(),
    db.collection('users').count(),
    db.collection('withdrawals').where({ status: 'pending' }).count(),
    db.collection('orders').where({ status: 'paid' }).count(),
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 今日营收只统计已实收到钱的订单：已支付/已发货/已完成。
  // 待支付(pending_payment)、已取消(cancelled)、已退款(refunded) 均不计入营收。
  const todayOrders = await db.collection('orders')
    .where({ createTime: _.gte(today), status: _.in(['paid', 'shipped', 'completed']) })
    .field({ finalPrice: true })
    .get();
  const todayRevenue = +todayOrders.data.reduce((sum, o) => sum + (o.finalPrice || 0), 0).toFixed(2);

  return {
    products: products.total,
    orders: orders.total,
    users: users.total,
    pendingWithdrawals: withdrawals.total,
    pendingShipping: pendingShip.total,
    todayOrders: todayOrders.data.length,
    todayRevenue,
  };
}

// 查询低库存商品（stock <= 10），与 /api/logistics/stats 口径一致。
async function buildLowStock(limit = 10) {
  const res = await db.collection('products').where({ status: 'active' }).limit(200).get();
  const items = (res.data || []).filter(p => (p.stock || 0) <= 10).sort((a, b) => a.stock - b.stock);
  return {
    lowStock: items.length,
    lowStockItems: items.slice(0, limit).map(p => ({ _id: p._id, name: p.name, stock: p.stock || 0 })),
  };
}

// ===== API：仪表盘数据 =====
router.get('/api/dashboard', requireLogin, async (req, res) => {
  try {
    res.json(await buildDashboard());
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== API：聚合概览（给 AI Agent 一句话回答「今天有什么要处理的」）=====
// 合并仪表盘待办指标 + 低库存预警，一次返回，避免 agent 连发多个请求。
router.get('/api/overview', requireLogin, async (req, res) => {
  try {
    const [dash, stock] = await Promise.all([buildDashboard(), buildLowStock()]);
    res.json({
      todayRevenue: dash.todayRevenue,
      todayOrders: dash.todayOrders,
      pendingShipping: dash.pendingShipping,
      pendingWithdrawals: dash.pendingWithdrawals,
      lowStock: stock.lowStock,
      lowStockItems: stock.lowStockItems,
      totalUsers: dash.users,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== API：店铺设置 =====
router.get('/api/settings', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('settings').doc('store').get();
    res.json({ data: result.data || {} });
  } catch (e) {
    res.json({ data: {}, error: e.message });
  }
});

router.put('/api/settings', requireLogin, async (req, res) => {
  try {
    const { storeName, phone, address, shippingFee, freeShippingThreshold, openTime, closeTime, shippingRules, pickupAddress, pickupPhone, pickupNote, serviceLabel, serviceText, serviceVisible, posterBadgeText, posterPriceLabel, posterTopSlogan, posterBottomSlogan } = req.body;
    const data = { storeName, phone, address, shippingFee, freeShippingThreshold, openTime, closeTime, pickupAddress, pickupPhone, pickupNote, serviceLabel, serviceText, serviceVisible: serviceVisible !== false, posterBadgeText, posterPriceLabel, posterTopSlogan, posterBottomSlogan, updatedAt: new Date() };
    if (Array.isArray(shippingRules)) {
      const valid = shippingRules.every(r =>
        Array.isArray(r.provinces) && r.provinces.length > 0 &&
        r.provinces.every(p => typeof p === 'string') &&
        typeof r.fee === 'number' && r.fee >= 0 &&
        typeof r.blocked === 'boolean'
      );
      if (!valid) return res.json({ success: false, error: '运费规则格式不正确' });
      data.shippingRules = shippingRules;
    }
    try {
      await db.collection('settings').doc('store').update(data);
    } catch (e) {
      await db.collection('settings').add({ _id: 'store', ...data });
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：仓储物流统计 =====
router.get('/api/logistics/stats', requireLogin, async (req, res) => {
  try {
    const [productsRes, pendingRes, inTransitRes] = await Promise.all([
      db.collection('products').where({ status: 'active' }).limit(200).get(),
      db.collection('orders').where({ status: 'paid' }).count(),
      db.collection('orders').where({ status: 'shipped' }).count(),
    ]);
    const products = productsRes.data || [];
    const lowStockItems = products.filter(p => (p.stock || 0) <= 10).sort((a, b) => a.stock - b.stock);
    res.json({
      data: {
        totalProducts: products.length,
        lowStock: lowStockItems.length,
        pendingShip: pendingRes.total,
        inTransit: inTransitRes.total,
        lowStockItems: lowStockItems.slice(0, 10).map(p => ({ _id: p._id, name: p.name, stock: p.stock || 0 })),
      }
    });
  } catch (e) {
    res.json({ data: {}, error: e.message });
  }
});

module.exports = router;
