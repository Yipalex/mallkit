// components/login-guide/index.js - 登录引导组件
Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    }
  },

  methods: {
    onClose() {
      this.triggerEvent('close');
    },

    onGoLogin() {
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      const currentRoute = currentPage.route;

      // 跳转到登录页，带上当前页面路径作为登录成功后的跳转目标
      wx.navigateTo({
        url: `/pages/login/index?redirect=/${currentRoute}`
      });

      this.triggerEvent('close');
    },

    noop() {
      // 阻止事件冒泡
    }
  }
});
