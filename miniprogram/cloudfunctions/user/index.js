// cloudfunctions/user/index.js
// 用户相关云函数：登录、获取用户信息、更新资料

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { checkRateLimit } = require('./utils/rateLimiter');

exports.main = async (event, context) => {
  const { action } = event;
  // 从云函数上下文获取调用者的openid（比前端传更安全）
  const { OPENID } = cloud.getWXContext();

  // 对签到操作应用频率限制：1分钟内最多2次
  if (action === 'checkin') {
    const limitResult = await checkRateLimit(OPENID, 'checkin', {
      maxRequests: 2,
      windowSeconds: 60
    });
    if (!limitResult.allowed) {
      return {
        code: 429,
        message: `签到过于频繁，请${limitResult.retryAfter}秒后再试`
      };
    }
  }

  switch (action) {
    case 'login':         return await login(OPENID, event);
    case 'getMemberInfo': return await getMemberInfo(OPENID);
    case 'updateProfile': return await updateProfile(OPENID, event.userInfo);
    case 'updatePhone':   return await updatePhone(OPENID, event.phone);
    case 'claimInvite':   return await claimInvite(OPENID, event.token);
    case 'bindReferrer':  return await bindReferrer(OPENID, event.referralCode);
    case 'checkin':       return await checkin(OPENID);
    case 'getPointLogs':  return await getPointLogs(OPENID, event);
    default: return { code: 400, message: '未知操作' };
  }
};

// ===== 登录 / 注册 =====
// 用户首次登录时自动创建账号
async function login(openid, event) {
  try {
    // 查找用户是否已存在
    const userRes = await db.collection('users').where({ _id: openid }).get();

    if (userRes.data.length === 0) {
      // 新用户：创建账号
      await db.collection('users').add({
        data: {
          _id: openid,           // 用openid作为文档ID，方便直接查询
          nickName: '新用户',
          avatarUrl: '',
          phone: '',
          memberLevel: {
            level: 0,            // 0=普通用户
            discount: 1,
            points: 0,
            joinDate: null,
          },
          isDistributor: false,
          distributorInfo: { parentId: null },
          balance: 0,
          createTime: new Date(),
          updateTime: new Date(),
          lastLoginTime: new Date(),
          status: 'active',
        }
      });
    } else {
      // 老用户：更新最后登录时间
      await db.collection('users').doc(openid).update({
        data: { lastLoginTime: new Date() }
      });
    }

    // 返回用户信息
    const user = (await db.collection('users').doc(openid).get()).data;
    return { code: 200, data: { openid, userInfo: user } };

  } catch (err) {
    console.error('login error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 获取会员信息 =====
async function getMemberInfo(openid) {
  try {
    const res = await db.collection('users').doc(openid).get();
    return { code: 200, data: res.data };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 每日签到 =====
// 积分规则：连续第1-3天得5分，第4-6天得10分，第7天得30分
const CHECKIN_POINTS = [5, 5, 5, 10, 10, 10, 30];

async function checkin(openid) {
  // 使用事务确保积分和日志同步更新
  const transaction = await db.startTransaction();

  try {
    // 1. 在事务中获取用户信息
    const userRes = await transaction.collection('users').doc(openid).get();
    const user = userRes.data;

    if (!user) {
      await transaction.rollback();
      return { code: 404, message: '用户不存在' };
    }

    const today = new Date();
    // 用 YYYY-MM-DD 格式做日期key，避免时区问题
    const todayKey = today.toISOString().slice(0, 10);

    // 2. 判断今日是否已签到
    if (user.lastCheckinDate === todayKey) {
      await transaction.rollback();
      return { code: 400, message: '今日已签到' };
    }

    // 3. 计算连续天数
    const yesterday = new Date(today - 86400000).toISOString().slice(0, 10);
    const streak = user.lastCheckinDate === yesterday ? (user.checkinStreak || 0) + 1 : 1;
    const earnedPoints = CHECKIN_POINTS[Math.min(streak - 1, 6)];
    const newPoints = (user.memberLevel?.points || 0) + earnedPoints;

    // 4. 在事务中更新用户积分
    const _ = db.command;
    await transaction.collection('users').doc(openid).update({
      data: {
        'memberLevel.points': _.inc(earnedPoints),
        lastCheckinDate: todayKey,
        checkinStreak: streak,
        updateTime: new Date(),
      }
    });

    // 5. 在事务中写入积分明细日志
    await transaction.collection('point_logs').add({
      data: {
        userId: openid,
        type: 'checkin',
        points: earnedPoints,
        description: `签到第${streak}天`,
        balance: newPoints,
        createdAt: new Date(),
      }
    });

    // 6. 提交事务
    await transaction.commit();

    return {
      code: 200,
      data: {
        earnedPoints,
        totalPoints: newPoints,
        streak,
        todayKey,
      }
    };
  } catch (err) {
    // 发生错误时回滚事务
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('事务回滚失败:', rollbackErr);
    }
    console.error('checkin error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 积分明细 =====
async function getPointLogs(openid, event) {
  const { page = 1, pageSize = 20 } = event;
  try {
    const res = await db.collection('point_logs')
      .where({ userId: openid })
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
    const count = await db.collection('point_logs').where({ userId: openid }).count();
    return { code: 200, data: res.data, total: count.total };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 扫邀请码入场：用 token 登记自己的 openid，等管理员确认 =====
async function claimInvite(openid, token) {
  if (!token) return { code: 400, message: '缺少邀请token' };
  try {
    // 查找有效的邀请记录
    const inviteRes = await db.collection('distributor_invites')
      .where({ token, status: 'pending' })
      .limit(1).get();

    if (!inviteRes.data.length) {
      return { code: 404, message: '邀请链接无效或已过期' };
    }

    const invite = inviteRes.data[0];
    // 检查是否过期（24小时）
    const expireTime = new Date(invite.expireAt.$date || invite.expireAt).getTime();
    if (Date.now() > expireTime) {
      await db.collection('distributor_invites').doc(invite._id).update({
        data: { status: 'expired', updateTime: new Date() }
      });
      return { code: 400, message: '邀请链接已过期，请联系管理员重新生成' };
    }

    // 检查该用户是否已经是分销员
    const userRes = await db.collection('users').doc(openid).get();
    if (userRes.data?.isDistributor) {
      return { code: 200, message: '您已经是分销员了', alreadyDist: true };
    }

    // 把 openid 写入邀请记录，状态改为 claimed（已认领，等管理员确认）
    await db.collection('distributor_invites').doc(invite._id).update({
      data: {
        claimedBy: openid,
        claimedAt: new Date(),
        status: 'claimed',
        updateTime: new Date(),
      }
    });

    return { code: 200, message: '已登记，等待管理员确认后即可成为分销员', claimed: true };
  } catch (err) {
    console.error('claimInvite error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 绑定分销员（扫码/分享自动绑定，永久、首次锁定）=====
// referralCode 来自分销员的专属带货码 scene 或分享链接 inviteCode
async function bindReferrer(openid, referralCode) {
  const code = (referralCode || '').trim().toUpperCase();
  if (!code) return { code: 400, message: '缺少推荐码' };
  try {
    // 1. 校验推荐码对应一个有效（active）分销员
    const distRes = await db.collection('distributors')
      .where({ referralCode: code, status: 'active' })
      .limit(1).get();
    if (!distRes.data.length) {
      return { code: 404, message: '推荐码无效' };
    }
    const referrerId = distRes.data[0].userId;

    // 2. 防自绑：分销员自己扫自己的码不绑定
    if (referrerId === openid) {
      return { code: 200, message: '不能绑定自己', selfBind: true };
    }

    const userRes = await db.collection('users').doc(openid).get();

    // 3. 分销员不能成为别人的下线：本身已是分销员则不绑定（防分销员之间互绑刷返佣）
    if (userRes.data?.isDistributor) {
      return { code: 200, message: '分销员不能成为下线', isDistributor: true };
    }

    // 4. 首次锁定：已绑定过则不覆盖（静默返回）
    const existing = userRes.data?.distributorInfo?.referrerId;
    if (existing) {
      return { code: 200, message: '已绑定推荐人', alreadyBound: true };
    }

    // 4. 写入永久绑定关系
    await db.collection('users').doc(openid).update({
      data: {
        'distributorInfo.referrerId': referrerId,
        'distributorInfo.referralCode': code,
        'distributorInfo.boundAt': new Date(),
        updateTime: new Date(),
      }
    });
    return { code: 200, message: '绑定成功', bound: true };
  } catch (err) {
    console.error('bindReferrer error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 绑定手机号 =====
async function updatePhone(openid, phone) {
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return { code: 400, message: '手机号格式不正确' };
  }
  try {
    await db.collection('users').doc(openid).update({
      data: { phone, updateTime: new Date() }
    });
    return { code: 200, message: '手机号已更新' };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}

// ===== 更新用户头像和昵称 =====
async function updateProfile(openid, userInfo) {
  try {
    await db.collection('users').doc(openid).update({
      data: {
        nickName: userInfo.nickName,
        avatarUrl: userInfo.avatarUrl,
        updateTime: new Date(),
      }
    });
    return { code: 200, message: '更新成功' };
  } catch (err) {
    return { code: 500, message: err.message };
  }
}
