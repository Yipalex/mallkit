// pages/order/list.js - 订单列表页
// 注意：WXML 不支持字符串下标/方法调用，摘要文字一律在 JS 里算好再 setData

const app = getApp();

// 订单状态 → 展示文案（与「我的」页快捷入口叫法一致）
const STATUS_TEXT = {
  pending_payment: '待付款',
  paid: '待发货',
  shipped: '待收货',
  completed: '已完成',
  cancelled: '已取消',
  refund_pending: '退款审核中',
  refunded: '已退款',
};

Page({
  data: {
    // 标签页（顺序与 statusList 对应）
    tabs: ['全部', '待付款', '待发货', '待收货', '已完成'],
    activeTab: 0,

    orders: [],
    isLoading: false,
    showLoginGuide: false,
  },

  onLoad(options) {
    this.checkLoginAndLoad(options);
  },

  onShow() {
    // 每次进入页面刷新订单列表（支付后状态会更新）
    if (!this.data.showLoginGuide) {
      this.loadOrders();
    }
  },

  // 检查登录状态：有 openid 即视为已登录，不再强依赖头像/昵称授权
  async checkLoginAndLoad(options) {
    await app.waitForLogin();

    if (!app.globalData.isLogin) {
      this.setData({ showLoginGuide: true, isLoading: false });
      return;
    }

    // 支持从"我的"页带 status 参数直接定位 tab
    if (options && options.status) {
      const statusList = [null, 'pending_payment', 'paid', 'shipped', 'completed'];
      const idx = statusList.indexOf(options.status);
      if (idx >= 0) this.setData({ activeTab: idx });
    }
    this.loadOrders();
  },

  // 切换标签
  onTabChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ activeTab: index, orders: [] });
    this.loadOrders();
  },

  async loadOrders() {
    this.setData({ isLoading: true });
    const statusList = [null, 'pending_payment', 'paid', 'shipped', 'completed'];
    const status = statusList[this.data.activeTab];

    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: {
          action: 'list',
          status,
          userId: app.globalData.openid,
        }
      });
      if (res.result.code === 200) {
        const fmtDate = (t) => {
          if (!t) return '';
          const ms = t.$date ? Number(t.$date) : (typeof t === 'number' ? t : new Date(t).getTime());
          if (!ms) return '';
          const d = new Date(ms);
          const p = n => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        };
        const orders = res.result.data.map(o => {
          const items = (o.items || []).map(item => ({
            ...item,
            name: item.productName || item.name,
            price: item.unitPrice || item.price,
          }));
          const first = items[0] || {};
          const createTime = fmtDate(o.createTime);
          // 摘要标题：首件商品名 + 「等 N 件」
          const firstName = first.name || '商品';
          const summaryTitle = items.length > 1 ? `${firstName} 等 ${items.length} 件` : firstName;
          // 副标题：待付款显示支付截止时间，待收货显示快递公司+运单号，已完成显示日期，其余显示下单时间
          let subText = createTime;
          if (o.status === 'pending_payment' && o.paymentExpireTime) {
            const expire = fmtDate(o.paymentExpireTime);
            if (expire) subText = `${expire.slice(11)} 前未支付将自动取消`;
          } else if (o.status === 'shipped' && o.expressNo) {
            subText = `${o.expressCompany ? o.expressCompany + ' · ' : ''}运单 ${o.expressNo}`;
          } else if (o.status === 'completed' && createTime) {
            subText = `${createTime.slice(5, 10).replace('-', '月')}日 已完成`;
          }
          return {
            ...o,
            items,
            statusText: STATUS_TEXT[o.status] || o.status,
            totalAmount: o.finalPrice,
            createTime,
            firstImage: first.image || '',
            summaryTitle,
            subText,
          };
        });
        this.setData({ orders });
      }
    } catch (err) {
      console.error('加载订单失败', err);
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 跳转订单详情
  onOrderTap(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/order/detail?id=${orderId}` });
  },

  // 继续支付（待付款订单）
  async onContinuePay(e) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find(o => o._id === orderId);
    if (!order) return;

    try {
      wx.showLoading({ title: '唤起支付...' });
      const payRes = await wx.cloud.callFunction({
        name: 'pay',
        data: { orderId, totalAmount: order.finalPrice, userId: app.globalData.openid }
      });
      wx.hideLoading();

      if (payRes.result.code !== 200) {
        wx.showToast({ title: payRes.result.message, icon: 'none' });
        return;
      }

      const p = payRes.result.data;
      wx.requestPayment({
        timeStamp: p.timeStamp, nonceStr: p.nonceStr, package: p.package,
        signType: 'RSA', paySign: p.paySign,
        success: () => {
          wx.showToast({ title: '支付成功', icon: 'success' });
          setTimeout(() => this.loadOrders(), 1500);
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

  // 取消单笔订单（待付款）
  onCancelOrder(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消订单',
      content: '确定要取消该订单吗？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await wx.cloud.callFunction({
            name: 'order',
            data: { action: 'cancelOrder', orderId }
          });
          wx.showToast({ title: '订单已取消', icon: 'success' });
          setTimeout(() => this.loadOrders(), 1000);
        } catch (err) {
          wx.showToast({ title: '取消失败，请重试', icon: 'none' });
        }
      }
    });
  },

  noop() {},

  // 申请退款（待发货订单，与详情页同款逻辑）
  onApplyRefund(e) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find(o => o._id === orderId);
    if (!order) return;
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
            data: { action: 'refund', orderId, reason: '用户申请退款' }
          });
          wx.hideLoading();
          if (result.result.code === 200) {
            wx.showToast({ title: '退款申请已提交', icon: 'success' });
            setTimeout(() => this.loadOrders(), 1500);
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

  // 查看物流轨迹（与详情页同款：每次换取最新 waybillToken）
  async onTrackLogistics(e) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find(o => o._id === orderId);
    if (!order || !order.expressNo) {
      wx.showToast({ title: '暂无物流信息', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '查询中...' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'order',
        data: { action: 'getWaybillToken', orderId }
      });
      const waybillToken = res.result?.data?.waybillToken || '';
      wx.hideLoading();
      if (!waybillToken) {
        wx.showToast({ title: '物流信息暂未同步，请稍后重试', icon: 'none' });
        return;
      }
      const logisticsPlugin = requirePlugin('logisticsPlugin');
      logisticsPlugin.openWaybillTracking({ waybillToken });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '查询失败，请稍后重试', icon: 'none' });
    }
  },

  // 确认收货（待收货 → 已完成）
  onConfirmReceive(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认收货',
      content: '确认已收到商品？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await wx.cloud.callFunction({
            name: 'order',
            data: { action: 'updateStatus', orderId, status: 'completed' }
          });
          wx.showToast({ title: '已确认收货', icon: 'success' });
          setTimeout(() => this.loadOrders(), 1000);
        } catch (err) {
          wx.showToast({ title: '操作失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // 再次购买：整单商品加回购物车（与详情页同款逻辑）
  onBuyAgain(e) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find(o => o._id === orderId);
    if (!order || !order.items || order.items.length === 0) return;

    const cart = wx.getStorageSync('cart') || [];
    order.items.forEach(item => {
      const idx = cart.findIndex(c => c.productId === item.productId);
      if (idx >= 0) {
        cart[idx].quantity += item.quantity;
      } else {
        cart.push({
          productId: item.productId,
          name: item.productName || item.name,
          image: item.image,
          price: item.unitPrice || item.price,
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

  // 去评价（带上订单ID和第一个商品信息）
  onGoReview(e) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find(o => o._id === orderId);
    if (!order || !order.items || order.items.length === 0) return;
    const firstItem = order.items[0];
    wx.navigateTo({
      url: `/pages/review/add?orderId=${order._id}&productId=${firstItem.productId}&productName=${encodeURIComponent(firstItem.name || '')}`
    });
  },

  // 批量取消全部待付款订单
  onBatchCancel() {
    const pendingOrders = this.data.orders.filter(o => o.status === 'pending_payment');
    if (pendingOrders.length === 0) return;

    wx.showModal({
      title: '一键取消',
      content: `确定取消全部 ${pendingOrders.length} 笔待付款订单？取消后无法恢复。`,
      confirmText: '全部取消',
      confirmColor: '#E06A5A',
      success: (res) => {
        if (res.confirm) {
          this._doBatchCancel(pendingOrders);
        }
      }
    });
  },

  async _doBatchCancel(pendingOrders) {
    wx.showLoading({ title: '取消中...' });
    let successCount = 0;
    for (const order of pendingOrders) {
      try {
        const r = await wx.cloud.callFunction({
          name: 'order',
          data: { action: 'cancelOrder', orderId: order._id }
        });
        if (r.result && r.result.code === 200) successCount++;
      } catch (e) {
        console.error('取消订单失败', order._id, e);
      }
    }
    wx.hideLoading();
    wx.showToast({ title: `已取消 ${successCount} 笔订单`, icon: 'success' });
    setTimeout(() => this.loadOrders(), 1500);
  },

  onCloseLoginGuide() {
    this.setData({ showLoginGuide: false });
    wx.navigateBack();
  }
});
