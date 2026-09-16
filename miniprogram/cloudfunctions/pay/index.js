// cloudfunctions/pay/index.js
// 微信支付 JSAPI v3 标准接口
// 凭证从云函数环境变量读取，不硬编码在代码里

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const fetch = require('node-fetch');
const crypto = require('crypto');

// 从环境变量读取商户配置
const MCH_ID         = process.env.WX_MCH_ID;           // 商户号
const API_V3_KEY     = process.env.WX_API_V3_KEY;        // APIv3密钥
const MCH_SERIAL_NO  = process.env.WX_MCH_SERIAL_NO;    // 商户证书序列号
// 私钥：环境变量里换行符可能丢失，兼容处理：
// 1. 如果是字面量 \n → 还原为真正换行
// 2. 如果没有 BEGIN/END 换行 → 自动补全 PEM 格式
function normalizePem(raw) {
  if (!raw) return '';
  let pem = raw.replace(/\\n/g, '\n');
  // 如果整个内容在一行（没有真正的换行），尝试插入换行
  if (!pem.includes('\n')) {
    pem = pem
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
      .replace('-----END ' + 'PRIVATE KEY-----', '\n-----END ' + 'PRIVATE KEY-----');
    // 把中间的 base64 每64字符换行
    const lines = pem.split('\n');
    if (lines.length === 3) {
      const b64 = lines[1].match(/.{1,64}/g).join('\n');
      pem = lines[0] + '\n' + b64 + '\n' + lines[2];
    }
  }
  return pem;
}
const PRIVATE_KEY = normalizePem(process.env.WX_MCH_PRIVATE_KEY);
const PUB_KEY_ID     = process.env.WX_PAY_PUBLIC_KEY_ID; // 微信支付公钥ID
const APPID          = 'touristappid';

// ===== 微信支付文本字段清洗 =====
// ⚠️ 微信支付 v3 接口只接受基本多文种平面(BMP)内的字符，传入 4 字节 UTF-8
// （emoji、部分生僻字，JS 里表现为 surrogate pair）会直接报
// 「请求内容传入了非UTF8参数」导致下单失败。
// 商品名允许带 emoji（如「🎁 示例商品」），所以传给微信前必须剥掉。
// 适用于所有发往微信的文本字段：description / reason 等。
function sanitizeWxText(str, fallback = '商品') {
  if (!str) return fallback;
  const cleaned = String(str)
    // 1) 代理对：4 字节 UTF-8，含绝大多数 emoji（🦐 等），微信拒收的就是这类
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    // 2) 孤立代理项：截断等原因残留，属非法 UTF-16，必须清掉
    .replace(/[\uD800-\uDFFF]/g, '')
    // 3) BMP 内的 emoji 修饰符：变体选择符 FE0E/FE0F、零宽连接符 200D、
    //    组合用围栏 20E3。单独留着会渲染成空盒子
    .replace(/[︎️‍⃣]/g, '')
    // 4) BMP 内的杂项/装饰符号区（☀ ★ ✅ ➡ 等）：微信能收但语义无用
    .replace(/[←-⇿⌀-➿⬀-⯿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

// ===== 生成签名 =====
function buildSign(method, url, timestamp, nonce, body) {
  const message = [method, url, timestamp, nonce, body].join('\n') + '\n';
  return crypto.createSign('RSA-SHA256')
    .update(message)
    .sign(PRIVATE_KEY, 'base64');
}

// ===== 生成 Authorization Header =====
function buildAuth(method, urlPath, body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sign = buildSign(method, urlPath, timestamp, nonce, body);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${MCH_SERIAL_NO}",signature="${sign}"`;
}

// ===== 时间转 RFC3339（东八区）=====
// 微信支付 time_expire 要求 yyyy-MM-DDTHH:mm:ss+08:00 格式。
// 入参可能是 Date（DB 原生）或字符串（序列化后跨云函数传递）。
function toRfc3339Beijing(input) {
  if (!input) return '';
  const d = new Date(input);
  const ms = d.getTime();
  if (!ms) return '';
  // 转成北京时间的「墙上时钟」再手动拼 +08:00，避免依赖运行环境时区
  const bj = new Date(ms + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`
       + `T${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}+08:00`;
}

// ===== 生成小程序调起支付的签名 =====
function buildPaySign(appId, timestamp, nonceStr, prepayId) {
  const message = [appId, timestamp, nonceStr, `prepay_id=${prepayId}`].join('\n') + '\n';
  return crypto.createSign('RSA-SHA256')
    .update(message)
    .sign(PRIVATE_KEY, 'base64');
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  // 验证支付环境变量配置
  if (!MCH_ID || !API_V3_KEY || !MCH_SERIAL_NO || !PRIVATE_KEY || !PUB_KEY_ID) {
    console.error('支付配置缺失', {
      hasMchId: !!MCH_ID,
      hasApiKey: !!API_V3_KEY,
      hasSerialNo: !!MCH_SERIAL_NO,
      hasPrivateKey: !!PRIVATE_KEY,
      hasPublicKeyId: !!PUB_KEY_ID
    });
    return { code: 500, message: '支付功能暂未配置，请联系管理员完成支付设置' };
  }

  if (event.action === 'recharge')      return await createRecharge(OPENID, event);
  if (event.action === 'rechargeLogs')  return await getRechargeLogs(OPENID, event); // 余额明细
  if (event.action === 'refund')        return await applyRefund(OPENID, event);
  if (event.action === 'executeRefund') return await executeRefund(event);    // 管理后台专用
  if (event.action === 'queryOrder')    return await queryOrderFromWx(event); // 管理后台专用：从微信查询真实状态
  if (event.action === 'closeOrder')    return await closeWxOrder(OPENID, event); // 管理端/超时任务专用：关闭微信侧订单

  const { orderId, totalAmount } = event;

  try {
    // 1. 参数验证
    if (!orderId || !totalAmount) {
      return { code: 400, message: '缺少必要参数' };
    }

    // 2. 从数据库验证订单（防止篡改金额）
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;

    if (!order) {
      return { code: 404, message: '订单不存在' };
    }
    if (order.userId !== OPENID) {
      return { code: 403, message: '无权操作此订单' };
    }
    if (order.status !== 'pending_payment') {
      return { code: 400, message: '订单状态不正确' };
    }
    if (Math.round(order.finalPrice * 100) !== Math.round(totalAmount * 100)) {
      return { code: 400, message: '支付金额不一致' };
    }

    // 2.1 支付超时时间：下单时写的 paymentExpireTime（15 分钟）。
    // ⚠️ 微信要求 time_expire 不早于「当前时间 + 1 分钟」，否则下单报错；
    // 已过期或不足 1 分钟的直接拒绝，交由 orderTimeout 定时函数取消。
    const timeExpire = toRfc3339Beijing(order.paymentExpireTime);
    if (order.paymentExpireTime) {
      const expireMs = new Date(order.paymentExpireTime).getTime();
      if (!expireMs || expireMs - Date.now() < 60 * 1000) {
        return { code: 400, message: '订单已超时，请重新下单' };
      }
    }

    // 3. 生成商品描述（用于微信订单中心显示）
    // ⚠️ 商品名可能带 emoji（后台可录入，如「🎁 示例商品」），必须经
    // sanitizeWxText 剥离 4 字节字符，否则微信返回「请求内容传入了非UTF8参数」下单失败。
    let productDescription = '示例商城';
    if (order.items && order.items.length > 0) {
      if (order.items.length === 1) {
        // 单个商品：显示商品名称
        const itemName = sanitizeWxText(order.items[0].name || order.items[0].productName, '商品');
        productDescription = `示例商城 - ${itemName}`;
        if (order.items[0].quantity > 1) {
          productDescription += ` x${order.items[0].quantity}`;
        }
      } else {
        // 多个商品：显示商品数量
        productDescription = `示例商城 - ${order.items.length}件商品`;
      }
    }
    // 最后再兜一次底：截断到微信 description 上限 127 字符，并确保非空
    productDescription = sanitizeWxText(productDescription, '示例商城').slice(0, 127);

    // 4. 构造下单请求体
    const totalFee = Math.round(totalAmount * 100); // 转为分
    const reqBody = JSON.stringify({
      appid: APPID,
      mchid: MCH_ID,
      description: productDescription,
      out_trade_no: orderId,
      // 注意：微信云开发的支付回调是云函数调用，不是HTTP回调
      // 回调会自动触发 payNotify 云函数
      notify_url: 'https://your-env-id.ap-shanghai.app.example.com/payNotify',
      amount: { total: totalFee, currency: 'CNY' },
      payer: { openid: OPENID },
      // 支付超时：微信侧到点自动关单，与 orderTimeout 定时取消形成双保险
      ...(timeExpire ? { time_expire: timeExpire } : {}),
    });

    // 4. 调用微信支付 JSAPI 下单接口
    const urlPath = '/v3/pay/transactions/jsapi';
    const auth = buildAuth('POST', urlPath, reqBody);

    const payRes = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'Wechatpay-Serial': PUB_KEY_ID,
        'Accept': 'application/json',
      },
      body: reqBody,
    });

    const payData = await payRes.json();

    if (!payData.prepay_id) {
      console.error('下单失败:', payData);
      return { code: 500, message: payData.message || '获取支付参数失败' };
    }

    const prepayId = payData.prepay_id;

    // 5. 生成小程序端调起支付所需参数
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const paySign = buildPaySign(APPID, timestamp, nonceStr, prepayId);

    // 6. 保存 prepayId 到订单
    await db.collection('orders').doc(orderId).update({
      data: { prepayId, updateTime: new Date() }
    });

    return {
      code: 200,
      data: {
        timeStamp: timestamp,
        nonceStr,
        package: `prepay_id=${prepayId}`,
        signType: 'RSA',
        paySign,
      }
    };

  } catch (err) {
    console.error('pay error:', err);
    return { code: 500, message: err.message };
  }
};

// ===== 用户申请退款 =====
// 流程：用户发起申请 → 写入 refund_requests 集合（pending）→ 管理后台审核 → 调微信退款API
async function applyRefund(openid, event) {
  const { orderId, reason = '用户申请退款' } = event;
  if (!orderId) return { code: 400, message: '缺少订单号' };

  try {
    // 1. 验证订单归属和状态
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.userId !== openid) return { code: 403, message: '无权操作此订单' };

    // 只有 paid（待发货）或 shipped（已发货）的订单才能申请退款
    // pending_payment 直接取消即可，completed 已完成不退
    const refundableStatuses = ['paid', 'shipped'];
    if (!refundableStatuses.includes(order.status)) {
      const tips = {
        'pending_payment': '待支付订单请直接取消',
        'completed': '已完成订单不支持退款',
        'cancelled': '订单已取消',
        'refund_pending': '退款申请已提交，请等待审核',
        'refunded': '订单已退款',
      };
      return { code: 400, message: tips[order.status] || '当前状态不支持退款' };
    }

    // 2. 防止重复申请（集合不存在时视为无记录，兼容首次使用）
    let existingReq = { data: [] };
    try {
      existingReq = await db.collection('refund_requests')
        .where({ orderId, status: 'pending' }).limit(1).get();
    } catch (e) {
      if (!e.message || !e.message.includes('-502005')) throw e;
    }
    if (existingReq.data.length > 0) {
      return { code: 400, message: '退款申请已提交，请等待商家审核' };
    }

    // 3. 写入退款申请记录
    const refundReqId = 'RF' + Date.now();
    await db.collection('refund_requests').add({
      data: {
        _id: refundReqId,
        orderId,
        userId: openid,
        amount: order.finalPrice,
        reason,
        status: 'pending',      // pending / approved / rejected
        transactionId: order.transactionId || '',
        createTime: new Date(),
        updateTime: new Date(),
      }
    });

    // 4. 把订单状态改为 refund_pending（退款审核中），防止发货
    await db.collection('orders').doc(orderId).update({
      data: { status: 'refund_pending', updateTime: new Date() }
    });

    return { code: 200, message: '退款申请已提交，商家将在1-3个工作日内处理', data: { refundReqId } };

  } catch (err) {
    console.error('applyRefund error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 管理后台：执行微信退款（审核通过后调用）=====
// 此 action 由管理后台调用，不对外开放给小程序用户
async function executeRefund(event) {
  const { refundReqId } = event;
  if (!refundReqId) return { code: 400, message: '缺少退款申请ID' };

  try {
    // 1. 读取退款申请
    const reqRes = await db.collection('refund_requests').doc(refundReqId).get();
    const req = reqRes.data;
    if (!req) return { code: 404, message: '退款申请不存在' };
    if (req.status !== 'pending') return { code: 400, message: '该申请已处理' };

    // 2. 读取订单
    const orderRes = await db.collection('orders').doc(req.orderId).get();
    const order = orderRes.data;
    if (!order) return { code: 404, message: '原始订单不存在' };

    // 3. 调微信支付退款 API
    const refundNo = 'RF' + Date.now();  // 商户退款单号
    const refundFen = Math.round(req.amount * 100);   // 退款金额（分）
    const totalFen  = Math.round(order.finalPrice * 100); // 原订单金额（分）

    const reqBody = JSON.stringify({
      out_trade_no: req.orderId,          // 商户订单号
      out_refund_no: refundNo,            // 商户退款单号（唯一）
      // 退款原因由用户自填，同样可能含 emoji，必须清洗（限 80 字符）
      reason: sanitizeWxText(req.reason, '商家同意退款').slice(0, 80),
      amount: {
        refund: refundFen,
        total: totalFen,
        currency: 'CNY',
      },
    });

    const urlPath = '/v3/refund/domestic/refunds';
    const auth = buildAuth('POST', urlPath, reqBody);

    const refundRes = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'Wechatpay-Serial': PUB_KEY_ID,
        'Accept': 'application/json',
      },
      body: reqBody,
    });

    const refundData = await refundRes.json();
    console.log('微信退款结果:', JSON.stringify(refundData));

    if (refundData.status === 'SUCCESS' || refundData.status === 'PROCESSING') {
      // 4. 退款成功：更新申请和订单状态
      await db.collection('refund_requests').doc(refundReqId).update({
        data: {
          status: 'approved',
          refundId: refundData.refund_id || '',
          wxRefundNo: refundNo,
          processTime: new Date(),
          updateTime: new Date(),
        }
      });
      await db.collection('orders').doc(req.orderId).update({
        data: { status: 'refunded', updateTime: new Date() }
      });
      return { code: 200, message: '退款已提交微信，预计5分钟内到账', data: refundData };
    } else if (refundData.code === 'INVALID_REQUEST' &&
               typeof refundData.message === 'string' &&
               refundData.message.includes('已全额退款')) {
      // 4.5 微信侧已全额退款（如商户平台手动退过 / 重复发起）：视为退款成功，同步状态
      await db.collection('refund_requests').doc(refundReqId).update({
        data: {
          status: 'approved',
          wxRefundNo: refundNo,
          wxError: refundData,
          note: '微信侧已全额退款，自动对齐状态',
          processTime: new Date(),
          updateTime: new Date(),
        }
      });
      await db.collection('orders').doc(req.orderId).update({
        data: { status: 'refunded', updateTime: new Date() }
      });
      return { code: 200, message: '该订单微信侧已全额退款，已同步状态', data: refundData };
    } else {
      // 5. 退款失败：记录错误信息
      await db.collection('refund_requests').doc(refundReqId).update({
        data: { status: 'failed', wxError: refundData, updateTime: new Date() }
      });
      return { code: 500, message: `退款失败：${refundData.message || refundData.code}` };
    }

  } catch (err) {
    console.error('executeRefund error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 管理后台：从微信支付查询订单真实状态并同步到DB =====
// 微信支付订单状态 → 我们的DB状态映射：
//   SUCCESS  → paid（已支付待发货，如果DB还是pending_payment说明回调没到）
//   REFUND   → refunded
//   NOTPAY   → pending_payment
//   CLOSED   → cancelled
// 微信"发货信息管理"里的物流状态（trade_state=SUCCESS + 有物流上报）→ 已完成流程由我们自己控制
async function queryOrderFromWx(event) {
  const { orderId } = event;
  if (!orderId) return { code: 400, message: '缺少订单号' };

  try {
    // 1. 调微信支付查单API（按商户订单号查询）
    const urlPath = `/v3/pay/transactions/out-trade-no/${orderId}?mchid=${MCH_ID}`;
    const auth = buildAuth('GET', urlPath, '');

    const wxRes = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
      method: 'GET',
      headers: {
        'Authorization': auth,
        'Wechatpay-Serial': PUB_KEY_ID,
        'Accept': 'application/json',
      },
    });

    const wxData = await wxRes.json();
    console.log('微信查单结果:', JSON.stringify(wxData));

    if (wxData.code && wxData.code !== 'SUCCESS') {
      // 微信返回错误（如订单不存在）
      return { code: 404, message: wxData.message || '微信侧订单不存在', wxData };
    }

    const tradeState = wxData.trade_state; // SUCCESS/REFUND/NOTPAY/CLOSED/REVOKED/USERPAYING/PAYERROR
    const transactionId = wxData.transaction_id || '';

    // 2. 读取我们DB里的订单
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order) return { code: 404, message: 'DB中订单不存在' };

    // 3. 根据微信状态决定是否需要同步DB
    // 微信状态 → DB目标状态映射
    const wxToDbStatus = {
      'SUCCESS':    'paid',        // 已支付（等待发货）
      'REFUND':     'refunded',    // 已退款
      'NOTPAY':     'pending_payment',
      'CLOSED':     'cancelled',
      'REVOKED':    'cancelled',
    };

    const targetStatus = wxToDbStatus[tradeState];
    const updates = {};

    // 微信侧已关单/已撤销，而 DB 还挂在待支付：必须走 order.adminCancel 走完整回滚
    // （库存 / SKU / 企业礼券）。⚠️ 曾经这里直接 update status，导致库存永久不退。
    if ((tradeState === 'CLOSED' || tradeState === 'REVOKED') && order.status === 'pending_payment') {
      let cancelRes = null;
      try {
        const r = await cloud.callFunction({
          name: 'order',
          data: { action: 'adminCancel', orderId, reason: 'wx_closed' }
        });
        cancelRes = r && r.result;
      } catch (e) {
        console.error('微信已关单但取消订单失败:', orderId, e.message);
        return { code: 500, message: '同步取消订单失败: ' + e.message };
      }
      return {
        code: 200,
        data: {
          wxTradeState: tradeState,
          wxTradeStateDesc: wxData.trade_state_desc || '',
          transactionId,
          dbStatusBefore: order.status,
          dbStatusAfter: (cancelRes && cancelRes.code === 200) ? 'cancelled' : order.status,
          synced: !!(cancelRes && cancelRes.code === 200),
          cancelResult: cancelRes,
          wxData,
        }
      };
    }

    if (targetStatus && order.status !== targetStatus) {
      // 特殊处理：微信是SUCCESS但我们DB已经是 shipped/completed，不要降级
      const noDowngrade = ['shipped', 'completed', 'refund_pending', 'refunded'];
      if (!noDowngrade.includes(order.status)) {
        updates.status = targetStatus;
        if (tradeState === 'SUCCESS' && transactionId && !order.transactionId) {
          updates.transactionId = transactionId;
          updates.paymentTime = new Date(wxData.success_time || Date.now());
          updates.needShipping = true;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updateTime = new Date();
      await db.collection('orders').doc(orderId).update({ data: updates });
      console.log(`订单 ${orderId} 状态已从 ${order.status} 同步为 ${updates.status || order.status}`);

      // 如果是首次从 pending_payment 同步到 paid，需要补齐 payNotify 应做的所有副作用
      // （因为回调可能失败，这里是兜底）
      if (order.status === 'pending_payment' && updates.status === 'paid') {
        try {
          await invokePayNotifyDirectly(order, transactionId);
        } catch (e) {
          console.error('补齐 payNotify 副作用失败:', e);
        }
      }
    }

    return {
      code: 200,
      data: {
        wxTradeState: tradeState,
        wxTradeStateDesc: wxData.trade_state_desc || '',
        transactionId,
        dbStatusBefore: order.status,
        dbStatusAfter: updates.status || order.status,
        synced: Object.keys(updates).length > 0,
        wxData,
      }
    };
  } catch (err) {
    console.error('queryOrderFromWx error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 关闭微信侧订单（管理端 / orderTimeout 定时任务专用）=====
// 用于订单超时取消前先关掉微信侧未支付单，防止用户在收银台里补付造成「已取消却收到钱」。
// ⚠️ 守门：小程序客户端调用必带 OPENID，此处非空直接 403。
// 微信 close 接口成功返回 204 空响应；ORDER_NOT_EXIST（用户从未拉起过支付）同样视为成功。
async function closeWxOrder(openid, event) {
  if (openid) return { code: 403, message: '仅限管理端调用' };
  const { orderId } = event;
  if (!orderId) return { code: 400, message: '缺少订单号' };

  try {
    const urlPath = `/v3/pay/transactions/out-trade-no/${orderId}/close`;
    const reqBody = JSON.stringify({ mchid: MCH_ID });
    const auth = buildAuth('POST', urlPath, reqBody);

    const wxRes = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'Wechatpay-Serial': PUB_KEY_ID,
        'Accept': 'application/json',
      },
      body: reqBody,
    });

    if (wxRes.status === 204) return { code: 200, message: '微信订单已关闭' };

    const text = await wxRes.text();
    let wxData = null;
    try { wxData = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 原样记日志 */ }

    // 从未在微信下过单 → 无需关闭，视为成功
    if (wxRes.status === 404 || (wxData && wxData.code === 'ORDER_NOT_EXIST')) {
      return { code: 200, message: '微信侧无此订单，无需关闭' };
    }
    console.error('关闭微信订单失败:', orderId, wxRes.status, text);
    return { code: 500, message: (wxData && wxData.message) || `关闭微信订单失败(${wxRes.status})`, wxData };
  } catch (err) {
    console.error('closeWxOrder error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 兜底：当 queryOrderFromWx 发现订单实际已支付但 DB 没同步时，调用 payNotify 完成副作用 =====
async function invokePayNotifyDirectly(order, transactionId) {
  // 通过云函数互调，复用 payNotify 的直接调用模式（resultCode=SUCCESS）
  await cloud.callFunction({
    name: 'payNotify',
    data: {
      resultCode: 'SUCCESS',
      outTradeNo: order._id,
      transactionId,
      openid: order.userId,
      forceSideEffects: true,  // 允许 payNotify 在订单已是 paid 时继续执行副作用
    }
  });
  console.log('已触发 payNotify 补齐:', order._id);
}

// ===== 充值预支付 =====
// 充值赠送积分规则（服务端唯一真源，不信前端）：满 ¥100 每 ¥1 送 1 积分，¥50 档无赠送
function calcRechargeBonusPoints(amount) {
  const a = Math.floor(Number(amount) || 0);
  return a >= 100 ? a : 0;
}

async function createRecharge(openid, event) {
  // 充值金额必须为正整数元；赠送积分服务端自算，忽略前端传入的任何 bonus，防止篡改
  const amount = Math.floor(Number(event.amount) || 0);
  if (!amount || amount <= 0) return { code: 400, message: '充值金额无效' };
  if (amount > 50000) return { code: 400, message: '单次充值金额过大' };
  const bonusPoints = calcRechargeBonusPoints(amount);

  try {
    // 生成充值订单号（R 前缀，payNotify 据此区分充值单）
    const rechargeId = 'R' + Date.now() + Math.floor(Math.random() * 1000);
    const totalFee = Math.round(amount * 100);

    // 写入充值记录。bonusPoints = 赠送积分（发到积分账户）；
    // 注意：余额只加充值本金 amount，赠送不再进余额（旧字段 bonus 会被 payNotify 当现金加进余额，已弃用）
    await db.collection('recharge_logs').add({
      data: {
        _id: rechargeId,
        userId: openid,
        amount,
        bonus: 0,            // 现金赠送恒为 0（送积分不送现金），避免 payNotify 把它加进余额
        bonusPoints,         // 赠送积分，payNotify 到账时发到积分账户
        status: 'pending',
        createTime: new Date(),
      }
    });

    const reqBody = JSON.stringify({
      appid: APPID,
      mchid: MCH_ID,
      description: `商城 - 余额充值 ¥${amount}`,
      out_trade_no: rechargeId,
      // 注意：微信云开发的支付回调是云函数调用，不是HTTP回调
      notify_url: 'https://your-env-id.ap-shanghai.app.example.com/payNotify',
      amount: { total: totalFee, currency: 'CNY' },
      payer: { openid },
    });

    const urlPath = '/v3/pay/transactions/jsapi';
    const auth = buildAuth('POST', urlPath, reqBody);

    const payRes = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'Wechatpay-Serial': PUB_KEY_ID,
        'Accept': 'application/json',
      },
      body: reqBody,
    });

    const payData = await payRes.json();
    if (!payData.prepay_id) {
      return { code: 500, message: payData.message || '获取支付参数失败' };
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const paySign = buildPaySign(APPID, timestamp, nonceStr, payData.prepay_id);

    return {
      code: 200,
      data: {
        timeStamp: timestamp,
        nonceStr,
        package: `prepay_id=${payData.prepay_id}`,
        signType: 'RSA',
        paySign,
        rechargeId,
        bonusPoints,   // 前端可据此提示"到账后送 X 积分"
      }
    };
  } catch (err) {
    console.error('createRecharge error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 余额明细：只返回当前用户自己的充值记录（按 OPENID 过滤，防越权）=====
async function getRechargeLogs(openid, event) {
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Number(event.pageSize) || 20);
  try {
    const res = await db.collection('recharge_logs')
      .where({ userId: openid })
      .orderBy('createTime', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
    const count = await db.collection('recharge_logs').where({ userId: openid }).count();
    return { code: 200, data: res.data, total: count.total };
  } catch (err) {
    console.error('getRechargeLogs error:', err);
    return { code: 500, message: err.message };
  }
}
