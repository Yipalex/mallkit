// cloudfunctions/orderTimeout/index.js
// 待支付订单超时自动取消（定时触发器每 5 分钟跑一次，也支持手动 action:'run'）
//
// 处理流程（单笔）：
//   1. pay.queryOrder —— 以微信侧为准。若微信已 SUCCESS，该接口会自动把订单同步为 paid
//      并补齐 payNotify 副作用，此处跳过不取消（防止「已付款却被超时取消」）。
//   2. pay.closeOrder —— 关闭微信侧未支付单，避免用户在收银台里补付。失败只记日志不阻断。
//   3. order.adminCancel —— 走 doCancelOrder 完成状态 + 库存 / SKU / 企业礼券的完整回滚。
//
// ⚠️ 取消必须走 order.adminCancel，禁止本函数直接改 orders.status（会漏回滚库存）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const BATCH_LIMIT = 30; // 每笔 3 次网络调用，批量太大易撞云函数超时；5 分钟一轮足够消化
const FALLBACK_TIMEOUT_MS = 15 * 60 * 1000; // 老数据没有 paymentExpireTime 时按下单 15 分钟兜底

exports.main = async (event) => {
  const action = event && event.action ? event.action : 'run';
  if (action !== 'run') return { code: 400, message: '未知操作' };

  const now = new Date();
  const fallbackBefore = new Date(now.getTime() - FALLBACK_TIMEOUT_MS);

  const result = { scanned: 0, cancelled: 0, skippedPaid: 0, deferred: 0, failed: 0 };

  try {
    const res = await db.collection('orders')
      .where(_.and([
        { status: 'pending_payment' },
        _.or([
          { paymentExpireTime: _.lt(now) },
          { paymentExpireTime: _.exists(false), createTime: _.lt(fallbackBefore) },
          { paymentExpireTime: null, createTime: _.lt(fallbackBefore) },
        ]),
      ]))
      .orderBy('createTime', 'asc')
      .limit(BATCH_LIMIT)
      .get();

    const orders = res.data || [];
    result.scanned = orders.length;

    for (const order of orders) {
      const orderId = order._id;
      try {
        // 1. 先问微信：是否其实已支付 / 是否已被 queryOrder 顺手取消 / 查单是否异常
        const wx = await checkWx(orderId);
        if (wx === 'paid') {
          result.skippedPaid++;
          console.log('订单微信侧已支付，跳过取消:', orderId);
          continue;
        }
        if (wx === 'cancelled') {
          // queryOrder 发现微信已关单，已走 adminCancel 完成回滚
          result.cancelled++;
          continue;
        }
        if (wx === 'defer') {
          result.deferred++;
          continue;
        }

        // 2. 关闭微信侧订单（失败不阻断）
        try {
          const closeRes = await cloud.callFunction({
            name: 'pay', data: { action: 'closeOrder', orderId }
          });
          const r = closeRes && closeRes.result;
          if (!r || r.code !== 200) console.warn('关闭微信订单未成功:', orderId, r && r.message);
        } catch (e) {
          console.warn('关闭微信订单异常:', orderId, e.message);
        }

        // 3. 取消订单 + 回滚库存
        const cancelRes = await cloud.callFunction({
          name: 'order', data: { action: 'adminCancel', orderId, reason: 'timeout' }
        });
        const cr = cancelRes && cancelRes.result;
        if (cr && cr.code === 200) {
          result.cancelled++;
        } else {
          result.failed++;
          console.error('取消超时订单失败:', orderId, cr && cr.message);
        }
      } catch (e) {
        result.failed++;
        console.error('处理超时订单异常:', orderId, e.message);
      }
    }

    console.log('orderTimeout 执行结果:', JSON.stringify(result));
    return { code: 200, data: result };
  } catch (err) {
    console.error('orderTimeout error:', err);
    return { code: 500, message: err.message, data: result };
  }
};

// 查微信侧支付状态，返回：
//   'paid'      微信已支付/已退款（queryOrder 已把 DB 同步为 paid 并补副作用）→ 不取消
//   'cancelled' 微信已关单，queryOrder 内部已调 adminCancel 完成回滚 → 不再重复取消
//   'unpaid'    微信 NOTPAY，或微信侧根本没这笔单（404，用户从未拉起支付）→ 继续取消
//   'defer'     查单出错（网络/微信接口异常）→ 本轮不动，等下一轮，宁可晚取消也不错杀已付款单
async function checkWx(orderId) {
  try {
    const res = await cloud.callFunction({ name: 'pay', data: { action: 'queryOrder', orderId } });
    const r = res && res.result;
    if (!r) return 'defer';
    if (r.code === 404) return 'unpaid';
    if (r.code !== 200 || !r.data) return 'defer';
    const state = r.data.wxTradeState;
    if (state === 'SUCCESS' || state === 'REFUND') return 'paid';
    const after = r.data.dbStatusAfter;
    if (after === 'cancelled') return 'cancelled';
    if (after && after !== 'pending_payment') return 'paid';
    return 'unpaid';
  } catch (e) {
    console.warn('查微信订单状态异常，本轮跳过:', orderId, e.message);
    return 'defer';
  }
}
