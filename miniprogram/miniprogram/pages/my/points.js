// pages/my/points.js - 积分明细（point_logs 流水）
const app = getApp();

// 积分来源 type → 中文（WXML 不做映射，JS 里算好）
const TYPE_LABEL = {
  checkin: '每日签到',
  review: '评价晒单奖励',
  order: '下单获得',
  exchange: '积分兑换',
  recharge: '充值赠送',
  admin: '系统调整',
};

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
    points: 0,
    logs: [],
    loading: false,
    page: 1,
    pageSize: 20,
    hasMore: true,
  },

  onLoad() {
    // 当前积分从缓存快速展示
    const userInfo = wx.getStorageSync('userInfo') || {};
    this.setData({ points: userInfo.memberLevel?.points || userInfo.points || 0 });
    this.loadLogs();
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
        name: 'user',
        data: { action: 'getPointLogs', page: this.data.page, pageSize: this.data.pageSize }
      });
      if (res.result && res.result.code === 200) {
        const mapped = (res.result.data || []).map(l => {
          const pts = Number(l.points) || 0;
          return {
            ...l,
            desc: l.description || TYPE_LABEL[l.type] || '积分变动',
            timeText: fmtTime(l.createdAt),
            points: pts,
            pointsText: (pts >= 0 ? '+' : '') + pts,
          };
        });
        const logs = this.data.page === 1 ? mapped : [...this.data.logs, ...mapped];
        this.setData({
          logs,
          hasMore: logs.length < (res.result.total || 0),
        });
      }
    } catch (e) {
      console.error('加载积分明细失败', e);
    } finally {
      this.setData({ loading: false });
    }
  },
});
