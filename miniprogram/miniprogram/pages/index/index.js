// pages/index/index.js - 首页
// 展示商品分类、商品列表、搜索入口、轮播图

const app = getApp();

Page({

  data: {
    // 营销弹窗
    popup: null,
    showPopup: false,

    // 轮播图数据
    banners: [],

    // 商品分类列表（从后台数据库获取）
    categories: [],
    activeCategory: 'all',   // 当前选中的分类

    // 商品列表
    products: [],
    isLoading: false,        // 是否正在加载
    hasMore: true,           // 是否还有更多数据
    page: 1,                 // 当前页码
    pageSize: 10,            // 每页数量

    // 搜索
    searchKeyword: '',

    // 限时秒杀（2026-07 UI 重设计新增）
    seckill: [],                          // 秒杀商品列表
    countdown: { h: '00', m: '00', s: '00' }, // 倒计时

    // 多规格加购浮层
    showSkuPicker: false,
    skuPickerProduct: {},
  },

  // 购物车去重 key：与详情页/sku-picker 一致，单规格 skuId/specText 为空串
  _cartKey(item) {
    return (item.productId || '') + '|' + (item.skuId || '') + '|' + (item.specText || '');
  },

  // ===== 页面生命周期 =====

  onLoad() {
    // 先用本地缓存秒开（上次的首页数据），再发一个聚合请求刷新
    this.paintFromCache();
    this.loadHome();
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline'],
    });
  },

  onShow() {
    // 自定义底栏高亮跟随当前页（组件 pageLifetimes 不可靠，页面主动通知）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateSelected();
    }
    this.updateCartBadge();
    this.checkAndShowPopup();
    this.startCountdown(); // onHide 时停了，回到页面重新走
  },

  onUnload() {
    this.stopCountdown();
  },

  onHide() {
    this.stopCountdown();
  },

  // 下拉刷新：重新拉聚合数据
  onPullDownRefresh() {
    this.setData({ page: 1, activeCategory: 'all', products: [], hasMore: true });
    this.loadHome(() => wx.stopPullDownRefresh());
  },

  // 触底加载更多
  onReachBottom() {
    if (this.data.hasMore && !this.data.isLoading) {
      this.loadMore();
    }
  },

  // ===== 数据加载方法 =====

  // 用上次缓存的首页数据先渲染一版（秒开，避免白屏等云函数）
  paintFromCache() {
    const cached = wx.getStorageSync('home_cache');
    if (!cached) return;
    this.applyHomeData(cached, true);
  },

  // 聚合加载：一次云函数调用拿到 轮播+分类+秒杀+第一页商品
  async loadHome(callback) {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getHome', pageSize: this.data.pageSize }
      });
      if (res.result.code === 200) {
        wx.setStorageSync('home_cache', res.result.data);
        this.applyHomeData(res.result.data, false);
      }
    } catch (err) {
      console.error('加载首页失败', err);
      // 聚合接口失败时回退到老的分步加载（云函数没更新时也能用）
      this.loadBanners();
      this.loadProducts();
    } finally {
      this.setData({ isLoading: false });
      callback && callback();
    }
  },

  // 把聚合数据铺到页面上（fromCache=true 时不覆盖已有的新数据）
  applyHomeData(data, fromCache) {
    if (fromCache && this.data.products.length > 0) return;
    const categories = [
      { id: 'all', name: '全部' },
      ...(data.categories || []).map(c => ({ id: c._id, name: c.name }))
    ];
    const products = (data.products && data.products.list) || [];
    const total = (data.products && data.products.total) || 0;
    this.setData({
      banners: data.banners || [],
      categories,
      seckill: data.seckill || [],
      products,
      hasMore: products.length < total,
      page: 1,
    });
    this.startCountdown();
  },

  // ===== 秒杀倒计时 =====

  startCountdown() {
    this.stopCountdown();
    const list = this.data.seckill;
    if (!list || list.length === 0) return;
    // 用最早结束的场次做倒计时
    const endTime = Math.min(...list.map(i => i.endTime));
    const tick = () => {
      const left = endTime - Date.now();
      if (left <= 0) {
        this.stopCountdown();
        this.setData({ seckill: [] }); // 到点下架秒杀模块
        return;
      }
      const h = String(Math.floor(left / 3600000)).padStart(2, '0');
      const m = String(Math.floor(left % 3600000 / 60000)).padStart(2, '0');
      const s = String(Math.floor(left % 60000 / 1000)).padStart(2, '0');
      this.setData({ countdown: { h, m, s } });
    };
    tick();
    this._countdownTimer = setInterval(tick, 1000);
  },

  stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  },

  // 点秒杀商品进详情
  onSeckillTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/product/detail?id=${id}` });
  },

  // 检查并展示营销弹窗，弹出频率由后台 frequency 字段决定：
  //   always         —— 每次打开都弹
  //   daily          —— 每天最多弹一次（默认）
  //   once_per_user  —— 每人只弹一次（关闭/领取后永久不再弹）
  async checkAndShowPopup() {
    try {
      const res = await wx.cloud.callFunction({ name: 'popup', data: { action: 'getActive' } });
      if (res.result.code !== 200 || !res.result.data) return;
      const popup = res.result.data;
      const frequency = popup.frequency || 'daily';

      if (frequency === 'once_per_user') {
        // 优先用"已领券"判断（优惠券弹窗），否则用本地标记
        if (popup.linkType === 'coupon' && popup.linkValue && app.globalData.openid) {
          try {
            const db = wx.cloud.database();
            const r = await db.collection('user_coupons')
              .where({ userId: app.globalData.openid, couponId: popup.linkValue })
              .count();
            if (r.total > 0) return; // 已领过，不弹
          } catch (e) { /* 查询失败不阻断 */ }
        }
        if (wx.getStorageSync('popup_done_' + popup._id)) return; // 本地已标记永久不弹
      } else if (frequency === 'daily') {
        const today = new Date().toDateString();
        if (wx.getStorageSync('popup_seen_' + popup._id) === today) return;
      }
      // frequency === 'always' 不做任何拦截

      this.setData({ popup, showPopup: true });
    } catch (e) {
      // 弹窗加载失败不影响主流程
    }
  },

  onPopupClose() {
    const popup = this.data.popup;
    if (popup) {
      const frequency = popup.frequency || 'daily';
      if (frequency === 'daily') {
        wx.setStorageSync('popup_seen_' + popup._id, new Date().toDateString());
      } else if (frequency === 'once_per_user') {
        wx.setStorageSync('popup_done_' + popup._id, true);
      }
      // always 不写标记
    }
    this.setData({ showPopup: false });
  },

  // 加载轮播图（从云数据库取）
  async loadBanners() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getBanners' }
      });
      if (res.result.code === 200) {
        this.setData({ banners: res.result.data });
      }
    } catch (err) {
      console.error('加载轮播图失败', err);
    }
  },

  // 加载商品列表
  async loadProducts(callback) {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: {
          action: 'getList',
          category: this.data.activeCategory,
          keyword: this.data.searchKeyword,
          page: this.data.page,
          pageSize: this.data.pageSize,
        }
      });

      if (res.result.code === 200) {
        const { list, total } = res.result.data;
        const merged = this.data.page === 1 ? list : [...this.data.products, ...list];
        this.setData({
          products: merged,
          hasMore: merged.length < total,
        });
      }
    } catch (err) {
      console.error('加载商品失败', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
      callback && callback();
    }
  },

  // 加载更多商品
  loadMore() {
    this.setData({ page: this.data.page + 1 });
    this.loadProducts();
  },

  // ===== 交互事件 =====

  // 切换商品分类
  onCategoryChange(e) {
    const categoryId = e.currentTarget.dataset.id;
    this.setData({ activeCategory: categoryId, page: 1, products: [] });
    this.loadProducts();
  },

  // 点击搜索入口跳搜索页（2026-07 UI 重设计：首页不再承担搜索）
  onGoSearch() {
    wx.navigateTo({ url: '/pages/search/index' });
  },

  // 跳转商品详情（来自 product-card 组件的 tap 事件）
  onProductTap(e) {
    const product = e.detail.product;
    if (!product) {
      wx.showToast({ title: '商品信息错误', icon: 'none' });
      return;
    }

    // 如果没有 _id，使用 name 作为 fallback
    const productId = product._id || product.name || 'unknown';

    wx.navigateTo({
      url: `/pages/product/detail?id=${productId}`
    });
  },

  // 加入购物车（来自 product-card 组件的 addcart 事件）
  onAddToCart(e) {
    const product = e.detail.product;
    if (!product) {
      wx.showToast({ title: '商品信息错误', icon: 'none' });
      return;
    }

    // 如果没有 _id，使用 name 作为 fallback
    const productId = product._id || product.name || 'unknown';

    const item = {
      productId: productId,
      name: product.name,
      image: product.mainImage,
      price: product.basePrice,
      unit: product.unit || 'kg',
      quantity: 1,
    };
    const cart = wx.getStorageSync('cart') || [];
    const key = this._cartKey(item);
    const idx = cart.findIndex(i => this._cartKey(i) === key);
    if (idx >= 0) {
      cart[idx].quantity += 1;
    } else {
      cart.push(item);
    }
    wx.setStorageSync('cart', cart);
    this.updateCartBadge();
    wx.showToast({ title: '已加入购物车', icon: 'success', duration: 1000 });
  },

  // 多规格商品点卡片「+」：弹出规格选择浮层
  onSpecRequest(e) {
    this.setData({ skuPickerProduct: e.detail.product, showSkuPicker: true });
  },

  // 关闭规格浮层
  onSkuClose() {
    this.setData({ showSkuPicker: false });
  },

  // 规格浮层确定：把 item 按去重 key 合并进购物车
  onSkuConfirm(e) {
    const item = e.detail.item;
    if (!item) return;
    const cart = wx.getStorageSync('cart') || [];
    const key = this._cartKey(item);
    const idx = cart.findIndex(i => this._cartKey(i) === key);
    if (idx >= 0) {
      cart[idx].quantity += item.quantity;
    } else {
      cart.push(item);
    }
    wx.setStorageSync('cart', cart);
    this.updateCartBadge();
    this.setData({ showSkuPicker: false });
    wx.showToast({ title: '已加入购物车', icon: 'success', duration: 1000 });
  },

  // 更新购物车角标
  async updateCartBadge() {
    const cart = wx.getStorageSync('cart') || [];
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    app.updateCartBadge(count);
  },

  // 功能入口跳转
  onGoFresh() { wx.navigateTo({ url: '/pages/fresh/index' }); },
  onGoCoupons() { wx.navigateTo({ url: '/pages/coupons/index' }); },
  onGoCheckin() { wx.navigateTo({ url: '/pages/checkin/index' }); },
  onGoHelp() { wx.navigateTo({ url: '/pages/help/index' }); },

  // 微信分享钩子：右上角"..."→"发给朋友"时触发
  onShareAppMessage() {
    return {
      title: '示例商城 - 优选好物，品质保证',
      path: '/pages/index/index',
      imageUrl: '',
    };
  },

  // 微信分享钩子：右上角"..."→"分享到朋友圈"时触发
  onShareTimeline() {
    return {
      title: '【示例商城】优选好物，品质保证',
      query: '',
    };
  },

});
