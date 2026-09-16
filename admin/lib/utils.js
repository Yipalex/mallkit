// 通用工具函数

// ===== 分销折扣换算（统一防呆）=====
// discountPercent 语义：买家折扣率，100 = 不打折（10折），95 = 95折，0/null/undefined/>=100 一律视作不打折
// 返回 discountValue：买家最终减免的百分比（用来算钱），0 代表不减免
function computeDiscountValue(discountPercent) {
  const p = Number(discountPercent);
  if (!Number.isFinite(p) || p <= 0 || p >= 100) return 0;
  return 100 - p;
}

// 把 CloudBase 返回的 Date 对象/{$date:N}/字符串/数字 统一转成毫秒时间戳
function toMs(t) {
  if (!t) return 0;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return new Date(t).getTime();
  if (t.$date) return Number(t.$date);
  if (t instanceof Date) return t.getTime();
  return 0;
}

function fmtDateTime(t) {
  const ms = toMs(t);
  if (!ms) return '';
  // 容器时区为 UTC，必须显式按北京时间（Asia/Shanghai）格式化，否则会少 8 小时
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  // hour12:false 在零点可能返回 "24"，归一化为 "00"
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}/${parts.month}/${parts.day} ${hour}:${parts.minute}`;
}

// 月份字符串 "2026-05" → 北京时间月初/次月月初的毫秒时间戳区间
function monthToRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  // 用 UTC 构造避免服务器时区漂移，再减 8 小时变成北京时间的月初
  const start = Date.UTC(y, m - 1, 1) - 8 * 60 * 60 * 1000;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = Date.UTC(nextY, nextM - 1, 1) - 8 * 60 * 60 * 1000;
  return { start, end };
}

function fmtMonth(y, m) { return `${y}-${String(m).padStart(2, '0')}`; }

module.exports = {
  computeDiscountValue,
  toMs,
  fmtDateTime,
  monthToRange,
  fmtMonth,
};
