// TOTP 二次验证 + 简易 Token（HMAC-SHA256，无需第三方库）
const crypto = require('crypto');

// 固定 token 密钥（云托管多实例共享，无状态认证，替代内存session）
// 生产环境必须在云托管控制台 → 服务设置 → 环境变量配置 TOKEN_SECRET（强随机字符串）
function resolveTokenSecret() {
  if (process.env.TOKEN_SECRET) return process.env.TOKEN_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.error('[auth] ❌ 生产环境未配置 TOKEN_SECRET，使用随机临时值（重启即失效，所有登录态会丢）');
    return crypto.randomBytes(32).toString('hex');
  }
  console.warn('[auth] ⚠️ 未配置 TOKEN_SECRET，使用开发默认值（仅限本地）');
  return 'dev-only-do-not-use-in-prod';
}
const TOKEN_SECRET = resolveTokenSecret();
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7天（秒）

// ===== TOTP 二次验证（RFC 6238，兼容 Google Authenticator）=====
function generateTotpSecret() {
  // 生成20字节随机密钥，Base32编码
  const bytes = crypto.randomBytes(20);
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += base32chars[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += base32chars[(value << (5 - bits)) & 31];
  return result;
}

function base32Decode(s) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output = [];
  for (const char of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | base32chars.indexOf(char);
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

function verifyTotp(secret, token) {
  const key = base32Decode(secret);
  const now = Math.floor(Date.now() / 1000);
  // 允许前后1个时间窗口（±30秒）
  for (const offset of [-1, 0, 1]) {
    const counter = Math.floor((now + offset * 30) / 30);
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset2 = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac.readUInt32BE(offset2) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
    if (code === String(token)) return true;
  }
  return false;
}

function getTotpQrUrl(secret, label = '商城后台') {
  const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent('Mallkit')}&digits=6&period=30`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
}

// ===== 简易 Token 工具（HMAC-SHA256，无需第三方库）=====
// opts.maxAge: 自定义有效期（秒），默认 TOKEN_MAX_AGE（7天）。
// Agent 长期 token 传更大的 maxAge（如 180 天），payload 里带 kind:'agent' 便于审计。
function makeToken(payload, opts = {}) {
  const maxAge = opts.maxAge != null ? opts.maxAge : TOKEN_MAX_AGE;
  const data = JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + maxAge });
  const b64 = Buffer.from(data).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function getTokenFromReq(req) {
  // 优先从 cookie 取，其次 Authorization header
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/admin_token=([^;]+)/);
  if (match) return match[1];
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

module.exports = {
  TOKEN_SECRET,
  TOKEN_MAX_AGE,
  generateTotpSecret,
  base32Decode,
  verifyTotp,
  getTotpQrUrl,
  makeToken,
  verifyToken,
  getTokenFromReq,
};
