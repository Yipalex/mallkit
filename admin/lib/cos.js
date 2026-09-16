// 腾讯云 COS 客户端（用于云存储管理 API：list/delete/orphans/usage）
// 与 CloudBase SDK 不同：COS 是直连对象存储，需要 SecretId/SecretKey 才能用
const COS = require('cos-nodejs-sdk-v5');
const { cloudInitOptions, secretId, secretKey } = require('../config/cloud');

let _cosClient = null;
function getCos() {
  if (_cosClient) return _cosClient;
  if (!secretId || !secretKey) throw new Error('云存储功能需要 TENCENTCLOUD_SECRETID/SECRETKEY 环境变量');
  _cosClient = new COS({ SecretId: secretId, SecretKey: secretKey });
  return _cosClient;
}

// CloudBase 环境 ID + 资源 AppID（推断出 COS Bucket 名）
// 真实 bucket 名格式：{4位hash}-{envId}-{appId}，从 envQuery info 得到
const COS_ENV_ID = process.env.TCB_ENV_ID || cloudInitOptions.env || 'your-env-id';
const COS_APP_ID = 'your-app-id';
const COS_HASH = '0000';  // 4位 hash 前缀，CloudBase 控制台/envQuery info 里看
const COS_BUCKET = process.env.COS_BUCKET || `${COS_HASH}-${COS_ENV_ID}-${COS_APP_ID}`;
const COS_REGION = process.env.COS_REGION || 'ap-shanghai';
const COS_CDN_DOMAIN = `${COS_HASH}-${COS_ENV_ID}-${COS_APP_ID}.tcb.qcloud.la`;

// 把 cloud:// fileID 转成 COS 对象 key
function fileIdToCosKey(fileId) {
  // cloud://{envId}.{bucket}/avatars/xxx.jpg
  if (!fileId || !fileId.startsWith('cloud://')) return null;
  const m = fileId.match(/^cloud:\/\/[^.]+\.[^/]+\/(.+)$/);
  return m ? m[1] : null;
}

function cosKeyToFileId(key) {
  // cloud://{envId}.{bucket}/{key}
  return `cloud://${COS_ENV_ID}.${COS_BUCKET}/${key}`;
}

module.exports = {
  getCos,
  COS_ENV_ID,
  COS_APP_ID,
  COS_HASH,
  COS_BUCKET,
  COS_REGION,
  COS_CDN_DOMAIN,
  fileIdToCosKey,
  cosKeyToFileId,
};
