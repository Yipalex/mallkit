// 云函数错误处理工具
// 用于统一记录错误日志到数据库

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 记录错误到数据库
 * @param {string} functionName - 云函数名称
 * @param {string} action - 操作类型
 * @param {Error} error - 错误对象
 * @param {object} context - 错误上下文信息
 */
async function logError(functionName, action, error, context = {}) {
  try {
    await db.collection('error_logs').add({
      data: {
        functionName,
        action,
        errorMessage: error.message || 'Unknown error',
        errorStack: error.stack || '',
        context: JSON.stringify(context),
        userId: context.OPENID || 'anonymous',
        timestamp: new Date(),
        env: cloud.DYNAMIC_CURRENT_ENV
      }
    });
    console.log('错误已记录到数据库:', functionName, action);
  } catch (logError) {
    console.error('记录错误日志失败:', logError.message);
  }
}

/**
 * 包装云函数主函数，自动捕获错误
 * @param {string} functionName - 云函数名称
 * @param {Function} handler - 云函数主逻辑
 */
function withErrorHandling(functionName, handler) {
  return async (event, context) => {
    try {
      return await handler(event, context);
    } catch (error) {
      console.error(`${functionName} 执行出错:`, error);

      // 记录错误到数据库
      await logError(functionName, event.action || 'unknown', error, {
        event,
        OPENID: cloud.getWXContext().OPENID
      });

      // 返回用户友好的错误信息
      return {
        code: 500,
        message: error.message || '系统错误，请稍后重试'
      };
    }
  };
}

module.exports = {
  logError,
  withErrorHandling
};
