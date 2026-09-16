// pages/order/detail.js - V2
const app = getApp();

Page({
  data: {
    order: null,
    isLoading: true,
    createTimeText: '',
    payTimeText: '',
  },

  _pollTimer: null,   // 支付后轮询定时器

  onLoad(options) {
    this.orderId = options.id;
    this.loadOrder(options.id);

    // 从支付页跳转过来时，轮询等待回调处理（微信回调有延迟）
    if (options.justPaid === '1') {
      this._startPollForPaid(options.id);
    }
  },

  onUnload() {
    // 离开页面时清除轮询
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  },

  // 支付后轮询：最多轮询10次，每2秒一次，直到状态变为paid
  _startPollForPaid(orderId) {
    let attempts = 0;
    const maxAttempts = 10;

    const poll = async () => {
      if (attempts >= maxAttempts) return;
      attempts++;

      try {
        // 主动让后端从微信支付侧拉真实状态并同步到 DB（避免依赖回调）
        await wx.cloud.callFunction({
          name: 'pay',
          data: { action: 'queryOrder', orderId }
        }).catch(() => {});

        // 然后重新读 DB 中的订单
        const res = await wx.cloud.callFunction({
          name: 'order',
          data: { action: 'getDetail', orderId }
        });
        if (res.result.code === 200) {
          const order = res.result.data;
          if (order.status !== 'pending_payment') {
            this.setData({
              order,
              createTimeText: this.formatDate(order.createTime),
              payTimeText: this.formatDate(order.paymentTime),
            });
            return; // 停止轮询
          }
        }
      } catch (e) { /* 忽略轮询错误 */ }

      // 继续轮询
      this._pollTimer = setTimeout(poll, 2000);
    };

    // 2秒后开始第一次轮询（给回调处理一点时间）
    this._pollTimer = setTimeout(poll, 2000);
  },

  async loadOrder(orderId) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getDetail', orderId }
      });
      if (res.result.code === 200) {
        const order = res.result.data;
        this.setData({
          order,
          isLoading: false,
          createTimeText: this.formatDate(order.createTime),
          payTimeText: this.formatDate(order.paymentTime),
        });
        wx.setNavigationBarTitle({ title: '订单详情' });
      }
    } catch (err) {
      console.error(err);
      this.setData({ isLoading: false });
    }
  },

  formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // 查看物流轨迹（调用微信官方物流查询插件）
  async onTrackLogistics() {
    const { order } = this.data;
    if (!order || !order.expressNo) {
      wx.showToast({ title: '暂无物流信息', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '查询中...' });
    try {
      // waybillToken 不缓存：每次都向云函数换取最新 token，
      // 否则发货初期生成的「空轨迹」token 会让用户永远看到「暂无轨迹」
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getWaybillToken', orderId: order._id }
      });
      const waybillToken = res.result?.data?.waybillToken || '';
      wx.hideLoading();
      if (!waybillToken) {
        wx.showToast({ title: '物流信息暂未同步，请稍后重试', icon: 'none' });
        return;
      }
      const logisticsPlugin = requirePlugin('logisticsPlugin');
      logisticsPlugin.openWaybillTracking({ waybillToken });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '查询失败，请稍后重试', icon: 'none' });
    }
  },

  // 复制快递单号（多包裹时传 data-index，单包裹时不传）
  onCopyTracking(e) {
    const { order } = this.data;
    let no;
    if (order.packages && order.packages.length > 1) {
      const idx = e.currentTarget.dataset.index ?? 0;
      no = order.packages[idx]?.expressNo || '';
    } else {
      no = order.expressNo || order.trackingNumber || '';
    }
    if (!no) return;
    wx.setClipboardData({
      data: no,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  },

  // 点击商品跳详情
  onProductTap(e) {
    wx.navigateTo({ url: `/pages/product/detail?id=${e.currentTarget.dataset.id}` });
  },

  // 申请退款
  onApplyRefund() {
    const { order } = this.data;
    wx.showModal({
      title: '申请退款',
      content: `确定申请退款 ¥${order.finalPrice}？\n退款申请提交后，商家将在1-3个工作日内审核处理。`,
      confirmText: '确认申请',
      cancelText: '再想想',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '提交中...' });
        try {
          const result = await wx.cloud.callFunction({
            name: 'pay',
            data: { action: 'refund', orderId: order._id, reason: '用户申请退款' }
          });
          wx.hideLoading();
          if (result.result.code === 200) {
            wx.showToast({ title: '退款申请已提交', icon: 'success' });
            setTimeout(() => this.loadOrder(order._id), 1500);
          } else {
            wx.showModal({ title: '申请失败', content: result.result.message, showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '网络错误，请重试', icon: 'none' });
        }
      }
    });
  },

  // 取消订单
  onCancelOrder() {
    wx.showModal({
      title: '取消订单',
      content: '确定要取消该订单吗？',
      success: async (res) => {
        if (res.confirm) {
          await wx.cloud.callFunction({
            name: 'order',
            data: { action: 'updateStatus', orderId: this.data.order._id, status: 'cancelled' }
          });
          wx.showToast({ title: '订单已取消', icon: 'success' });
          this.loadOrder(this.data.order._id);
        }
      }
    });
  },

  // 继续支付
  async onContinuePay() {
    const order = this.data.order;
    try {
      wx.showLoading({ title: '唤起支付...' });
      const payRes = await wx.cloud.callFunction({
        name: 'pay',
        data: { orderId: order._id, totalAmount: order.finalPrice }
      });
      wx.hideLoading();

      if (payRes.result.code !== 200) {
        wx.showToast({ title: payRes.result.message, icon: 'none' });
        return;
      }

      const p = payRes.result.data;
      wx.requestPayment({
        timeStamp: p.timeStamp,
        nonceStr: p.nonceStr,
        package: p.package,
        signType: 'RSA',
        paySign: p.paySign,
        success: () => {
          wx.showToast({ title: '支付成功', icon: 'success' });
          setTimeout(() => this.loadOrder(order._id), 1500);
        },
        fail: (err) => {
          if (!err.errMsg.includes('cancel')) {
            wx.showToast({ title: '支付失败', icon: 'none' });
          }
        }
      });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '系统错误', icon: 'none' });
    }
  },

  // 确认收货
  onConfirmReceive() {
    wx.showModal({
      title: '确认收货',
      content: '确认已收到商品？',
      success: async (res) => {
        if (res.confirm) {
          await wx.cloud.callFunction({
            name: 'order',
            data: { action: 'updateStatus', orderId: this.data.order._id, status: 'completed' }
          });
          wx.showToast({ title: '已确认收货', icon: 'success' });
          this.loadOrder(this.data.order._id);
        }
      }
    });
  },

  // 去评价（跳转到评价页，带上订单ID和第一个商品信息）
  onGoReview() {
    const { order } = this.data;
    if (!order || !order.items || order.items.length === 0) return;
    const firstItem = order.items[0];
    wx.navigateTo({
      url: `/pages/review/add?orderId=${order._id}&productId=${firstItem.productId}&productName=${encodeURIComponent(firstItem.productName || firstItem.name || '')}`
    });
  },

  // 再次购买
  onBuyAgain() {
    const { items } = this.data.order;
    const cart = wx.getStorageSync('cart') || [];
    items.forEach(item => {
      const idx = cart.findIndex(c => c.productId === item.productId);
      if (idx >= 0) {
        cart[idx].quantity += item.quantity;
      } else {
        cart.push({
          productId: item.productId,
          name: item.productName || item.name,
          image: item.image,
          price: item.unitPrice,
          unit: item.unit || 'kg',
          quantity: item.quantity,
        });
      }
    });
    wx.setStorageSync('cart', cart);
    if (app.updateCartBadge) {
      app.updateCartBadge(cart.reduce((s, c) => s + c.quantity, 0));
    }
    wx.showToast({ title: '已加入购物车', icon: 'success' });
    setTimeout(() => wx.switchTab({ url: '/pages/cart/index' }), 1500);
  },
});
