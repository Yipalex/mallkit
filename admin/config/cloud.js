// CloudBase SDK 初始化
// 容器型云托管不会自动注入凭证（只有 CBR_ROLE），必须在控制台手工配置环境变量：
//   TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY
// 密钥生成地址：https://console.cloud.tencent.com/cam/capi
// 没有凭证时 SDK 数据库调用会挂 30 秒，所以这里直接 fail-fast。
const tcb = require('@cloudbase/node-sdk');

const cloudInitOptions = {
  env: process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'your-env-id',
  timeout: 15000,
};
const secretId = process.env.TENCENTCLOUD_SECRETID || process.env.CLOUDBASE_SECRET_ID;
const secretKey = process.env.TENCENTCLOUD_SECRETKEY || process.env.CLOUDBASE_SECRET_KEY;
if (secretId && secretKey) {
  cloudInitOptions.secretId = secretId;
  cloudInitOptions.secretKey = secretKey;
  if (process.env.TENCENTCLOUD_SESSIONTOKEN) {
    cloudInitOptions.sessionToken = process.env.TENCENTCLOUD_SESSIONTOKEN;
  }
}
console.log('[init] CloudBase SDK', {
  env: cloudInitOptions.env,
  hasSecret: !!cloudInitOptions.secretId,
  source: process.env.TENCENTCLOUD_SECRETID ? 'TENCENTCLOUD_*' : (process.env.CLOUDBASE_SECRET_ID ? 'CLOUDBASE_*' : 'NONE'),
});
if (!cloudInitOptions.secretId) {
  console.error('[init] ❌ 没有读到腾讯云密钥！数据库调用将会挂 30 秒');
  console.error('[init] 请在云托管控制台 → 服务设置 → 环境变量 中配置 TENCENTCLOUD_SECRETID 和 TENCENTCLOUD_SECRETKEY');
}
const cloud = tcb.init(cloudInitOptions);
const db = cloud.database();
const _ = db.command;

module.exports = {
  cloud,
  db,
  _,
  cloudInitOptions,
  secretId,
  secretKey,
};
