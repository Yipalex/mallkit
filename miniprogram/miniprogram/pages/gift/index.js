// pages/gift/index.js
// 积分区间筛选（客户端过滤，无需后端字段）
const CHIP_FILTERS = [
  () => true,
  (g) => g.points < 500,
  (g) => g.points >= 500 && g.points <= 1000,
  (g) => g.points > 1000,
];

Page({
  data: {
    points: 0,
    gifts: [],        // 全量礼品
    showGifts: [],    // 过滤+标记后的展示列表
    chips: ['全部', '500 分以下', '500-1000 分', '1000 分以上'],
    activeChip: 0,
    loading: false,
  },

  onLoad() {
    this.loadGifts();
  },

  onShow() {
    // 每次进入刷新积分（签到/购物后可能变化）
    const userInfo = wx.getStorageSync('userInfo') || {};
    this.setData({ points: userInfo.memberLevel?.points || userInfo.points || 0 });
    this.refreshShowGifts();
  },

  onChipChange(e) {
    this.setData({ activeChip: e.currentTarget.dataset.index });
    this.refreshShowGifts();
  },

  // 过滤 + 算「够不够兑」标记（WXML 里不做运算）
  refreshShowGifts() {
    const { gifts, points, activeChip } = this.data;
    const showGifts = gifts
      .filter(CHIP_FILTERS[activeChip] || CHIP_FILTERS[0])
      .map(g => ({
        ...g,
        enough: points >= g.points,
        lack: Math.max(0, g.points - points),
      }));
    this.setData({ showGifts });
  },

  async loadGifts() {
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'gift',
        data: { action: 'list' }
      });
      if (res.result.code === 200) {
        this.setData({ gifts: res.result.data });
        this.refreshShowGifts();
      }
    } catch (e) {
      console.error('加载礼品失败', e);
    } finally {
      this.setData({ loading: false });
    }
  },

  onGoCheckin() {
    wx.navigateTo({ url: '/pages/checkin/index' });
  },

  onGoPointsDetail() {
    wx.navigateTo({ url: '/pages/my/points' });
  },

  onExchange(e) {
    const item = e.currentTarget.dataset.item;
    if (this.data.points < item.points) {
      wx.showToast({ title: `积分不足，还差 ${item.points - this.data.points} 积分`, icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认兑换',
      content: `使用 ${item.points} 积分兑换「${item.name}」？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '兑换中...' });
        try {
          const r = await wx.cloud.callFunction({
            name: 'gift',
            data: { action: 'exchange', giftId: item._id }
          });
          wx.hideLoading();
          if (r.result.code === 200) {
            // 更新本地积分显示
            const newPoints = this.data.points - item.points;
            this.setData({ points: newPoints });
            const userInfo = wx.getStorageSync('userInfo') || {};
            if (userInfo.memberLevel) userInfo.memberLevel.points = newPoints;
            wx.setStorageSync('userInfo', userInfo);
            this.loadGifts();
            // 提示填写收货地址
            const logId = r.result.data?.logId;
            if (logId) {
              wx.showModal({
                title: '兑换成功！',
                content: '请填写收货地址，方便我们为您寄出礼品',
                confirmText: '填写地址',
                cancelText: '稍后再说',
                success: async (modal) => {
                  if (!modal.confirm) return;
                  try {
                    const addr = await wx.chooseAddress();
                    await wx.cloud.callFunction({
                      name: 'gift',
                      data: {
                        action: 'updateAddress',
                        logId,
                        address: {
                          name: addr.userName,
                          phone: addr.telNumber,
                          province: addr.provinceName,
                          city: addr.cityName,
                          district: addr.countyName,
                          detail: addr.detailInfo,
                          postalCode: addr.postalCode,
                        }
                      }
                    });
                    wx.showToast({ title: '地址已保存', icon: 'success' });
                  } catch (addrErr) {
                    if (!addrErr.errMsg?.includes('cancel')) {
                      console.error('保存地址失败', addrErr);
                    }
                  }
                }
              });
            } else {
              wx.showToast({ title: r.result.message, icon: 'success' });
            }
          } else {
            wx.showToast({ title: r.result.message, icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: '兑换失败，请重试', icon: 'none' });
        }
      }
    });
  }
});
