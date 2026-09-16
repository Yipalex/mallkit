// 企业礼券确认页：选地址 → 展示金额明细（企业付货款 + 自付运费）→ 提交
// 免运费：voucher.createOrder 直接返回已付订单，跳订单详情。
// 省外运费：createOrder 建 pending_payment 单，继续走 pay + wx.requestPayment 付运费。
const app = getApp();

Page({
  data: {
    code: '',
    voucher: null,
    items: [],
    goodsTotal: '0.00',      // 货款（企业付）
    address: null,
    shippingFee: '0.00',     // 运费（用户付，前端预览）
    blocked: false,          // 地址不可达
    remark: '',
    submitting: false,
  },

  onLoad() {
    const data = wx.getStorageSync('voucherCheckout');
    if (!data || !data.items || data.items.length === 0) {
      wx.showToast({ title: '数据失效，请重新选择', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const goodsTotal = data.items.reduce((s, i) => s + i.price * i.quantity, 0);
    this.setData({
      code: data.code,
      voucher: data.voucher,
      items: data.items,
      goodsTotal: goodsTotal.toFixed(2),
    });
    // 复用上次选择的地址
    const cached = wx.getStorageSync('defaultAddress');
    if (cached && cached.province) this._applyAddress(cached);
  },

  onChooseAddress() {
    wx.chooseAddress({
      success: (res) => {
        this._applyAddress({
          name: res.userName, phone: res.telNumber,
          province: res.provinceName, city: res.cityName,
          district: res.countyName, detail: res.detailInfo || res.detailInfoNew || '',
        });
      },
      fail: () => {},
    });
  },

  async _applyAddress(address) {
    wx.setStorageSync('defaultAddress', address);
    // 算运费（前端预览，服务端会重算并最终决定）
    let rules = wx.getStorageSync('shippingRulesCache');
    if (!rules) {
      try {
        const r = await wx.cloud.callFunction({ name: 'product', data: { action: 'getSettings' } });
        rules = r.result?.data?.shippingRules || null;
        if (rules) wx.setStorageSync('shippingRulesCache', rules);
      } catch (e) { rules = null; }
    }
    if (!rules) rules = [
      // 默认运费：请在后台「店铺设置」按你的发货地改。
      { provinces: ['香港','澳门','台湾'], fee: 0, blocked: true },
      { provinces: [''], fee: 10, blocked: false },
    ];
    const matched = rules.find(r => r.provinces.some(p => address.province.includes(p)));
    if (matched?.blocked) {
      this.setData({ address, blocked: true, shippingFee: '0.00' });
      wx.showModal({ title: '暂不支持配送', content: `抱歉，暂不配送至${address.province}`, showCancel: false });
      return;
    }
    const fee = matched ? matched.fee : 15;
    this.setData({ address, blocked: false, shippingFee: fee.toFixed(2) });
  },

  onRemarkInput(e) { this.setData({ remark: e.detail.value }); },

  async onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.address) { wx.showToast({ title: '请填写收货地址', icon: 'none' }); return; }
    if (this.data.blocked) { wx.showToast({ title: '该地区暂不支持配送', icon: 'none' }); return; }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中…' });
    try {
      const items = this.data.items.map(i => ({ productId: i.productId, skuId: i.skuId || null, quantity: i.quantity }));
      const res = await wx.cloud.callFunction({
        name: 'voucher',
        data: { action: 'createOrder', code: this.data.code, items, address: this.data.address, remark: this.data.remark },
      });
      const r = res.result;
      if (!r || r.code !== 200) {
        wx.hideLoading();
        wx.showModal({ title: '下单失败', content: (r && r.message) || '请重试', showCancel: false });
        this.setData({ submitting: false });
        return;
      }

      const { orderId, needPay, finalPrice } = r.data;
      wx.removeStorageSync('voucherCheckout');

      // 免运费：订单已支付，直接进订单详情
      if (!needPay) {
        wx.hideLoading();
        wx.showToast({ title: '兑换成功', icon: 'success' });
        setTimeout(() => wx.redirectTo({ url: `/pages/order/detail?id=${orderId}` }), 800);
        return;
      }

      // 有运费：调 pay 拿微信支付参数
      wx.showLoading({ title: '唤起支付…' });
      const payRes = await wx.cloud.callFunction({ name: 'pay', data: { orderId, totalAmount: finalPrice } });
      if (!payRes.result || payRes.result.code !== 200) {
        wx.hideLoading();
        wx.showModal({ title: '支付参数获取失败', content: (payRes.result && payRes.result.message) || '订单已生成，可在订单列表继续支付运费', showCancel: false });
        this.setData({ submitting: false });
        return;
      }
      const pp = payRes.result.data;
      wx.hideLoading();
      wx.requestPayment({
        timeStamp: pp.timeStamp, nonceStr: pp.nonceStr, package: pp.package,
        signType: 'RSA', paySign: pp.paySign,
        success: () => {
          wx.showToast({ title: '支付成功', icon: 'success' });
          setTimeout(() => wx.redirectTo({ url: `/pages/order/detail?id=${orderId}` }), 800);
        },
        fail: () => {
          // 运费未付：订单待支付，超时会自动取消并回滚券/企业余额
          wx.showModal({ title: '运费未支付', content: '订单已保留，可在订单列表继续支付运费；超时未付将自动取消', showCancel: false,
            success: () => wx.redirectTo({ url: `/pages/order/detail?id=${orderId}` }) });
        },
      });
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '下单异常', content: '请重试', showCancel: false });
      this.setData({ submitting: false });
    }
  },
});
