// custom-tab-bar/index.js - 悬浮毛玻璃底栏（2026-07 UI 重设计）
// 微信约定：放在 custom-tab-bar/ 目录 + app.json 里 tabBar.custom: true 即自动启用。
// 选中态不依赖各 tab 页 JS 调用，而是组件自己根据当前页面路由判断，
// 这样四个 tab 页的 JS 完全不用改。

const TABS = [
  { pagePath: '/pages/index/index', text: '首页', key: 'home' },
  { pagePath: '/pages/member/index', text: '会员中心', key: 'member' },
  { pagePath: '/pages/cart/index', text: '购物车', key: 'cart' },
  { pagePath: '/pages/my/index', text: '我的', key: 'my' }
];

Component({
  data: {
    selected: 0,
    tabs: TABS,
    cartCount: 0   // 购物车角标数量（自定义 tabBar 需自绘，wx.setTabBarBadge 对 custom 无效）
  },

  lifetimes: {
    attached() {
      this.updateSelected();
      this.refreshCartBadge();
    }
  },

  pageLifetimes: {
    // 每次所在页面显示时重新判断选中项 + 刷新角标（switchTab 返回时也正确）
    show() {
      this.updateSelected();
      this.refreshCartBadge();
    }
  },

  methods: {
    // 根据当前页面路由计算选中的 tab
    updateSelected() {
      const pages = getCurrentPages();
      if (!pages.length) return;
      const route = '/' + pages[pages.length - 1].route;
      const idx = TABS.findIndex((t) => t.pagePath === route);
      if (idx !== -1 && idx !== this.data.selected) {
        this.setData({ selected: idx });
      }
    },

    // 刷新购物车角标：直接读本地 cart 存储求和（app.globalData.cartCount 兜底）
    refreshCartBadge() {
      let count = 0;
      try {
        const cart = wx.getStorageSync('cart') || [];
        count = cart.reduce((s, c) => s + (c.quantity || 0), 0);
      } catch (e) {
        const app = getApp();
        count = (app && app.globalData && app.globalData.cartCount) || 0;
      }
      if (count !== this.data.cartCount) this.setData({ cartCount: count });
    },

    // 点击切换 tab
    onTabTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      const tab = TABS[index];
      if (!tab) return;
      wx.switchTab({ url: tab.pagePath });
    }
  }
});
