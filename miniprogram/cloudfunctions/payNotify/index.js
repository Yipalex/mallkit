// cloudfunctions/payNotify/index.js
// 微信支付 JSAPI v3 直连商户回调云函数
// 通过 CloudBase HTTP 触发器接收微信支付 POST 回调

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const crypto = require('crypto');

const API_V3_KEY = process.env.WX_API_V3_KEY;

// 解密微信支付回调的加密资源
function decryptResource(ciphertext, associatedData, nonce) {
  try {
    const key = Buffer.from(API_V3_KEY, 'utf8');
    const nonceBuffer = Buffer.from(nonce, 'utf8');
    const ciphertextBuffer = Buffer.from(ciphertext, 'base64');
    // 最后16字节是 authTag
    const authTag = ciphertextBuffer.slice(ciphertextBuffer.length - 16);
    const data = ciphertextBuffer.slice(0, ciphertextBuffer.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceBuffer);
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const decoded = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(decoded.toString('utf8'));
  } catch (err) {
    console.error('解密失败:', err.message);
    return null;
  }
}

exports.main = async (event, context) => {
  console.log('payNotify 被调用, event keys:', Object.keys(event));

  // ── HTTP 触发器模式（微信支付直连回调）──
  if (event.httpMethod) {
    return await handleHttpCallback(event);
  }

  // ── 旧的直接调用模式（兼容保留）──
  // forceSideEffects=true：用于 pay.queryOrder 已经把订单同步成 paid 但需补齐副作用的兜底场景
  const {
    resultCode,
    outTradeNo,
    transactionId,
    totalFee,
    openid,
    forceSideEffects = false,
  } = event;

  console.log('直接调用模式:', { resultCode, outTradeNo, transactionId, forceSideEffects });

  if (!outTradeNo) {
    return { code: 1, message: '缺少订单号' };
  }
  if (resultCode !== 'SUCCESS') {
    return { code: 0, message: 'ok' };
  }

  try {
    // 2. 充值单（R 前缀）单独处理
    if (outTradeNo.startsWith('R')) {
      return await handleRecharge(outTradeNo, transactionId);
    }

    // 3. 查询订单，确认状态（防止重复处理）
    const orderRes = await db.collection('orders').doc(outTradeNo).get();
    const order = orderRes.data;

    if (!order) {
      console.error('订单不存在:', outTradeNo);
      return { code: 0, message: 'ok' };
    }

    // 已处理过：默认幂等返回；但兜底补齐时(forceSideEffects)允许继续执行后续副作用
    if (order.status !== 'pending_payment' && !forceSideEffects) {
      console.log('订单已处理，忽略重复回调:', outTradeNo);
      return { code: 0, message: 'ok' };
    }

    // 只有还在待支付时才更新订单主状态
    if (order.status === 'pending_payment') {
      await db.collection('orders').doc(outTradeNo).update({
        data: {
          status: 'paid',
          transactionId,
          paymentTime: new Date(),
          updateTime: new Date(),
          needShipping: true,
        }
      });
      console.log('订单支付成功，状态已更新:', outTradeNo);
    }

    const isVoucher = order.orderType === 'voucher';

    // 券订单：结算券码（扣剩余额度/落定状态），跳过积分/佣金/清车
    if (isVoucher) {
      await settleVoucherOrder(order);
    } else {
      // 4. 如果订单有分销来源，记录佣金日志
      if (order.referrerId && order.referrerCommission > 0) {
        await recordCommission(order);
      }
      // 5. 更新用户积分（消费1元=1积分）
      await updateMemberPoints(order.userId, order.finalPrice);
    }

    // 6. 更新商品销量统计（券订单也计销量）
    for (const item of order.items) {
      await db.collection('products').doc(item.productId).update({
        data: { salesCount: _.inc(item.quantity) }
      });
    }

    // 7. 服务端清理购物车已结算商品（券订单不走购物车，跳过）
    if (!isVoucher) {
      await clearPurchasedItemsFromCart(order.userId, order.items);
    }

    // 8. 推送新订单到企业微信群（幂等，重复回调/兜底不会重复推）
    await pushOrderToWework(order);

    return { code: 0, message: 'ok' };

  } catch (err) {
    console.error('payNotify error:', err);
    // 即使处理出错，也要返回成功（否则微信会重复回调）
    // 可以配合监控系统发送告警
    return { code: 0, message: 'ok' };
  }
};

// ===== 充值成功处理 =====
async function handleRecharge(rechargeId, transactionId) {
  try {
    // 原子抢占余额入账：把 status 从 pending 条件更新为 success，
    // 只有 stats.updated>0（真正抢到的那次回调）才加余额。
    // 微信回调会重试、且本函数有 HTTP + 直接调用两条路径，"先读后判"防不住并发双花，必须条件更新。
    const claim = await db.collection('recharge_logs')
      .where({ _id: rechargeId, status: 'pending' })
      .update({ data: { status: 'success', transactionId, paidAt: new Date() } });

    const logRes = await db.collection('recharge_logs').doc(rechargeId).get();
    const log = logRes.data;
    if (!log) return { code: 0, message: 'ok' };

    // 余额只加充值本金；赠送改为发积分（送积分不送现金）。
    // 兼容旧数据：老记录只有 bonus(现金赠送) 没有 bonusPoints，仍按旧逻辑把 bonus 计入余额。
    const cashCredit = log.amount + (log.bonus || 0);
    const bonusPoints = Number(log.bonusPoints) || 0;

    // 只有抢到入账权的回调加余额（并发/重试的其余回调 updated=0，直接跳过）
    if (claim.stats && claim.stats.updated > 0) {
      await db.collection('users').doc(log.userId).update({
        data: { balance: _.inc(cashCredit), updateTime: new Date() }
      });
    }

    // 赠送积分：独立的原子抢占标记 bonusPointsGranted，与余额解耦。
    // 好处：① 只发一次；② 即使发积分这步失败，回滚标记后后续重试回调仍能补发（不会因 status 已 success 而永久漏发）。
    if (bonusPoints > 0) {
      const ptClaim = await db.collection('recharge_logs')
        .where({ _id: rechargeId, bonusPointsGranted: _.neq(true) })
        .update({ data: { bonusPointsGranted: true } });
      if (ptClaim.stats && ptClaim.stats.updated > 0) {
        try {
          const uRes = await db.collection('users').doc(log.userId).get();
          const newPoints = (uRes.data?.memberLevel?.points || 0) + bonusPoints;
          await db.collection('users').doc(log.userId).update({
            data: { 'memberLevel.points': _.inc(bonusPoints) }
          });
          await db.collection('point_logs').add({
            data: {
              userId: log.userId,
              type: 'recharge',
              points: bonusPoints,
              description: `充值 ¥${log.amount} 赠送`,
              balance: newPoints,
              createdAt: new Date(),
            }
          });
        } catch (ptErr) {
          // 发放失败：回滚标记，让后续回调可重试补发
          await db.collection('recharge_logs').doc(rechargeId)
            .update({ data: { bonusPointsGranted: false } }).catch(() => {});
          console.error('充值赠送积分发放失败，已回滚标记待重试:', ptErr.message);
        }
      }
    }

    console.log('充值回调处理:', rechargeId, '本次是否入账:', !!(claim.stats && claim.stats.updated > 0));
    return { code: 0, message: 'ok' };
  } catch (err) {
    console.error('handleRecharge error:', err);
    return { code: 0, message: 'ok' };
  }
}

// ===== 记录分销佣金 =====
async function recordCommission(order) {
  try {
    // 写入佣金日志
    await db.collection('commission_logs').add({
      data: {
        distributorId: order.referrerId,
        orderId: order._id,
        orderAmount: order.finalPrice,
        commissionAmount: order.referrerCommission,
        status: 'pending',    // 待结算（订单完成后7天自动结算）
        calculatedAt: new Date(),
        // 结算时间：7天后
        settleTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        level: 1,
      }
    });

    // 更新分销员的待结算金额
    await db.collection('distributors').where({ userId: order.referrerId }).update({
      data: {
        'withdrawal.pendingAmount': _.inc(order.referrerCommission),
        'stats.totalSalesAmount': _.inc(order.finalPrice),
        lastActivityTime: new Date(),
      }
    });

    console.log('佣金记录成功:', order.referrerId, order.referrerCommission);
  } catch (err) {
    console.error('recordCommission error:', err);
    // 佣金记录失败不影响主流程，但需要告警
  }
}

// ===== 更新用户积分（不用事务，避免 CloudBase 基础版兼容问题）=====
async function updateMemberPoints(userId, orderAmount) {
  try {
    const userRes = await db.collection('users').doc(userId).get();
    const user = userRes.data;

    if (!user) {
      console.error('用户不存在:', userId);
      return;
    }

    const level = user.memberLevel?.level || 0;
    const multipliers = [1, 2, 3, 5];  // 普通/银牌/金牌/钻石 积分倍率
    const addedPoints = Math.floor(orderAmount) * multipliers[level];
    const currentPoints = (user.memberLevel?.points || 0) + addedPoints;  // 仅用于判定升级/流水快照
    const upgradeTo = checkLevelUpgrade(level, currentPoints);

    // 积分用 _.inc 增量写，不用整读整写——否则与充值赠送积分等并发写会互相覆盖丢分
    await db.collection('users').doc(userId).update({
      data: {
        'memberLevel.points': _.inc(addedPoints),
        'memberLevel.level': upgradeTo,
        'memberLevel.discount': [1, 0.95, 0.90, 0.85][upgradeTo],
        'memberLevel.joinDate': user.memberLevel?.joinDate || new Date(),
        updateTime: new Date(),
      }
    });

    await db.collection('point_logs').add({
      data: {
        userId,
        type: 'purchase',
        points: addedPoints,
        description: '消费获得积分',
        balance: currentPoints,
        createdAt: new Date(),
      }
    });

    if (upgradeTo > level) {
      const levelNames = ['普通用户', '银牌会员', '金牌会员', '钻石会员'];
      console.log(`用户 ${userId} 升级为 ${levelNames[upgradeTo]}`);
    }
  } catch (err) {
    console.error('updateMemberPoints error:', err);
  }
}

// ── HTTP 触发器处理函数（微信支付 v3 回调）──
async function handleHttpCallback(event) {
  // 必须返回标准 HTTP 响应格式
  const okResp = {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'SUCCESS', message: '成功' }),
  };
  const failResp = (msg) => ({
    statusCode: 200, // 仍返回200，body里标记失败，让微信停止重试
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'FAIL', message: msg }),
  });

  try {
    // CloudBase HTTP 触发器可能对 body 做 Base64 编码，需先解码
    let rawBody = event.body;
    if (event.isBase64Encoded && typeof rawBody === 'string') {
      rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
    }
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    console.log('HTTP回调 body:', JSON.stringify(body));

    const { resource, event_type } = body;
    if (event_type !== 'TRANSACTION.SUCCESS') {
      console.log('非支付成功事件，忽略:', event_type);
      return okResp;
    }

    // 解密资源
    const transaction = decryptResource(
      resource.ciphertext,
      resource.associated_data,
      resource.nonce
    );
    if (!transaction) return failResp('解密失败');

    console.log('解密后交易数据:', JSON.stringify(transaction));

    const outTradeNo   = transaction.out_trade_no;
    const transactionId = transaction.transaction_id;
    const tradeState   = transaction.trade_state;

    if (tradeState !== 'SUCCESS') {
      console.warn('交易状态非SUCCESS:', tradeState);
      return okResp;
    }

    if (!outTradeNo) return failResp('缺少订单号');

    // 充值单（R 前缀）
    if (outTradeNo.startsWith('R')) {
      await handleRecharge(outTradeNo, transactionId);
      return okResp;
    }

    // 普通订单
    const orderRes = await db.collection('orders').doc(outTradeNo).get();
    const order = orderRes.data;
    if (!order) { console.error('订单不存在:', outTradeNo); return okResp; }
    if (order.status !== 'pending_payment') {
      console.log('重复回调，忽略:', outTradeNo);
      return okResp;
    }

    await db.collection('orders').doc(outTradeNo).update({
      data: {
        status: 'paid',
        transactionId,
        paymentTime: new Date(),
        updateTime: new Date(),
        needShipping: true,
      }
    });
    console.log('订单状态已更新为paid:', outTradeNo);

    const isVoucher = order.orderType === 'voucher';
    if (isVoucher) {
      // 券订单：结算券码，跳过积分/佣金/清车
      await settleVoucherOrder(order);
    } else {
      if (order.referrerId && order.referrerCommission > 0) {
        await recordCommission(order);
      }
      await updateMemberPoints(order.userId, order.finalPrice);
    }
    for (const item of order.items) {
      await db.collection('products').doc(item.productId).update({
        data: { salesCount: _.inc(item.quantity) }
      });
    }

    // 服务端清空购物车里已结算的商品（前端 wx.requestPayment.success 可能因网络/超时未触发）
    if (!isVoucher) {
      await clearPurchasedItemsFromCart(order.userId, order.items);
    }

    // 推送新订单到企业微信群（便于店主第一时间知晓、转发供应商）
    await pushOrderToWework(order);

    return okResp;
  } catch (err) {
    console.error('handleHttpCallback error:', err);
    return okResp; // 仍返回成功，避免微信无限重试
  }
}

// ===== 支付成功后从购物车移除已结算的商品 =====
// 只清掉本次购买的，不动用户其他还没结算的商品
async function clearPurchasedItemsFromCart(userId, orderItems) {
  try {
    if (!userId || !Array.isArray(orderItems) || orderItems.length === 0) return;
    let cartRes;
    try {
      cartRes = await db.collection('carts').where({ userId }).get();
    } catch (e) {
      // carts 集合不存在视为购物车为空，直接退出
      if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || e.message || ''))) return;
      throw e;
    }
    if (!cartRes.data || cartRes.data.length === 0) return;

    const cart = cartRes.data[0];
    // 按 productId+skuId 精确匹配：只删买掉的那个规格，
    // 原来只按 productId 匹配，会把同商品用户没买的其他规格也误删
    const key = (i) => `${i.productId}|${i.skuId || ''}`;
    const purchasedKeys = new Set(orderItems.map(key));
    const remaining = (cart.items || []).filter(i => !purchasedKeys.has(key(i)));

    await db.collection('carts').doc(cart._id).update({
      data: { items: remaining, updateTime: new Date() }
    });
    console.log('购物车已清理已购买商品，剩余:', remaining.length);
  } catch (err) {
    console.error('clearPurchasedItemsFromCart error:', err);
  }
}

// ===== 新订单推送到企业微信群机器人 =====
// 客户付款成功后，把订单信息推到店主的企业微信群，便于第一时间知晓并复制转发给供应商。
// webhook 地址放环境变量 WEWORK_WEBHOOK_URL（不硬编码）。推送失败绝不影响主流程。
async function pushOrderToWework(order) {
  try {
    const url = process.env.WEWORK_WEBHOOK_URL;
    if (!url) {
      console.warn('未配置 WEWORK_WEBHOOK_URL，跳过下单推送');
      return;
    }

    // 幂等：HTTP 回调可能被微信重试、pay.queryOrder 也可能兜底再调，
    // 用订单上的 weworkNotified 标记抢占，保证同一订单只推一次。
    // 条件更新（where weworkNotified != true）+ 检查 updated 数，避免并发重复。
    const claim = await db.collection('orders')
      .where({ _id: order._id, weworkNotified: _.neq(true) })
      .update({ data: { weworkNotified: true } });
    if (!claim.stats || claim.stats.updated === 0) {
      console.log('订单已推送过，跳过:', order._id);
      return;
    }

    const addr = order.shippingAddress || {};
    const itemsText = (order.items || [])
      .map(it => `  · ${it.productName || it.name} ×${it.quantity}（${it.unit || ''}）`)
      .join('\n');
    const payTime = new Date(Date.now() + 8 * 3600 * 1000) // 北京时间
      .toISOString().replace('T', ' ').slice(0, 19);

    const content = [
      `🛒 新订单 ${order._id}`,
      `下单时间：${payTime}`,
      `收货人：${addr.name || ''}　${addr.phone || ''}`,
      // 自提单没有省市区，直接标注到店自提，避免推空地址行
      order.shippingMethod === 'pickup' || !addr.province
        ? '配送方式：到店自提'
        : `地址：${addr.province}${addr.city || ''}${addr.district || ''}${addr.detail || ''}`,
      `商品：\n${itemsText}`,
      `实付：¥${order.finalPrice ?? ''}`,
      order.remark ? `备注：${order.remark}` : '',
    ].filter(Boolean).join('\n');

    // wx-server-sdk 运行环境支持全局 fetch（Node 18+）；兜底用 https。
    const payload = JSON.stringify({ msgtype: 'text', text: { content } });
    if (typeof fetch === 'function') {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    } else {
      await new Promise((resolve) => {
        const https = require('https');
        const req = https.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
        req.on('error', (e) => { console.error('wework push error:', e.message); resolve(); });
        req.write(payload);
        req.end();
      });
    }
    console.log('已推送新订单到企业微信:', order._id);
  } catch (err) {
    console.error('pushOrderToWework error:', err.message);
    // 推送失败不影响支付主流程
  }
}

// ===== 企业礼券：支付成功后结算券码 =====
// 混合支付（省外运费）付完后调用；充值卡型扣剩余额度并落定状态，商品型直接置 used。
// 幂等：条件 status:'locked' + lockedBy:order.userId，只有真正锁定中的券会被结算。
async function settleVoucherOrder(order) {
  try {
    const code = order.voucherCode;
    const amount = Math.round((Number(order.enterprisePaidAmount) || 0) * 100) / 100;
    if (!code) return;

    const res = await db.collection('voucher_codes')
      .where({ code, status: 'locked', lockedBy: order.userId }).limit(1).get();
    const vc = res.data[0];
    if (!vc) { console.log('券已结算或未锁定，跳过:', code); return; }

    // 取批次判断券型与单单限制
    const batchRes = await db.collection('voucher_batches').doc(vc.batchId).get().catch(() => null);
    const batch = batchRes && batchRes.data;
    const isProduct = batch ? batch.type === 'product' : (vc.type === 'product');
    const single = (batch && !!batch.singleOrderOnly) || isProduct;

    const newRemaining = isProduct ? vc.remaining : Math.round((vc.remaining - amount) * 100) / 100;
    const finalStatus = (single || Math.round(newRemaining * 100) <= 0) ? 'used' : 'partially_used';

    await db.collection('voucher_codes').doc(vc._id).update({
      data: {
        remaining: newRemaining,
        status: finalStatus,
        firstUsedBy: vc.firstUsedBy || order.userId,
        lockedBy: null, lockExpireAt: null, lockedAmount: 0,
        usageLogs: _.push([{ orderId: order._id, amount, time: new Date() }]),
        updateTime: new Date(),
      }
    });
    await db.collection('voucher_batches').doc(vc.batchId).update({
      data: {
        'stats.used': _.inc(finalStatus === 'used' ? 1 : 0),
        'stats.consumedAmount': _.inc(amount),
        updateTime: new Date(),
      }
    }).catch(() => {});
    console.log('券码已结算:', code, '→', finalStatus);
  } catch (e) {
    console.error('settleVoucherOrder error:', e.message);
  }
}

// 检查是否满足升级条件
function checkLevelUpgrade(currentLevel, points) {
  const thresholds = [5000, 15000, 30000];  // 升到银牌/金牌/钻石所需积分
  let newLevel = currentLevel;

  for (let i = currentLevel; i < 3; i++) {
    if (points >= thresholds[i]) {
      newLevel = i + 1;
    } else {
      break;
    }
  }
  return newLevel;
}
