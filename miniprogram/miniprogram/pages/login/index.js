// pages/login/index.js - 登录引导页面
// 微信新版（2021年起）已废弃 wx.getUserProfile 弹窗授权
// 现在登录只需要 openid（云函数自动获取），用户昵称/头像在"我的"页面单独采集
const app = getApp();

Page({
  data: {
    isLogging: false,
    agreeChecked: false,   // 隐私政策勾选状态，默认未勾选（合规要求）
  },

  onLoad(options) {
    this.redirectUrl = options.redirect || '/pages/index/index';
  },

  onToggleAgree() {
    this.setData({ agreeChecked: !this.data.agreeChecked });
  },

  async onWechatLogin() {
    if (this.data.isLogging) return;

    if (!this.data.agreeChecked) {
      wx.showToast({ title: '请先阅读并同意隐私政策和服务条款', icon: 'none', duration: 2000 });
      return;
    }

    this.setData({ isLogging: true });
    wx.showLoading({ title: '登录中...' });

    try {
      // 调用云函数 login，云函数通过 getWXContext() 自动获取 openid
      // 不再需要 wx.getUserProfile，用户资料在"我的"页面单独采集
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'login' }
      });

      wx.hideLoading();

      if (!res.result || res.result.code !== 200) {
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
        this.setData({ isLogging: false });
        return;
      }

      const { openid, userInfo } = res.result.data;

      // 更新全局状态
      app.globalData.openid = openid;
      app.globalData.isLogin = true;

      if (userInfo) {
        app.globalData.userInfo = userInfo;
        wx.setStorageSync('userInfo', userInfo);
        // 只要有 openid 就算登录成功，不再强依赖昵称/头像
        app.globalData.hasUserProfile = true;
      } else {
        // 没有用户资料也算登录成功（首次登录），引导去"我的"设置昵称头像
        app.globalData.hasUserProfile = true;
      }

      wx.setStorageSync('openid', openid);

      wx.showToast({ title: '登录成功', icon: 'success', duration: 1500 });

      setTimeout(() => {
        const tabBarPages = ['/pages/index/index', '/pages/member/index', '/pages/cart/index', '/pages/my/index'];
        const isTabBar = tabBarPages.some(p => this.redirectUrl.startsWith(p));
        if (isTabBar) {
          wx.reLaunch({ url: this.redirectUrl });
        } else {
          wx.redirectTo({ url: this.redirectUrl });
        }
      }, 1500);

    } catch (err) {
      wx.hideLoading();
      console.error('登录失败', err);
      wx.showToast({ title: '网络错误，请重试', icon: 'none' });
      this.setData({ isLogging: false });
    }
  },

  onPrivacyTap() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  onTermsTap() {
    wx.navigateTo({ url: '/pages/terms/terms' });
  }
});
