// 认证与账户路由：登录页/登录/登出/首页/分销员页/修改密码/MFA/管理员账户
// 挂载方式：app.use(require('./routes/auth'))
const express = require('express');
const path = require('path');
const router = express.Router();

const { db } = require('../config/cloud');
const {
  TOKEN_MAX_AGE,
  generateTotpSecret,
  verifyTotp,
  getTotpQrUrl,
  makeToken,
  verifyToken,
  getTokenFromReq,
} = require('../lib/auth');
const { requireLogin } = require('../middleware/auth');

// public 目录的绝对路径（基于项目根，注意这里 __dirname 是 routes/，所以往上一级）
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ===== 管理员账户（从数据库或环境变量读取）=====
async function getAdminAccount() {
  try {
    const r = await db.collection('settings').where({ key: 'admin_account' }).limit(1).get();
    if (r.data && r.data.length > 0) return r.data[0].value;
  } catch (e) {}
  // 默认值：用户名 admin，密码必须由环境变量提供（不再硬编码弱口令兜底）
  if (!process.env.ADMIN_PASSWORD) {
    console.error('[auth] 致命：未配置 ADMIN_PASSWORD 环境变量，且数据库无 admin_account，登录将被拒绝。请在云托管控制台配置 ADMIN_PASSWORD。');
  }
  return {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || null,  // null=未配置，登录校验时会拒绝
    totpSecret: process.env.ADMIN_TOTP_SECRET || null,  // null=未绑定MFA
  };
}

async function saveAdminAccount(data) {
  const existing = await db.collection('settings').where({ key: 'admin_account' }).limit(1).get();
  if (existing.data.length > 0) {
    await db.collection('settings').doc(existing.data[0]._id).update({ value: data });
  } else {
    await db.collection('settings').add({ key: 'admin_account', value: data });
  }
}

// ===== 路由：登录页 =====
router.get('/login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

router.post('/login', async (req, res) => {
  const { username, password, totp_code } = req.body;

  try {
    const account = await getAdminAccount();

    // 未配置密码：直接拒绝（避免 null===null 之类的绕过）
    if (!account.password) {
      return res.redirect('/login?error=not_configured');
    }

    // 验证用户名+密码
    if (username !== account.username || password !== account.password) {
      return res.redirect('/login?error=wrong_password');
    }

    // 已绑定MFA：验证TOTP
    if (account.totpSecret) {
      if (!totp_code) return res.redirect('/login?error=need_totp');
      if (!verifyTotp(account.totpSecret, totp_code.replace(/\s/g, ''))) {
        return res.redirect('/login?error=wrong_totp');
      }
    }

    // 登录成功
    const token = makeToken({ role: 'admin' });
    res.setHeader('Set-Cookie', `admin_token=${token}; Path=/; HttpOnly; Max-Age=${TOKEN_MAX_AGE}`);
    return res.redirect('/');
  } catch (e) {
    console.error('login error:', e);
    return res.redirect('/login?error=1');
  }
});

router.get('/logout', (req, res) => {
  // 清除 cookie（设置过期时间为过去）
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

// ===== 路由：管理员首页 =====
router.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ===== 路由：分销员专属页面 =====
router.get('/distributor', (req, res) => {
  const token = getTokenFromReq(req);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'distributor') return res.redirect('/login');
  res.sendFile(path.join(PUBLIC_DIR, 'distributor.html'));
});

// ===== API：修改登录密码 =====
router.post('/api/change-password', requireLogin, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.json({ success: false, error: '参数缺失' });
  if (newPassword.length < 6) return res.json({ success: false, error: '新密码至少6位' });
  try {
    const account = await getAdminAccount();
    if (oldPassword !== account.password) return res.json({ success: false, error: '当前密码错误' });
    await saveAdminAccount({ ...account, password: newPassword });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: '保存失败：' + e.message });
  }
});

// ===== MFA 绑定相关 API =====

// 生成新的 TOTP 密钥（返回二维码URL供扫描）
router.get('/api/mfa/setup', requireLogin, async (req, res) => {
  const secret = generateTotpSecret();
  const qrUrl = getTotpQrUrl(secret);
  res.json({ success: true, secret, qrUrl });
});

// 确认绑定（验证一次TOTP后正式保存）
router.post('/api/mfa/bind', requireLogin, async (req, res) => {
  const { secret, code } = req.body;
  if (!verifyTotp(secret, code)) return res.json({ success: false, error: '验证码错误，请重试' });
  try {
    const account = await getAdminAccount();
    await saveAdminAccount({ ...account, totpSecret: secret });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 解绑 MFA
router.post('/api/mfa/unbind', requireLogin, async (req, res) => {
  try {
    const account = await getAdminAccount();
    await saveAdminAccount({ ...account, totpSecret: null });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 修改管理员用户名/密码
router.post('/api/admin/account', requireLogin, async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  try {
    const account = await getAdminAccount();
    if (oldPassword !== account.password) return res.json({ success: false, error: '原密码错误' });
    await saveAdminAccount({ ...account, username: username || account.username, password: newPassword || account.password });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 查询当前MFA状态
router.get('/api/admin/account', requireLogin, async (req, res) => {
  try {
    const account = await getAdminAccount();
    res.json({ username: account.username, mfaEnabled: !!account.totpSecret });
  } catch (e) { res.json({ error: e.message }); }
});

module.exports = router;
