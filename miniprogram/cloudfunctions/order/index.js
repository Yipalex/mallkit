// cloudfunctions/order/index.js
// 订单相关云函数：创建订单、查询订单、验证优惠码、更新状态

const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { checkRateLimit } = require('./utils/rateLimiter');

const WX_APPID = 'touristappid';

function httpsPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch (e) { reject(new Error('微信API响应非JSON: ' + chunks)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch (e) { reject(new Error('微信API响应非JSON: ' + chunks)); }
      });
    }).on('error', reject);
  });
}

async function getAccessToken() {
  const cacheRes = await db.collection('system_config').doc('wx_access_token').get().catch(() => null);
  const now = Date.now();
  if (cacheRes && cacheRes.data && cacheRes.data.expiresAt > now + 60000) {
    return cacheRes.data.token;
  }
  const secret = process.env.WX_APPSECRET;
  if (!secret) throw new Error('未配置环境变量 WX_APPSECRET');
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${secret}`;
  const res = await httpsGetJson(url);
  if (!res.access_token) throw new Error(`获取access_token失败: errcode=${res.errcode} errmsg=${res.errmsg}`);
  const expiresAt = now + (res.expires_in - 300) * 1000;
  await db.collection('system_config').doc('wx_access_token').set({
    data: { token: res.access_token, expiresAt, updatedAt: now }
  }).catch(async () => {
    await db.collection('system_config').add({ data: { _id: 'wx_access_token', token: res.access_token, expiresAt, updatedAt: now } });
  });
  return res.access_token;
}

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  // 对创建订单操作应用频率限制：1分钟内最多5次
  if (action === 'create') {
    const limitResult = await checkRateLimit(OPENID, 'createOrder', {
      maxRequests: 5,
      windowSeconds: 60
    });
    if (!limitResult.allowed) {
      return {
        code: 429,
        message: `创建订单过于频繁，请${limitResult.retryAfter}秒后再试`
      };
    }
  }

  switch (action) {
    case 'create':         return await createOrder(OPENID, event);
    case 'list':           return await listOrders(OPENID, event);
    case 'getDetail':      return await getOrderDetail(event.orderId);
    case 'validateCoupon': return await validateCoupon(OPENID, event);
    case 'updateStatus':   return await updateStatus(OPENID, event.orderId, event.status);
    case 'cancelOrder':    return await cancelOrder(OPENID, event.orderId);
    case 'adminCancel':    return await adminCancelOrder(OPENID, event);
    case 'shipOrder':        return await shipOrder(event.orderId, event.expressCompany, event.expressNo, event.shippingMethod);
    case 'uploadShipping':   return await uploadShipping(event);
    case 'getWaybillToken':  return await getWaybillToken(OPENID, event.orderId);
    case 'adminListOrders':  return await adminListOrders(event);
    default: return { code: 400, message: '未知操作' };
  }
};

// 秒杀有效价（服务端为准，不信前端价）：
// 仅单规格商品生效；须 active + 未过 endTime + 价格 >0 且低于原价，任一不满足回退原价。
// 与 product 云函数 getSeckill 的展示口径保持一致。
function getEffectiveSeckillPrice(product) {
  const sk = product.seckill;
  if (!sk || !sk.active) return null;
  if (product.hasSku) return null;              // 秒杀仅支持单规格商品
  const price = Number(sk.price);
  const base = Number(product.basePrice);
  // basePrice 非法（缺失/NaN）时不启用秒杀价，走原价路径由后续逻辑兜底
  if (!Number.isFinite(base) || !(price > 0) || price >= base) return null;
  if (!sk.endTime) return null;                 // 必须有结束时间
  const end = new Date(sk.endTime).getTime();
  if (!end || end <= Date.now()) return null;   // 已结束
  return price;
}

// 多规格某个 SKU 的有效秒杀价（服务端为准）：
// 商品级 seckill.active + endTime 未过 + seckill.skuPrices[skuId] >0 且低于该 sku 原价，任一不满足回退原价（返回 null）。
function getSkuSeckillPrice(product, sku) {
  const sk = product.seckill;
  if (!sk || !sk.active || !sk.skuPrices || !sku) return null;
  const price = Number(sk.skuPrices[sku.skuId]);
  const base = Number(sku.price);
  if (!Number.isFinite(base) || !(price > 0) || price >= base) return null;
  if (!sk.endTime) return null;
  const end = new Date(sk.endTime).getTime();
  if (!end || end <= Date.now()) return null;   // 已结束
  return price;
}

// ===== 创建订单 =====
// 流程：验证商品 → 计算价格（含秒杀价判定）→ 处理优惠券 → 直读分销绑定关系算返佣 → 写入订单 → 扣减库存
async function createOrder(openid, event) {
  const { items, address, userCouponId, remark } = event;
  const shippingMethod = event.shippingMethod === 'pickup' ? 'pickup' : 'delivery';

  try {
    // 0.1 自提必须留联系人（前端已校验，服务端再兜一次，防绕过）
    if (shippingMethod === 'pickup') {
      const pickupName = String((address && address.name) || '').trim();
      const pickupPhone = String((address && address.phone) || '').trim();
      if (!pickupName || !/^1[3-9]\d{9}$/.test(pickupPhone)) {
        return { code: 400, message: '请填写自提联系人和手机号' };
      }
    }

    // 0. 防止重复提交：检查5秒内是否有相同订单
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    const duplicateCheck = await db.collection('orders')
      .where({
        userId: openid,
        status: 'pending_payment',
        createTime: _.gte(fiveSecondsAgo)
      })
      .get();

    // 检查是否有相同商品的订单
    const hasDuplicate = duplicateCheck.data.some(existingOrder => {
      if (existingOrder.items.length !== items.length) return false;
      return items.every(item => {
        const existingItem = existingOrder.items.find(e => e.productId === item.productId);
        return existingItem && existingItem.quantity === item.quantity;
      });
    });

    if (hasDuplicate) {
      return { code: 400, message: '请勿重复提交订单' };
    }

    // 1. 从数据库验证商品信息（不信任前端传来的价格！）
    const productIds = items.map(item => item.productId);
    const productsRes = await db.collection('products')
      .where({ _id: _.in(productIds), isActive: true })
      .get();

    const products = productsRes.data;
    if (products.length !== productIds.length) {
      return { code: 400, message: '部分商品已下架' };
    }

    // 2. 检查库存并重新计算价格（以数据库价格为准）
    const orderItems = [];
    let subtotal = 0;

    for (const cartItem of items) {
      // 验证商品数量合理性（必须是正整数——小数如 0.01 会按 1% 单价成交）
      if (!Number.isInteger(cartItem.quantity) || cartItem.quantity <= 0) {
        return { code: 400, message: '商品数量必须为正整数' };
      }
      if (cartItem.quantity > 999) {
        return { code: 400, message: '单商品数量不能超过999' };
      }

      const product = products.find(p => p._id === cartItem.productId);

      // ===== 多规格：按 skuId 取该规格的价格/库存/返佣（服务端为准，不信前端价）=====
      if (product.hasSku && Array.isArray(product.skus) && product.skus.length) {
        if (!cartItem.skuId) {
          return { code: 400, message: `${product.name} 请选择规格` };
        }
        const skuIdx = product.skus.findIndex(s => s.skuId === cartItem.skuId);
        const sku = skuIdx >= 0 ? product.skus[skuIdx] : null;
        if (!sku || sku.isActive === false) {
          return { code: 400, message: `${product.name} 规格已失效，请重新选择` };
        }
        if (Number(sku.stock) < cartItem.quantity) {
          return { code: 400, message: `${product.name}（${sku.specText}）库存不足` };
        }
        // 秒杀计价：该 SKU 秒杀有效则用秒杀价，否则用规格原价（服务端判定，前端价一律不信）
        const skuSeckillPrice = getSkuSeckillPrice(product, sku);
        const unitPrice = skuSeckillPrice != null ? skuSeckillPrice : Number(sku.price);
        const itemTotal = unitPrice * cartItem.quantity;
        subtotal += itemTotal;
        orderItems.push({
          productId: product._id,
          productName: product.name,
          image: sku.image || product.mainImage,
          quantity: cartItem.quantity,
          unitPrice,
          totalPrice: parseFloat(itemTotal.toFixed(2)),
          unit: sku.unit || product.unit || 'kg',
          isSeckill: skuSeckillPrice != null,   // 审计：该件按秒杀价成交
          // 规格信息（审计 + 扣库存定位）
          skuId: sku.skuId,
          skuName: sku.specText,
          _skuIdx: skuIdx,                 // 内部用：事务里按下标精确扣该 sku 库存，写库前删掉
          // 返佣额：规格级优先，留空回退商品级
          commissionPerUnit: (sku.commissionPerUnit != null) ? Number(sku.commissionPerUnit)
                            : (product.commissionPerUnit != null) ? Number(product.commissionPerUnit) : null,
        });
        continue;
      }

      // ===== 单规格：走原逻辑 =====
      if (product.stock < cartItem.quantity) {
        return { code: 400, message: `${product.name} 库存不足` };
      }

      // 秒杀计价：活动有效则按秒杀价，否则原价（服务端判定，前端价一律不信）
      const seckillPrice = getEffectiveSeckillPrice(product);
      const unitPrice = seckillPrice != null ? seckillPrice : product.basePrice;
      const itemTotal = unitPrice * cartItem.quantity;
      subtotal += itemTotal;

      orderItems.push({
        productId: product._id,
        productName: product.name,
        image: product.mainImage,
        quantity: cartItem.quantity,
        unitPrice,
        totalPrice: parseFloat(itemTotal.toFixed(2)),
        unit: product.unit || 'kg',
        isSeckill: seckillPrice != null,   // 审计：该件按秒杀价成交
        // 单品返佣额（元/件，null=该商品走全局/分销员比例），返佣计算用
        commissionPerUnit: (product.commissionPerUnit != null) ? Number(product.commissionPerUnit) : null,
      });
    }

    // 3. 运费计算（从 settings 读分区规则，服务端二次校验）
    let shippingFee = 0;
    if (address && address.province) {
      try {
        const settingsRes = await db.collection('settings').doc('store').get();
        const rules = settingsRes.data?.shippingRules || [
          // 默认运费：请在后台「店铺设置」按你的发货地改。
          { provinces: ['香港','澳门','台湾'], fee: 0, blocked: true },
          { provinces: [''], fee: 10, blocked: false },
        ];
        const matched = rules.find(r => r.provinces.some(p => address.province.includes(p)));
        if (matched?.blocked) return { code: 400, message: `暂不支持配送至${address.province}` };
        shippingFee = matched ? matched.fee : 15;
      } catch (e) {
        console.warn('读取运费规则失败，使用默认值:', e.message);
      }
    }

    // 4. 应用优惠（已领取券 userCouponId）+ 读分销绑定关系
    let discountAmount = 0;
    let couponId = null;             // 主券ID（user_coupon 对应的 couponId）
    let usedUserCouponId = null;
    let userCouponDiscount = 0;

    // —— 分销归属：直读用户的永久绑定关系（扫码/分享时绑定），不再手动填码 ——
    let referrerId = null;
    try {
      const buyerRes = await db.collection('users').doc(openid).get();
      const boundReferrerId = buyerRes.data?.distributorInfo?.referrerId;
      // 分销员本人下单不算别人的下线单（分销员不做下线）；也不能算给自己
      if (boundReferrerId && boundReferrerId !== openid && !buyerRes.data?.isDistributor) {
        referrerId = boundReferrerId;
      }
    } catch (e) { console.warn('读取分销绑定关系失败:', e.message); }

    // —— 已领取的券（user_coupons）
    if (userCouponId) {
      try {
        const ucRes = await db.collection('user_coupons').doc(userCouponId).get();
        const uc = ucRes.data;
        // 领取型券的过期时间在 user_coupons.expireAt（模板通常没有 endDate），服务端必须校验，
        // 否则前端可绕过 expired 过滤直接传过期券 ID 抵扣
        const ucExpired = uc && uc.expireAt && new Date(uc.expireAt) < new Date();
        if (uc && uc.userId === openid && uc.status === 'unused' && !ucExpired) {
          const cRes = await db.collection('coupons').doc(uc.couponId).get();
          const c = cRes.data;
          if (c && c.status !== 'inactive' && c.isActive !== false) {
            const now = new Date();
            const startOk = !c.startDate || now >= new Date(c.startDate);
            const endOk = !c.endDate || now <= new Date(c.endDate);
            const minPurchase = c.applicableScope?.minPurchaseAmount || c.minAmount || 0;
            if (startOk && endOk && subtotal >= minPurchase) {
              const dtype = c.discountType || 'fixed';
              const dval = c.discountValue || c.value || 0;
              if (dtype === 'fixed' || dtype === 'discount') {
                userCouponDiscount = dval;
              } else if (dtype === 'percent') {
                userCouponDiscount = parseFloat((subtotal * dval / 100).toFixed(2));
              }
              userCouponDiscount = Math.min(userCouponDiscount, subtotal);
              usedUserCouponId = userCouponId;
              if (!couponId) couponId = c._id;
            }
          }
        }
      } catch (e) { console.warn('user_coupon 处理失败:', e.message); }
    }

    discountAmount = userCouponDiscount;

    // 5. 计算最终金额
    const finalPrice = parseFloat(
      Math.max(0, subtotal + shippingFee - discountAmount).toFixed(2)
    );

    // 6. 计算分销员返佣（逐商品累加：单品有固定返佣额则用固定额，否则按比例打底）
    //    全部基于商品原价（数据库价），不被优惠券吃掉返佣基数
    let referrerCommission = 0;
    if (referrerId) {
      // 取该分销员的比例：分销员个人 commissionRate 优先，否则全局 distribution_settings
      let commissionRate = null;
      try {
        const distRes = await db.collection('distributors')
          .where({ userId: referrerId })
          .field({ commissionRate: true })
          .limit(1)
          .get();
        if (distRes.data.length > 0 && distRes.data[0].commissionRate != null) {
          commissionRate = distRes.data[0].commissionRate;
        }
      } catch (e) {
        console.warn('读取分销员提成比例失败:', e.message);
      }
      if (commissionRate == null) {
        try {
          const sr = await db.collection('settings').where({ key: 'distribution_settings' }).limit(1).get();
          const gp = sr.data?.[0]?.value?.commissionPercent;
          commissionRate = (gp != null ? gp : 5) / 100;
        } catch (e) {
          commissionRate = 0.05;
        }
      }
      // 归一：个人 commissionRate 应是小数(0.2)，若被误填成百分数(20)则除回；最后封顶 [0,1]
      if (commissionRate > 1) commissionRate = commissionRate / 100;
      if (!(commissionRate >= 0)) commissionRate = 0;
      commissionRate = Math.min(commissionRate, 1);

      let commission = 0;
      for (const it of orderItems) {
        const lineTotal = it.unitPrice * it.quantity;   // 该单品原价小计（佣金上限）
        let lineComm;
        if (it.commissionPerUnit != null) {
          lineComm = it.commissionPerUnit * it.quantity;  // 单品固定额覆盖
        } else {
          lineComm = lineTotal * commissionRate;          // 比例打底
        }
        // 单品佣金不超过该单品原价小计（防后台误配固定额过大）
        commission += Math.max(0, Math.min(lineComm, lineTotal));
      }
      // 总佣金不超过订单商品原价（subtotal）
      referrerCommission = parseFloat(Math.min(commission, subtotal).toFixed(2));
    }

    // 7. 生成订单ID（时间戳 + 随机数）
    const orderId = 'O' + Date.now() + Math.floor(Math.random() * 1000);

    // 写库前剥离内部字段 _skuIdx（仅事务扣库存用，不入库）
    const orderItemsToSave = orderItems.map(({ _skuIdx, ...rest }) => rest);

    // 8+9. 事务内「再次校验库存 → 扣库存 → 写订单」，保证原子、防超卖
    //      事务限制：只能用 doc()，单事务 ≤100 操作，不能调外部 API
    try {
      await db.runTransaction(async transaction => {
        for (const item of orderItems) {
          const cur = (await transaction.collection('products').doc(item.productId).get()).data;
          if (!cur) throw new Error(`${item.productName} 已下架`);
          if (item.skuId != null && item._skuIdx >= 0) {
            // 多规格：按下标精确扣该 sku 库存 + 同步商品级合计
            const sku = (cur.skus || [])[item._skuIdx];
            if (!sku || sku.skuId !== item.skuId || sku.isActive === false) {
              throw new Error(`${item.productName} 规格已失效`);
            }
            if (Number(sku.stock) < item.quantity) {
              throw new Error(`${item.productName}（${item.skuName}）库存不足`);
            }
            await transaction.collection('products').doc(item.productId).update({
              data: {
                [`skus.${item._skuIdx}.stock`]: _.inc(-item.quantity),  // 点号路径精确改数组元素
                stock: _.inc(-item.quantity),                          // 商品级合计同步
              }
            });
          } else {
            // 单规格
            if (Number(cur.stock) < item.quantity) {
              throw new Error(`${item.productName} 库存不足`);
            }
            await transaction.collection('products').doc(item.productId).update({
              data: { stock: _.inc(-item.quantity) }
            });
          }
        }

        // 写入订单
        await transaction.collection('orders').add({
          data: {
            _id: orderId,
            userId: openid,
            items: orderItemsToSave,
            subtotal: parseFloat(subtotal.toFixed(2)),
            discountAmount,
            userCouponDiscount,
            shippingFee,
            finalPrice,
            appliedCouponId: couponId,
            appliedUserCouponId: usedUserCouponId,
            referrerId,
            referrerCommission,
            commissionStatus: referrerId ? 'pending' : null,
            status: 'pending_payment',
            shippingMethod,
            // 自提只存联系人（称呼+手机号），快递存完整地址
            shippingAddress: shippingMethod === 'pickup'
              ? { name: String(address.name).trim(), phone: String(address.phone).trim() }
              : address,
            remark: remark || '',
            paymentExpireTime: new Date(Date.now() + 15 * 60 * 1000),
            createTime: new Date(),
            updateTime: new Date(),
          }
        });
      });
    } catch (txErr) {
      // 事务回滚：订单未创建、库存未扣，把原因返回前端
      console.error('下单事务失败:', txErr.message);
      return { code: 400, message: txErr.message || '下单失败，请重试' };
    }

    // 10. 标记优惠码为已使用
    if (couponId) {
      await db.collection('coupons').doc(couponId).update({
        data: {
          'usageLimit.currentUses': _.inc(1),
          usedBy: _.push([{ userId: openid, usedTime: new Date(), orderId }]),
        }
      });
    }
    // 11. 标记 user_coupon 为已使用
    if (usedUserCouponId) {
      try {
        await db.collection('user_coupons').doc(usedUserCouponId).update({
          data: { status: 'used', usedAt: new Date(), orderId }
        });
      } catch (e) { console.warn('标记 user_coupon 失败:', e.message); }
    }
    return {
      code: 200,
      message: '订单创建成功',
      data: { orderId, finalPrice }
    };

  } catch (err) {
    console.error('createOrder error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 查询订单列表 =====
async function listOrders(openid, event) {
  const { status } = event;
  try {
    let query = { userId: openid };
    if (status) query.status = status;

    const res = await db.collection('orders')
      .where(query)
      .orderBy('createTime', 'desc')
      .limit(50)
      .get();

    return { code: 200, data: res.data };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 查询订单详情 =====
async function getOrderDetail(orderId) {
  try {
    const res = await db.collection('orders').doc(orderId).get();
    return { code: 200, data: res.data };
  } catch (err) {
    return { code: 404, message: '订单不存在' };
  }
}

// ===== 验证优惠码（下单前预验证）=====
async function validateCoupon(openid, event) {
  const { code, userCouponId, subtotal } = event;
  try {
    let coupon = null;
    if (userCouponId) {
      const ucRes = await db.collection('user_coupons').doc(userCouponId).get();
      const uc = ucRes.data;
      if (!uc || uc.userId !== openid || uc.status !== 'unused') {
        return { code: 400, message: '优惠券不可用' };
      }
      // 领取型券按 user_coupons.expireAt 判过期（服务端强校验，不依赖前端过滤）
      if (uc.expireAt && new Date(uc.expireAt) < new Date()) {
        return { code: 400, message: '优惠券已过期' };
      }
      const cRes = await db.collection('coupons').doc(uc.couponId).get();
      coupon = cRes.data;
      if (!coupon) return { code: 400, message: '优惠券已失效' };
    } else {
      const couponRes = await db.collection('coupons')
        .where({ code, isActive: true })
        .limit(1).get();
      if (couponRes.data.length === 0) {
        return { code: 400, message: '优惠码不存在或已失效' };
      }
      coupon = couponRes.data[0];
    }

    const now = new Date();

    // 检查有效期
    if (coupon.startDate && now < new Date(coupon.startDate)) {
      return { code: 400, message: '优惠码未生效' };
    }
    if (coupon.endDate && now > new Date(coupon.endDate)) {
      return { code: 400, message: '优惠码已过期' };
    }

    // 检查最低消费
    const minPurchase = coupon.applicableScope?.minPurchaseAmount || 0;
    if (subtotal < minPurchase) {
      return { code: 400, message: `需消费满 ¥${minPurchase} 才能使用` };
    }

    // 检查使用次数限制（仅 couponCode 模式校验，user_coupon 模式由领取记录控制）
    if (!userCouponId && coupon.usageLimit) {
      if (coupon.usageLimit.maxUses > 0 &&
          coupon.usageLimit.currentUses >= coupon.usageLimit.maxUses) {
        return { code: 400, message: '优惠码已被领完' };
      }
      if (coupon.usageLimit.maxUsesPerUser !== -1) {
        const userUsed = (coupon.usedBy || []).filter(u => u.userId === openid).length;
        if (userUsed >= coupon.usageLimit.maxUsesPerUser) {
          return { code: 400, message: '你已使用过此优惠码' };
        }
      }
    }

    // 兼容旧字段（value + 无 discountType）和新字段（discountType + discountValue）
    const discountType = coupon.discountType || 'fixed';
    const discountValue = coupon.discountValue || coupon.value || 0;

    let discountAmount = 0;
    if (discountType === 'fixed') {
      discountAmount = discountValue;
    } else if (discountType === 'percent') {
      discountAmount = parseFloat((subtotal * discountValue / 100).toFixed(2));
    } else {
      // discount 类型（旧数据）：按金额直减
      discountAmount = discountValue;
    }
    discountAmount = Math.min(discountAmount, subtotal);

    return {
      code: 200,
      data: {
        couponId: coupon._id,
        discountAmount,
        description: coupon.description || coupon.condition || `优惠 ¥${discountAmount}`,
      }
    };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 更新订单状态 =====
// 用户侧状态变更：只允许本人订单 + 白名单流转（取消待支付 / 确认收货）。
// 原版无鉴权无白名单——任何人可把任意订单改成任意状态（含未付款改 paid 跳过支付），已封死。
// 管理端发货走 shipOrder，管理后台 不使用本 action。
const USER_STATUS_TRANSITIONS = {
  'pending_payment': ['cancelled'],   // 取消待支付订单
  'shipped': ['completed'],           // 确认收货
};

async function updateStatus(openid, orderId, status) {
  if (!orderId || !status) return { code: 400, message: '缺少参数' };
  try {
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.userId !== openid) return { code: 403, message: '无权操作此订单' };

    const allowed = USER_STATUS_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      return { code: 400, message: `订单当前状态不支持该操作` };
    }

    // 取消待支付订单走 cancelOrder（会恢复库存），避免两条取消路径行为不一致
    if (status === 'cancelled') {
      return await cancelOrder(openid, orderId);
    }

    await db.collection('orders').doc(orderId).update({
      data: { status, updateTime: new Date() }
    });
    return { code: 200, message: '状态已更新' };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 取消订单（仅限待支付状态，恢复库存）=====
async function cancelOrder(openid, orderId) {
  if (!orderId) return { code: 400, message: '缺少订单ID' };
  try {
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.userId !== openid) return { code: 403, message: '无权操作此订单' };
    if (order.status !== 'pending_payment') return { code: 400, message: '只能取消待支付订单' };

    return await doCancelOrder(order, 'user');
  } catch (err) {
    console.error('cancelOrder error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 管理端/系统取消待支付订单（无 openid 鉴权）=====
// ⚠️ 只允许服务端调用：小程序客户端调用云函数必带 OPENID，此处 OPENID 非空直接 403。
// 管理后台（node-sdk）与 orderTimeout 定时函数调用时 OPENID 为空。
async function adminCancelOrder(openid, event) {
  if (openid) return { code: 403, message: '仅限管理端调用' };
  const { orderId } = event;
  const reason = event.reason || 'admin';
  if (!orderId) return { code: 400, message: '缺少订单ID' };
  try {
    const orderRes = await db.collection('orders').doc(orderId).get().catch(() => null);
    const order = orderRes && orderRes.data;
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.status !== 'pending_payment') return { code: 400, message: '订单当前状态不可取消' };

    const res = await doCancelOrder(order, reason);
    if (res.code !== 200) return res;
    return { code: 200, message: '已取消' };
  } catch (err) {
    console.error('adminCancelOrder error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 取消订单回滚主体（无鉴权，接收已查出的订单文档）=====
// ⚠️ 所有取消待支付订单的路径都必须走这里，禁止裸改 status——
// 裸改会漏掉库存/SKU/优惠券/企业礼券回滚（2026-09 修 queryOrderFromWx 同 bug）。
// 并发安全：先做「状态仍为 pending_payment」的条件更新，只有 updated===1 才回滚，
// 保证用户自助取消与定时超时取消同时发生时库存不会被退两次。
async function doCancelOrder(order, reason) {
  const orderId = order._id;
  const now = new Date();
  try {
    const upRes = await db.collection('orders')
      .where({ _id: orderId, status: 'pending_payment' })
      .update({
        data: {
          status: 'cancelled',
          cancelReason: reason || 'user',
          cancelTime: now,
          updateTime: now,
        }
      });
    if (!upRes.stats || upRes.stats.updated !== 1) {
      // 已被其他路径取消/支付，不重复回滚
      console.log('订单状态已变更，跳过回滚:', orderId);
      return { code: 400, message: '订单当前状态不可取消' };
    }

    // 恢复库存（与下单扣减对称：SKU 订单要同时退 skus.{idx}.stock 和商品级 stock，
    // 原来只退商品级，规格库存会越扣越少造成虚假售罄）
    for (const item of (order.items || [])) {
      try {
        const data = { stock: _.inc(item.quantity) };
        if (item.skuId != null) {
          const pRes = await db.collection('products').doc(item.productId).get();
          const idx = (pRes.data?.skus || []).findIndex(s => s.skuId === item.skuId);
          if (idx >= 0) data[`skus.${idx}.stock`] = _.inc(item.quantity);
        }
        await db.collection('products').doc(item.productId).update({ data });
      } catch (e) {
        console.warn('恢复库存失败:', item.productId, e.message);
      }
    }

    // 企业礼券订单：解锁券 + 退回企业余额 + 写回补流水（仅取消待支付的混合支付券单）
    if (order.orderType === 'voucher') {
      await rollbackVoucher(order);
    }

    return { code: 200, message: '订单已取消' };
  } catch (err) {
    console.error('doCancelOrder error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 企业礼券订单回滚：解锁券 + 退回企业余额 + 写回补流水 =====
// 用于混合支付券单在待支付阶段被取消/超时。券在下单时被锁定（status:locked），
// 货款已从企业余额扣走且订单尚未 paid，此处对称退回。
// 幂等保护：只处理仍处 locked 且 lockedBy 为下单人的券（已结算的券不会被误退）。
async function rollbackVoucher(order) {
  try {
    const code = order.voucherCode;
    const amount = Math.round((Number(order.enterprisePaidAmount) || 0) * 100) / 100;
    if (!code || amount <= 0) return;

    // 条件解锁：只有本单锁定中的券才回滚，避免重复取消/并发误退
    const codeRes = await db.collection('voucher_codes')
      .where({ code, status: 'locked', lockedBy: order.userId }).limit(1).get();
    const vc = codeRes.data[0];
    if (!vc) { console.log('券非本单锁定中，跳过回滚:', code); return; }

    const prev = vc._prevStatus || 'unused';
    await db.collection('voucher_codes').doc(vc._id).update({
      data: { status: prev, lockedBy: null, lockExpireAt: null, lockedAmount: 0, updateTime: new Date() }
    });

    // 退回企业余额 + 流水
    await db.collection('enterprises').doc(order.enterpriseId).update({
      data: { balance: _.inc(amount), updateTime: new Date() }
    });
    await db.collection('enterprise_logs').add({
      data: {
        enterpriseId: order.enterpriseId, type: 'refund_back', amount,
        orderId: order._id, voucherCode: code,
        remark: '券订单取消，货款退回', createTime: new Date(),
      }
    }).catch(() => {});
    console.log('券订单已回滚，退回企业余额:', code, amount);
  } catch (e) {
    console.error('rollbackVoucher error:', e.message);
  }
}

// ===== 发货：支持快递发货和用户自提两种模式 =====
async function shipOrder(orderId, expressCompany, expressNo, shippingMethod) {
  if (!orderId) return { code: 400, message: '缺少订单号' };
  const isPickup = shippingMethod === 'pickup';
  if (!isPickup && (!expressCompany || !expressNo)) {
    return { code: 400, message: '快递发货需要填写快递公司和单号' };
  }

  try {
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.status !== 'paid') return { code: 400, message: '订单状态不是已支付' };

    if (isPickup) {
      // 自提：直接标记为已完成
      await db.collection('orders').doc(orderId).update({
        data: {
          status: 'completed',
          shippingMethod: 'pickup',
          shippedAt: new Date(),
          completedAt: new Date(),
          needShipping: false,
          updateTime: new Date(),
        }
      });
      // 上报微信物流（自提类型），失败不影响主流程
      try {
        await cloud.openapi.security.uploadShippingInfo({
          orderKey: { orderNumberType: 2, outTradeNo: orderId },
          logisticsType: 3, // 3=用户自提
          deliveryList: [{ deliveryId: 'OTHERS', waybillId: orderId }],
          uploadTime: new Date().toISOString(),
        });
      } catch (e) {
        console.error('自提物流上报失败（不影响主流程）:', e.message);
      }
      return { code: 200, message: '自提确认成功，订单已完成' };
    }

    // 快递发货
    const companyCodeMap = {
      '顺丰': 'SF', '圆通': 'YTO', '中通': 'ZTO',
      '韵达': 'YD', '极兔': 'JTSD', '申通': 'STO', '邮政': 'CNPOST',
    };
    await db.collection('orders').doc(orderId).update({
      data: {
        status: 'shipped',
        shippingMethod: 'express',
        expressCompany,
        expressNo,
        shippedAt: new Date(),
        needShipping: false,
        updateTime: new Date(),
      }
    });
    try {
      await cloud.openapi.security.uploadShippingInfo({
        orderKey: { orderNumberType: 2, outTradeNo: orderId },
        logisticsType: 1,
        deliveryList: [{ deliveryId: companyCodeMap[expressCompany] || 'SF', waybillId: expressNo }],
        uploadTime: new Date().toISOString(),
      });
      console.log('物流上报成功:', orderId, expressNo);
    } catch (e) {
      console.error('物流上报失败（不影响发货）:', e.message);
    }
    return { code: 200, message: '发货成功' };
  } catch (err) {
    console.error('shipOrder error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 仅上报微信物流（不修改订单状态，供管理后台发货后调用）=====
async function uploadShipping(event) {
  const { orderId, logisticsType, deliveryId, waybillId } = event;
  if (!orderId) return { code: 400, message: '缺少订单号' };
  try {
    await cloud.openapi.security.uploadShippingInfo({
      orderKey: { orderNumberType: 2, outTradeNo: orderId },
      logisticsType,
      deliveryList: [{ deliveryId, waybillId }],
      uploadTime: new Date().toISOString(),
    });
    console.log('物流上报成功:', orderId, waybillId);
    return { code: 200, message: '物流上报成功' };
  } catch (e) {
    console.error('物流上报失败:', e.message);
    return { code: 500, message: e.message };
  }
}

// ===== 获取物流查询插件 waybill_token（供小程序端查看物流轨迹）=====
// trace_waybill 接口不支持云调用，必须用 HTTPS + access_token 方式
async function getWaybillToken(openid, orderId) {
  if (!orderId) return { code: 400, message: '缺少订单号' };
  try {
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.userId !== openid) return { code: 403, message: '无权查询' };
    // 自提单无物流：新单看 shippingMethod，老单（无该字段）看有没有省份的收货地址
    if (order.shippingMethod === 'pickup' || !order.shippingAddress || !order.shippingAddress.province) {
      return { code: 400, message: '自提订单无物流信息' };
    }
    if (!order.expressNo) return { code: 400, message: '该订单暂无物流信息' };

    // 注意：waybillToken 不能缓存。微信 trace_waybill 在「运力方尚未录入轨迹」时
    // 也会签发 token，但该 token 绑定的是当时的空轨迹快照，后续轨迹更新不会反映到旧 token。
    // 早期(刚发货)生成并缓存的 token 会导致永远「暂无轨迹」。故每次都重新换取。

    const companyCodeMap = {
      '顺丰速递': 'SF', '顺丰速运': 'SF', '顺丰': 'SF',
      '圆通速递': 'YTO', '圆通': 'YTO',
      '中通快递': 'ZTO', '中通': 'ZTO',
      '韵达快递': 'YD', '韵达': 'YD',
      '极兔速递': 'JTSD', '极兔': 'JTSD',
      '申通快递': 'STO', '申通': 'STO',
      '邮政快递': 'CNPOST', '邮政快递包裹': 'CNPOST', '邮政': 'CNPOST',
      '京东物流': 'JD', '京东快递': 'JD', '京东': 'JD',
    };
    // 查不到就明确报错，不猜成某个具体快递（猜错会导致轨迹查不到）
    const deliveryId = companyCodeMap[order.expressCompany] || companyCodeMap[String(order.expressCompany || '').trim()];
    if (!deliveryId) {
      return { code: 400, message: `无法识别快递公司「${order.expressCompany || '空'}」` };
    }

    const firstItem = (order.items && order.items[0]) || {};
    const goodsName = firstItem.productName || firstItem.name || '商品';
    // trace_waybill 要求商品图为 https URL；云存储 cloud:// 路径需先转临时 https
    let goodsImg = firstItem.image || '';
    if (goodsImg.startsWith('cloud://')) {
      try {
        const tmp = await cloud.getTempFileURL({ fileList: [goodsImg] });
        if (tmp && tmp.fileList && tmp.fileList[0] && tmp.fileList[0].tempFileURL) {
          goodsImg = tmp.fileList[0].tempFileURL;
        } else {
          goodsImg = '';
        }
      } catch (e) {
        console.warn('转换商品图URL失败:', e.message);
        goodsImg = '';
      }
    }
    if (!goodsImg || !/^https?:\/\//.test(goodsImg)) {
      goodsImg = '' // TODO 换成你自己的兜底商品图 URL;
    }

    const accessToken = await getAccessToken();
    const apiUrl = `https://api.weixin.qq.com/cgi-bin/express/delivery/open_msg/trace_waybill?access_token=${accessToken}`;
    const reqBody = {
      openid,
      waybill_id: order.expressNo,
      receiver_phone: order.shippingAddress.phone || '',
      goods_info: {
        detail_list: [{ goods_name: goodsName, goods_img_url: goodsImg }]
      },
      trans_id: order.transactionId || '',
      order_detail_path: `pages/order/detail?id=${orderId}`,
      delivery_id: deliveryId,
    };
    console.log('trace_waybill request:', JSON.stringify(reqBody));
    const result = await httpsPostJson(apiUrl, reqBody);
    console.log('trace_waybill response:', JSON.stringify(result));

    if (result.errcode === 0 && result.waybill_token) {
      // 不写库缓存：每次按需换取，确保拿到最新轨迹快照对应的 token
      return { code: 200, data: { waybillToken: result.waybill_token } };
    }
    return { code: 500, message: `获取物流token失败: errcode=${result.errcode} errmsg=${result.errmsg}` };
  } catch (err) {
    console.error('getWaybillToken error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== Admin 查询所有订单（供后台管理系统调用）=====
async function adminListOrders(event) {
  const { status, page = 1, pageSize = 20 } = event;
  try {
    let query = db.collection('orders');
    if (status && status !== 'all') {
      query = query.where({ status });
    }
    const offset = (page - 1) * pageSize;
    const [res, countRes] = await Promise.all([
      query.orderBy('createTime', 'desc').skip(offset).limit(pageSize).get(),
      status && status !== 'all'
        ? db.collection('orders').where({ status }).count()
        : db.collection('orders').count(),
    ]);
    return { code: 200, data: res.data, total: countRes.total };
  } catch (err) {
    console.error('adminListOrders error:', err);
    return { code: 500, message: err.message };
  }
}
