// pages/my/settings.js
const app = getApp();

Page({
  data: {
    phone: '未绑定',
    savedAddress: '',   // 已保存的默认地址摘要
    hasUserAuth: false,
    nickname: '园友',
    avatarChar: '园',   // 首字头像在 JS 里算（WXML 不支持字符串下标）
    avatarUrl: '',      // 微信头像（chooseAvatar 上传云存储后的 fileID），空则显示首字方块
    msgNotify: true,    // 消息通知偏好（本地持久化，默认开）
  },

  onLoad() {
    this.setData({ hasUserAuth: app.globalData.hasUserProfile });
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo.phone) {
      const p = userInfo.phone;
      this.setData({ phone: p.slice(0,3) + '****' + p.slice(7) });
    }
    // 消息通知偏好：读本地，未设过默认开
    const saved = wx.getStorageSync('msgNotify');
    this.setData({ msgNotify: saved === '' ? true : !!saved });
    this.loadProfile();
    this.loadSavedAddress();
  },

  noop() {},

  // 消息通知开关：持久化用户偏好。
  // 注意：小程序目前未接入订阅消息推送，这里先存偏好；后续做订单状态推送时，
  // 打开时应调 wx.requestSubscribeMessage 申请模板授权、服务端按此偏好决定是否推送。
  onToggleNotify(e) {
    const on = e.detail.value;
    wx.setStorageSync('msgNotify', on);
    this.setData({ msgNotify: on });
    wx.showToast({ title: on ? '已开启消息通知' : '已关闭消息通知', icon: 'none' });
  },

  onShow() {
    this.setData({ hasUserAuth: app.globalData.hasUserProfile });
    this.loadProfile();
    this.loadSavedAddress();
  },

  loadProfile() {
    const userInfo = wx.getStorageSync('userInfo') || {};
    const nickname = userInfo.nickName || userInfo.nickname || '园友';
    this.setData({
      nickname,
      avatarChar: nickname.charAt(0) || '园',
      avatarUrl: userInfo.avatarUrl || '',
    });
  },

  onGoHelp() {
    wx.navigateTo({ url: '/pages/help/index' });
  },

  loadSavedAddress() {
    const addr = wx.getStorageSync('defaultAddress');
    if (addr && addr.province) {
      this.setData({ savedAddress: addr.name + ' ' + addr.province + addr.city });
    } else {
      this.setData({ savedAddress: '' });
    }
  },

  // ===== 修改头像：微信官方 chooseAvatar 能力 =====
  // ⚠️ e.detail.avatarUrl 有两种形态，必须分开处理（真机「头像保存失败」的根因）：
  //  1) 选「使用微信头像」→ https://thirdwx.qlogo.cn/... 网络地址。
  //     这本身就是永久可访问的 CDN 地址，直接存库即可，无需转存。
  //     ❌ 不能走 wx.cloud.uploadFile（filePath 只收本地路径）；
  //     ❌ 也不宜先 wx.downloadFile 落地再传——该域名不在 downloadFile
  //        合法域名白名单里，真机会被拦截（开发者工具勾了"不校验域名"会误判通过）。
  //  2) 从相册/拍照选 → http://tmp/xxx、wxfile://xxx 本地临时文件，
  //     临时路径重启即失效，必须上传云存储换持久 fileID。
  async onChooseAvatar(e) {
    const picked = e.detail.avatarUrl;
    if (!picked) return;
    const prevAvatar = this.data.avatarUrl;
    this.setData({ avatarUrl: picked });   // 即时回显
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      let avatarUrl = picked;
      // ⚠️ 不能只看 http:// 前缀——微信本地临时文件也长成 http://tmp/xxx，
      //    按前缀判断会把它当网络地址存库，重启后头像失效。
      //    只有真正的微信头像 CDN 域名（qlogo.cn / qpic.cn）才直接存。
      const isWxCdn = /^https?:\/\/[^/]*(qlogo\.cn|qpic\.cn)\//i.test(picked);
      if (!isWxCdn) {
        const ext = (picked.match(/\.(\w+)(?:\?|$)/) || [, 'jpg'])[1].toLowerCase();
        const uid = app.globalData.openid || wx.getStorageSync('openid') || 'anon';
        const up = await wx.cloud.uploadFile({
          cloudPath: `avatars/${uid}_${Date.now()}.${ext}`,
          filePath: picked,
        });
        if (!up.fileID) throw new Error('上传未返回 fileID');
        avatarUrl = up.fileID;
      }
      await this.saveProfile({ avatarUrl });
      this.setData({ avatarUrl });
      wx.hideLoading();
      wx.showToast({ title: '头像已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      console.error('头像保存失败:', err);
      this.setData({ avatarUrl: prevAvatar });   // 回滚，不留存不下来的临时图
      this.loadProfile();
      wx.showToast({ title: '头像保存失败，请重试', icon: 'none' });
    }
  },

  // ===== 修改昵称：type="nickname" 输入框失焦即保存 =====
  async onNicknameBlur(e) {
    const nickName = (e.detail.value || '').trim();
    if (!nickName || nickName === this.data.nickname) return;
    if (nickName.length > 20) {
      wx.showToast({ title: '昵称不能超过20个字', icon: 'none' });
      return;
    }
    this.setData({ nickname: nickName, avatarChar: nickName.charAt(0) || '园' });
    try {
      await this.saveProfile({ nickName });
      wx.showToast({ title: '昵称已更新', icon: 'success' });
    } catch (err) {
      this.loadProfile();
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  // 头像/昵称统一落库 + 同步本地缓存与全局态（复用 user 云函数已有的 updateProfile）
  async saveProfile(patch) {
    const info = wx.getStorageSync('userInfo') || {};
    const merged = { ...info, ...patch };
    const res = await wx.cloud.callFunction({
      name: 'user',
      data: {
        action: 'updateProfile',
        userInfo: { nickName: merged.nickName || '', avatarUrl: merged.avatarUrl || '' },
      },
    });
    if (!res.result || res.result.code !== 200) {
      throw new Error((res.result && res.result.message) || '更新失败');
    }
    wx.setStorageSync('userInfo', merged);
    app.globalData.userInfo = merged;
    // 昵称已不是默认值 → 标记资料已完善（仅用于引导，不作登录门槛）
    app.globalData.hasUserProfile = !!(merged.nickName && merged.nickName !== '新用户');
    this.setData({ hasUserAuth: app.globalData.hasUserProfile });
  },

  onEditPhone() {
    const userInfo = wx.getStorageSync('userInfo') || {};
    const current = userInfo.phone || '';
    wx.showModal({
      title: '绑定手机号',
      content: '填写手机号后，商家可通过手机号识别您的身份（如设置分销员资格）',
      editable: true,
      placeholderText: '请输入11位手机号',
      defaultValue: current,
      confirmText: '保存',
      success: async (res) => {
        if (!res.confirm) return;
        const phone = (res.content || '').trim();
        if (!phone) return;
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '保存中...' });
        try {
          const r = await wx.cloud.callFunction({
            name: 'user',
            data: { action: 'updatePhone', phone }
          });
          wx.hideLoading();
          if (r.result && r.result.code === 200) {
            // 更新本地缓存
            const info = wx.getStorageSync('userInfo') || {};
            info.phone = phone;
            wx.setStorageSync('userInfo', info);
            this.setData({ phone: phone.slice(0,3) + '****' + phone.slice(7) });
            wx.showToast({ title: '手机号已保存', icon: 'success' });
          } else {
            wx.showToast({ title: r.result?.message || '保存失败', icon: 'none' });
          }
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '网络错误，请重试', icon: 'none' });
        }
      }
    });
  },

  onEditAddress() {
    // 进地址管理页（多地址列表）
    wx.navigateTo({ url: '/pages/address/list' });
  },

  onAbout() {
    wx.showModal({
      title: '关于我们',
      content: '示例商城 · 优选好物\n\n专注挑选优质好物，源头直发、品质保障。\n\n客服电话：400-000-0000\n版本号：v1.0.0',
      showCancel: false,
      confirmText: '知道了',
    });
  },


  onPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  onTerms() {
    wx.navigateTo({ url: '/pages/terms/terms' });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      success(res) {
        if (res.confirm) {
          console.log('=== 退出登录（设置页面） ===');

          // 1. 清除所有本地存储的用户信息
          wx.removeStorageSync('userInfo');
          wx.removeStorageSync('openid');

          // 2. 清除全局用户信息（但保留云开发连接）
          const app = getApp();
          app.globalData.userInfo = null;
          app.globalData.hasUserProfile = false;
          app.globalData.openid = null;
          app.globalData.isLogin = false;

          console.log('退出登录完成，hasUserProfile:', app.globalData.hasUserProfile);

          // 3. 返回我的页面
          wx.navigateBack();

          // 4. 延迟显示提示并刷新页面
          setTimeout(() => {
            wx.showToast({
              title: '已退出登录',
              icon: 'success',
              duration: 1500
            });

            // 刷新个人中心页面
            const pages = getCurrentPages();
            const prevPage = pages[pages.length - 2];
            if (prevPage && prevPage.route === 'pages/my/index') {
              prevPage.onLoad(); // 重新加载个人中心页面
            }
          }, 500);
        }
      }
    });
  }
});
