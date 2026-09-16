// pages/distribution/index.js - 分销中心
// 分销员可以在这里：查看自己的专属邀请码、查看收益统计、申请提现

const app = getApp();

Page({
  data: {
    isDistributor: false,   // 是否为分销员
    distributorInfo: null,  // 分销员信息
    isLoading: true,

    // 我的带货二维码
    qrcodeFileID: '',
    qrcodeLoading: false,

    // 我的分销订单（别人用我的码下的单）
    myOrders: [],
    ordersLoading: false,

    // 提现
    withdrawAmount: '',
    isWithdrawing: false,
  },

  onLoad() {
    this.loadDistributorInfo();
  },

  onShow() {
    this.loadDistributorInfo();
  },

  // 加载分销员信息
  async loadDistributorInfo() {
    this.setData({ isLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'distribution',
        data: {
          action: 'getInfo',
          userId: app.globalData.openid,
        }
      });

      if (res.result.code === 200 && res.result.data) {
        const info = res.result.data;
        // 格式化所有金额字段，避免出现 0.0011.12000000000001 这样的浮点尾巴
        const fmt = v => (Number(v) || 0).toFixed(2);
        if (info.withdrawal) {
          info.withdrawal.settledAmount = fmt(info.withdrawal.settledAmount);
          info.withdrawal.pendingAmount = fmt(info.withdrawal.pendingAmount);
          info.withdrawal.totalWithdrawn = fmt(info.withdrawal.totalWithdrawn);
          info.withdrawal.appliedAmount = fmt(info.withdrawal.appliedAmount);
        }
        if (info.stats) {
          info.stats.totalSalesAmount = fmt(info.stats.totalSalesAmount);
          info.stats.totalCommissionEarned = fmt(info.stats.totalCommissionEarned);
          info.stats.monthlyCommission = fmt(info.stats.monthlyCommission);
        }
        this.setData({
          isDistributor: true,
          distributorInfo: info,
        });
        // 加载分销订单列表
        this.loadMyOrders();
        // 加载带货二维码（仅首次，已有则不重复请求）
        if (!this.data.qrcodeFileID) this.loadQrcode();
      } else {
        this.setData({ isDistributor: false });
      }
    } catch (err) {
      console.error('加载分销信息失败', err);
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 成为分销员
  async onBecomeDistributor() {
    try {
      wx.showLoading({ title: '开通中...' });
      const res = await wx.cloud.callFunction({
        name: 'distribution',
        data: {
          action: 'register',
          userId: app.globalData.openid,
        }
      });
      wx.hideLoading();

      if (res.result.code === 200) {
        wx.showToast({ title: '开通成功', icon: 'success' });
        this.loadDistributorInfo();
      } else {
        wx.showToast({ title: res.result.message, icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '开通失败，请重试', icon: 'none' });
    }
  },

  // 加载我的分销订单（别人用我的码下的单）
  async loadMyOrders() {
    this.setData({ ordersLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'distribution',
        data: { action: 'getMyOrders', limit: 30 }
      });
      if (res.result && res.result.code === 200) {
        const statusLabel = {
          'pending_payment': '待付款',
          'paid': '待发货',
          'shipped': '已发货',
          'completed': '已完成',
          'cancelled': '已取消',
          'refunded': '已退款',
        };
        const list = (res.result.data || []).map((o, idx) => {
          const dt = o.createTime ? new Date(o.createTime) : null;
          const dtStr = dt
            ? `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
            : '-';
          const itemsText = (o.items || []).map(i => `${i.productName}×${i.quantity}`).join('，');
          // 首字头像在 JS 里算好（WXML 不支持字符串下标）
          const buyerLabel = o.buyerLabel || '好友';
          return {
            ...o,
            buyerLabel,
            avatarChar: buyerLabel.charAt(0),
            alt: idx % 2 === 1,   // 明细行头像绿橙交替
            dtStr,
            itemsText,
            statusLabel: statusLabel[o.status] || o.status,
            finalPriceStr: (Number(o.finalPrice) || 0).toFixed(2),
            commissionStr: (Number(o.referrerCommission) || 0).toFixed(2),
          };
        });
        this.setData({ myOrders: list });
      }
    } catch (err) {
      console.error('loadMyOrders error:', err);
    } finally {
      this.setData({ ordersLoading: false });
    }
  },

  // 加载我的带货二维码（云函数生成，返回 fileID）
  async loadQrcode() {
    if (this.data.qrcodeLoading) return;
    this.setData({ qrcodeLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'distribution',
        data: { action: 'getQrcode' }
      });
      if (res.result && res.result.code === 200 && res.result.data?.fileID) {
        this.setData({ qrcodeFileID: res.result.data.fileID });
      }
    } catch (err) {
      console.error('loadQrcode error:', err);
    } finally {
      this.setData({ qrcodeLoading: false });
    }
  },

  // 长按二维码保存到相册
  async onSaveQrcode() {
    const fileID = this.data.qrcodeFileID;
    if (!fileID) return;
    try {
      wx.showLoading({ title: '保存中...' });
      const { tempFilePath } = await wx.cloud.downloadFile({ fileID });
      await wx.saveImageToPhotosAlbum({ filePath: tempFilePath });
      wx.hideLoading();
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      // 用户拒绝相册授权：引导去设置开启
      if (err.errMsg && err.errMsg.includes('auth')) {
        wx.showModal({
          title: '需要相册权限',
          content: '保存二维码需要授权访问相册，请在设置中开启',
          confirmText: '去设置',
          success: (r) => { if (r.confirm) wx.openSetting(); }
        });
      } else {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    }
  },

  // 页面分享配置（分享带货卡片，朋友点进来自动绑定）
  onShareAppMessage() {
    const code = this.data.distributorInfo?.referralCode;
    return {
      title: '优选好物，品质保证！点进来下单更优惠 →',
      path: `/pages/index/index?inviteCode=${code}`,
      imageUrl: '/assets/share-cover.png',
    };
  },

  // 提现金额输入
  onWithdrawInput(e) {
    this.setData({ withdrawAmount: e.detail.value });
  },

  // 收益卡「提现」滚动定位到提现区
  onScrollToWithdraw() {
    wx.pageScrollTo({ selector: '#withdraw', duration: 300 });
  },

  // 申请提现
  async onWithdraw() {
    const amount = parseFloat(this.data.withdrawAmount);
    const minAmount = this.data.distributorInfo?.withdrawal?.minWithdrawalAmount || 50;
    const available = this.data.distributorInfo?.withdrawal?.settledAmount || 0;

    if (!amount || amount < minAmount) {
      wx.showToast({ title: `最低提现 ¥${minAmount}`, icon: 'none' });
      return;
    }
    if (amount > available) {
      wx.showToast({ title: '可提现余额不足', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '确认提现',
      content: `申请提现 ¥${amount}，将在1-3个工作日内到账`,
      success: async (res) => {
        if (res.confirm) {
          this.setData({ isWithdrawing: true });
          try {
            const result = await wx.cloud.callFunction({
              name: 'distribution',
              data: { action: 'withdraw', userId: app.globalData.openid, amount }
            });
            if (result.result.code === 200) {
              wx.showToast({ title: '提现申请已提交', icon: 'success' });
              this.setData({ withdrawAmount: '' });
              this.loadDistributorInfo();
            } else {
              wx.showToast({ title: result.result.message, icon: 'none' });
            }
          } catch (err) {
            wx.showToast({ title: '提现失败，请重试', icon: 'none' });
          } finally {
            this.setData({ isWithdrawing: false });
          }
        }
      }
    });
  },
});
