// pages/member/index.js - 会员中心

const app = getApp();

Page({
  data: {
    userInfo: null,
    memberInfo: null,
    avatarChar: '园',
    isLoading: true,
    isGuest: false,   // 极端情况下（静默登录失败）以游客态展示公开权益内容
    // 数据栏 / 成长值 / 快捷入口副标题（loadMemberInfo & loadCouponCount 填充）
    balance: '0.00',
    couponCount: 0,
    growthLeft: '',
    growthDiff: 0,
    growthPercent: 0,
    nextLevelName: '',
    checkinSub: '签到领积分',
    giftSub: '积分可兑换',
    couponSub: '优惠先领券',
    discountPerk: '会员价',
    levelConfig: [
      { level: 0, name: '普通用户', discount: 1,    color: '#999', nextPoints: 5000 },
      { level: 1, name: '银牌会员', discount: 0.95, color: '#9E9E9E', nextPoints: 15000 },
      { level: 2, name: '金牌会员', discount: 0.90, color: '#FFA000', nextPoints: 30000 },
      { level: 3, name: '钻石会员', discount: 0.85, color: '#7B1FA2', nextPoints: null },
    ],
  },

  onLoad() {
    this.checkLoginAndLoad();
  },

  onShow() {
    // 自定义底栏高亮跟随当前页（组件 pageLifetimes 不可靠，页面主动通知）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().updateSelected();
    }
  },

  // 加载会员数据
  // ⚠️ 登录规范：本页是 tabBar 第 2 个 tab，进入即弹登录蒙层会被审核判定
  //    「未完整浏览即要求授权登录」。这里一律先展示等级权益等公开内容，
  //    登录引导只在用户点击「我的积分/优惠券」等个人数据入口时才触发。
  async checkLoginAndLoad() {
    await app.waitForLogin();
    // 微信静默登录已拿到 openid 即视为已登录，可直接读个人会员数据
    if (app.globalData.isLogin && app.globalData.openid) {
      this.loadMemberInfo();
      this.loadCouponCount();
      return;
    }
    // 极端情况（云函数失败等）：不弹蒙层，仅以游客态展示公开的等级权益说明
    this.setData({ isLoading: false, isGuest: true });
  },

  async loadMemberInfo() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'getMemberInfo', userId: app.globalData.openid }
      });
      if (res.result.code === 200) {
        const data = res.result.data;
        const level = data.memberLevel.level;
        const levelConf = this.data.levelConfig[level];
        const nextConf = this.data.levelConfig[level + 1] || null;
        const points = data.memberLevel.points || 0;

        // 成长值进度（满级显示满格 + 已达最高等级，不再隐藏进度条）
        let growthLeft, growthDiff = 0, growthPercent = 100, nextLevelName = '';
        if (levelConf.nextPoints) {
          growthLeft = `成长值 ${points} / ${levelConf.nextPoints}`;
          growthDiff = Math.max(0, levelConf.nextPoints - points);
          growthPercent = Math.min(100, points / levelConf.nextPoints * 100);
          nextLevelName = nextConf ? nextConf.name : '';
        } else {
          growthLeft = `成长值 ${points} · 已达最高等级`;
        }

        this.setData({
          userInfo: data,
          memberInfo: { ...data.memberLevel, ...levelConf },
          avatarChar: (data.nickName || '园').charAt(0), // WXML 不支持字符串下标，在 JS 里取首字
          balance: (data.balance || 0).toFixed(2),
          growthLeft,
          growthDiff,
          growthPercent,
          nextLevelName,
          // 快捷入口副标题（真实数据）
          checkinSub: (data.checkinStreak || 0) > 0 ? `连签 ${data.checkinStreak} 天` : '签到领积分',
          giftSub: `${points} 分可兑`,
          // 权益：折扣卡文案按当前等级折扣算
          discountPerk: levelConf.discount < 1 ? `${levelConf.discount * 10}折卡` : '会员价',
          isLoading: false,
        });
      }
    } catch (err) {
      console.error(err);
      this.setData({ isLoading: false });
    }
  },

  // 数据栏「优惠券」张数（未过期未使用的券）
  async loadCouponCount() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getUserCoupons' }
      });
      if (res.result && res.result.code === 200) {
        const count = (res.result.data || []).filter(c => !c.expired).length;
        this.setData({
          couponCount: count,
          couponSub: count > 0 ? `${count} 张可用` : '优惠先领券',
        });
      }
    } catch (e) {
      // 查失败保持默认 0，不影响页面
    }
  },

  // 头像行 → 个人资料（我的页）
  onGoProfile() {
    wx.switchTab({ url: '/pages/my/index' });
  },

  // ===== 快捷入口跳转（2026-07 UI 重设计新增） =====
  onGoCheckin() { wx.navigateTo({ url: '/pages/checkin/index' }); },
  onGoGift() { wx.navigateTo({ url: '/pages/gift/index' }); },
  onGoCoupons() { wx.navigateTo({ url: '/pages/coupons/index' }); },
  onGoRecharge() { wx.navigateTo({ url: '/pages/my/recharge' }); },
  onGoDistribution() { wx.navigateTo({ url: '/pages/distribution/index' }); },
});
