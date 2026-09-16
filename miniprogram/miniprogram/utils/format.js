// utils/format.js - 格式化工具函数

/**
 * 格式化金额：1234.5 → '1,234.50'
 */
function formatPrice(price) {
  if (price === null || price === undefined) return '0.00';
  return parseFloat(price).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 格式化日期：Date对象 → '2026-03-28 14:30'
 */
function formatDate(date, format = 'YYYY-MM-DD HH:mm') {
  if (!date) return '';
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');

  return format
    .replace('YYYY', d.getFullYear())
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()));
}

/**
 * 格式化手机号：13800138000 → '138****8000'（脱敏）
 */
function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone;
  return phone.substring(0, 3) + '****' + phone.substring(7);
}

/**
 * 订单状态 → 中文文字
 */
function orderStatusText(status) {
  const map = {
    'pending_payment': '待支付',
    'paid': '待发货',
    'shipped': '已发货',
    'completed': '已完成',
    'cancelled': '已取消',
    'refunded': '已退款',
  };
  return map[status] || status;
}

module.exports = { formatPrice, formatDate, maskPhone, orderStatusText };
