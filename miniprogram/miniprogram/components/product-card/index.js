Component({
  properties: {
    product: {
      type: Object,
      value: {},
      // 商品变化时计算是否售罄（单规格 stock<=0；多规格全部 active sku 售罄）
      observer(p) {
        this.setData({ isSoldOut: computeSoldOut(p) });
      }
    }
  },
  data: {
    added: false,
    isSoldOut: false
  },
  methods: {
    onTap() {
      this.triggerEvent('producttap', { product: this.properties.product });
    },
    onAddCart() {
      const p = this.properties.product;
      // 售罄不可加购
      if (computeSoldOut(p)) {
        wx.showToast({ title: '商品已售罄', icon: 'none' });
        return;
      }
      // 多规格商品：请求宿主页面弹出规格选择浮层，就地选规格加购，不跳详情
      if (p && p.hasSku) {
        this.triggerEvent('specrequest', { product: p });
        return;
      }
      // 触发动画
      this.setData({ added: true });
      // 触发事件
      this.triggerEvent('addcart', { product: p });
      // 动画结束后重置状态
      setTimeout(() => {
        this.setData({ added: false });
      }, 600);
    }
  }
});

// 计算商品是否整品售罄
function computeSoldOut(p) {
  if (!p) return false;
  if (p.hasSku && Array.isArray(p.skus) && p.skus.length) {
    const active = p.skus.filter(s => s.isActive !== false);
    return active.length === 0 || active.every(s => Number(s.stock) <= 0);
  }
  return Number(p.stock) <= 0;
}
