// 财务报表：月度聚合 + CSV 导出
// 营收口径：status ∈ [paid, shipped, completed]，按 createTime 月份归属
// 退款：status = refunded，按 createTime 月份归属（下单月份，便于和原月营收对账）
const express = require('express');
const router = express.Router();

const { db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { monthToRange, fmtMonth } = require('../lib/utils');

const REVENUE_STATUSES = ['paid', 'shipped', 'completed'];

// 聚合一个月的财务数据
async function aggregateMonth(monthStr) {
  const { start, end } = monthToRange(monthStr);
  const startDate = new Date(start);
  const endDate = new Date(end);

  // 一次性拉这个月所有相关订单（CloudBase 默认 limit 20，需要 .limit(1000)）
  const allRes = await db.collection('orders')
    .where({ createTime: _.gte(startDate).and(_.lt(endDate)) })
    .field({
      _id: true, status: true, subtotal: true, discountAmount: true,
      distDiscount: true, userCouponDiscount: true, shippingFee: true,
      finalPrice: true, referrerCommission: true, createTime: true,
    })
    .limit(1000)
    .get();
  const orders = allRes.data || [];

  let revenue = 0;
  let orderCount = 0;
  let subtotalSum = 0;
  let userCouponSum = 0;
  let shippingSum = 0;
  let commissionSum = 0;
  let refundAmount = 0;
  let refundCount = 0;

  for (const o of orders) {
    const finalP = Number(o.finalPrice) || 0;
    if (REVENUE_STATUSES.includes(o.status)) {
      revenue += finalP;
      orderCount++;
      subtotalSum += Number(o.subtotal) || 0;
      userCouponSum += Number(o.userCouponDiscount) || 0;
      shippingSum += Number(o.shippingFee) || 0;
      commissionSum += Number(o.referrerCommission) || 0;
    } else if (o.status === 'refunded') {
      refundAmount += finalP;
      refundCount++;
    }
  }

  const netIncome = revenue - refundAmount - commissionSum;
  return {
    month: monthStr,
    revenue: +revenue.toFixed(2),
    orderCount,
    refundAmount: +refundAmount.toFixed(2),
    refundCount,
    commission: +commissionSum.toFixed(2),
    netIncome: +netIncome.toFixed(2),
    breakdown: {
      subtotal: +subtotalSum.toFixed(2),
      userCouponSubsidy: +userCouponSum.toFixed(2),
      shipping: +shippingSum.toFixed(2),
    },
  };
}

// GET /api/finance/monthly?month=YYYY-MM
router.get('/api/finance/monthly', requireLogin, async (req, res) => {
  try {
    let monthStr = req.query.month;
    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
      const d = new Date();
      monthStr = fmtMonth(d.getFullYear(), d.getMonth() + 1);
    }
    const [y, m] = monthStr.split('-').map(Number);

    const current = await aggregateMonth(monthStr);
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    const previous = await aggregateMonth(fmtMonth(prevY, prevM));

    const last12 = [];
    for (let i = 0; i < 12; i++) {
      let yy = y, mm = m - i;
      while (mm <= 0) { mm += 12; yy--; }
      last12.push(await aggregateMonth(fmtMonth(yy, mm)));
    }

    res.json({ success: true, current, previous, last12Months: last12 });
  } catch (e) {
    console.error('finance/monthly error:', e);
    res.json({ success: false, error: e.message });
  }
});

// GET /api/finance/export?month=YYYY-MM  → CSV 下载
router.get('/api/finance/export', requireLogin, async (req, res) => {
  try {
    let monthStr = req.query.month;
    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
      const d = new Date();
      monthStr = fmtMonth(d.getFullYear(), d.getMonth() + 1);
    }
    const { start, end } = monthToRange(monthStr);
    const startDate = new Date(start);
    const endDate = new Date(end);

    const r = await db.collection('orders')
      .where({ createTime: _.gte(startDate).and(_.lt(endDate)) })
      .orderBy('createTime', 'asc')
      .limit(2000)
      .get();
    const orders = r.data || [];

    const userIds = [...new Set(orders.map(o => o.userId).filter(Boolean))];
    const userMap = {};
    if (userIds.length > 0) {
      for (let i = 0; i < userIds.length; i += 50) {
        const slice = userIds.slice(i, i + 50);
        try {
          const u = await db.collection('users').where({ _id: _.in(slice) })
            .field({ _id: true, nickName: true, phone: true }).get();
          (u.data || []).forEach(uu => { userMap[uu._id] = uu; });
        } catch (e) {}
      }
    }

    const statusLabel = {
      pending_payment: '待付款', paid: '待发货', shipped: '已发货',
      completed: '已完成', cancelled: '已取消', refunded: '已退款',
    };

    const header = ['订单号', '下单时间', '状态', '买家昵称', '买家手机',
                    '商品总额', '分销码减', '新人券减', '运费', '实付',
                    '分销佣金', '微信交易号'].join(',');
    const rows = orders.map(o => {
      const u = userMap[o.userId] || {};
      const dt = o.createTime ? new Date(o.createTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
      const cells = [
        o._id || '',
        dt,
        statusLabel[o.status] || o.status || '',
        (u.nickName || '').replace(/[,"\n\r]/g, ' '),
        u.phone || '',
        (Number(o.subtotal) || 0).toFixed(2),
        (Number(o.distDiscount) || 0).toFixed(2),
        (Number(o.userCouponDiscount) || 0).toFixed(2),
        (Number(o.shippingFee) || 0).toFixed(2),
        (Number(o.finalPrice) || 0).toFixed(2),
        (Number(o.referrerCommission) || 0).toFixed(2),
        o.transactionId || '',
      ];
      return cells.map(c => /[,"\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',');
    });

    const csv = '﻿' + [header, ...rows].join('\n');  // BOM 让 Excel 识别 UTF-8
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="finance-${monthStr}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('finance/export error:', e);
    res.status(500).send('导出失败: ' + e.message);
  }
});

module.exports = router;
