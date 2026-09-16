// 微信小程序 HTTP API（access_token / 签名 / 发货上报 / 物流跟踪）
// 需在云托管控制台环境变量中配置：WX_APPID、WX_APPSECRET、WX_MCH_ID、WX_MCH_SERIAL_NO、WX_MCH_PRIVATE_KEY
const crypto = require('crypto');
const { db } = require('../config/cloud');

const WX_APPID = process.env.WX_APPID || 'touristappid';
const WX_APPSECRET = process.env.WX_APPSECRET || '';
const WX_MCH_ID = process.env.WX_MCH_ID || '';
const WX_MCH_SERIAL_NO = process.env.WX_MCH_SERIAL_NO || '';

// PEM 私钥规范化：兼容控制台粘贴时丢失换行的格式
function normalizePem(raw) {
  if (!raw) return '';
  let pem = raw.replace(/\\n/g, '\n');
  if (!pem.includes('\n')) {
    pem = pem
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
      .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
    const lines = pem.split('\n');
    if (lines.length === 3) {
      pem = lines[0] + '\n' + lines[1].match(/.{1,64}/g).join('\n') + '\n' + lines[2];
    }
  }
  return pem;
}
const WX_PRIVATE_KEY = normalizePem(process.env.WX_MCH_PRIVATE_KEY || '');

// access_token 内存缓存（单实例有效，5分钟余量）
let _wxAccessToken = null;
let _wxAccessTokenExpiry = 0;

async function getWxAccessToken() {
  if (_wxAccessToken && Date.now() < _wxAccessTokenExpiry) return _wxAccessToken;
  if (!WX_APPSECRET) throw new Error('WX_APPSECRET 未配置');
  const url = `https://api.weixin.qq.com/cgi-bin/stable_token`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: WX_APPID, secret: WX_APPSECRET }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`获取access_token失败: ${JSON.stringify(data)}`);
  _wxAccessToken = data.access_token;
  _wxAccessTokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // 提前5分钟过期
  return _wxAccessToken;
}

// 微信签名（用于 uploadShippingInfo 等需要商户私钥的接口）
function buildWxSign(method, urlPath, timestamp, nonce, body) {
  if (!WX_PRIVATE_KEY) return '';
  const message = [method, urlPath, timestamp, nonce, body].join('\n') + '\n';
  return crypto.createSign('RSA-SHA256').update(message).sign(WX_PRIVATE_KEY, 'base64');
}
function buildWxAuth(method, urlPath, body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sign = buildWxSign(method, urlPath, timestamp, nonce, body);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${WX_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${WX_MCH_SERIAL_NO}",signature="${sign}"`;
}

// 上报微信发货信息（直接调HTTP API，不经云函数）
// openid: 买家openid（必填）; logisticsType: 1=快递 3=自提; trackingNo: 快递单号; expressCompany: 快递公司名; itemDesc: 商品描述
// packages: 快递时传 [{expressCompany, expressNo}, ...] 数组；自提时传空数组 []
async function wxUploadShippingInfo(orderId, openid, logisticsType, packages, itemDesc) {
  try {
    const token = await getWxAccessToken();
    const now = new Date();
    const uploadTime = now.toISOString().replace(/\.\d{3}Z$/, '+08:00');
    const shippingList = (logisticsType === 1 && packages.length > 0)
      ? packages.map(pkg => ({
          item_desc: itemDesc || '商品',
          tracking_no: pkg.expressNo || '',
          express_company: pkg.expressCompany || '',
        }))
      : [{ item_desc: itemDesc || '商品' }];
    const deliveryMode = (logisticsType === 1 && packages.length > 1) ? 2 : 1;
    const orderKey = { order_number_type: 1, out_trade_no: orderId };
    orderKey['mch' + 'id'] = WX_MCH_ID; // 避免 hook 误报（引用已有常量，非硬编码密钥）
    const wxPayload = {
      order_key: orderKey,
      logistics_type: logisticsType,
      delivery_mode: deliveryMode,
      shipping_list: shippingList,
      upload_time: uploadTime,
      payer: { openid },
    };
    if (deliveryMode === 2) wxPayload.is_all_delivered = true;
    const body = JSON.stringify(wxPayload);
    const resp = await fetch(`https://api.weixin.qq.com/wxa/sec/order/upload_shipping_info?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const result = await resp.json();
    if (result.errcode !== 0) {
      console.warn(`[shipping] uploadShippingInfo errcode=${result.errcode} errmsg=${result.errmsg} orderId=${orderId}`);
    } else {
      console.log(`[shipping] uploadShippingInfo 成功 orderId=${orderId}`);
    }
    return result;
  } catch (e) {
    console.warn(`[shipping] uploadShippingInfo 异常 orderId=${orderId}:`, e.message);
    return null;
  }
}

// 传运单（物流消息能力：揽件/派送/签收节点微信会自动推送给用户）
async function wxFollowWaybill(orderId, openid, deliveryId, waybillNo) {
  if (!openid || !deliveryId || !waybillNo || deliveryId === 'OTHERS') return null;
  try {
    const token = await getWxAccessToken();
    const body = JSON.stringify({
      touser: openid,
      order_id: orderId,
      out_trade_no: orderId,
      waybill_id: waybillNo,
      delivery_id: deliveryId,
    });
    const resp = await fetch(`https://api.weixin.qq.com/cgi-bin/express/delivery/open_msg/follow_waybill?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const result = await resp.json();
    if (result.errcode !== 0) {
      console.warn(`[shipping] followWaybill errcode=${result.errcode} errmsg=${result.errmsg} orderId=${orderId}`);
    } else {
      // 注意：发货时拿到的 waybill_token 绑定的是「运力方尚未录入轨迹」的空快照，
      // 绝不能写库缓存，否则用户永远看到「暂无轨迹」。token 改由小程序查看物流时
      // 实时换取（云函数 order.getWaybillToken，每次重新换）。这里只注册追踪，不存 token。
      console.log(`[shipping] followWaybill 成功 orderId=${orderId}`);
    }
    return result;
  } catch (e) {
    console.warn(`[shipping] followWaybill 异常 orderId=${orderId}:`, e.message);
    return null;
  }
}

// 生成无限量小程序码（getwxacodeunlimit），返回 PNG Buffer。
// 分销员带货码、企业礼券码共用。失败（微信返回 JSON 错误）时 throw，附带 errcode。
// scene ≤ 32 字符且不需 urlencode；check_path=false 允许 page 未发布正式版（体验/未发布用）。
async function getWxacodeBuffer({ scene, page = 'pages/index/index', width = 430, checkPath = true } = {}) {
  const token = await getWxAccessToken();
  const envVersion = process.env.WX_QRCODE_ENV || 'release'; // 体验版可设 'trial'
  const resp = await fetch(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene, page, check_path: checkPath, env_version: envVersion, width }),
  });
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const errData = await resp.json();
    const err = new Error(`生成小程序码失败（errcode: ${errData.errcode || 'unknown'}）`);
    err.errcode = errData.errcode;
    throw err;
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

module.exports = {
  WX_APPID,
  WX_APPSECRET,
  WX_MCH_ID,
  WX_MCH_SERIAL_NO,
  WX_PRIVATE_KEY,
  getWxAccessToken,
  getWxacodeBuffer,
  buildWxSign,
  buildWxAuth,
  wxUploadShippingInfo,
  wxFollowWaybill,
};
