// 企业礼券落地页：扫码进入 → 校验券 → 展示券信息 + 可购商品 → 进确认页
// 锁定流程起点：本页 reLaunch 进入清栈，页内只允许跳 voucher/confirm，不提供跳首页入口。
const app = getApp();

Page({
  data: {
    loading: true,
    code: '',
    voucher: null,          // 券信息（含 type/remaining/enterpriseName...）
    unusable: false,
    unusableReason: '',
    // 商品型：product 对象；充值卡型：products 列表 + 券内购物袋
    product: null,
    products: [],
    bag: {},                // key = productId|skuId → { productId, skuId, name, price, quantity, image, unit, specText }
    bagCount: 0,
    bagTotal: '0.00',
    // 充值卡型 SKU 选择弹窗
    skuPickerVisible: false,
    skuPickerProduct: null,
  },

  async onLoad(options) {
    const code = (options.code || '').toUpperCase();
    if (!code) { this.setData({ loading: false, unusable: true, unusableReason: '无效的礼券链接' }); return; }
    this.setData({ code });
    await app.waitForLogin();
    this.loadVoucher();
  },

  async loadVoucher() {
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'voucher', data: { action: 'query', code: this.data.code } });
      const r = res.result;
      if (!r || r.code !== 200) {
        this.setData({ loading: false, unusable: true, unusableReason: (r && r.message) || '礼券不可用' });
        return;
      }
      const v = r.data;
      if (!v.usable) {
        this.setData({ loading: false, voucher: v, unusable: true, unusableReason: v.unusableReason || '礼券不可用' });
        return;
      }
      this.setData({
        loading: false,
        voucher: v,
        unusable: false,
        product: v.product || null,
        products: v.products || [],
      });
    } catch (e) {
      this.setData({ loading: false, unusable: true, unusableReason: '网络异常，请重试' });
    }
  },

  // ===== 商品型：直接去确认 =====
  onExchangeProduct() {
    const p = this.data.product;
    const items = [{ productId: p.productId, skuId: p.skuId || null, quantity: p.quantity, name: p.name, price: p.price, image: p.image, unit: p.unit, specText: p.skuName }];
    this._goConfirm(items);
  },

  // ===== 充值卡型：加入券内购物袋 =====
  onAddToBag(e) {
    const pid = e.currentTarget.dataset.pid;
    const prod = this.data.products.find(p => p.productId === pid);
    if (!prod) return;
    if (prod.hasSku && prod.skus && prod.skus.length) {
      // 需选规格
      this.setData({ skuPickerVisible: true, skuPickerProduct: prod });
      return;
    }
    this._addBagItem({ productId: prod.productId, skuId: null, name: prod.name, price: prod.price, image: prod.image, unit: prod.unit, specText: null });
  },

  onPickSku(e) {
    const skuId = e.currentTarget.dataset.skuid;
    const prod = this.data.skuPickerProduct;
    const sku = prod.skus.find(s => s.skuId === skuId);
    if (!sku) return;
    this._addBagItem({ productId: prod.productId, skuId: sku.skuId, name: prod.name, price: sku.price, image: sku.image || prod.image, unit: prod.unit, specText: sku.specText });
    this.setData({ skuPickerVisible: false, skuPickerProduct: null });
  },

  closeSkuPicker() { this.setData({ skuPickerVisible: false, skuPickerProduct: null }); },

  _addBagItem(item) {
    const key = `${item.productId}|${item.skuId || ''}`;
    const bag = { ...this.data.bag };
    if (bag[key]) bag[key] = { ...bag[key], quantity: bag[key].quantity + 1 };
    else bag[key] = { ...item, quantity: 1 };
    this._refreshBag(bag);
  },

  onBagPlus(e) {
    const key = e.currentTarget.dataset.key;
    const bag = { ...this.data.bag };
    if (bag[key]) { bag[key] = { ...bag[key], quantity: bag[key].quantity + 1 }; this._refreshBag(bag); }
  },
  onBagMinus(e) {
    const key = e.currentTarget.dataset.key;
    const bag = { ...this.data.bag };
    if (bag[key]) {
      const q = bag[key].quantity - 1;
      if (q <= 0) delete bag[key];
      else bag[key] = { ...bag[key], quantity: q };
      this._refreshBag(bag);
    }
  },

  _refreshBag(bag) {
    const list = Object.values(bag);
    const count = list.reduce((s, i) => s + i.quantity, 0);
    const total = list.reduce((s, i) => s + i.price * i.quantity, 0);
    const remaining = this.data.voucher.remaining;
    // 券余额提示（不硬拦，服务端会最终校验；这里给用户预警）
    if (total > remaining) {
      wx.showToast({ title: `超出券余额 ¥${remaining}`, icon: 'none' });
    }
    this.setData({ bag, bagCount: count, bagTotal: total.toFixed(2) });
  },

  onCheckoutBag() {
    const list = Object.values(this.data.bag);
    if (list.length === 0) { wx.showToast({ title: '请先选择商品', icon: 'none' }); return; }
    const total = list.reduce((s, i) => s + i.price * i.quantity, 0);
    if (total > this.data.voucher.remaining) {
      wx.showModal({ title: '超出券余额', content: `本券剩余 ¥${this.data.voucher.remaining}，请调整数量`, showCancel: false });
      return;
    }
    const items = list.map(i => ({ productId: i.productId, skuId: i.skuId, quantity: i.quantity, name: i.name, price: i.price, image: i.image, unit: i.unit, specText: i.specText }));
    this._goConfirm(items);
  },

  // 跳确认页：items 存 storage（避免 URL 过长），confirm 页读取
  _goConfirm(items) {
    wx.setStorageSync('voucherCheckout', { code: this.data.code, voucher: this.data.voucher, items });
    wx.navigateTo({ url: '/pages/voucher/confirm' });
  },
});
