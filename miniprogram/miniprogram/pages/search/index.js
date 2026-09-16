// pages/search/index.js - 搜索页（2026-07 UI 重设计新增）
// 从首页搜索框跳转进来，独立承担搜索：历史记录 + 结果列表
// 搜索本身复用云函数 product/getList 的 keyword 参数，不新增后端接口

const app = getApp();

const HISTORY_KEY = 'search_history'; // 本地存储的搜索历史 key
const HISTORY_MAX = 10;               // 最多保留 10 条历史

Page({

  data: {
    keyword: '',        // 输入框当前内容
    history: [],        // 搜索历史（字符串数组）
    searched: false,    // 是否已执行过搜索（区分「初始页」和「无结果」）
    hotList: [],        // 园里热搜：按真实销量 Top5
    guessList: [],      // 猜你想搜：随机 2 个在售商品卡

    // 结果列表（与首页同一套分页逻辑）
    products: [],
    isLoading: false,
    hasMore: true,
    page: 1,
    pageSize: 10,

    // 多规格加购浮层
    showSkuPicker: false,
    skuPickerProduct: {},
  },

  // 购物车去重 key：与详情页/sku-picker 一致，单规格 skuId/specText 为空串
  _cartKey(item) {
    return (item.productId || '') + '|' + (item.skuId || '') + '|' + (item.specText || '');
  },

  onLoad(options) {
    // 支持带参跳转：/pages/search/index?keyword=xxx
    const history = wx.getStorageSync(HISTORY_KEY) || [];
    this.setData({ history });
    this.loadDiscover();
    if (options && options.keyword) {
      this.setData({ keyword: options.keyword });
      this.doSearch();
    }
  },

  // 加载「园里热搜 + 猜你想搜」：取第一页商品（与首页同参数，命中服务端同一份缓存）
  // 热搜 = 按 salesCount 真实销量排 Top5；猜你想搜 = 随机挑 2 个带图商品
  async loadDiscover() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getList', category: 'all', page: 1, pageSize: this.data.pageSize }
      });
      if (!res.result || res.result.code !== 200) return;
      const list = res.result.data.list || [];

      // 热搜：销量降序 Top5，销量第一且确实有销量的挂「热」标
      const hotList = [...list]
        .sort((a, b) => (b.salesCount || 0) - (a.salesCount || 0))
        .slice(0, 5)
        .map((p, i) => ({
          _id: p._id,
          name: p.name,
          hot: i === 0 && (p.salesCount || 0) > 0,
        }));

      // 猜你想搜：有主图的商品里随机挑 2 个（价格在 JS 里算好：多规格取最低 sku 价）
      const withImage = list.filter(p => p.mainImage);
      const shuffled = [...withImage].sort(() => Math.random() - 0.5).slice(0, 2);
      const guessList = shuffled.map(p => {
        let price = p.basePrice;
        if (p.hasSku && Array.isArray(p.skus) && p.skus.length) {
          const prices = p.skus.filter(s => s.isActive !== false).map(s => Number(s.price));
          if (prices.length) price = Math.min(...prices);
        }
        return { _id: p._id, name: p.name, mainImage: p.mainImage, guessPrice: price || '' };
      });

      this.setData({ hotList, guessList });
    } catch (e) {
      // 加载失败不影响搜索主流程，两个模块隐藏即可
      console.warn('loadDiscover error', e);
    }
  },

  // 猜你想搜卡片 → 商品详情
  onGuessTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/product/detail?id=${id}` });
  },

  // 触底加载更多
  onReachBottom() {
    if (this.data.hasMore && !this.data.isLoading && this.data.searched) {
      this.setData({ page: this.data.page + 1 });
      this.loadProducts();
    }
  },

  // ===== 搜索逻辑 =====

  onInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onConfirm() {
    this.doSearch();
  },

  onClearInput() {
    this.setData({ keyword: '', searched: false, products: [], page: 1, hasMore: true });
  },

  // 点历史标签直接搜
  onHistoryTap(e) {
    const kw = e.currentTarget.dataset.kw;
    this.setData({ keyword: kw });
    this.doSearch();
  },

  onClearHistory() {
    wx.removeStorageSync(HISTORY_KEY);
    this.setData({ history: [] });
  },

  // 执行搜索：写历史 + 拉第一页
  doSearch() {
    const kw = (this.data.keyword || '').trim();
    if (!kw) {
      wx.showToast({ title: '请输入搜索内容', icon: 'none' });
      return;
    }
    this.saveHistory(kw);
    this.setData({ searched: true, page: 1, products: [], hasMore: true });
    this.loadProducts();
  },

  // 保存搜索历史（去重 + 最新在前 + 截断）
  saveHistory(kw) {
    let history = wx.getStorageSync(HISTORY_KEY) || [];
    history = [kw, ...history.filter((h) => h !== kw)].slice(0, HISTORY_MAX);
    wx.setStorageSync(HISTORY_KEY, history);
    this.setData({ history });
  },

  // 拉取搜索结果（复用 product/getList 的 keyword 过滤）
  async loadProducts() {
    if (this.data.isLoading) return;
    this.setData({ isLoading: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: {
          action: 'getList',
          category: 'all',
          keyword: this.data.keyword.trim(),
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
      console.error('搜索失败', err);
      wx.showToast({ title: '搜索失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // ===== 结果卡片交互（与首页保持一致） =====

  onProductTap(e) {
    const product = e.detail.product;
    if (!product) {
      wx.showToast({ title: '商品信息错误', icon: 'none' });
      return;
    }
    const productId = product._id || product.name || 'unknown';
    wx.navigateTo({ url: `/pages/product/detail?id=${productId}` });
  },

  onAddToCart(e) {
    const product = e.detail.product;
    if (!product) {
      wx.showToast({ title: '商品信息错误', icon: 'none' });
      return;
    }
    const productId = product._id || product.name || 'unknown';

    const item = {
      productId: productId,
      name: product.name,
      image: product.mainImage,
      price: product.basePrice,
      unit: product.unit || 'kg',
      quantity: 1,
    };
    this._mergeCart(item);
  },

  // 多规格商品点卡片「+」：弹出规格选择浮层
  onSpecRequest(e) {
    this.setData({ skuPickerProduct: e.detail.product, showSkuPicker: true });
  },

  // 关闭规格浮层
  onSkuClose() {
    this.setData({ showSkuPicker: false });
  },

  // 规格浮层确定：把 item 合并进购物车
  onSkuConfirm(e) {
    if (!e.detail.item) return;
    this._mergeCart(e.detail.item);
    this.setData({ showSkuPicker: false });
  },

  // 按去重 key 合并进购物车 storage + 更新角标 + toast
  _mergeCart(item) {
    const cart = wx.getStorageSync('cart') || [];
    const key = this._cartKey(item);
    const idx = cart.findIndex((i) => this._cartKey(i) === key);
    if (idx >= 0) {
      cart[idx].quantity += item.quantity;
    } else {
      cart.push(item);
    }
    wx.setStorageSync('cart', cart);
    const count = cart.reduce((sum, i) => sum + i.quantity, 0);
    app.updateCartBadge(count);
    wx.showToast({ title: '已加入购物车', icon: 'success', duration: 1000 });
  },

});
