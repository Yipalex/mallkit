// pages/cart/index.js - 购物车页面（支持云同步）

const app = getApp();
const SWIPE_THRESHOLD = 80;   // 触发展开的最小滑动距离(px)
const DELETE_WIDTH = 160;     // 删除按钮宽度(rpx → 约80px)

// 购物车去重 key：同一商品的同一规格才算同一项（与商品详情页加购去重保持一致）
function cartKey(item) {
  return (item.productId || '') + '|' + (item.skuId || '') + '|' + (item.specText || '');
}

// 合并两份购物车：按 cartKey 去重，同项数量取两边最大值（避免重复累加、又不丢任何一端的新增项）
function mergeCarts(listA, listB) {
  const map = new Map();
  for (const item of [...(listA || []), ...(listB || [])]) {
    if (!item || !item.productId) continue;
    const key = cartKey(item);
    const existing = map.get(key);
    if (existing) {
      existing.quantity = Math.max(existing.quantity || 0, item.quantity || 0);
    } else {
      map.set(key, { ...item });
    }
  }
  return Array.from(map.values());
}

Page({
  data: {
    cartItems: [],       // 购物车列表
    totalPrice: 0,       // 合计金额
    selectedCount: 0,    // 选中商品件数
    selectedAll: true,   // 是否全选
    syncing: false,      // 同步状态
    couponHint: '',      // 凑单提示条文案（如：再买 ¥20.10 可用「满100减15」券）
    checkoutSub: '全场包邮',  // 结算栏副行（可减金额/包邮说明）
    recommends: [],      // 为你推荐商品
  },
  _touchStartX: 0,
  _touchIndex: -1,

  onShow() {
    // 自定义底栏高亮跟随当前页（组件 pageLifetimes 不可靠，页面主动通知）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateSelected();
    }
    // 每次显示页面重新读取购物车（优先从云端获取）
    this.loadCart();
    this.loadCoupons();
    this.loadRecommends();
  },

  // 加载用户优惠券（只取一次），用于凑单提示条
  async loadCoupons() {
    if (this._coupons) {
      this.updateCouponHint();
      return;
    }
    if (app.waitForLogin) await app.waitForLogin();
    if (!app.globalData.openid) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getUserCoupons', userId: app.globalData.openid }
      });
      if (res.result && res.result.code === 200) {
        this._coupons = (res.result.data || []).filter(c => !c.expired && !c.used);
        this.updateCouponHint();
      }
    } catch (e) {
      console.error('加载优惠券失败:', e);
    }
  },

  // 凑单提示 + 结算栏副行：
  // - couponHint：门槛高于当前合计、差额最小的一张券 →「再买 ¥X 可用「满A减B」券」
  // - checkoutSub：已达门槛的券里减得最多的 →「结算可减 ¥X · 全场包邮」，没有则只显示包邮
  updateCouponHint() {
    const coupons = this._coupons || [];
    const total = parseFloat(this.data.totalPrice) || 0;
    let best = null;       // 最近的没够门槛的券
    let usable = 0;        // 已够门槛的券里最大的立减金额（仅固定金额券）
    for (const c of coupons) {
      const min = c.minPurchase || 0;
      if (min > total) {
        const gap = min - total;
        if (!best || gap < best.gap) best = { gap, coupon: c };
      } else if (c.discountType === 'fixed' && Number(c.discountValue) > usable) {
        usable = Number(c.discountValue);
      }
    }
    let couponHint = '';
    if (best && total > 0) {
      const c = best.coupon;
      const label = c.discountType === 'fixed'
        ? `满${c.minPurchase}减${c.discountValue}`
        : (c.name || '优惠');
      couponHint = `再买 ¥${best.gap.toFixed(2)} 可用「${label}」券`;
    }
    const checkoutSub = (usable > 0 && total > 0) ? `结算可减 ¥${usable} · 全场包邮` : '全场包邮';
    this.setData({ couponHint, checkoutSub });
  },

  // 去凑单：回首页逛
  onGoMakeUp() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 为你推荐（只取一次，4 个商品）
  async loadRecommends() {
    if (this._recLoaded) return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getList', page: 1, pageSize: 4 }
      });
      if (res.result && res.result.code === 200) {
        this._recLoaded = true;
        // 商品价格字段是 basePrice（多规格取 skus 最低价），在 JS 里算好
        const recommends = (res.result.data.list || []).slice(0, 4).map(p => {
          let recPrice = p.basePrice;
          if (p.hasSku && Array.isArray(p.skus) && p.skus.length) {
            const prices = p.skus.filter(s => s.isActive !== false).map(s => Number(s.price));
            if (prices.length) recPrice = Math.min(...prices);
          }
          return { ...p, recPrice: recPrice || p.price || '' };
        });
        this.setData({ recommends });
      }
    } catch (e) {
      console.error('加载推荐商品失败:', e);
    }
  },

  // 给购物车项补齐展示字段（key/规格chip/选中/小计）
  _decorate(list) {
    return (list || []).map(item => ({
      ...item,
      uniqueKey: cartKey(item),   // 多规格下 productId 会重复，列表 key 用 productId|skuId|specText
      specChip: item.specText || item.unit || '',  // 规格 chip：无规格时兜底显示单位
      selected: true,
      subtotal: (item.price * item.quantity).toFixed(2)
    }));
  },

  // 加载购物车数据（云同步 + 本地缓存双重保障）
  loadCart() {
    this.setData({ syncing: true });

    const localCart = wx.getStorageSync('cart') || [];

    // 先按本地渲染——本地为空也必须渲染空列表！
    // 修复：结算完成后本地已清空，但这里原来只在"本地有商品"时才 setData，
    // 页面留在导航栈里的旧 cartItems 没被清掉，回到购物车看起来"商品还在"。
    this.setData({ cartItems: this._decorate(localCart) });
    this.calcTotal();

    // 刚结算/上次云同步失败：本地是准绳，直接用本地覆盖云端，跳过合并。
    // 否则云端的旧数据会通过下面的 merge 把已购商品"复活"回购物车。
    if (wx.getStorageSync('cartNeedsSync')) {
      this.syncToCloud(this.data.cartItems);   // syncToCloud 成功后会清掉 cartNeedsSync 标记
      this.setData({ syncing: false });
      return;
    }

    // 然后从云端同步（确保最新数据）
    wx.cloud.callFunction({
      name: 'cart',
      data: { action: 'get' }
    }).then(res => {
      if (res.result.code === 200) {
        const cloudItems = res.result.data || [];
        if (cloudItems.length > 0 && localCart.length > 0) {
          // 云端和本地都有数据：按 productId+skuId+specText 合并去重，数量取两边最大值。
          // 不能用云端直接覆盖，否则会丢弃本地刚加入、还没同步上云的商品。
          const merged = mergeCarts(localCart, cloudItems);
          const cartItems = this._decorate(merged);
          this.setData({ cartItems });
          // 合并结果回写本地 + 同步上云，三端一致
          this.saveCartToLocal(cartItems);
          this.syncToCloud(cartItems);
        } else if (cloudItems.length === 0 && localCart.length > 0) {
          // 云端无数据但有本地数据，上传到云端
          this.syncToCloud(localCart);
        } else if (cloudItems.length > 0 && localCart.length === 0) {
          // 本地空、云端有：跨设备 / 重装小程序场景，从云端恢复。
          // 刚结算完的场景已被上面的 cartNeedsSync 分支拦截，这里恢复是安全的。
          const cartItems = this._decorate(cloudItems);
          this.setData({ cartItems });
          this.saveCartToLocal(cartItems);
        }
        this.calcTotal();
      }
    }).catch(err => {
      console.error('加载云端购物车失败:', err);
      // 云端加载失败，继续使用本地数据
    }).finally(() => {
      this.setData({ syncing: false });
    });
  },

  // 保存购物车到本地缓存（去除 UI 临时字段）
  saveCartToLocal(cartItems) {
    const toSave = cartItems.map(item => ({
      productId: item.productId,
      skuId: item.skuId || '',       // 多规格：保留 skuId 供下单按规格扣款
      name: item.name,
      image: item.image,
      price: item.price,
      unit: item.unit,
      quantity: item.quantity,
      specText: item.specText || '',
    }));
    wx.setStorageSync('cart', toSave);
  },

  // 同步购物车到云端。失败时留下 cartNeedsSync 标记，
  // 下次进购物车页会以本地为准重推云端（防止云端旧数据在合并时复活）。
  syncToCloud(items) {
    const toSync = items.map(item => ({
      productId: item.productId,
      skuId: item.skuId || '',
      name: item.name,
      image: item.image,
      price: item.price,
      unit: item.unit,
      quantity: item.quantity,
      specText: item.specText || '',
    }));

    wx.setStorageSync('cartNeedsSync', true);
    wx.cloud.callFunction({
      name: 'cart',
      data: { action: 'sync', items: toSync }
    }).then(res => {
      if (res.result && res.result.code === 200) {
        wx.removeStorageSync('cartNeedsSync');
      }
    }).catch(err => {
      console.error('同步到云端失败（已留标记，下次进购物车重试）:', err);
    });
  },

  // 计算选中商品的总价和件数
  calcTotal() {
    const selected = this.data.cartItems.filter(item => item.selected);
    const total = selected.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const selectedCount = selected.reduce((sum, item) => sum + item.quantity, 0);
    this.setData({ totalPrice: total.toFixed(2), selectedCount });
    // 合计变化后刷新凑单提示
    this.updateCouponHint();
  },

  // 切换单个商品选中状态
  onToggleSelect(e) {
    const index = e.currentTarget.dataset.index;
    const cartItems = this.data.cartItems;
    cartItems[index].selected = !cartItems[index].selected;
    const selectedAll = cartItems.every(item => item.selected);
    this.setData({ cartItems, selectedAll });
    this.calcTotal();
  },

  // 全选/取消全选
  onToggleSelectAll() {
    const selectedAll = !this.data.selectedAll;
    const cartItems = this.data.cartItems.map(item => ({ ...item, selected: selectedAll }));
    this.setData({ cartItems, selectedAll });
    this.calcTotal();
  },

  // 改变商品数量
  onQuantityChange(e) {
    const { index, action } = e.currentTarget.dataset;
    const cartItems = this.data.cartItems;
    if (action === 'minus') {
      if (cartItems[index].quantity <= 1) {
        // 数量为1时再减，弹出确认删除
        this.onDeleteItem({ currentTarget: { dataset: { index } } });
        return;
      }
      cartItems[index].quantity--;
    } else {
      cartItems[index].quantity++;
    }
    cartItems[index].subtotal = (cartItems[index].price * cartItems[index].quantity).toFixed(2);
    this.setData({ cartItems });
    this.saveCart();
    this.calcTotal();
  },

  // 删除商品
  onDeleteItem(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.cartItems[index];

    wx.showModal({
      title: '提示',
      content: '确认删除该商品？',
      success: (res) => {
        if (res.confirm) {
          const cartItems = this.data.cartItems;
          cartItems.splice(index, 1);
          this.setData({ cartItems });
          // saveCart 内的 syncToCloud 会全量覆盖云端，不再单独调 remove——
          // 原来 remove(按 productId) 和全量 sync 并发写云端有竞态，且会误删同商品的其他规格
          this.saveCart();

          this.calcTotal();
          app.updateCartBadge(cartItems.reduce((sum, item) => sum + item.quantity, 0));
        }
      }
    });
  },

  // 保存购物车（本地 + 云端同步）
  saveCart() {
    // 保存到本地缓存
    this.saveCartToLocal(this.data.cartItems);

    // 同步到云端
    this.syncToCloud(this.data.cartItems);
  },

  // 点击商品图片跳转详情
  onItemTap(e) {
    wx.navigateTo({ url: `/pages/product/detail?id=${e.currentTarget.dataset.id}` });
  },

  // 左滑删除 — 触摸事件
  onTouchStart(e) {
    this._touchStartX = e.touches[0].clientX;
    this._touchIndex = e.currentTarget.dataset.index;
    // 关闭其他已展开的项
    const cartItems = this.data.cartItems.map((item, i) => {
      if (i !== this._touchIndex && item.offsetX) {
        return { ...item, offsetX: 0, transitioning: true };
      }
      return item;
    });
    this.setData({ cartItems });
  },

  onTouchMove(e) {
    const dx = e.touches[0].clientX - this._touchStartX;
    const idx = this._touchIndex;
    if (idx < 0) return;
    // 只允许向左滑（负值），最多滑 DELETE_WIDTH px
    const offsetPx = Math.max(-DELETE_WIDTH / 2, Math.min(0, dx));
    // 转换为 rpx（设备像素比约2）
    const offsetRpx = offsetPx * 2;
    const cartItems = [...this.data.cartItems];
    cartItems[idx] = { ...cartItems[idx], offsetX: offsetRpx, transitioning: false };
    this.setData({ cartItems });
  },

  onTouchEnd(e) {
    const idx = this._touchIndex;
    if (idx < 0) return;
    const current = this.data.cartItems[idx].offsetX || 0;
    // 超过一半宽度则展开，否则收起
    const snap = current < -DELETE_WIDTH / 2 ? -DELETE_WIDTH : 0;
    const cartItems = [...this.data.cartItems];
    cartItems[idx] = { ...cartItems[idx], offsetX: snap, transitioning: true };
    this.setData({ cartItems });
    this._touchIndex = -1;
  },

  // 清空购物车
  onClearCart() {
    wx.showModal({
      title: '清空购物车',
      content: '确定要清空所有商品吗？',
      confirmText: '清空',
      confirmColor: '#F44336',
      success: (res) => {
        if (res.confirm) {
          this.setData({ cartItems: [], totalPrice: '0.00', selectedCount: 0, selectedAll: true });
          wx.setStorageSync('cart', []);
          app.updateCartBadge(0);
          // 云端清空失败时留标记，下次进页面以本地(空)为准重推，防止旧数据恢复
          wx.setStorageSync('cartNeedsSync', true);
          wx.cloud.callFunction({
            name: 'cart',
            data: { action: 'clear' }
          }).then(r => {
            if (r.result && r.result.code === 200) wx.removeStorageSync('cartNeedsSync');
          }).catch(err => console.error('云端清空失败（已留标记）:', err));
        }
      }
    });
  },

  // 结算
  onCheckout() {
    const selectedItems = this.data.cartItems.filter(item => item.selected);
    if (selectedItems.length === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' });
      return;
    }
    // 将选中的商品存入临时数据，跳转结算页
    wx.setStorageSync('checkoutItems', selectedItems);
    wx.navigateTo({ url: '/pages/order/pay?from=cart' });
  },
});
