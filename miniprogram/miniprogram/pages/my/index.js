// pages/my/index.js - 个人中心
const app = getApp();

Page({
  data: {
    userInfo: {},
    memberLevel: 0,
    memberName: '普通用户',
    userPoints: 0,
    userBalance: 0,
    nicknameFirstChar: '用',
    hasUserAuth: false,
    isDistributor: false,  // 是否是分销员（由管理后台设置）
  },

  onLoad() {
    // 页面加载时初始化
    this.loadUserInfo();
  },

  onShow() {
    // 自定义底栏高亮跟随当前页（组件 pageLifetimes 不可靠，页面主动通知）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateSelected();
    }
    // 页面显示时刷新数据
    this.loadUserInfo();
  },

  // 优先从云端拉取最新用户信息，降级用本地缓存
  async loadUserInfo() {
    console.log('=== 我的页面加载用户信息 ===');
    console.log('全局 hasUserProfile:', app.globalData.hasUserProfile);

    // hasUserAuth 表示「是否已完善昵称头像」，只影响资料区展示，不作登录门槛
    this.setData({ hasUserAuth: app.globalData.hasUserProfile });

    // 真正未登录（无 openid，通常是主动退出登录）才回落到默认空状态；
    // ⚠️ 不能用 hasUserProfile 判断——新用户昵称默认就是「新用户」，
    //    据此判断会让正常用户看到"未登录"空页，被审核判定功能不可体验。
    if (!app.globalData.isLogin || !app.globalData.openid) {
      this.setData({
        userInfo: {},
        nicknameFirstChar: '用',
        memberName: '普通用户',
        memberLevel: 0,
        userPoints: 0,
        userBalance: 0,
      });
      return;
    }

    // 先用本地缓存快速渲染
    let userInfo = wx.getStorageSync('userInfo') || app.globalData.userInfo || {};
    this.applyUserInfo(userInfo);

    // 从云端同步最新数据
    try {
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'getMemberInfo' }
      });
      if (res.result && res.result.code === 200) {
        const cloudUserInfo = res.result.data;
        wx.setStorageSync('userInfo', cloudUserInfo);
        app.globalData.userInfo = cloudUserInfo;

        // 更新授权状态
        const hasAuth = cloudUserInfo.nickName && cloudUserInfo.nickName !== '新用户';
        app.globalData.hasUserProfile = hasAuth;
        this.setData({ hasUserAuth: hasAuth });
        this.applyUserInfo(cloudUserInfo);
      }
    } catch (e) {
      // 云端失败不影响本地展示
      console.log('获取云端用户信息失败', e);
    }
  },

  applyUserInfo(userInfo) {
    const levelNames = ['普通用户', '银牌会员', '金牌会员', '钻石会员'];
    const level = userInfo.memberLevel?.level || 0;
    const nickName = userInfo.nickName || '用户';
    const firstChar = nickName.charAt(0).toUpperCase();
    this.setData({
      userInfo,
      memberLevel: level,
      memberName: levelNames[level],
      userPoints: userInfo.memberLevel?.points || 0,
      userBalance: userInfo.balance || 0,
      nicknameFirstChar: firstChar,
      isDistributor: !!userInfo.isDistributor,  // 从云端用户信息读取分销员状态
    });
  },

  // 新版微信：选择头像
  async onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    const userInfo = { ...this.data.userInfo, avatarUrl };
    this.setData({ userInfo });
    wx.setStorageSync('userInfo', userInfo);
    // 同步到云端
    try {
      await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'updateProfile', userInfo: { avatarUrl, nickName: userInfo.nickName } }
      });
    } catch (e) { /* 静默失败 */ }
  },

  // 新版微信：昵称输入框失焦
  async onNicknameBlur(e) {
    const nickName = e.detail.value.trim();
    if (!nickName || nickName === this.data.userInfo.nickName) return;
    const userInfo = { ...this.data.userInfo, nickName };
    this.setData({ userInfo });
    wx.setStorageSync('userInfo', userInfo);
    try {
      await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'updateProfile', userInfo: { nickName, avatarUrl: userInfo.avatarUrl } }
      });
      wx.showToast({ title: '昵称已更新', icon: 'success' });
    } catch (e) { /* 静默失败 */ }
  },

  // 跳转各页面
  onGoOrders(e) {
    const status = e.currentTarget.dataset.status || '';
    wx.navigateTo({ url: `/pages/order/list${status ? '?status=' + status : ''}` });
  },
  onGoAddress() { wx.navigateTo({ url: '/pages/address/list' }); },
  onGoDistribution() { wx.navigateTo({ url: '/pages/distribution/index' }); },
  onGoCheckin() { wx.navigateTo({ url: '/pages/checkin/index' }); },  // 修复：老版 wxml 绑定了但一直没有这个方法
  onGoGift() { wx.navigateTo({ url: '/pages/gift/index' }); },
  onGoRecharge() { wx.navigateTo({ url: '/pages/my/recharge' }); },
  onGoHelp() { wx.navigateTo({ url: '/pages/help/index' }); },
  onGoSettings() { wx.navigateTo({ url: '/pages/my/settings' }); },

  // 点击头像弹出操作菜单
  onAvatarTap() {
    // 真正未登录（已退出登录）才去登录页；已登录但没改过昵称的，
    // 直接进设置页改资料——不能因昵称是默认值就把人推去登录页
    if (!app.globalData.isLogin || !app.globalData.openid) {
      wx.navigateTo({
        url: '/pages/login/index?redirect=/pages/my/index',
        fail: () => wx.showToast({ title: '页面跳转失败', icon: 'none' }),
      });
      return;
    }
    if (!app.globalData.hasUserProfile) {
      wx.navigateTo({ url: '/pages/my/settings' });
      return;
    }

    // 已完善资料，显示操作菜单
    console.log('已有用户授权，显示退出登录选项');
    const itemList = ['退出登录'];
    wx.showActionSheet({
      itemList: itemList,
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onLogout();
        }
      }
    });
  },

  // 退出登录
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          console.log('=== 退出登录 ===');

          // 1. 清除所有本地存储的用户信息
          wx.removeStorageSync('userInfo');
          wx.removeStorageSync('openid');

          // 2. 清除全局用户信息（但保留云开发连接）
          app.globalData.userInfo = null;
          app.globalData.hasUserProfile = false;
          app.globalData.openid = null;
          app.globalData.isLogin = false;

          // 3. 重新加载页面显示默认状态
          this.setData({
            hasUserAuth: false,
            userInfo: {},
            nicknameFirstChar: '用',
            memberName: '普通用户',
            memberLevel: 0,
            userPoints: 0,
            userBalance: 0,
          });

          console.log('退出登录完成，hasUserProfile:', app.globalData.hasUserProfile);

          wx.showToast({
            title: '已退出登录',
            icon: 'success',
            duration: 1500
          });

          // 4. 延迟后刷新页面，确保状态完全重置
          setTimeout(() => {
            this.onLoad(); // 重新加载页面
          }, 1500);
        }
      }
    });
  }
});
