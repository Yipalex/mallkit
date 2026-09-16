// pages/help/index.js - 客服帮助
Page({
  data: {
    faqExpanded: [false, false, false, false, false]
  },

  // 拨打客服热线
  onCallService() {
    wx.makePhoneCall({
      phoneNumber: '400-000-0000'
    });
  },

  // 联系在线客服
  onContactService() {
    wx.showModal({
      title: '在线客服',
      content: '客服工作时间为08:00-22:00，请稍后...',
      showCancel: false
    });
  },

  // 发送邮件
  onSendEmail() {
    wx.showModal({
      title: '发送邮件',
      content: '邮箱：support@example.com\n我们会在24小时内回复您的邮件',
      showCancel: false
    });
  },

  // 展开/收起FAQ
  onToggleFaq(e) {
    const index = e.currentTarget.dataset.index;
    const expanded = [...this.data.faqExpanded];
    expanded[index] = !expanded[index];
    this.setData({ faqExpanded: expanded });
  },

  // 意见反馈
  onFeedback() {
    wx.showModal({
      title: '意见反馈',
      content: '感谢您的反馈！您可以通过以下方式联系我们：\n\n客服热线：400-000-0000\n电子邮箱：support@example.com',
      showCancel: false
    });
  }
});