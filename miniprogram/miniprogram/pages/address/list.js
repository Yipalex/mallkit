// pages/address/list.js - 收货地址管理
// 地址存本地 storage：addressList = [{id,name,phone,province,city,district,detail,isDefault}]
// 默认地址同时镜像写入 defaultAddress（pay 页 / 商品详情「送至」等都读它，保持兼容）

function maskPhone(p) {
  if (!p || p.length < 11) return p || '';
  return p.slice(0, 3) + '****' + p.slice(7);
}

Page({
  data: {
    addresses: [],
  },

  onShow() {
    this.loadList();
  },

  loadList() {
    let list = wx.getStorageSync('addressList') || [];

    // 兼容迁移：旧版只有 defaultAddress 单地址；pay 页 wx.chooseAddress 也只写 defaultAddress。
    // 若 defaultAddress 不在列表里，合并进来作为默认地址。
    const def = wx.getStorageSync('defaultAddress');
    if (def && def.province) {
      const exists = list.some(a =>
        a.name === def.name && a.phone === def.phone && a.detail === def.detail
      );
      if (!exists) {
        list = list.map(a => ({ ...a, isDefault: false }));
        list.unshift({ id: 'def_' + Date.now(), ...def, isDefault: true });
        wx.setStorageSync('addressList', list);
      }
    }

    // 默认地址排最前，展示字段在 JS 里算好
    const sorted = [...list].sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    this.setData({
      addresses: sorted.map(a => ({
        ...a,
        phoneMask: maskPhone(a.phone),
        fullText: `${a.province}${a.city}${a.district} ${a.detail}`,
      })),
    });
  },

  _saveList(list) {
    wx.setStorageSync('addressList', list);
    // 镜像默认地址（供 pay/详情等页读取）
    const def = list.find(a => a.isDefault);
    if (def) {
      const { id, isDefault, phoneMask, fullText, ...addr } = def;
      wx.setStorageSync('defaultAddress', addr);
    } else {
      wx.removeStorageSync('defaultAddress');
    }
    this.loadList();
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/address/edit' });
  },

  onEdit(e) {
    wx.navigateTo({ url: `/pages/address/edit?id=${e.currentTarget.dataset.id}` });
  },

  // 点卡片 = 设为默认并返回（从下单/详情页进来选地址的场景）
  onSelect(e) {
    this.onSetDefault(e);
  },

  onSetDefault(e) {
    const id = e.currentTarget.dataset.id;
    const list = (wx.getStorageSync('addressList') || []).map(a => ({
      ...a,
      isDefault: a.id === id,
    }));
    this._saveList(list);
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除地址',
      content: '确定删除该收货地址？',
      confirmColor: '#E06A5A',
      success: (res) => {
        if (!res.confirm) return;
        let list = (wx.getStorageSync('addressList') || []).filter(a => a.id !== id);
        // 删掉默认地址后，第一条自动成为默认
        if (list.length && !list.some(a => a.isDefault)) {
          list[0].isDefault = true;
        }
        this._saveList(list);
      }
    });
  },
});
