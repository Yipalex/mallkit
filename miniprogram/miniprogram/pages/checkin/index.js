// pages/checkin/index.js - 每日签到
// 积分存储在云数据库 users.memberLevel.points；
// 连签奖励与 user 云函数 CHECKIN_POINTS 保持一致：[5,5,5,10,10,10,30]（按连签天数，第7天封顶）
const CHECKIN_POINTS = [5, 5, 5, 10, 10, 10, 30];

function dateKey(d) {
  // 与云函数一致用 ISO 日期（yyyy-mm-dd）
  return d.toISOString().slice(0, 10);
}

Page({
  data: {
    points: 0,
    streak: 0,
    todayChecked: false,
    cells: [],        // 7 格连签进度（label/state/points）
    tipText: '',
    btnText: '今日签到',
    loading: false,
  },

  onShow() {
    this.loadCheckinData();
  },

  async loadCheckinData() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'getMemberInfo' }
      });
      if (res.result.code !== 200) return;

      const user = res.result.data;
      const now = new Date();
      const todayKey = dateKey(now);
      const yesterdayKey = dateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));

      const streak = user.checkinStreak || 0;
      const todayChecked = user.lastCheckinDate === todayKey;
      // 复刻云函数逻辑：今天签到后的连签天数（昨天签过则 +1，否则从 1 重新起算）
      const streakIfCheckToday = user.lastCheckinDate === yesterdayKey ? streak + 1 : 1;
      // 「今天」在 7 格里的位置（第 7 天封顶）
      const todayDayNum = Math.min(todayChecked ? streak : streakIfCheckToday, 7) || 1;
      const todayEarn = CHECKIN_POINTS[todayDayNum - 1];
      const tomorrowEarn = CHECKIN_POINTS[Math.min(todayDayNum, 6)];

      // 7 格：今天之前=已签，今天=高亮，之后=虚线（第7格橙色礼盒）
      const cells = [];
      for (let i = 1; i <= 7; i++) {
        let state, label = `第${i}天`, points = CHECKIN_POINTS[i - 1];
        if (i < todayDayNum) {
          state = 'done';
        } else if (i === todayDayNum) {
          label = '今天';
          state = todayChecked ? 'done' : 'today';
          points = todayEarn;
        } else {
          state = i === 7 ? 'day7' : 'future';
        }
        cells.push({ label, state, points });
      }

      this.setData({
        points: user.memberLevel?.points || 0,
        streak,
        todayChecked,
        cells,
        tipText: todayChecked
          ? `明天再来可得 ${tomorrowEarn} 积分`
          : `今天签到可得 ${todayEarn} 积分，连签第 7 天 +30`,
        btnText: todayChecked ? '今日已签到 ✓' : `今日签到 · 领 ${todayEarn} 积分`,
      });
    } catch (err) {
      console.error('loadCheckinData error', err);
    }
  },

  async onCheckin() {
    if (this.data.todayChecked || this.data.loading) return;
    this.setData({ loading: true });

    try {
      wx.showLoading({ title: '签到中...' });
      const res = await wx.cloud.callFunction({
        name: 'user',
        data: { action: 'checkin' }
      });
      wx.hideLoading();

      if (res.result.code === 200) {
        const { earnedPoints } = res.result.data;
        wx.showToast({ title: `签到成功 +${earnedPoints}积分`, icon: 'success' });
        // 刷新完整状态（格子/按钮/提示一起更新）
        this.loadCheckinData();
      } else {
        wx.showToast({ title: res.result.message || '签到失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络错误，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 任务入口
  onGoGift() { wx.navigateTo({ url: '/pages/gift/index' }); },
  // 评价晒单 → 已完成订单列表，从里面选订单去评价（评价成功后端发 +20 积分）
  onGoReview() { wx.navigateTo({ url: '/pages/order/list?status=completed' }); },
  onGoShop() { wx.switchTab({ url: '/pages/index/index' }); },
});
