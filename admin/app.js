// 电商商城管理后台 - 主入口
// 模块结构：
//   config/cloud.js       - CloudBase SDK 初始化
//   lib/utils.js          - 通用工具（时间、折扣换算）
//   lib/wx-api.js         - 微信 HTTP API（access_token、发货上报）
//   lib/auth.js           - TOTP + Token 工具
//   lib/cloud-files.js    - cloud:// fileID 转 URL / 删除
//   lib/cos.js            - 腾讯云 COS 客户端 + Bucket 配置
//   middleware/auth.js    - requireLogin / requireAnyLogin
//   routes/*.js           - 按业务领域分组的路由

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;

// ===== 全局中间件 =====
app.use(express.json({ limit: '10mb' }));       // 商品详情富文本可能很大
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 简易请求日志（帮助排查云托管问题）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    if (req.url.startsWith('/api/') || req.method === 'POST' || dur > 1000) {
      console.log(`[req] ${req.method} ${req.url} → ${res.statusCode} (${dur}ms)`);
    }
  });
  next();
});

// ===== 业务路由（按领域分组）=====
app.use(require('./routes/auth'));          // 登录/登出/首页/分销员页/改密/MFA
app.use(require('./routes/my'));            // 分销员自己的 API (/api/my/*)
app.use(require('./routes/settings'));      // 仪表盘 + 店铺设置 + 物流统计
app.use(require('./routes/products'));      // 商品 + 分类 + 上传 + 轮播图
app.use(require('./routes/orders'));        // 订单 + 发货 + 退款 + 提现审核
app.use(require('./routes/users'));         // 用户 + 积分 + 客户分析
app.use(require('./routes/distributors'));  // 分销员管理 + 邀请 + 全局分销设置
app.use(require('./routes/marketing'));     // 优惠券 + 评价 + 礼品库
app.use(require('./routes/enterprises'));   // 企业礼券：企业账户 + 充值 + 券批次 + 二维码
app.use(require('./routes/popups'));        // 营销弹窗
app.use(require('./routes/finance'));       // 财务月度 + CSV 导出
app.use(require('./routes/storage'));       // 云存储管理（list/delete/orphans/usage）
app.use(require('./routes/assistant'));     // AI 运营助手（SSE 对话 + /assistant 移动页）

const server = app.listen(PORT, () => {
  // 助手工具走 127.0.0.1 回环调自己的 /api/*，需要知道实际监听端口。
  const addr = server.address();
  app.set('listenPort', (addr && addr.port) || PORT);
  console.log(`管理后台运行在端口 ${PORT}`);
});
