// pages/my/balance.js - 余额明细（充值记录 recharge_logs）
const app = getApp();

const STATUS_TEXT = { success: '已到账', pending: '待支付', failed: '未成功' };

function fmtTime(ts) {
  if (!ts) return '';
  const ms = ts.$date ? Number(ts.$date) : (typeof ts === 'number' ? ts : new Date(ts).getTime());
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    balance: '0.00',
    logs: [],
    loading: false,
    page: 1,
    pageSize: 20,
    hasMore: true,
  },

  onShow() {
    this.loadBalance();
  },

  onLoad() {
    this.loadLogs();
  },

  async loadBalance() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'getMemberInfo' }
      });
      if (res.result.code === 200) {
        this.setData({ balance: (res.result.data.balance || 0).toFixed(2) });
      }
    } catch (e) { /* 忽略，用默认 */ }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.setData({ page: this.data.page + 1 });
      this.loadLogs();
    }
  },

  async loadLogs() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'pay',
        data: { action: 'rechargeLogs', page: this.data.page, pageSize: this.data.pageSize }
      });
      if (res.result && res.result.code === 200) {
        const mapped = (res.result.data || []).map(l => {
          const bp = Number(l.bonusPoints) || 0;
          return {
            ...l,
            timeText: fmtTime(l.createTime),
            statusText: STATUS_TEXT[l.status] || l.status,
            bonusText: bp > 0 ? `（送 ${bp} 积分）` : '',
          };
        });
        const logs = this.data.page === 1 ? mapped : [...this.data.logs, ...mapped];
        this.setData({ logs, hasMore: logs.length < (res.result.total || 0) });
      }
    } catch (e) {
      console.error('加载余额明细失败', e);
    } finally {
      this.setData({ loading: false });
    }
  },
});
