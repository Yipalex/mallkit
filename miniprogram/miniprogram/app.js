// app.js - 全局逻辑文件
// 小程序启动时执行，负责：登录、获取openid、初始化云开发环境

App({

  // ========== 全局数据 ==========
  globalData: {
    userInfo: null,     // 用户信息
    openid: null,       // 微信唯一标识符
    isLogin: false,     // 是否已登录（有OPENID）
    hasUserProfile: false, // 是否已授权用户信息（昵称、头像）
    cartCount: 0,       // 购物车商品数量（用于角标显示）
    pendingInviteToken: null, // 扫邀请码带来的 token，登录后处理（招募分销员）
    pendingReferralCode: null, // 扫分销员带货码/点分享链接带来的 referralCode，登录后绑定推荐人
    pendingVoucherCode: null,  // 扫企业礼券码带来的 code，就绪后 reLaunch 到礼券落地页
  },

  // ========== 小程序启动时执行 ==========
  onLaunch(options) {
    // 1. 初始化云开发环境
    wx.cloud.init({
      env: 'cloudbase-your-env-id',
      traceUser: true,
    });

    // 检查是否通过邀请码扫码进入（scene 参数格式：invite_token=xxx）
    if (options.scene === 1047 || options.scene === 1048 || options.scene === 1011) {
      // 小程序码/二维码扫码进入，scene 里带参数
      try {
        const sceneStr = decodeURIComponent(options.query?.scene || '');
        const match = sceneStr.match(/invite_token=([a-zA-Z0-9]+)/);
        if (match) {
          this.globalData.pendingInviteToken = match[1];
        }
      } catch (e) {}
    }
    // 也支持普通链接方式（开发工具预览）
    if (options.query?.invite_token) {
      this.globalData.pendingInviteToken = options.query.invite_token;
    }

    // 捕获企业礼券码（scene: v=XXXX），命中则跳礼券落地页（优先级最高，且此时不再当带货码处理）
    if (this._captureVoucher(options)) {
      this._redirectToVoucher();
    } else {
      // 捕获分销员带货码/分享链接里的推荐码（登录后绑定推荐人）
      this._captureReferral(options);
    }

    // 2. 注册隐私协议处理（微信合规要求：app.json 声明 __usePrivacyVersion 后必须注册）
    // 当某个 API 需要用到隐私数据时，微信框架会触发此回调
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization((resolve) => {
        wx.showModal({
          title: '隐私保护提示',
          content: '在使用该功能前，请阅读并同意《隐私政策》，我们将依据隐私政策收集和使用您的信息。',
          confirmText: '同意',
          cancelText: '拒绝',
          success: (res) => {
            if (res.confirm) {
              resolve({ event: 'agree' });
            } else {
              resolve({ event: 'disagree' });
            }
          }
        });
      });
    }

    // 3. 执行登录流程
    this.login();
  },

  // ========== 登录流程 ==========
  // 流程说明：
  // wx.login() → 获得 code
  // → 调用云函数 user → 云函数用 code 换取 openid
  // → 将 openid 存入本地缓存和全局变量
  async login() {
    try {
      // 先检查本地缓存的用户信息
      const cachedUserInfo = wx.getStorageSync('userInfo');
      if (cachedUserInfo) {
        this.globalData.userInfo = cachedUserInfo;
        // hasUserProfile 只表示「是否已补充过昵称头像」，用于引导完善资料，
        // ⚠️ 不可当作登录门槛：微信静默登录拿到 openid 即为已登录（isLogin）。
        // 曾用它拦截会员中心/领券中心，而新用户默认昵称就是「新用户」→ 恒为
        // false → 人人被登录蒙层挡住，导致审核判定「未浏览即要求授权登录」。
        this.globalData.hasUserProfile = !!(cachedUserInfo.nickName && cachedUserInfo.nickName !== '新用户');
      }

      // 调用云函数确保用户记录存在（微信自动登录，无需授权）
      const userRes = await wx.cloud.callFunction({
        name: 'user',
        data: {
          action: 'login',
        }
      });

      if (userRes.result && userRes.result.code === 200) {
        const { openid, userInfo } = userRes.result.data;
        this.globalData.openid = openid;
        this.globalData.isLogin = true;

        // 无论昵称是什么，都用云端最新数据（含积分、余额等）覆盖本地缓存
        if (userInfo) {
          this.globalData.userInfo = userInfo;
          this.globalData.hasUserProfile = !!(userInfo.nickName && userInfo.nickName !== '新用户');
          wx.setStorageSync('userInfo', userInfo);
        }

        // 缓存 openid
        wx.setStorageSync('openid', openid);

        // 如果是通过邀请码扫码进入，登录完成后自动登记
        if (this.globalData.pendingInviteToken) {
          const token = this.globalData.pendingInviteToken;
          this.globalData.pendingInviteToken = null;
          wx.cloud.callFunction({
            name: 'user',
            data: { action: 'claimInvite', token }
          }).then(r => {
            if (r.result && r.result.code === 200 && r.result.claimed) {
              wx.showModal({
                title: '邀请登记成功',
                content: '您的信息已提交，管理员确认后即可成为分销员，届时"我的"页面将出现分销中心入口。',
                showCancel: false,
                confirmText: '好的',
              });
            }
          }).catch(() => {});
        }

        // 如果扫了分销员带货码/点了分享链接，登录完成后自动绑定推荐人（永久、首次锁定）
        if (this.globalData.pendingReferralCode) {
          const referralCode = this.globalData.pendingReferralCode;
          this.globalData.pendingReferralCode = null;
          wx.cloud.callFunction({
            name: 'user',
            data: { action: 'bindReferrer', referralCode }
          }).catch(() => {});
          // 静默绑定：不打扰客户购物流程（首次锁定，重复扫不覆盖）
        }
      }

    } catch (error) {
      console.error('登录流程出错：', error);
    }
  },

  // ========== 热启动兜底：已在后台时扫码/点链接进入，onLaunch 不再触发，靠 onShow 捕获 ==========
  onShow(options) {
    if (!options) return;
    // 热启动扫礼券码：命中即跳礼券落地页（优先，且不再当带货码处理）
    if (this._captureVoucher(options)) {
      this._redirectToVoucher();
      return;
    }
    const had = this.globalData.pendingReferralCode;
    this._captureReferral(options);
    // 若此时已登录且本次新捕获到推荐码，立即触发绑定（登录流程已过，不会再走 login 里的绑定）
    if (!had && this.globalData.pendingReferralCode && this.globalData.isLogin) {
      const referralCode = this.globalData.pendingReferralCode;
      this.globalData.pendingReferralCode = null;
      wx.cloud.callFunction({
        name: 'user',
        data: { action: 'bindReferrer', referralCode }
      }).catch(() => {});
    }
  },

  // ========== 捕获企业礼券码（scene: v=XXXX；开发工具预览用 query.v）==========
  // 命中返回 true 并把 code 存入 globalData.pendingVoucherCode。
  _captureVoucher(options) {
    try {
      let code = null;
      if (options.scene === 1047 || options.scene === 1048 || options.scene === 1011) {
        const sceneStr = decodeURIComponent(options.query?.scene || '');
        const m = sceneStr.match(/^v=([A-Z0-9]{8,20})$/i);
        if (m) code = m[1].toUpperCase();
      }
      if (!code && options.query?.v) code = String(options.query.v).toUpperCase();
      if (code) {
        this.globalData.pendingVoucherCode = code;
        return true;
      }
    } catch (e) {}
    return false;
  },

  // 跳转到礼券落地页（清栈，锁定流程起点）。等 waitForLogin 静默注册完成后跳，保证有 openid。
  _redirectToVoucher() {
    const go = () => {
      const code = this.globalData.pendingVoucherCode;
      if (!code) return;
      this.globalData.pendingVoucherCode = null;
      wx.reLaunch({ url: `/pages/voucher/index?code=${code}` });
    };
    // 若尚未登录，等登录完成再跳（voucher 页也会自行 waitForLogin，这里主要保证时序）
    if (this.globalData.isLogin) go();
    else this.waitForLogin().then(go);
  },

  // ========== 从启动参数里捕获分销员推荐码（扫带货码 scene / 分享链接 inviteCode）==========
  _captureReferral(options) {
    try {
      // 1. 扫描分销员专属带货码：scene 直接是 referralCode（也兼容 rc=XXXXXX 形式）
      if (options.scene === 1047 || options.scene === 1048 || options.scene === 1011) {
        const sceneStr = decodeURIComponent(options.query?.scene || '');
        const m = sceneStr.match(/(?:rc=)?([A-Za-z0-9]{4,12})/);
        // 排除已被 invite_token 占用（招募分销员）、v= 占用（企业礼券码）、p= 占用（商品海报码）的 scene
        // 上面的正则没有锚定，p=xxxx 这类 scene 会被误捞成推荐码，污染分销归因，必须显式排除
        if (m && !/invite_token=/.test(sceneStr) && !/^v=/i.test(sceneStr) && !/^p=/i.test(sceneStr)) {
          this.globalData.pendingReferralCode = m[1].toUpperCase();
          return;
        }
      }
      // 2. 分享卡片/链接：?inviteCode=XXX
      if (options.query?.inviteCode) {
        this.globalData.pendingReferralCode = String(options.query.inviteCode).toUpperCase();
      }
    } catch (e) {}
  },

  // ========== 等待登录完成的辅助方法 ==========
  // 有些页面需要在登录完成后才能请求数据
  // 使用方式：await app.waitForLogin()
  waitForLogin() {
    return new Promise((resolve) => {
      if (this.globalData.isLogin) {
        resolve(this.globalData.openid);
        return;
      }
      // 轮询等待登录完成
      const timer = setInterval(() => {
        if (this.globalData.isLogin) {
          clearInterval(timer);
          resolve(this.globalData.openid);
        }
      }, 100);
    });
  },

  // ========== 更新购物车角标 ==========
  // 自定义 tabBar（app.json tabBar.custom:true）下 wx.setTabBarBadge 无效，
  // 角标由 custom-tab-bar 组件自绘。这里更新 globalData 并通知当前页的 tabBar 组件刷新。
  updateCartBadge(count) {
    this.globalData.cartCount = count;
    try {
      const pages = getCurrentPages();
      const cur = pages[pages.length - 1];
      if (cur && typeof cur.getTabBar === 'function') {
        const tabBar = cur.getTabBar();
        if (tabBar && typeof tabBar.refreshCartBadge === 'function') {
          tabBar.refreshCartBadge();
        }
      }
    } catch (e) {}
  },

});
