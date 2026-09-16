// pages/my/recharge.js
const app = getApp();

Page({
  data: {
    balance: '0.00',
    selectedAmount: -1,   // >=0 选中档位下标；-2 自定义
    customAmount: '',
    payAmount: 0,         // 底部栏展示的实付金额
    payBonus: 0,          // 底部栏展示的赠送积分
    agreed: false,
    isProcessing: false,
    showLoginGuide: false,
    // 充值档位（送积分规则：满 ¥100 每 ¥1 送 1 积分，¥50 无赠送；服务端 calcRechargeBonusPoints 是唯一真源）
    amountOptions: [
      { amount: 50,   points: 0 },
      { amount: 100,  points: 100 },
      { amount: 200,  points: 200 },
      { amount: 300,  points: 300, hot: true },
      { amount: 500,  points: 500 },
    ],
  },

  onLoad() {
    this.checkLoginAndLoad();
  },

  onShow() {
    if (!this.data.showLoginGuide) {
      this.loadBalance();
    }
  },

  // 检查登录状态：有 openid 即视为已登录（微信静默登录），
  // 不用 hasUserProfile（昵称是否已改）当门槛，否则新用户一进来就被蒙层拦住
  async checkLoginAndLoad() {
    await app.waitForLogin();
    if (!app.globalData.isLogin || !app.globalData.openid) {
      this.setData({ showLoginGuide: true });
      return;
    }
    this.loadBalance();
  },

  async loadBalance() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'getMemberInfo' }
      });
      if (res.result.code === 200) {
        this.setData({ balance: (res.result.data.balance || 0).toFixed(2) });
      }
    } catch (err) {
      console.error('loadBalance error', err);
    }
  },

  onSelectAmount(e) {
    const index = Number(e.currentTarget.dataset.index);
    const opt = this.data.amountOptions[index];
    this.setData({
      selectedAmount: index,
      customAmount: '',
      payAmount: opt.amount,
      payBonus: opt.points || 0,
    });
  },

  // 自定义金额：用可编辑弹窗输入（送等额积分，与档位规则一致）
  onCustomAmount() {
    wx.showModal({
      title: '自定义充值金额',
      editable: true,
      placeholderText: '请输入金额（元）',
      success: (res) => {
        if (!res.confirm) return;
        const amount = Math.floor(Number(res.content));
        if (!amount || amount <= 0 || amount > 50000) {
          wx.showToast({ title: '请输入有效金额', icon: 'none' });
          return;
        }
        this.setData({
          selectedAmount: -2,
          customAmount: String(amount),
          payAmount: amount,
          payBonus: amount >= 100 ? amount : 0,   // 满 ¥100 每 ¥1 送 1 积分，与档位/服务端一致
        });
      }
    });
  },

  onViewAgreement() {
    wx.navigateTo({ url: '/pages/terms/terms?type=recharge' });
  },

  // 余额明细（充值记录）
  onGoBalanceDetail() {
    wx.navigateTo({ url: '/pages/my/balance' });
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  async onRecharge() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先同意充值协议', icon: 'none' });
      return;
    }
    if (this.data.isProcessing) return;

    const { selectedAmount, amountOptions, customAmount } = this.data;
    let amount = 0;
    if (selectedAmount >= 0) {
      amount = amountOptions[selectedAmount].amount;
    } else if (selectedAmount === -2 && customAmount) {
      amount = Number(customAmount);
    }

    if (!amount || amount <= 0) {
      wx.showToast({ title: '请选择或输入充值金额', icon: 'none' });
      return;
    }

    this.setData({ isProcessing: true });

    try {
      wx.showLoading({ title: '创建充值订单...' });

      // 1. 调用 pay 云函数获取充值预支付参数
      //    赠送积分由服务端按金额自算（不再传 bonus，防篡改）
      const payRes = await wx.cloud.callFunction({
        name: 'pay',
        data: {
          action: 'recharge',
          amount,
          userId: app.globalData.openid,
        }
      });

      if (payRes.result.code !== 200) {
        wx.showModal({ title: '充值失败', content: payRes.result.message || '未知错误', showCancel: false });
        return;
      }

      const p = payRes.result.data;
      wx.hideLoading();

      // 2. 唤起微信支付
      wx.requestPayment({
        timeStamp: p.timeStamp,
        nonceStr: p.nonceStr,
        package: p.package,
        signType: 'RSA',
        paySign: p.paySign,

        success: () => {
          const bp = p.bonusPoints || 0;
          wx.showToast({ title: bp > 0 ? `充值成功，送${bp}积分` : '充值成功', icon: 'success' });
          setTimeout(() => this.loadBalance(), 1500);
        },

        fail: (err) => {
          if (!err.errMsg.includes('cancel')) {
            wx.showToast({ title: '支付失败，请重试', icon: 'none' });
          }
        }
      });

    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '系统错误，请重试', icon: 'none' });
      console.error('onRecharge error', err);
    } finally {
      this.setData({ isProcessing: false });
    }
  },

  onCloseLoginGuide() {
    this.setData({ showLoginGuide: false });
    wx.navigateBack();
  }
});
