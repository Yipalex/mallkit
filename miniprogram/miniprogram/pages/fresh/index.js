// pages/fresh/index.js - 即时达页面
// 显示所有商品，与首页使用相同的分类

const app = getApp();

Page({
  data: {
    keyword: '',
    activeCategory: 0,
    categories: [
      { id: 'all', name: '全部' },
      { id: 'category_a', name: '推荐分类一' },
      { id: 'category_b', name: '推荐分类二' },
      { id: 'category_c', name: '推荐分类三' },
    ],
    products: [],
    loading: false,
    page: 1,
    pageSize: 20,
    hasMore: true,
    // 规格选择
    showSpecModal: false,
    currentProduct: null,
    specSelections: {},
    selectedSpecText: '',
    // 添加动画状态
    addedProductId: null,
    // 底部玻璃购物条
    cartCount: 0,
    cartTotal: '0.00',
  },

  onLoad() {
    // 加载分类（与首页保持一致）
    this.loadCategories();
    // 加载商品
    this.loadProducts();
  },

  onShow() {
    this.updateCartBar();
  },

  // 底部购物条：读本地购物车算件数和合计
  updateCartBar() {
    const cart = wx.getStorageSync('cart') || [];
    const cartCount = cart.reduce((s, c) => s + (c.quantity || 0), 0);
    const cartTotal = cart.reduce((s, c) => s + (Number(c.price) || 0) * (c.quantity || 0), 0).toFixed(2);
    this.setData({ cartCount, cartTotal });
  },

  onGoCheckout() {
    wx.switchTab({ url: '/pages/cart/index' });
  },

  noop() {},

  // 加载分类（与首页相同的逻辑）
  async loadCategories() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('categories')
        .where({ isActive: true })
        .orderBy('sort', 'asc')
        .get();

      const categories = [{ id: 'all', name: '全部' }, ...res.data.map(c => ({ id: c._id, name: c.name }))];
      this.setData({ categories });
    } catch (err) {
      console.error('加载分类失败，使用默认分类', err);
      // 使用默认分类 - 与首页一致
      this.setData({
        categories: [
          { id: 'all', name: '全部' },
          { id: 'category_a', name: '推荐分类一' },
          { id: 'category_b', name: '推荐分类二' },
          { id: 'category_c', name: '推荐分类三' },
        ]
      });
    }
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value, page: 1, products: [], hasMore: true });
    this.loadProducts();
  },

  onCategoryTap(e) {
    this.setData({ activeCategory: e.currentTarget.dataset.index, page: 1, products: [], hasMore: true });
    this.loadProducts();
  },

  async loadProducts() {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ loading: true });

    try {
      const { activeCategory, categories, keyword, page, pageSize } = this.data;
      const categoryId = categories[activeCategory].id;

      // 调用云函数获取商品（与首页相同的逻辑）
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: {
          action: 'getList',
          category: categoryId === 'all' ? undefined : categoryId,
          keyword: keyword || undefined,
          page: page,
          pageSize: pageSize
        }
      });

      if (res.result && res.result.code === 200) {
        const newList = page === 1 ? res.result.data.list : [...this.data.products, ...res.result.data.list];

        // 计算会员价 + 是否售罄，添加到商品数据中
        const productsWithVipPrice = newList.map(product => {
          let vipPrice = '';
          if (product.memberDiscount && product.memberDiscount.level1) {
            vipPrice = (product.basePrice * product.memberDiscount.level1).toFixed(1);
          }
          // 售罄判断：多规格全部 active sku 无货；单规格 stock<=0
          let isSoldOut;
          if (product.hasSku && Array.isArray(product.skus) && product.skus.length) {
            const active = product.skus.filter(s => s.isActive !== false);
            isSoldOut = active.length === 0 || active.every(s => Number(s.stock) <= 0);
          } else {
            isSoldOut = Number(product.stock) <= 0;
          }
          return {
            ...product,
            vipPrice: vipPrice,
            isSoldOut,
          };
        });

        this.setData({
          products: productsWithVipPrice,
          loading: false,
          hasMore: productsWithVipPrice.length < res.result.data.total,
          page: page + 1
        });
      } else {
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error('加载商品失败', err);
      this.setData({ loading: false });
    }
  },

  onLoadMore() {
    this.loadProducts();
  },

  onProductTap(e) {
    const productId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/product/detail?id=${productId}` });
  },

  // 选择规格
  onSelectSpec(e) {
    const item = e.currentTarget.dataset.item;
    console.log('选择规格，商品:', item);

    if (!item.specs || item.specs.length === 0) {
      // 没有规格，直接加入购物车
      this.onAddCart(e);
      return;
    }

    // 有规格，显示规格选择弹窗
    this.setData({
      currentProduct: item,
      showSpecModal: true,
      specSelections: {},
      selectedSpecText: ''
    });
  },

  // 选择具体规格
  onSpecOptionTap(e) {
    const { group, index } = e.currentTarget.dataset;
    const specSelections = { ...this.data.specSelections, [group]: index };

    // 生成已选规格文本
    const { currentProduct } = this.data;
    const parts = (currentProduct.specs || []).map((spec, gi) => {
      const vi = specSelections[gi];
      return vi !== undefined ? spec.values[vi] : null;
    }).filter(Boolean);

    this.setData({
      specSelections,
      selectedSpecText: parts.join('・')
    });
  },

  // 关闭规格弹窗
  onCloseSpecModal() {
    this.setData({ showSpecModal: false });
  },

  // 从规格弹窗加入购物车
  onAddCartFromModal() {
    const { currentProduct, selectedSpecText } = this.data;

    // 检查是否选择了所有规格
    if (currentProduct.specs && currentProduct.specs.length > 0 && !selectedSpecText) {
      wx.showToast({
        title: '请选择规格',
        icon: 'none'
      });
      return;
    }

    // 加入购物车
    this.addToCart(currentProduct, selectedSpecText);

    // 关闭弹窗
    this.setData({ showSpecModal: false });
  },

  onAddCart(e) {
    const item = e.currentTarget.dataset.item;

    // 如果有规格且未选择规格，显示规格选择
    if (item.specs && item.specs.length > 0) {
      this.onSelectSpec(e);
      return;
    }

    // 没有规格或规格已选，直接加入购物车
    this.addToCart(item, '');
  },

  // 加入购物车逻辑
  addToCart(item, specText) {
    const cart = wx.getStorageSync('cart') || [];

    // 生成唯一key（考虑规格）
    const key = item._id + (specText || '');
    const idx = cart.findIndex(c => (c.productId + (c.specText || '')) === key);

    if (idx >= 0) {
      cart[idx].quantity += 1;
    } else {
      cart.push({
        productId: item._id,
        name: item.name,
        image: item.mainImage,
        price: item.basePrice,
        unit: item.unit || 'kg',
        quantity: 1,
        specText: specText || '',
      });
    }

    wx.setStorageSync('cart', cart);

    const total = cart.reduce((s, c) => s + c.quantity, 0);
    if (app.updateCartBadge) app.updateCartBadge(total);

    // 触发动画 + 刷新底部购物条
    this.setData({ addedProductId: item._id });
    this.updateCartBar();

    // 动画结束后重置
    setTimeout(() => {
      this.setData({ addedProductId: null });
    }, 600);

    wx.showToast({ title: '已加入购物车', icon: 'success' });
  }
});
