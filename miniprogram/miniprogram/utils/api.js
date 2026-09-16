// utils/api.js - 云函数调用统一封装
// 所有与后端的通信都通过这里，方便统一处理错误和 loading

/**
 * 调用云函数的通用方法
 * @param {string} name - 云函数名称
 * @param {object} data - 传递给云函数的参数
 * @param {boolean} showLoading - 是否显示 loading（默认 false）
 * @returns {Promise} 云函数返回结果
 */
async function callFunction(name, data, showLoading = false) {
  if (showLoading) wx.showLoading({ title: '加载中...' });

  try {
    const res = await wx.cloud.callFunction({ name, data });
    return res.result;
  } catch (err) {
    console.error(`云函数 ${name} 调用失败:`, err);
    throw new Error('网络错误，请稍后重试');
  } finally {
    if (showLoading) wx.hideLoading();
  }
}

// ===== 商品相关 =====
const Product = {
  getList: (params) => callFunction('product', { action: 'getList', ...params }),
  getDetail: (productId) => callFunction('product', { action: 'getDetail', productId }),
  getBanners: () => callFunction('product', { action: 'getBanners' }),
};

// ===== 订单相关 =====
const Order = {
  create: (params) => callFunction('order', { action: 'create', ...params }),
  list: (status) => callFunction('order', { action: 'list', status }),
  getDetail: (orderId) => callFunction('order', { action: 'getDetail', orderId }),
  validateCoupon: (code, subtotal) => callFunction('order', { action: 'validateCoupon', code, subtotal }),
  updateStatus: (orderId, status) => callFunction('order', { action: 'updateStatus', orderId, status }),
};

// ===== 支付相关 =====
const Pay = {
  prepay: (orderId, totalAmount, userId) => callFunction('pay', { orderId, totalAmount, userId }),
};

// ===== 用户相关 =====
const User = {
  login: () => callFunction('user', { action: 'login' }),
  getMemberInfo: () => callFunction('user', { action: 'getMemberInfo' }),
  updateProfile: (userInfo) => callFunction('user', { action: 'updateProfile', userInfo }),
};

// ===== 分销相关 =====
const Distribution = {
  register: () => callFunction('distribution', { action: 'register' }),
  getInfo: () => callFunction('distribution', { action: 'getInfo' }),
  withdraw: (amount) => callFunction('distribution', { action: 'withdraw', amount }),
};

module.exports = { Product, Order, Pay, User, Distribution };
