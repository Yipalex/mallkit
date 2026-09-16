// 登录验证中间件
// requireLogin: 仅允许管理员（role === 'admin'）
// requireAnyLogin: 允许任意登录用户（管理员 + 分销员）
const { verifyToken, getTokenFromReq } = require('../lib/auth');

function requireLogin(req, res, next) {
  const token = getTokenFromReq(req);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登录' });
    return res.redirect('/login');
  }
  req.adminUser = payload;
  next();
}

function requireAnyLogin(req, res, next) {
  const token = getTokenFromReq(req);
  const payload = verifyToken(token);
  if (!payload) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登录' });
    return res.redirect('/login');
  }
  req.adminUser = payload;
  next();
}

module.exports = { requireLogin, requireAnyLogin };
