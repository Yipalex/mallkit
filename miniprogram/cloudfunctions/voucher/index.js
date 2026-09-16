// cloudfunctions/voucher/index.js
// 企业礼券：扫码校验券码 + 免付货款下单（货款从企业余额原子扣减，用完即止）。
//
// 三种券型（voucher_batches.type）：
//   store_card   全店充值卡：面额封顶、可多次消费直到额度用完
//   scoped_card  指定商品范围卡：同上，但只能买 allowedProductIds 内的商品，可限一码一单
//   product      商品券：绑定 productId(+skuId)+quantity，一码一单，扫码直达
//
// 一致性顺序：先原子锁码 → 事务(扣企业余额+扣库存+建单) → 失败回滚锁。
// 运费=0：订单直接 paid，并调 payNotify(内部模式) 完成副作用子集 + 券结算。
// 运费>0：订单 pending_payment，用户走微信支付付运费；券结算/副作用在 payNotify 里做。
//
// 运费规则、价格重算、事务扣库存逻辑与 order/index.js createOrder 保持一致（云函数间无法共享代码，此处为对齐副本）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const LOCK_TTL_MS = 15 * 60 * 1000; // 锁定/待支付有效期，与订单 paymentExpireTime 对齐

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function cents(n) { return Math.round((Number(n) || 0) * 100); }

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();
  switch (action) {
    case 'query':       return await queryVoucher(event.code, OPENID);
    case 'createOrder': return await createVoucherOrder(OPENID, event);
    default: return { code: 400, message: '未知操作' };
  }
};

// ============ 券码 + 批次 + 企业 联合读取 + 惰性过期/解锁 ============
async function loadVoucherContext(code) {
  if (!code) return { err: '缺少券码' };
  const codeRes = await db.collection('voucher_codes').where({ code }).limit(1).get();
  const vc = codeRes.data[0];
  if (!vc) return { err: '券码无效' };

  const batchRes = await db.collection('voucher_batches').doc(vc.batchId).get().catch(() => null);
  const batch = batchRes && batchRes.data;
  if (!batch) return { err: '券批次不存在' };

  const entRes = await db.collection('enterprises').doc(vc.enterpriseId).get().catch(() => null);
  const ent = entRes && entRes.data;
  if (!ent) return { err: '企业账户不存在' };

  // 惰性解锁：锁已超时则释放（对应订单如仍待支付，让其自然过期，不在此强改订单）
  if (vc.status === 'locked' && vc.lockExpireAt && new Date(vc.lockExpireAt) < new Date()) {
    await db.collection('voucher_codes').doc(vc._id).update({
      data: { status: vc._prevStatus || 'unused', lockedBy: null, lockExpireAt: null, lockedAmount: 0, updateTime: new Date() }
    }).catch(() => {});
    vc.status = vc._prevStatus || 'unused';
    vc.lockedBy = null;
  }
  return { vc, batch, ent };
}

// 校验券可用性（不含并发锁），返回 {ok} 或 {err}
function checkUsable(vc, batch, ent) {
  if (vc.status === 'disabled') return { err: '券码已作废' };
  if (vc.status === 'used') return { err: '券码已使用完毕' };
  if (vc.status === 'expired') return { err: '券码已过期' };
  if (vc.status === 'locked') return { err: '券码正在被使用，请稍后再试' };
  if (batch.status === 'disabled') return { err: '该批次券已停用' };

  const now = new Date();
  if (batch.validFrom && new Date(batch.validFrom) > now) return { err: '券尚未生效' };
  if (batch.expireAt && new Date(batch.expireAt) < now) return { err: '券码已过期' };
  if (ent.status === 'disabled') return { err: '企业账户已停用' };
  if (round2(ent.balance) <= 0) return { err: '企业余额已用尽，券暂不可用' };
  return { ok: true };
}

// ============ query：扫码后展示券信息 + 可购商品 ============
async function queryVoucher(code, openid) {
  const ctx = await loadVoucherContext(code);
  if (ctx.err) return { code: 400, message: ctx.err };
  const { vc, batch, ent } = ctx;

  const usable = checkUsable(vc, batch, ent);

  // 首次使用绑定校验：充值卡型券一旦被某人首用，后续限同人使用（防截图外流被多人抢）
  if (usable.ok && vc.firstUsedBy && vc.firstUsedBy !== openid) {
    return { code: 400, message: '该券已被其他微信账号绑定使用' };
  }

  const info = {
    code: vc.code,
    type: batch.type,
    status: vc.status,
    faceValue: vc.faceValue,
    remaining: batch.type === 'product' ? null : round2(vc.remaining),
    enterpriseName: ent.name,
    batchName: batch.name,
    expireAt: batch.expireAt || null,
    singleOrderOnly: !!batch.singleOrderOnly,
    usable: !!usable.ok,
    unusableReason: usable.ok ? null : usable.err,
  };

  // 附带可购商品
  if (batch.type === 'product') {
    const pRes = await db.collection('products').doc(batch.productId).get().catch(() => null);
    const p = pRes && pRes.data;
    if (!p || p.isActive === false) return { code: 400, message: '绑定商品已下架' };
    let sku = null;
    if (batch.skuId && Array.isArray(p.skus)) {
      sku = p.skus.find(s => s.skuId === batch.skuId) || null;
    }
    info.product = {
      productId: p._id,
      name: p.name,
      image: (sku && sku.image) || p.mainImage,
      unit: (sku && sku.unit) || p.unit || 'kg',
      quantity: batch.quantity || 1,
      skuId: batch.skuId || null,
      skuName: sku ? sku.specText : null,
      price: sku ? Number(sku.price) : Number(p.basePrice),
    };
  } else {
    // 充值卡型：返回可购商品列表（全店 or 指定范围）
    let query = { isActive: true };
    if (batch.type === 'scoped_card') {
      const ids = batch.allowedProductIds || [];
      if (ids.length === 0) return { code: 400, message: '该券未配置可购商品' };
      query = { _id: _.in(ids), isActive: true };
    }
    const prods = await db.collection('products').where(query)
      .field({ name: true, mainImage: true, basePrice: true, unit: true, hasSku: true, skus: true, stock: true })
      .limit(200).get();
    info.products = (prods.data || []).map(p => ({
      productId: p._id, name: p.name, image: p.mainImage,
      price: Number(p.basePrice), unit: p.unit || 'kg',
      hasSku: !!p.hasSku, stock: p.stock,
      skus: (p.hasSku && Array.isArray(p.skus))
        ? p.skus.filter(s => s.isActive !== false).map(s => ({ skuId: s.skuId, specText: s.specText, price: Number(s.price), stock: s.stock, image: s.image }))
        : [],
    }));
  }

  return { code: 200, data: info };
}

// ============ createOrder：免付货款下单 ============
async function createVoucherOrder(openid, event) {
  const { code, address, remark } = event;
  const ctx = await loadVoucherContext(code);
  if (ctx.err) return { code: 400, message: ctx.err };
  const { vc, batch, ent } = ctx;

  const usable = checkUsable(vc, batch, ent);
  if (!usable.ok) return { code: 400, message: usable.err };
  if (vc.firstUsedBy && vc.firstUsedBy !== openid) {
    return { code: 400, message: '该券已被其他微信账号绑定使用' };
  }
  if (!address || !address.province) return { code: 400, message: '请填写收货地址' };

  // ---- 1. 服务端确定 items（按券型），价格从 products 重算，不信前端价 ----
  let reqItems;
  if (batch.type === 'product') {
    reqItems = [{ productId: batch.productId, skuId: batch.skuId || null, quantity: batch.quantity || 1 }];
  } else {
    reqItems = Array.isArray(event.items) ? event.items : [];
    if (reqItems.length === 0) return { code: 400, message: '请选择商品' };
    // 指定范围卡：所有商品必须在允许清单内
    if (batch.type === 'scoped_card') {
      const allow = new Set(batch.allowedProductIds || []);
      if (reqItems.some(it => !allow.has(it.productId))) {
        return { code: 400, message: '包含不在券可购范围内的商品' };
      }
    }
  }

  const productIds = [...new Set(reqItems.map(i => i.productId))];
  const productsRes = await db.collection('products').where({ _id: _.in(productIds), isActive: true }).get();
  const products = productsRes.data;
  if (products.length !== productIds.length) return { code: 400, message: '部分商品已下架' };

  const orderItems = [];
  let subtotal = 0;
  for (const cartItem of reqItems) {
    if (!Number.isInteger(cartItem.quantity) || cartItem.quantity <= 0) return { code: 400, message: '商品数量必须为正整数' };
    if (cartItem.quantity > 999) return { code: 400, message: '单商品数量不能超过999' };
    const product = products.find(p => p._id === cartItem.productId);

    if (product.hasSku && Array.isArray(product.skus) && product.skus.length) {
      if (!cartItem.skuId) return { code: 400, message: `${product.name} 请选择规格` };
      const skuIdx = product.skus.findIndex(s => s.skuId === cartItem.skuId);
      const sku = skuIdx >= 0 ? product.skus[skuIdx] : null;
      if (!sku || sku.isActive === false) return { code: 400, message: `${product.name} 规格已失效` };
      if (Number(sku.stock) < cartItem.quantity) return { code: 400, message: `${product.name}（${sku.specText}）库存不足` };
      const unitPrice = Number(sku.price);
      const itemTotal = unitPrice * cartItem.quantity;
      subtotal += itemTotal;
      orderItems.push({
        productId: product._id, productName: product.name,
        image: sku.image || product.mainImage, quantity: cartItem.quantity,
        unitPrice, totalPrice: round2(itemTotal), unit: sku.unit || product.unit || 'kg',
        skuId: sku.skuId, skuName: sku.specText, _skuIdx: skuIdx,
      });
    } else {
      if (Number(product.stock) < cartItem.quantity) return { code: 400, message: `${product.name} 库存不足` };
      const unitPrice = Number(product.basePrice);
      const itemTotal = unitPrice * cartItem.quantity;
      subtotal += itemTotal;
      orderItems.push({
        productId: product._id, productName: product.name,
        image: product.mainImage, quantity: cartItem.quantity,
        unitPrice, totalPrice: round2(itemTotal), unit: product.unit || 'kg',
      });
    }
  }
  subtotal = round2(subtotal);

  // ---- 2. 运费（与 order createOrder 同规则：指定区域包邮，区域外自付）----
  const shippingFee = await calcShippingFee(address);
  if (shippingFee === false) return { code: 400, message: `暂不支持配送至${address.province}` };

  // ---- 3. 货款校验（充值卡型不得超剩余额度）----
  const goodsAmount = subtotal; // 货款=商品小计，由企业余额承担
  if (batch.type !== 'product') {
    if (cents(goodsAmount) > cents(vc.remaining)) {
      return { code: 400, message: `券余额不足（剩余 ¥${round2(vc.remaining)}，需 ¥${goodsAmount}）` };
    }
  }
  if (cents(goodsAmount) > cents(ent.balance)) {
    return { code: 400, message: '企业余额不足，券暂不可用' };
  }

  // ---- 4. 原子锁码（防并发双花）----
  const now = new Date();
  const lockExpireAt = new Date(Date.now() + LOCK_TTL_MS);
  const prevStatus = vc.status; // unused | partially_used
  const lockWhere = { code, status: prevStatus, lockedBy: null };
  if (batch.type !== 'product') lockWhere.remaining = _.gte(goodsAmount);
  const lockRes = await db.collection('voucher_codes').where(lockWhere).update({
    data: { status: 'locked', _prevStatus: prevStatus, lockedBy: openid, lockedAmount: goodsAmount, lockExpireAt, updateTime: now }
  });
  if (!lockRes.stats || lockRes.stats.updated === 0) {
    return { code: 409, message: '券码正在被使用或余额不足，请稍后重试' };
  }

  // ---- 5. 事务：扣企业余额 + 扣库存 + 建单 ----
  const orderId = 'O' + Date.now() + Math.floor(Math.random() * 1000);
  const orderItemsToSave = orderItems.map(({ _skuIdx, ...rest }) => rest);
  const needShippingPay = cents(shippingFee) > 0; // 是否需用户付运费
  const finalPrice = needShippingPay ? round2(shippingFee) : 0; // 用户实付（=运费或 0）

  try {
    await db.runTransaction(async transaction => {
      // 5.1 企业余额：条件式原子扣减（事务内再校验，防并发把余额扣成负）
      const entDoc = (await transaction.collection('enterprises').doc(ent._id).get()).data;
      if (!entDoc || round2(entDoc.balance) < goodsAmount) throw new Error('企业余额不足');
      await transaction.collection('enterprises').doc(ent._id).update({
        data: { balance: _.inc(-goodsAmount), updateTime: now }
      });

      // 5.2 扣库存
      for (const item of orderItems) {
        const cur = (await transaction.collection('products').doc(item.productId).get()).data;
        if (!cur) throw new Error(`${item.productName} 已下架`);
        if (item.skuId != null && item._skuIdx >= 0) {
          const sku = (cur.skus || [])[item._skuIdx];
          if (!sku || sku.skuId !== item.skuId || sku.isActive === false) throw new Error(`${item.productName} 规格已失效`);
          if (Number(sku.stock) < item.quantity) throw new Error(`${item.productName}（${item.skuName}）库存不足`);
          await transaction.collection('products').doc(item.productId).update({
            data: { [`skus.${item._skuIdx}.stock`]: _.inc(-item.quantity), stock: _.inc(-item.quantity) }
          });
        } else {
          if (Number(cur.stock) < item.quantity) throw new Error(`${item.productName} 库存不足`);
          await transaction.collection('products').doc(item.productId).update({
            data: { stock: _.inc(-item.quantity) }
          });
        }
      }

      // 5.3 写订单（券订单标记；finalPrice=运费，兼容 pay 云函数金额校验）
      await transaction.collection('orders').add({
        data: {
          _id: orderId,
          userId: openid,
          items: orderItemsToSave,
          subtotal,
          discountAmount: 0,
          userCouponDiscount: 0,
          shippingFee,
          finalPrice,
          // 企业礼券专属字段
          orderType: 'voucher',
          voucherCode: code,
          voucherBatchId: batch._id,
          enterpriseId: ent._id,
          enterprisePaidAmount: goodsAmount,
          // 券订单不参与分销
          referrerId: null,
          referrerCommission: 0,
          commissionStatus: null,
          status: needShippingPay ? 'pending_payment' : 'paid',
          shippingAddress: address,
          remark: remark || '',
          ...(needShippingPay
            ? { paymentExpireTime: new Date(Date.now() + LOCK_TTL_MS) }
            : { paymentTime: now, needShipping: true }),
          createTime: now,
          updateTime: now,
        }
      });
    });
  } catch (txErr) {
    // 事务失败 → 回滚锁（企业余额/库存由事务自身回滚）
    console.error('券下单事务失败:', txErr.message);
    await db.collection('voucher_codes').where({ code, status: 'locked', lockedBy: openid }).update({
      data: { status: prevStatus, lockedBy: null, lockExpireAt: null, lockedAmount: 0, updateTime: new Date() }
    }).catch(() => {});
    return { code: 400, message: txErr.message || '下单失败，请重试' };
  }

  // ---- 6. 写企业消费流水（事务外，失败不影响主流程）----
  await db.collection('enterprise_logs').add({
    data: {
      enterpriseId: ent._id, type: 'consume', amount: -goodsAmount,
      balanceAfter: round2(ent.balance - goodsAmount),
      orderId, voucherCode: code, remark: `礼券消费 ${batch.name}`, createTime: now,
    }
  }).catch(e => console.warn('写企业流水失败:', e.message));

  // ---- 7. 免运费：订单已 paid，调 payNotify 统一完成券结算 + 副作用子集 ----
  //   payNotify 对券订单会：结算券码(settleVoucherOrder) + 计销量 + 群推送，跳过积分/佣金/清车。
  //   券结算幂等（条件 status:'locked'），此处券当前正处 locked，会被正常结算。
  if (!needShippingPay) {
    try {
      await cloud.callFunction({
        name: 'payNotify',
        data: { resultCode: 'SUCCESS', outTradeNo: orderId, transactionId: 'VOUCHER_FREESHIP', forceSideEffects: true },
      });
    } catch (e) {
      // payNotify 调用失败：券仍处 locked，靠 lockExpireAt 惰性回收；订单已 paid 需人工关注
      console.error('券订单 payNotify 调用失败，券未结算(将惰性回收):', e.message);
    }
  }

  return {
    code: 200,
    data: {
      orderId, finalPrice,
      needPay: needShippingPay,          // true=还需微信付运费
      shippingFee, goodsAmount,
    }
  };
}

// 运费计算（对齐 order/index.js createOrder 第 232-251 行；返回 false 表示不可达）
async function calcShippingFee(address) {
  if (!address || !address.province) return 0;
  try {
    const settingsRes = await db.collection('settings').doc('store').get();
    const rules = settingsRes.data?.shippingRules || defaultShippingRules();
    const matched = rules.find(r => r.provinces.some(p => address.province.includes(p)));
    if (matched?.blocked) return false;
    return matched ? matched.fee : 15;
  } catch (e) {
    const rules = defaultShippingRules();
    const matched = rules.find(r => r.provinces.some(p => address.province.includes(p)));
    if (matched?.blocked) return false;
    return matched ? matched.fee : 15;
  }
}
function defaultShippingRules() {
  return [
    // 默认运费：请在后台「店铺设置」按你的发货地改。
    { provinces: ['香港','澳门','台湾'], fee: 0, blocked: true },
    { provinces: [''], fee: 10, blocked: false },
  ];
}
