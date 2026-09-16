// 订单 + 发货 + 退款 + 提现审核
const express = require('express');
const router = express.Router();

const { cloud, db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { toMs, fmtDateTime } = require('../lib/utils');
const { wxUploadShippingInfo, wxFollowWaybill } = require('../lib/wx-api');

// 快递公司 → 微信物流编码（getDeliveryList 返回的标准码）。
// 全称/简称都要收，因为前端历史上既传过全称（圆通速递）也传过简称（圆通）。
const COMPANY_CODE_MAP = {
  '顺丰速递': 'SF',  '顺丰速运': 'SF',  '顺丰': 'SF',
  '圆通速递': 'YTO', '圆通': 'YTO',
  '中通快递': 'ZTO', '中通': 'ZTO',
  '韵达快递': 'YD',  '韵达': 'YD',
  '极兔速递': 'JTSD','极兔': 'JTSD',
  '申通快递': 'STO', '申通': 'STO',
  '京东物流': 'JD',  '京东快递': 'JD', '京东': 'JD',
  '邮政快递': 'CNPOST', '邮政快递包裹': 'CNPOST', '邮政': 'CNPOST',
};

// 查微信快递编码。查不到时返回 null（绝不猜成某个具体快递，
// 否则会把单号配上错误的快递公司码上报给微信，导致轨迹查不到）。
function resolveDeliveryId(company) {
  if (!company) return null;
  return COMPANY_CODE_MAP[company] || COMPANY_CODE_MAP[String(company).trim()] || null;
}

// ===== API：订单列表 =====
router.get('/api/orders', requireLogin, async (req, res) => {
  try {
    const { page = 1, pageSize = 15, status } = req.query;
    let query = db.collection('orders');
    if (status) query = query.where({ status });
    const result = await query
      .skip((page - 1) * pageSize)
      .limit(Number(pageSize))
      .orderBy('createTime', 'desc')
      .get();
    const countQuery = status
      ? db.collection('orders').where({ status })
      : db.collection('orders');
    const count = await countQuery.count();

    // 联表：拿这一页订单涉及的用户昵称 + 头像
    const userIds = [...new Set(result.data.map(o => o.userId).filter(Boolean))];
    const userMap = {};
    if (userIds.length > 0) {
      const usersRes = await db.collection('users').where({ _id: _.in(userIds) }).field({ nickName: true, phone: true, avatarUrl: true }).get();
      usersRes.data.forEach(u => { userMap[u._id] = u; });
    }

    let list = result.data.map(o => {
      const u = userMap[o.userId] || {};
      return {
        ...o,
        createTimeMs: toMs(o.createTime),
        createTimeStr: fmtDateTime(o.createTime),
        userNick: u.nickName || '微信用户',
        userPhone: u.phone || '',
        userAvatar: u.avatarUrl || '',
      };
    });

    // 把每个订单 items 里的 image 字段（cloud://）批量转为临时 URL
    const allImageIds = [];
    for (const o of list) {
      for (const item of (o.items || [])) {
        if (item.image && item.image.startsWith('cloud://')) allImageIds.push(item.image);
      }
    }
    if (allImageIds.length > 0) {
      try {
        const unique = [...new Set(allImageIds)];
        const r = await cloud.getTempFileURL({ fileList: unique });
        const imgMap = {};
        for (const f of r.fileList) imgMap[f.fileID] = f.tempFileURL;
        list = list.map(o => ({
          ...o,
          items: (o.items || []).map(item => ({
            ...item,
            image: (item.image && imgMap[item.image]) ? imgMap[item.image] : item.image,
          })),
        }));
      } catch (_) {}
    }

    res.json({ list, total: count.total });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// 后台可直接改写的订单状态白名单。
// cancelled 不在其中：取消要回滚库存/SKU/企业礼券，必须走 /cancel 调云函数，裸改状态会漏回滚。
const ALLOWED_STATUS = ['paid', 'shipped', 'completed'];

// ===== API：修改订单状态 =====
router.post('/api/orders/:id/status', requireLogin, async (req, res) => {
  try {
    const { status } = req.body;
    if (status === 'cancelled') {
      return res.json({ success: false, error: '取消订单请用 /cancel 接口' });
    }
    if (!ALLOWED_STATUS.includes(status)) {
      return res.json({ success: false, error: '不支持的订单状态' });
    }
    await db.collection('orders').doc(req.params.id).update({ status, updateTime: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：后台取消待支付订单 =====
// 走 order 云函数 adminCancel（无 OPENID 时才放行），由云函数统一回滚库存/SKU/企业礼券余额。
router.post('/api/orders/:id/cancel', requireLogin, async (req, res) => {
  try {
    const result = await cloud.callFunction({
      name: 'order',
      data: { action: 'adminCancel', orderId: req.params.id, reason: 'admin' },
    });
    const r = result.result;
    if (r && r.code === 200) {
      res.json({ success: true, message: r.message || '已取消' });
    } else {
      res.json({ success: false, error: r?.message || '取消失败' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：从微信支付同步订单真实状态 =====
router.post('/api/orders/:id/sync', requireLogin, async (req, res) => {
  try {
    const result = await cloud.callFunction({
      name: 'pay',
      data: { action: 'queryOrder', orderId: req.params.id },
    });
    const r = result.result;
    if (r && r.code === 200) {
      res.json({ success: true, data: r.data });
    } else {
      res.json({ success: false, error: r?.message || '同步失败' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：提现申请列表 =====
router.get('/api/withdrawals', requireLogin, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const result = await db.collection('withdrawals')
      .where({ status })
      .orderBy('createTime', 'desc')
      .get();
    res.json({ list: result.data });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== API：审核提现（通过/拒绝）=====
router.post('/api/withdrawals/:id/review', requireLogin, async (req, res) => {
  try {
    const { action } = req.body;
    const newStatus = action === 'approve' ? 'completed' : 'rejected';

    const withdrawal = await db.collection('withdrawals').doc(req.params.id).get();
    const w = Array.isArray(withdrawal.data) ? withdrawal.data[0] : withdrawal.data;

    await db.collection('withdrawals').doc(req.params.id).update({
      status: newStatus,
      reviewedAt: new Date(),
    });

    if (action === 'reject') {
      await db.collection('distributors').doc(w.distributorId).update({
        'withdrawal.settledAmount': _.inc(w.amount),
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：发货（支持快递/自提两种模式）=====
router.post('/api/orders/:id/ship', requireLogin, async (req, res) => {
  try {
    const { shippingMethod, packages } = req.body;
    const isPickup = shippingMethod === 'pickup';

    if (!isPickup) {
      if (!Array.isArray(packages) || packages.length === 0) {
        return res.json({ success: false, error: '请填写快递单号' });
      }
      if (packages.length > 15) {
        return res.json({ success: false, error: '最多支持 15 个包裹' });
      }
      if (packages.some(p => !p.expressNo?.trim())) {
        return res.json({ success: false, error: '每个包裹都需要填写运单号' });
      }
      // 提前校验快递公司编码：识别不了就拒绝发货，避免按错误的码上报微信
      const badPkg = packages.find(p => !resolveDeliveryId(p.expressCompany));
      if (badPkg) {
        return res.json({ success: false, error: `无法识别快递公司「${badPkg.expressCompany || '空'}」，请检查后重试` });
      }
    }

    if (isPickup) {
      await db.collection('orders').doc(req.params.id).update({
        status: 'completed',
        shippingMethod: 'pickup',
        shippedAt: new Date(),
        completedAt: new Date(),
        needShipping: false,
        updateTime: new Date(),
      });
    } else {
      // 兼容单包裹（取第一个）和多包裹（存 packages 数组）
      const firstPkg = packages[0];
      await db.collection('orders').doc(req.params.id).update({
        status: 'shipped',
        shippingMethod: 'express',
        expressCompany: firstPkg.expressCompany,
        expressNo: firstPkg.expressNo,
        packages,                 // 完整多包裹数组
        shippedAt: new Date(),
        needShipping: false,
        updateTime: new Date(),
      });
    }

    let orderOpenid = '';
    try {
      const orderSnap = await db.collection('orders').doc(req.params.id).get();
      orderOpenid = (Array.isArray(orderSnap.data) ? orderSnap.data[0] : orderSnap.data)?.userId || '';
    } catch (_) {}

    if (isPickup) {
      await wxUploadShippingInfo(req.params.id, orderOpenid, 3, [], '商品');
    } else {
      await wxUploadShippingInfo(req.params.id, orderOpenid, 1, packages, '商品');
      // 每个包裹都注册物流追踪（快递码已在入口校验，必有效）
      for (const pkg of packages) {
        const deliveryId = resolveDeliveryId(pkg.expressCompany);
        await wxFollowWaybill(req.params.id, orderOpenid, deliveryId, pkg.expressNo);
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：补报历史订单发货信息 =====
router.post('/api/orders/reupload-shipping', requireLogin, async (req, res) => {
  try {
    const [shippedRes, completedRes] = await Promise.all([
      db.collection('orders').where({ status: 'shipped' }).get(),
      db.collection('orders').where({ status: 'completed' }).get(),
    ]);
    const orders = [...(shippedRes.data || []), ...(completedRes.data || [])];

    const results = [];
    for (const order of orders) {
      const orderId = order._id;
      try {
        let uploadResult;
        if (order.shippingMethod === 'pickup') {
          uploadResult = await wxUploadShippingInfo(orderId, order.userId, 3, '', '', '商品');
        } else if (order.expressNo) {
          const deliveryId = resolveDeliveryId(order.expressCompany);
          if (!deliveryId) {
            results.push({ orderId, status: 'skipped', reason: `无法识别快递公司「${order.expressCompany || '空'}」` });
            continue;
          }
          uploadResult = await wxUploadShippingInfo(orderId, order.userId, 1, order.expressNo, order.expressCompany, '商品');
          if (order.userId) {
            await wxFollowWaybill(orderId, order.userId, deliveryId, order.expressNo);
          }
        } else {
          results.push({ orderId, status: 'skipped', reason: '无快递信息' });
          continue;
        }
        results.push({ orderId, status: 'ok', errcode: uploadResult?.errcode });
      } catch (e) {
        results.push({ orderId, status: 'error', reason: e.message });
      }
    }
    console.log('[shipping] 补报完成，共处理', orders.length, '单');
    res.json({ success: true, total: orders.length, results });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：获取单个订单详情 =====
router.get('/api/orders/:id', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('orders').doc(req.params.id).get();
    let data = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!data) return res.json({ data: null });
    let user = {};
    if (data.userId) {
      try {
        const userRes = await db.collection('users').doc(data.userId).get();
        user = (Array.isArray(userRes.data) ? userRes.data[0] : userRes.data) || {};
      } catch (e) {}
    }
    res.json({ data: {
      ...data,
      createTimeMs: toMs(data.createTime),
      createTimeStr: fmtDateTime(data.createTime),
      userNick: user.nickName || '微信用户',
      userPhone: user.phone || '',
    }});
  } catch (e) {
    res.json({ data: null, error: e.message });
  }
});

// ===== 退款管理 API =====
router.get('/api/refunds', requireLogin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = db.collection('refund_requests').orderBy('createTime', 'desc').limit(100);
    if (status) query = db.collection('refund_requests').where({ status }).orderBy('createTime', 'desc').limit(100);
    const result = await query.get();
    res.json({ success: true, list: result.data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/api/refunds/:id/approve', requireLogin, async (req, res) => {
  const { id } = req.params;
  try {
    // 先取退款申请对应订单，判断是否企业礼券订单
    let order = null;
    try {
      const reqRes = await db.collection('refund_requests').doc(id).get();
      const refundReq = Array.isArray(reqRes.data) ? reqRes.data[0] : reqRes.data;
      if (refundReq?.orderId) {
        const oRes = await db.collection('orders').doc(refundReq.orderId).get();
        order = Array.isArray(oRes.data) ? oRes.data[0] : oRes.data;
      }
    } catch (e) { /* 查询失败不阻断，退款仍按原逻辑走 */ }

    // executeRefund 按 order.finalPrice 退微信：券订单 finalPrice=运费，退运费天然正确；
    // 若券订单免运费(finalPrice=0)则无微信退款可执行，跳过云函数调用。
    let wxRefundOk = true;
    if (!(order?.orderType === 'voucher' && Number(order.finalPrice || 0) <= 0)) {
      const result = await cloud.callFunction({
        name: 'pay',
        data: { action: 'executeRefund', refundReqId: id }
      });
      wxRefundOk = !!(result.result && result.result.code === 200);
      if (!wxRefundOk) {
        return res.json({ success: false, error: result.result?.message || '退款失败' });
      }
    }

    // 券订单：货款退回企业余额（用户微信只退了运费部分）
    if (order?.orderType === 'voucher' && order.enterpriseId && Number(order.enterprisePaidAmount) > 0) {
      const amt = Math.round(Number(order.enterprisePaidAmount) * 100) / 100;
      await db.collection('enterprises').doc(order.enterpriseId).update({
        balance: _.inc(amt), updateTime: new Date(),
      });
      await db.collection('enterprise_logs').add({
        enterpriseId: order.enterpriseId, type: 'refund_back', amount: amt,
        orderId: order._id, voucherCode: order.voucherCode || null,
        remark: '券订单退款，货款退回企业余额', createTime: new Date(),
      });
    }

    res.json({ success: true, message: '退款已处理' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/api/refunds/:id/reject', requireLogin, async (req, res) => {
  const { id } = req.params;
  const { reason = '商家审核后拒绝退款申请' } = req.body;
  try {
    const reqRes = await db.collection('refund_requests').doc(id).get();
    const refundReq = Array.isArray(reqRes.data) ? reqRes.data[0] : reqRes.data;
    if (!refundReq) return res.json({ success: false, error: '申请不存在' });

    await db.collection('orders').doc(refundReq.orderId).update({
      status: 'paid', updateTime: new Date()
    });
    await db.collection('refund_requests').doc(id).update({
      status: 'rejected', rejectReason: reason, processTime: new Date(), updateTime: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
