// pages/order/pay.js - 订单确认 + 支付页面
// 这是整个支付流程的核心页面：
// 1. 展示要购买的商品
// 2. 填写收货地址
// 3. 选择已领取的优惠券（可选）
// 4. 点击支付 → 创建订单 → 调起微信支付
// 注：分销归属已改为"扫码/分享自动绑定"，下单时由服务端直读绑定关系，本页不再有手动填分销码

const app = getApp();

Page({
  data: {
    items: [],
    address: null,
    shippingMethod: 'delivery',  // 'delivery' 快递 | 'pickup' 自提
    pickupContact: { name: '', phone: '' },  // 自提联系人（自提必填）
    // 自提门店信息（后台 settings 可配置，未配置时用下面的默认文案兜底）
    pickupStore: {
      address: '示例省示例市示例区 示例自提点',
      phone: '400-000-0000',
      note: '下单后请联系商家确认自提时间',
    },
    // 已领取的券（如新朋友券）
    selectedCouponId: '',
    selectedCouponInfo: null,  // { discountAmount, couponId, description }
    selectedCouponError: '',
    myCoupons: [],
    // 汇总
    subtotal: 0,
    discountAmount: 0,        // 总减免 = 已领取券减免
    shippingFee: 0,
    finalPrice: 0,
    remark: '',
    isCreatingOrder: false,
  },

  onLoad(options) {
    this._fromCart = options.from === 'cart';   // 支付成功后清购物车时区分来源
    const items = this._fromCart
      ? (wx.getStorageSync('checkoutItems') || [])
      : (wx.getStorageSync('buyNow')?.items || []);

    const itemsWithSubtotal = items.map(item => ({
      ...item,
      subtotal: (item.price * item.quantity).toFixed(2)
    }));
    this.setData({ items: itemsWithSubtotal, pickupContact: this._initPickupContact() });
    this.loadAddressAndCalc();
    this.loadMyCoupons();
    this.loadPickupStore();
  },

  // 拉取后台配置的自提门店信息，字段为空则保留 data 里的默认文案
  async loadPickupStore() {
    try {
      const r = await wx.cloud.callFunction({ name: 'product', data: { action: 'getSettings' } });
      const s = r.result?.data || {};
      const patch = {};
      if (s.pickupAddress) patch['pickupStore.address'] = s.pickupAddress;
      if (s.pickupPhone) patch['pickupStore.phone'] = s.pickupPhone;
      if (s.pickupNote) patch['pickupStore.note'] = s.pickupNote;
      if (Object.keys(patch).length) this.setData(patch);
    } catch (e) {
      console.error('loadPickupStore error', e);
    }
  },

  // 自提联系人预填：上次自提填的 → 用户资料手机号 → 默认收货地址
  _initPickupContact() {
    const saved = wx.getStorageSync('pickupContact');
    if (saved && saved.name && saved.phone) {
      return { name: saved.name, phone: saved.phone };
    }
    const contact = { name: (saved && saved.name) || '', phone: (saved && saved.phone) || '' };
    if (!contact.phone) {
      contact.phone = wx.getStorageSync('userInfo')?.phone || '';
    }
    const addr = wx.getStorageSync('defaultAddress');
    if (addr) {
      if (!contact.name) contact.name = addr.name || '';
      if (!contact.phone) contact.phone = addr.phone || '';
    }
    return contact;
  },

  // 自提联系人输入
  onPickupInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`pickupContact.${field}`]: e.detail.value });
  },

  // 加载用户可用的优惠券（已领取且未使用）
  async loadMyCoupons() {
    if (!app.globalData.openid) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getUserCoupons', userId: app.globalData.openid }
      });
      if (res.result && res.result.code === 200) {
        const subtotal = parseFloat(this.data.subtotal) || 0;
        const list = (res.result.data || [])
          .filter(c => !c.expired)
          .map(c => {
            const reachThreshold = subtotal >= (c.minPurchase || 0);
            return {
              ...c,
              disabled: !reachThreshold,
              disabledReason: reachThreshold ? '' : `还差¥${(c.minPurchase - subtotal).toFixed(2)}可用`,
            };
          })
          // 把可用的排在前面
          .sort((a, b) => (a.disabled === b.disabled ? 0 : a.disabled ? 1 : -1));
        this.setData({ myCoupons: list });
      }
    } catch (e) {
      console.error('loadMyCoupons error', e);
    }
  },

  // 点击选择/取消选择优惠券（新人券等已领取的券，与下方分销优惠码独立）
  async onSelectCoupon(e) {
    const { id, disabled } = e.currentTarget.dataset;
    if (disabled) {
      wx.showToast({ title: '未达到使用门槛', icon: 'none' });
      return;
    }
    // 再次点同一张：取消选中
    if (this.data.selectedCouponId === id) {
      this.setData({
        selectedCouponId: '',
        selectedCouponInfo: null,
        selectedCouponError: '',
      });
      this.calcPrice();
      return;
    }
    // 选中一张：调云函数验证
    try {
      wx.showLoading({ title: '验证中...' });
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'validateCoupon',
          userCouponId: id,
          subtotal: parseFloat(this.data.subtotal),
          userId: app.globalData.openid,
        }
      });
      wx.hideLoading();
      if (res.result.code === 200) {
        this.setData({
          selectedCouponId: id,
          selectedCouponInfo: res.result.data,
          selectedCouponError: '',
        });
        this.calcPrice();
      } else {
        this.setData({
          selectedCouponId: '',
          selectedCouponInfo: null,
          selectedCouponError: res.result.message,
        });
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ selectedCouponError: '验证失败，请重试' });
    }
  },

  // 每次显示页面时重新读取地址（从地址页返回后刷新）
  onShow() {
    // 每次显示时清除规则缓存，确保能拿到管理员最新配置
    wx.removeStorageSync('shippingRulesCache');
    this.loadAddressAndCalc();
  },

  async loadAddressAndCalc() {
    const savedAddress = wx.getStorageSync('defaultAddress');
    if (!savedAddress || !savedAddress.province) {
      this.calcPrice();
      return;
    }

    // 每次加载时用规则重新计算运费，不依赖旧的 shippingFee 缓存
    let shippingRules = wx.getStorageSync('shippingRulesCache');
    if (!shippingRules) {
      try {
        const r = await wx.cloud.callFunction({ name: 'product', data: { action: 'getSettings' } });
        shippingRules = r.result?.data?.shippingRules || null;
        if (shippingRules) wx.setStorageSync('shippingRulesCache', shippingRules);
      } catch (e) { shippingRules = null; }
    }

    const rules = shippingRules || [
      // 默认运费：请在后台「店铺设置」按你的发货地改。
      { provinces: ['香港','澳门','台湾'], fee: 0, blocked: true },
      { provinces: [''], fee: 10, blocked: false },
    ];

    const matchedRule = rules.find(rule =>
      rule.provinces.some(p => savedAddress.province.includes(p))
    );

    if (matchedRule?.blocked) {
      // 已缓存的地址是被封锁区域，清除地址缓存
      wx.removeStorageSync('defaultAddress');
      wx.removeStorageSync('shippingFee');
      this.setData({ address: null, shippingFee: '0.00' });
      this.calcPrice();
      return;
    }

    const fee = matchedRule ? matchedRule.fee : 15;
    wx.setStorageSync('shippingFee', fee);
    this.setData({ address: savedAddress, shippingFee: fee.toFixed(2) });
    this.calcPrice();
  },

  // ===== 价格计算 =====

  calcPrice() {
    const subtotal = this.data.items.reduce(
      (sum, item) => sum + item.price * item.quantity, 0
    );
    // 运费从地址页计算结果读取（默认0，全程包邮）
    const shippingFee = parseFloat(this.data.shippingFee) || 0;
    // 仅已领取的优惠券参与折扣计算
    const userCouponDiscount = this.data.selectedCouponInfo?.discountAmount || 0;
    const totalDiscount = userCouponDiscount;
    const finalPrice = Math.max(0, subtotal + shippingFee - totalDiscount);

    this.setData({
      subtotal: subtotal.toFixed(2),
      shippingFee: shippingFee.toFixed(2),
      discountAmount: totalDiscount.toFixed(2),
      finalPrice: finalPrice.toFixed(2),
    });
  },

  // ===== 配送方式切换 =====
  onSelectDelivery() {
    this.setData({ shippingMethod: 'delivery' });
  },
  onSelectPickup() {
    this.setData({ shippingMethod: 'pickup', address: null, shippingFee: '0.00' });
    this.calcPrice();
  },

  // ===== 地址选择 =====
  onChooseAddress() {
    wx.chooseAddress({
      success: async (res) => {
        const address = {
          name:     res.userName,
          phone:    res.telNumber,
          province: res.provinceName,
          city:     res.cityName,
          district: res.countyName,
          detail:   res.detailInfo || res.detailInfoNew || '',
        };

        // 选地址时清旧缓存，强制从云端重新拉取最新规则
        wx.removeStorageSync('shippingRulesCache');
        let shippingRules = null;
        try {
          const r = await wx.cloud.callFunction({ name: 'product', data: { action: 'getSettings' } });
          shippingRules = r.result?.data?.shippingRules || null;
          if (shippingRules) wx.setStorageSync('shippingRulesCache', shippingRules);
        } catch (e) { shippingRules = null; }

        // 兜底规则（后台未配置时使用）
        const rules = shippingRules || [
          // 默认运费：请在后台「店铺设置」按你的发货地改。
          { provinces: ['香港','澳门','台湾'], fee: 0, blocked: true },
          { provinces: [''], fee: 10, blocked: false },
        ];

        // 按省份匹配规则
        const matchedRule = rules.find(rule =>
          rule.provinces.some(p => address.province.includes(p))
        );

        if (matchedRule?.blocked) {
          wx.showModal({
            title: '暂不支持配送',
            content: `抱歉，当前配送范围暂未覆盖${address.province}`,
            showCancel: false,
          });
          return;
        }

        const fee = matchedRule ? matchedRule.fee : 15; // 无规则匹配时默认15元
        wx.setStorageSync('defaultAddress', address);
        wx.setStorageSync('shippingFee', fee);
        this.setData({ address, shippingFee: fee.toFixed(2) });
        this.calcPrice();
      },
      fail: (err) => {
        console.log('chooseAddress cancelled or failed:', err.errMsg);
      },
    });
  },

  // ===== 备注 =====
  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  // ===== 提交订单并支付 =====

  async onPay() {
    // 1. 校验
    if (this.data.shippingMethod === 'delivery' && !this.data.address) {
      wx.showToast({ title: '请填写收货地址', icon: 'none' });
      return;
    }
    // 自提必须留下称呼和手机号，方便到店核对
    let pickupContact = null;
    if (this.data.shippingMethod === 'pickup') {
      const name = (this.data.pickupContact.name || '').trim();
      const phone = (this.data.pickupContact.phone || '').trim();
      if (!name) {
        wx.showToast({ title: '请填写自提人称呼', icon: 'none' });
        return;
      }
      if (!/^1[3-9]\d{9}$/.test(phone)) {
        wx.showToast({ title: '请填写正确的手机号', icon: 'none' });
        return;
      }
      pickupContact = { name, phone };
    }
    if (this.data.items.length === 0) {
      wx.showToast({ title: '购物车为空', icon: 'none' });
      return;
    }
    if (this.data.isCreatingOrder) return;  // 防止重复提交

    this.setData({ isCreatingOrder: true });

    try {
      wx.showLoading({ title: '提交订单...' });

      // 2. 调用云函数创建订单
      const orderRes = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'create',
          items: this.data.items,
          address: this.data.shippingMethod === 'delivery' ? this.data.address : pickupContact,
          shippingMethod: this.data.shippingMethod,
          // 分销归属由服务端直读绑定关系，无需前端传；这里只传已领取的优惠券
          userCouponId: this.data.selectedCouponId || null,
          remark: this.data.remark,
          userId: app.globalData.openid,
        }
      });

      if (orderRes.result.code !== 200) {
        wx.showModal({ title: '创建订单失败', content: orderRes.result.message || '未知错误', showCancel: false });
        return;
      }

      // 记住自提联系人，下次自提直接预填
      if (pickupContact) {
        wx.setStorageSync('pickupContact', pickupContact);
      }

      const { orderId, finalPrice } = orderRes.result.data;

      wx.showLoading({ title: '唤起支付...' });

      // 3. 调用云函数获取微信支付参数（prepay）
      const payRes = await wx.cloud.callFunction({
        name: 'pay',
        data: {
          orderId,
          totalAmount: finalPrice,
          userId: app.globalData.openid,
        }
      });

      if (payRes.result.code !== 200) {
        wx.showModal({ title: '支付参数获取失败', content: payRes.result.message || '未知错误', showCancel: false });
        return;
      }

      const payParams = payRes.result.data;
      wx.hideLoading();

      // 4. 调起微信支付
      wx.requestPayment({
        timeStamp: payParams.timeStamp,
        nonceStr: payParams.nonceStr,
        package: payParams.package,
        signType: 'RSA',
        paySign: payParams.paySign,

        success: () => {
          wx.removeStorageSync('checkoutItems');
          wx.removeStorageSync('buyNow');

          // 只在「从购物车结算」时清购物车，且只移除本次买掉的商品——
          // 未勾选的商品保留；立即购买不碰购物车（原来两种情况都整车清空，是 bug）
          if (this._fromCart) {
            const key = (i) => `${i.productId}|${i.skuId || ''}|${i.specText || ''}`;
            const bought = new Set(this.data.items.map(key));
            const remaining = (wx.getStorageSync('cart') || []).filter(c => !bought.has(key(c)));
            wx.setStorageSync('cart', remaining);
            app.updateCartBadge(remaining.reduce((s, c) => s + (c.quantity || 0), 0));

            // 标记「本地为准、待同步」：购物车页下次打开会用本地覆盖云端，
            // 防止这里的云端同步失败后，云端旧数据把已购商品"复活"回购物车
            wx.setStorageSync('cartNeedsSync', true);
            wx.cloud.callFunction({
              name: 'cart',
              data: { action: 'sync', items: remaining }
            }).then(() => {
              wx.removeStorageSync('cartNeedsSync');
            }).catch(() => {});
            // 服务端 payNotify 收到支付回调后也会按订单商品清一遍云端购物车，双保险
          }

          wx.showToast({ title: '支付成功', icon: 'success' });

          // 轮询兜底：微信支付回调可能因为密钥/网络问题失败导致订单状态不更新
          // 这里主动调用 pay.queryOrder 从微信侧查真实状态并同步到数据库
          // 每 2 秒查 1 次，最多 5 次，发现 paid 立即停止
          this._pollOrderStatus(orderId, 0);
        },

        fail: (err) => {
          if (err.errMsg.includes('cancel')) {
            // 用户取消支付，订单保留为待支付状态
            wx.showModal({
              title: '已取消支付',
              content: '订单已保存，可在"我的订单"中继续支付',
              showCancel: false,
              success: () => {
                wx.navigateTo({ url: `/pages/order/detail?id=${orderId}` });
              }
            });
          } else {
            wx.showToast({ title: '支付失败，请重试', icon: 'none' });
          }
        },
      });

    } catch (err) {
      console.error('支付流程出错', err);
      wx.showToast({ title: '系统错误，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ isCreatingOrder: false });
    }
  },

  // 轮询订单状态（兜底机制）
  // 用 pay.queryOrder 直接问微信支付侧的真实状态，绕过 payNotify 回调
  _pollOrderStatus(orderId, attempt) {
    const MAX_ATTEMPTS = 5;
    const INTERVAL_MS = 2000;

    if (attempt >= MAX_ATTEMPTS) {
      // 超时也跳转到详情，让用户在那边手动刷新
      wx.redirectTo({ url: `/pages/order/detail?id=${orderId}&justPaid=1` });
      return;
    }

    setTimeout(() => {
      wx.cloud.callFunction({
        name: 'pay',
        data: { action: 'queryOrder', orderId }
      }).then(res => {
        const state = res.result?.data?.wxTradeState;
        const dbStatus = res.result?.data?.dbStatusAfter;
        // 微信侧已 SUCCESS 且 DB 已同步成 paid：可以走了
        if (state === 'SUCCESS' && dbStatus && dbStatus !== 'pending_payment') {
          wx.redirectTo({ url: `/pages/order/detail?id=${orderId}&justPaid=1` });
          return;
        }
        // 否则继续轮询
        this._pollOrderStatus(orderId, attempt + 1);
      }).catch(() => {
        // 出错也继续轮询
        this._pollOrderStatus(orderId, attempt + 1);
      });
    }, INTERVAL_MS);
  },
});
