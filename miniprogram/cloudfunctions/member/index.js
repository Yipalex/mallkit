// cloudfunctions/member/index.js
// 会员相关云函数（目前逻辑已集成在 user 和 payNotify 中，此文件备用扩展）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { action, triggerName } = event;

  // 定时触发器触发时 triggerName 有值，直接执行结算
  if (triggerName) {
    console.log('定时触发器执行佣金结算:', triggerName);
    return await settleCommissions();
  }

  switch (action) {
    case 'settleCommissions': return await settleCommissions();
    default: return { code: 400, message: '未知操作' };
  }
};

// ===== 自动结算到期的佣金 =====
// 规则：订单完成超过7天的佣金，从 pending → settled（可提现）
// 建议用云开发"定时触发器"每天0点自动执行
async function settleCommissions() {
  try {
    const now = new Date();

    // 查找所有到达结算时间、状态为 pending 的佣金日志
    const logsRes = await db.collection('commission_logs')
      .where({
        status: 'pending',
        settleTime: _.lte(now),  // 结算时间已到
      })
      .limit(100)  // 每次处理100条
      .get();

    console.log(`待结算佣金数量: ${logsRes.data.length}`);

    let settledCount = 0;
    let totalSettledAmount = 0;

    for (const log of logsRes.data) {
      // 将 pending_amount 转移到 settled_amount（可提现）
      await db.collection('distributors').where({ userId: log.distributorId }).update({
        data: {
          'withdrawal.pendingAmount': _.inc(-log.commissionAmount),
          'withdrawal.settledAmount': _.inc(log.commissionAmount),
          'stats.totalCommissionEarned': _.inc(log.commissionAmount),
        }
      });

      // 更新日志状态
      await db.collection('commission_logs').doc(log._id).update({
        data: { status: 'settled', settledAt: now }
      });

      settledCount++;
      totalSettledAmount += log.commissionAmount;
    }

    console.log(`结算完成：${settledCount} 条，合计 ¥${totalSettledAmount.toFixed(2)}`);
    return { code: 200, data: { settledCount, totalSettledAmount } };

  } catch (err) {
    console.error('settleCommissions error:', err);
    return { code: 500, message: err.message };
  }
}
