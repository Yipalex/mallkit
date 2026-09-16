// pages/address/edit.js
// 发货地：示例发货城市，示例快递
// 不支持配送的地区，请按你的实际情况改

const NO_DELIVERY = ['新疆', '西藏', '内蒙古', '青海', '宁夏', '香港', '澳门', '台湾'];

function getShippingInfo(province) {
  if (!province) return null;
  for (const p of NO_DELIVERY) {
    if (province.includes(p)) return null;
  }
  return { fee: 0, label: '指定区域包邮', desc: '预计1-2个工作日送达' };
}

Page({
  data: {
    form: { name: '', phone: '', province: '', city: '', district: '', detail: '' },
    regionVal: [],
    deliveryTip: '',
    shippingInfo: null,
    canSave: false,
  },

  onLoad(options) {
    // 带 id = 编辑地址列表里的某条；不带 = 新增（空表单）
    this._editId = options.id || '';
    if (this._editId) {
      const list = wx.getStorageSync('addressList') || [];
      const saved = list.find(a => a.id === this._editId);
      if (saved && saved.province) {
        this.setData({
          form: {
            name: saved.name, phone: saved.phone,
            province: saved.province, city: saved.city,
            district: saved.district, detail: saved.detail,
          },
          regionVal: [saved.province, saved.city, saved.district],
        });
        this.calcShipping(saved.province);
        this.checkCanSave();
      }
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
    this.checkCanSave();
  },

  onRegionChange(e) {
    const [province, city, district] = e.detail.value;
    this.setData({
      'form.province': province,
      'form.city': city,
      'form.district': district,
      regionVal: [province, city, district],
    });
    this.calcShipping(province);
    this.checkCanSave();
  },

  calcShipping(province) {
    const info = getShippingInfo(province);
    if (!info) {
      this.setData({
        deliveryTip: `抱歉，当前配送范围暂未覆盖${province}`,
        shippingInfo: null,
        canSave: false,
      });
    } else {
      this.setData({ deliveryTip: '', shippingInfo: info });
    }
  },

  checkCanSave() {
    const { name, phone, province, detail } = this.data.form;
    const blocked = !!this.data.deliveryTip;
    this.setData({
      canSave: !!(name && phone && phone.length === 11 && province && detail && !blocked)
    });
  },

  onSave() {
    if (!this.data.canSave) return;
    const address = this.data.form;

    // 写入地址列表（编辑=更新原条目，新增=追加；首条自动设为默认）
    let list = wx.getStorageSync('addressList') || [];
    if (this._editId) {
      list = list.map(a => a.id === this._editId ? { ...a, ...address } : a);
    } else {
      list.push({
        id: 'a_' + Date.now(),
        ...address,
        isDefault: list.length === 0,
      });
    }
    wx.setStorageSync('addressList', list);

    // 默认地址镜像到 defaultAddress（pay/详情等页读它）
    const def = list.find(a => a.isDefault);
    if (def) {
      const { id, isDefault, ...addr } = def;
      wx.setStorageSync('defaultAddress', addr);
      // 运费按默认地址算（当前编辑的就是默认地址时才更新）
      if (this._editId ? def.id === this._editId : list.length === 1) {
        wx.setStorageSync('shippingFee', this.data.shippingInfo?.fee ?? 0);
      }
    }
    wx.navigateBack();
  }
});
