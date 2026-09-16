// cloudfunctions/distribution/index.js
// 分销系统云函数：注册分销员、获取信息、申请提现

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  switch (action) {
    case 'register':    return await registerDistributor(OPENID, event);
    case 'getInfo':     return await getDistributorInfo(OPENID);
    case 'getQrcode':   return await getQrcode(OPENID);
    case 'withdraw':    return await requestWithdraw(OPENID, event);
    case 'getMyOrders': return await getMyOrders(OPENID, event);
    default: return { code: 400, message: '未知操作' };
  }
};

// ===== 获取我作为分销员的订单（别人用我的码下的单）=====
async function getMyOrders(openid, event) {
  const limit = Math.min(Number(event.limit) || 50, 100);
  try {
    const res = await db.collection('orders')
      .where({ referrerId: openid })
      .orderBy('createTime', 'desc')
      .limit(limit)
      .field({
        _id: true,
        userId: true,           // 买家 openid（不返回手机号/姓名，保护隐私）
        items: true,
        subtotal: true,
        discountAmount: true,
        distDiscount: true,
        finalPrice: true,
        referrerCommission: true,
        commissionStatus: true,
        status: true,
        createTime: true,
      })
      .get();
    // 简化 items 只返回名称和数量，避免数据过大
    const list = (res.data || []).map(o => ({
      ...o,
      items: (o.items || []).map(i => ({
        productName: i.productName || i.name || '商品',
        quantity: i.quantity || 1,
      })),
      // 买家昵称用 openid 后6位代替（隐私）
      buyerLabel: o.userId ? '用户' + String(o.userId).slice(-6) : '匿名',
    }));
    return { code: 200, data: list };
  } catch (err) {
    if (err && (err.errCode === -502005 || /not exist/i.test(err.errMsg || err.message || ''))) {
      return { code: 200, data: [] };
    }
    console.error('getMyOrders error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 注册成为分销员 =====
async function registerDistributor(openid, event) {
  try {
    // 检查是否已经是分销员
    const existRes = await db.collection('distributors')
      .where({ userId: openid })
      .limit(1)
      .get();

    if (existRes.data.length > 0) {
      return {
        code: 200,
        message: '已是分销员',
        data: existRes.data[0]
      };
    }

    // 生成唯一6位邀请码（字母+数字）
    const referralCode = await generateUniqueCode();

    // 如果用户是通过别人的邀请进来的，记录上级
    let parentId = null;
    let depth = 1;
    let lineage = [openid];

    // 检查用户的父级信息（在users表中可能有记录）
    const userRes = await db.collection('users').doc(openid).get();
    if (userRes.data?.distributorInfo?.parentId) {
      parentId = userRes.data.distributorInfo.parentId;

      // 获取上级的链路信息
      const parentRes = await db.collection('distributors')
        .where({ userId: parentId })
        .limit(1)
        .get();

      if (parentRes.data.length > 0) {
        const parent = parentRes.data[0];
        depth = parent.depth + 1;
        lineage = [...parent.lineage, openid];
      }
    }

    // 创建分销员记录
    const distributorData = {
      userId: openid,
      referralCode,
      registrationDate: new Date(),
      parentId,
      lineage,
      depth,
      stats: {
        directInvitedCount: 0,
        totalInvitedCount: 0,
        totalSalesAmount: 0,
        totalCommissionEarned: 0,
        monthlyCommission: 0,
      },
      withdrawal: {
        totalWithdrawn: 0,
        pendingAmount: 0,      // 待结算（订单完成7天内）
        settledAmount: 0,      // 可提现
        appliedAmount: 0,      // 已申请提现（审核中）
        minWithdrawalAmount: 50,
      },
      status: 'active',
      lastActivityTime: new Date(),
    };

    await db.collection('distributors').add({ data: distributorData });

    // 同步更新users表
    await db.collection('users').doc(openid).update({
      data: { isDistributor: true }
    });

    // 注：分销归属已改为"扫码/分享自动绑定"，不再为分销员创建可填写的专属优惠码

    return { code: 200, message: '注册成功', data: distributorData };

  } catch (err) {
    console.error('registerDistributor error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 获取分销员信息 =====
async function getDistributorInfo(openid) {
  try {
    const res = await db.collection('distributors')
      .where({ userId: openid })
      .limit(1)
      .get();

    if (res.data.length === 0) {
      return { code: 404, message: '未找到分销员信息' };
    }

    // 统计绑定到我名下的下线用户数（与后台 routes/distributors.js 同口径）
    let boundUserCount = 0;
    try {
      const cnt = await db.collection('users')
        .where({ 'distributorInfo.referrerId': openid })
        .count();
      boundUserCount = cnt.total || 0;
    } catch (e) {}

    return { code: 200, data: { ...res.data[0], boundUserCount } };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 生成我的带货小程序码（扫码即绑定我为推荐人）=====
// scene = referralCode，app.js onLaunch/onShow 会解析并调 user/bindReferrer
async function getQrcode(openid) {
  try {
    const res = await db.collection('distributors')
      .where({ userId: openid }).limit(1).get();
    if (!res.data.length || !res.data[0].referralCode) {
      return { code: 404, message: '未找到专属码' };
    }
    const referralCode = res.data[0].referralCode;

    // 云调用免 access_token；扫此码进首页，由前端捕获 scene 完成绑定
    const wxacode = await cloud.openapi.wxacode.getUnlimited({
      scene: referralCode,
      page: 'pages/index/index',
      checkPath: true,
      envVersion: 'release', // 体验阶段可临时改 'trial'
      width: 430,
    });

    // 存入云存储返回 fileID，前端用 <image> 直接渲染、可保存
    const upload = await cloud.uploadFile({
      cloudPath: `dist-qrcode/${referralCode}.png`,
      fileContent: wxacode.buffer,
    });
    return { code: 200, data: { fileID: upload.fileID, referralCode } };
  } catch (err) {
    console.error('getQrcode error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 申请提现 =====
async function requestWithdraw(openid, event) {
  const { amount } = event;

  try {
    // 获取分销员信息
    const distRes = await db.collection('distributors')
      .where({ userId: openid })
      .limit(1)
      .get();

    if (distRes.data.length === 0) {
      return { code: 400, message: '你不是分销员' };
    }

    const dist = distRes.data[0];
    const minAmount = dist.withdrawal.minWithdrawalAmount;
    const availableAmount = dist.withdrawal.settledAmount;

    // 金额校验
    if (!amount || amount < minAmount) {
      return { code: 400, message: `最低提现金额为 ¥${minAmount}` };
    }
    if (amount > availableAmount) {
      return { code: 400, message: `可提现余额不足（当前可提现 ¥${availableAmount}）` };
    }

    // 创建提现申请记录
    const withdrawalId = 'W' + Date.now();
    await db.collection('withdrawals').add({
      data: {
        _id: withdrawalId,
        distributorId: dist._id,
        userId: openid,
        amount,
        status: 'pending',      // 待审核
        requestTime: new Date(),
        remarks: '',
      }
    });

    // 扣减可提现余额，增加申请中金额
    await db.collection('distributors').doc(dist._id).update({
      data: {
        'withdrawal.settledAmount': _.inc(-amount),
        'withdrawal.appliedAmount': _.inc(amount),
        updateTime: new Date(),
      }
    });

    return {
      code: 200,
      message: '提现申请已提交，将在1-3个工作日内审核',
      data: { withdrawalId, amount }
    };

  } catch (err) {
    console.error('requestWithdraw error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 辅助函数：生成唯一6位邀请码 =====
async function generateUniqueCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  let isUnique = false;

  // 循环直到生成唯一的码
  while (!isUnique) {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    // 检查是否已存在
    const existing = await db.collection('distributors')
      .where({ referralCode: code })
      .count();
    if (existing.total === 0) isUnique = true;
  }

  return code;
}

