// components/sku-picker - 列表页复用的规格选择浮层
// 复用 detail.js 的规格匹配逻辑；确定时 triggerEvent('confirm', { item }) + triggerEvent('close')
// 秒杀价不处理，一律按 sku.price 原价（服务端下单会重算）
Component({
  properties: {
    product: {
      type: Object,
      value: {},
      // 商品变化时重置已选状态并算最低价
      observer() {
        this._reset();
      }
    },
    show: {
      type: Boolean,
      value: false,
      // 每次打开时重置，避免残留上次的选择
      observer(val) {
        if (val) this._reset();
      }
    }
  },
  data: {
    selectedOptionIndexes: [], // 各维度已选下标，未选为 undefined
    matchedSku: null,          // 选项组合命中的 sku（全选齐才有）
    quantity: 1,
    skuMinPrice: '',           // 未选齐时展示的"¥X 起"最低价
  },
  methods: {
    noop() {},

    // 重置选择状态 + 计算最低价
    _reset() {
      const p = this.properties.product || {};
      let skuMinPrice = '';
      if (p.hasSku && Array.isArray(p.skus) && p.skus.length) {
        const active = p.skus.filter(s => s.isActive !== false);
        if (active.length) skuMinPrice = Math.min(...active.map(s => Number(s.price))).toString();
      }
      this.setData({
        selectedOptionIndexes: [],
        matchedSku: null,
        quantity: 1,
        skuMinPrice,
      });
    },

    // 点击某维度的某个选项
    onSelectSkuOption(e) {
      const { gi, oi } = e.currentTarget.dataset;
      const selected = [...this.data.selectedOptionIndexes];
      selected[gi] = Number(oi);
      this.setData({ selectedOptionIndexes: selected });
      this._matchSku(selected);
    },

    // 根据已选各维度下标匹配 sku（全选齐才算命中）
    _matchSku(selected) {
      const product = this.properties.product || {};
      const groupCount = (product.specGroups || []).length;
      const allChosen = selected.length === groupCount && selected.every(v => v !== undefined && v !== null);
      let matchedSku = null;
      if (allChosen) {
        matchedSku = (product.skus || []).find(s =>
          s.isActive !== false &&
          Array.isArray(s.optionIndexes) &&
          s.optionIndexes.length === selected.length &&
          s.optionIndexes.every((v, i) => Number(v) === Number(selected[i]))
        ) || null;
      }
      // 切换规格时数量回到 1，避免超过新规格库存
      this.setData({ matchedSku, quantity: 1 });
    },

    // 数量增减
    onQuantityChange(e) {
      const action = e.currentTarget.dataset.action;
      let q = this.data.quantity;
      if (action === 'minus' && q > 1) q--;
      if (action === 'plus' && q < 99) q++;
      this.setData({ quantity: q });
    },

    // 关闭浮层
    onClose() {
      this.triggerEvent('close');
    },

    // 确定：校验选齐 + 有货，构建购物车 item 抛给宿主页面
    onConfirm() {
      const { matchedSku, quantity } = this.data;
      const product = this.properties.product || {};
      if (!matchedSku) return wx.showToast({ title: '请选择规格', icon: 'none' });
      if (Number(matchedSku.stock) <= 0) return wx.showToast({ title: '该规格已售罄', icon: 'none' });
      const item = {
        productId: product._id,
        skuId: matchedSku.skuId,
        specText: matchedSku.specText || '',
        name: product.name,
        image: matchedSku.image || product.mainImage,
        price: matchedSku.price,
        unit: matchedSku.unit || product.unit || 'kg',
        quantity,
      };
      this.triggerEvent('confirm', { item });
      this.triggerEvent('close');
    },
  }
});
