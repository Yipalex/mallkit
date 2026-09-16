// pages/terms/terms.js
Page({
  data: {
    type: 'terms',  // 'terms' 用户协议 | 'recharge' 充值声明
  },
  onLoad(options) {
    const type = options.type || 'terms';
    this.setData({ type });
    const titleMap = {
      terms: '用户服务协议',
      recharge: '充值服务个人信息授权声明',
    };
    wx.setNavigationBarTitle({ title: titleMap[type] || '服务协议' });
  },
})
