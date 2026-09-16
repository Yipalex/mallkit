// 企业礼券：企业账户 + 充值/流水 + 券批次 + 券码生成/统计 + 二维码 ZIP 打包下载
// 业务：企业对公转账 → 管理员后台手工录入充值 → 为企业批量生成唯一二维码券 → 企业印刷发放，
// 客户扫码进小程序免付货款下单，货款从企业余额原子扣减（扣减/结算逻辑在小程序 voucher 云函数）。
const express = require('express');
const crypto = require('crypto');
const archiver = require('archiver');
const router = express.Router();

const { db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { getWxacodeBuffer } = require('../lib/wx-api');

const BATCH_TYPES = ['store_card', 'scoped_card', 'product'];
// base32 去掉易混字符 0/O/1/I，券码可读性更好
const BASE32_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 生成 11 位随机券码正文（前缀 V），如 VK7M3XP9Q2AB，共 12 字符，scene 传 v=<code> 仅 14 字符
function genVoucherCode() {
  const bytes = crypto.randomBytes(11);
  let s = 'V';
  for (let i = 0; i < 11; i++) s += BASE32_ALPHABET[bytes[i] % 32];
  return s;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ========================= 企业账户 =========================

router.get('/api/enterprises', requireLogin, async (req, res) => {
  try {
    const { keyword, status, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (keyword) query.name = new RegExp(keyword, 'i');
    const countRes = await db.collection('enterprises').where(query).count();
    const listRes = await db.collection('enterprises').where(query)
      .orderBy('_id', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    res.json({ success: true, data: listRes.data, total: countRes.total, page: pageNum });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/enterprises', requireLogin, async (req, res) => {
  try {
    const { name, contactName, contactPhone, remark } = req.body;
    if (!name) return res.json({ success: false, error: '企业名称必填' });
    const now = new Date();
    const r = await db.collection('enterprises').add({
      name,
      contactName: contactName || '',
      contactPhone: contactPhone || '',
      remark: remark || '',
      balance: 0,
      totalRecharged: 0,
      status: 'active',
      createTime: now,
      updateTime: now,
    });
    res.json({ success: true, id: r.id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/enterprises/:id', requireLogin, async (req, res) => {
  try {
    const { name, contactName, contactPhone, remark, status } = req.body;
    const update = { updateTime: new Date() };
    if (name !== undefined) update.name = name;
    if (contactName !== undefined) update.contactName = contactName;
    if (contactPhone !== undefined) update.contactPhone = contactPhone;
    if (remark !== undefined) update.remark = remark;
    if (status !== undefined && ['active', 'disabled'].includes(status)) update.status = status;
    await db.collection('enterprises').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 删除企业：有已使用/部分使用的券码时禁止删（券已发出、有消费记录，删了会丢账），
// 否则连带删除该企业的券批次、券码、流水。
router.delete('/api/enterprises/:id', requireLogin, async (req, res) => {
  try {
    const id = req.params.id;
    const entRes = await db.collection('enterprises').doc(id).get();
    const ent = Array.isArray(entRes.data) ? entRes.data[0] : entRes.data;
    if (!ent) return res.json({ success: false, error: '企业不存在' });

    // 已有券被使用（used / partially_used / locked）则不允许删除
    const usedCnt = await db.collection('voucher_codes')
      .where({ enterpriseId: id, status: _.in(['used', 'partially_used', 'locked']) }).count();
    if (usedCnt.total > 0) {
      return res.json({ success: false, error: `该企业已有 ${usedCnt.total} 张券被使用，不可删除。可改为「停用」。` });
    }

    // 连带删除：券码 → 批次 → 流水 →（最后）企业。CloudBase where().remove() 一次最多删 1000 条，循环删空。
    async function removeAll(collection, where) {
      while (true) {
        const r = await db.collection(collection).where(where).limit(1000).remove();
        if (!r.deleted || r.deleted < 1000) break;
      }
    }
    await removeAll('voucher_codes', { enterpriseId: id });
    await removeAll('voucher_batches', { enterpriseId: id });
    await removeAll('enterprise_logs', { enterpriseId: id });
    await db.collection('enterprises').doc(id).remove();

    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 手工充值（对公转账到账后录入）：原子自增余额 + 写流水（仿 users.js points 范式）
router.post('/api/enterprises/:id/recharge', requireLogin, async (req, res) => {
  try {
    const { amount, remark } = req.body;
    const amt = round2(amount);
    if (!amt || amt <= 0) return res.json({ success: false, error: '充值金额必须大于 0' });

    const entRes = await db.collection('enterprises').doc(req.params.id).get();
    const ent = Array.isArray(entRes.data) ? entRes.data[0] : entRes.data;
    if (!ent) return res.json({ success: false, error: '企业不存在' });

    const before = round2(ent.balance);
    const after = round2(before + amt);
    await db.collection('enterprises').doc(req.params.id).update({
      balance: _.inc(amt),
      totalRecharged: _.inc(amt),
      updateTime: new Date(),
    });
    await db.collection('enterprise_logs').add({
      enterpriseId: req.params.id,
      type: 'recharge',
      amount: amt,
      balanceAfter: after,
      operator: req.adminUser?.username || req.adminUser?.sub || 'admin',
      remark: remark || '对公转账充值',
      createTime: new Date(),
    });
    res.json({ success: true, before, after });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 手工调整余额（正/负），用于纠错、退款回补等
router.post('/api/enterprises/:id/adjust', requireLogin, async (req, res) => {
  try {
    const { amount, remark } = req.body;
    const amt = round2(amount);
    if (!amt) return res.json({ success: false, error: '调整金额不能为 0' });

    const entRes = await db.collection('enterprises').doc(req.params.id).get();
    const ent = Array.isArray(entRes.data) ? entRes.data[0] : entRes.data;
    if (!ent) return res.json({ success: false, error: '企业不存在' });

    const before = round2(ent.balance);
    if (before + amt < 0) return res.json({ success: false, error: '调整后余额不能为负' });
    const after = round2(before + amt);
    await db.collection('enterprises').doc(req.params.id).update({
      balance: _.inc(amt),
      updateTime: new Date(),
    });
    await db.collection('enterprise_logs').add({
      enterpriseId: req.params.id,
      type: 'adjust',
      amount: amt,
      balanceAfter: after,
      operator: req.adminUser?.username || req.adminUser?.sub || 'admin',
      remark: remark || '管理员调整',
      createTime: new Date(),
    });
    res.json({ success: true, before, after });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.get('/api/enterprises/:id/logs', requireLogin, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    const query = { enterpriseId: req.params.id };
    const countRes = await db.collection('enterprise_logs').where(query).count();
    const listRes = await db.collection('enterprise_logs').where(query)
      .orderBy('createTime', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    res.json({ success: true, data: listRes.data, total: countRes.total });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ========================= 券批次 =========================

router.get('/api/voucher-batches', requireLogin, async (req, res) => {
  try {
    const { enterpriseId, page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    let query = {};
    if (enterpriseId) query.enterpriseId = enterpriseId;
    const countRes = await db.collection('voucher_batches').where(query).count();
    const listRes = await db.collection('voucher_batches').where(query)
      .orderBy('_id', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    res.json({ success: true, data: listRes.data, total: countRes.total });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 创建批次 + 批量生成券码。三种券型字段：
//   store_card  全店充值卡：faceValue 面额（可分多次用完）
//   scoped_card 指定范围卡：faceValue + allowedProductIds[] + singleOrderOnly
//   product     商品型：productId(+skuId) + quantity（一码一单，扫码直达）
router.post('/api/voucher-batches', requireLogin, async (req, res) => {
  try {
    const {
      enterpriseId, name, type, faceValue, count,
      allowedProductIds, singleOrderOnly, productId, skuId, quantity,
      validFrom, expireAt,
    } = req.body;

    if (!enterpriseId) return res.json({ success: false, error: '请选择企业' });
    if (!name) return res.json({ success: false, error: '批次名称必填' });
    if (!BATCH_TYPES.includes(type)) return res.json({ success: false, error: '券型无效' });
    const cnt = parseInt(count);
    if (!cnt || cnt <= 0 || cnt > 5000) return res.json({ success: false, error: '生成数量需在 1~5000 之间' });

    const entRes = await db.collection('enterprises').doc(enterpriseId).get();
    const ent = Array.isArray(entRes.data) ? entRes.data[0] : entRes.data;
    if (!ent) return res.json({ success: false, error: '企业不存在' });

    const doc = {
      enterpriseId, name, type,
      count: cnt,
      validFrom: validFrom ? new Date(validFrom) : null,
      expireAt: expireAt ? new Date(expireAt) : null,
      status: 'active',
      stats: { activated: 0, used: 0, consumedAmount: 0 },
      createTime: new Date(),
      updateTime: new Date(),
    };

    let face = 0;
    if (type === 'store_card' || type === 'scoped_card') {
      face = round2(faceValue);
      if (!face || face <= 0) return res.json({ success: false, error: '面额必须大于 0' });
      doc.faceValue = face;
      doc.singleOrderOnly = !!singleOrderOnly;
      if (type === 'scoped_card') {
        const ids = Array.isArray(allowedProductIds) ? allowedProductIds.filter(Boolean) : [];
        if (ids.length === 0) return res.json({ success: false, error: '指定范围卡请至少选一个商品' });
        doc.allowedProductIds = ids;
      }
    } else { // product
      if (!productId) return res.json({ success: false, error: '商品型请选择商品' });
      const qty = parseInt(quantity) || 1;
      doc.productId = productId;
      doc.skuId = skuId || null;
      doc.quantity = qty;
      doc.faceValue = 0; // 商品型按商品实价结算
      doc.singleOrderOnly = true; // 商品型天然一码一单
    }

    const batchRes = await db.collection('voucher_batches').add(doc);
    const batchId = batchRes.id;

    // 批量生成券码。CloudBase add 无批量接口，循环插入；code 唯一索引保证不重（撞了重试）
    const now = new Date();
    let created = 0;
    for (let i = 0; i < cnt; i++) {
      let inserted = false;
      for (let retry = 0; retry < 5 && !inserted; retry++) {
        const code = genVoucherCode();
        try {
          await db.collection('voucher_codes').add({
            code,
            batchId,
            enterpriseId,
            type,
            faceValue: face,
            remaining: face,           // 充值卡型初始=面额；商品型=0（不用）
            status: 'unused',
            lockedBy: null,
            lockExpireAt: null,
            lockedAmount: 0,
            firstUsedBy: null,
            usageLogs: [],
            createTime: now,
            updateTime: now,
          });
          inserted = true;
          created++;
        } catch (err) {
          // 唯一索引冲突则换码重试；其他错误抛出
          if (!/duplicate|unique|E11000/i.test(err.message || '')) throw err;
        }
      }
    }

    res.json({ success: true, batchId, created });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/voucher-batches/:id', requireLogin, async (req, res) => {
  try {
    const { name, status, expireAt } = req.body;
    const update = { updateTime: new Date() };
    if (name !== undefined) update.name = name;
    if (status !== undefined && ['active', 'disabled'].includes(status)) update.status = status;
    if (expireAt !== undefined) update.expireAt = expireAt ? new Date(expireAt) : null;
    await db.collection('voucher_batches').doc(req.params.id).update(update);
    // 批次停用时，未使用的码一并作废（已用/部分已用的保留历史）
    if (update.status === 'disabled') {
      await db.collection('voucher_codes')
        .where({ batchId: req.params.id, status: 'unused' })
        .update({ status: 'disabled', updateTime: new Date() });
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 批次统计：各状态码数 + 已消费金额
router.get('/api/voucher-batches/:id/stats', requireLogin, async (req, res) => {
  try {
    const batchId = req.params.id;
    const statuses = ['unused', 'locked', 'partially_used', 'used', 'disabled', 'expired'];
    const counts = {};
    for (const s of statuses) {
      const c = await db.collection('voucher_codes').where({ batchId, status: s }).count();
      counts[s] = c.total;
    }
    const total = await db.collection('voucher_codes').where({ batchId }).count();
    res.json({ success: true, total: total.total, counts });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 券码列表（可按状态筛选）
router.get('/api/voucher-batches/:id/codes', requireLogin, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    let query = { batchId: req.params.id };
    if (status && status !== 'all') query.status = status;
    const countRes = await db.collection('voucher_codes').where(query).count();
    const listRes = await db.collection('voucher_codes').where(query)
      .orderBy('createTime', 'desc')
      .skip((pageNum - 1) * limitNum).limit(limitNum).get();
    res.json({ success: true, data: listRes.data, total: countRes.total });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 单码作废（仅未使用的码可作废）
router.post('/api/voucher-codes/:id/disable', requireLogin, async (req, res) => {
  try {
    const r = await db.collection('voucher_codes').doc(req.params.id).get();
    const code = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!code) return res.json({ success: false, error: '券码不存在' });
    if (!['unused', 'locked'].includes(code.status)) {
      return res.json({ success: false, error: '该券码已被使用，不可作废' });
    }
    await db.collection('voucher_codes').doc(req.params.id).update({ status: 'disabled', updateTime: new Date() });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// 二维码 ZIP 打包下载：遍历批次所有券码 → 逐个生成小程序码 PNG → archiver 流式写 res
// 小并发（5）拉微信码接口，注意 getwxacodeunlimit 频率限制（5000/min）
router.get('/api/voucher-batches/:id/download', requireLogin, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batchRes = await db.collection('voucher_batches').doc(batchId).get();
    const batch = Array.isArray(batchRes.data) ? batchRes.data[0] : batchRes.data;
    if (!batch) return res.status(404).json({ success: false, error: '批次不存在' });

    // 拉全部券码（分页取，批次上限 5000）
    const all = [];
    let skip = 0;
    const pageSize = 100;
    while (true) {
      const r = await db.collection('voucher_codes').where({ batchId })
        .field({ code: true }).orderBy('createTime', 'asc')
        .skip(skip).limit(pageSize).get();
      all.push(...r.data);
      if (r.data.length < pageSize) break;
      skip += pageSize;
    }
    if (all.length === 0) return res.status(404).json({ success: false, error: '该批次无券码' });

    // Content-Disposition 的 filename 只能是 ASCII（中文批次名会触发 "Invalid character in header"）。
    // ASCII 部分把非 ASCII 全换成 _ 作兜底；中文原名用 RFC 5987 filename* UTF-8 编码。
    const rawName = String(batch.name || batchId);
    const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    const encodedName = encodeURIComponent(`vouchers-${rawName}.zip`);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition',
      `attachment; filename="vouchers-${asciiName}.zip"; filename*=UTF-8''${encodedName}`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => { console.error('[voucher-zip] archive error:', err.message); try { res.status(500).end(); } catch (_) {} });
    archive.pipe(res);

    // 小并发生成小程序码，逐个 append 进 zip
    const CONCURRENCY = 5;
    let idx = 0;
    let failed = 0;
    async function worker() {
      while (idx < all.length) {
        const my = idx++;
        const code = all[my].code;
        try {
          const buf = await getWxacodeBuffer({ scene: `v=${code}`, page: 'pages/voucher/index', checkPath: false });
          archive.append(buf, { name: `${code}.png` });
        } catch (err) {
          failed++;
          console.warn(`[voucher-zip] 生成 ${code} 失败: ${err.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (failed > 0) {
      archive.append(`本批共 ${all.length} 张，其中 ${failed} 张生成失败，请稍后重新下载。`, { name: '_失败说明.txt' });
    }
    await archive.finalize();
  } catch (e) {
    console.error('[voucher-zip] error:', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
