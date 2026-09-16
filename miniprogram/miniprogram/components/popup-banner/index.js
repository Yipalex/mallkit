Component({
  properties: {
    popup: {
      type: Object,
      value: null,
    },
    show: {
      type: Boolean,
      value: false,
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close');
    },

    onTap() {
      const popup = this.properties.popup;
      if (!popup) return;
      const { linkType, linkValue } = popup;

      if (linkType === 'product' && linkValue) {
        wx.navigateTo({ url: `/pages/product/detail?id=${linkValue}` });
      } else if (linkType === 'coupon' && linkValue) {
        wx.navigateTo({ url: `/pages/coupons/index?autoGet=${linkValue}` });
      } else if (linkType === 'page' && linkValue) {
        wx.navigateTo({ url: linkValue });
      }

      this.triggerEvent('close');
    },

    noop() {},
  },
});
