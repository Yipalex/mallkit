// pages/coupons/index.js - 领券中心

const app = getApp();

// 优惠券展示文本统一在 JS 里算好（WXML 不支持方法调用）
function fmtExpire(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `有效期至 ${d.getMonth() + 1}月${d.getDate()}日`;
}

Page({
  data: {
    tabs: ['可领取', '我的券', '已失效'],
    activeTab: 0,
    coupons: [],
    isLoading: false,
    emptyText: '暂无可领取的券',
  },

  onLoad(options) {
    this._autoGetCouponId = options.autoGet || null;
    this.checkLoginAndLoad();
  },

  // ⚠️ 登录规范：进入领券中心不得拦截。券列表属公开内容，先展示；
  //    领取动作才需要身份（见 onGetCoupon）。
  async checkLoginAndLoad() {
    await app.waitForLogin();
    await this.loadData();
    if (this._autoGetCouponId) {
      this.autoGetCoupon(this._autoGetCouponId);
      this._autoGetCouponId = null;
    }
  },

  onTabChange(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ activeTab: index, coupons: [] });
    this.loadData();
  },

  async loadData() {
    if (this.data.activeTab === 0) {
      await this.loadAvailable();
    } else {
      await this.loadMine(this.data.activeTab === 2);
    }
  },

  // tab0：可领取的券（getCoupons）+ 标记已领取
  async loadAvailable() {
    this.setData({ isLoading: true, emptyText: '暂无可领取的券' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getCoupons', type: 'all' }
      });
      if (!res.result || res.result.code !== 200) {
        this.setData({ coupons: [] });
        return;
      }

      // 查用户已领取的券，标记「已领取」
      let receivedIds = [];
      if (app.globalData.openid) {
        try {
          const ur = await wx.cloud.callFunction({
            name: 'product',
            data: { action: 'getUserCoupons', userId: app.globalData.openid }
          });
          if (ur.result && ur.result.code === 200) {
            receivedIds = (ur.result.data || []).map(c => c.couponId);
          }
        } catch (e) { /* 查失败不影响列表展示 */ }
      }

      const coupons = (res.result.data || []).map(c => {
        const value = c.discountValue || c.discount || 0;
        const minAmount = c.minAmount || 0;
        return {
          _id: c._id,
          title: c.title || c.name || '优惠券',
          description: c.description || '',
          valueText: `¥${value}`,
          condition: minAmount > 0 ? `满 ${minAmount} 可用` : '无门槛',
          validText: c.validDays ? `领取后 ${c.validDays} 天内有效` : '',
          isNew: c.type === 'new',
          isReceived: receivedIds.includes(c._id),
          dim: false,
        };
      });
      this.setData({ coupons });
    } catch (err) {
      console.error('loadAvailable error', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // tab1/2：我的券（未过期）/ 已失效（过期）
  async loadMine(expiredOnly) {
    this.setData({
      isLoading: true,
      emptyText: expiredOnly ? '没有失效的券' : '还没有可用的券，去领一张吧',
    });
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getUserCoupons', userId: app.globalData.openid }
      });
      if (!res.result || res.result.code !== 200) {
        this.setData({ coupons: [] });
        return;
      }
      const coupons = (res.result.data || [])
        .filter(c => expiredOnly ? c.expired : !c.expired)
        .map(c => ({
          _id: c._id,
          title: c.name || '优惠券',
          description: c.description || '',
          valueText: c.discountType === 'percent' ? `${c.discountValue}%` : `¥${c.discountValue}`,
          condition: c.minPurchase > 0 ? `满 ${c.minPurchase} 可用` : '无门槛',
          validText: fmtExpire(c.expireAt),
          isNew: c.type === 'new',
          isReceived: false,
          dim: expiredOnly,
          invalidText: '已过期',
        }));
      this.setData({ coupons });
    } catch (err) {
      console.error('loadMine error', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 从弹窗跳转过来时自动领取指定优惠券（receiveCoupon 自带"已领过则拒绝"校验）
  async autoGetCoupon(couponId) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'receiveCoupon', couponId }
      });
      const r = res.result || {};
      if (r.code === 200) {
        wx.showToast({ title: '优惠券已领取', icon: 'success' });
        this.loadData();
      } else {
        wx.showToast({ title: r.message || '领取失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '领取失败，请重试', icon: 'none' });
    }
  },

  // 领取优惠券
  async onReceiveCoupon(e) {
    const couponId = e.currentTarget.dataset.id;
    try {
      wx.showLoading({ title: '领取中...' });
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'receiveCoupon', couponId }
      });
      wx.hideLoading();
      if (res.result && res.result.code === 200) {
        wx.showToast({ title: '领取成功', icon: 'success' });
        const coupons = this.data.coupons.map(c =>
          c._id === couponId ? { ...c, isReceived: true } : c
        );
        this.setData({ coupons });
      } else {
        wx.showToast({ title: res.result?.message || '领取失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '领取失败，请重试', icon: 'none' });
    }
  },

  // 我的券 → 去逛逛下单使用
  onGoUse() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onPullDownRefresh() {
    this.loadData();
    wx.stopPullDownRefresh();
  }
});
