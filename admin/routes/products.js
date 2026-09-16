// 商品 + 上传 + 商品分类
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { cloud, db, _ } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { resolveImageFieldsCdn, deleteCloudFiles } = require('../lib/cloud-files');
const { fileIdToCosKey } = require('../lib/cos');
const { compressImage } = require('../lib/image');

// multer：内存模式，5MB 上限
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ===== 多规格（SKU）校验与归一化 =====
// 入参 specGroups（1~2 个维度）+ skus（组合表，每条带 skuId/optionIndexes/price/stock...）
// 返回 { ok, error, skus, specGroups, basePrice, stock }；basePrice=最低价、stock=库存合计（兜底给旧逻辑展示用）
// oldSkus：编辑场景下的原有 skus，用于保留已存在组合的 skuId（避免历史订单对不上规格）
function buildSkus(specGroups, skus, oldSkus) {
  // 维度校验：1~2 组，每组要有名字和至少一个选项
  if (!Array.isArray(specGroups) || specGroups.length < 1 || specGroups.length > 2) {
    return { ok: false, error: '规格维度需要 1~2 个' };
  }
  for (const g of specGroups) {
    if (!g || !g.name || !Array.isArray(g.options) || g.options.length < 1) {
      return { ok: false, error: '每个规格维度都要有名称和至少一个选项' };
    }
  }
  if (!Array.isArray(skus) || skus.length < 1) {
    return { ok: false, error: '请至少配置一个规格组合' };
  }

  // 旧组合按"维度下标组合"建索引，用于沿用原 skuId
  const oldByKey = {};
  (oldSkus || []).forEach(s => {
    if (Array.isArray(s.optionIndexes)) oldByKey[s.optionIndexes.join('-')] = s.skuId;
  });

  const seenId = new Set();
  const seenKey = new Set();
  const out = [];
  for (const s of skus) {
    // optionIndexes 维度数要与 specGroups 一致，且每个下标合法
    if (!Array.isArray(s.optionIndexes) || s.optionIndexes.length !== specGroups.length) {
      return { ok: false, error: '规格组合的维度数量不正确' };
    }
    for (let i = 0; i < specGroups.length; i++) {
      const idx = Number(s.optionIndexes[i]);
      if (!Number.isInteger(idx) || idx < 0 || idx >= specGroups[i].options.length) {
        return { ok: false, error: '规格组合存在无效选项' };
      }
    }
    const key = s.optionIndexes.map(Number).join('-');
    if (seenKey.has(key)) return { ok: false, error: '存在重复的规格组合' };
    seenKey.add(key);

    const price = Number(s.price);
    if (!Number.isFinite(price) || price < 0) return { ok: false, error: '规格售价必须是不小于0的数字' };
    const stk = Number(s.stock);
    if (!Number.isFinite(stk) || stk < 0) return { ok: false, error: '规格库存必须是不小于0的数字' };

    // skuId：优先沿用旧组合的 id；否则用前端传的；都没有才新生成。保证不可变、商品内唯一
    let skuId = oldByKey[key] || s.skuId;
    if (!skuId || seenId.has(skuId)) skuId = `sku_${Date.now()}_${out.length}`;
    seenId.add(skuId);

    // 展示用组合名：各维度选中的选项用 · 连接，如 "大件" 或 "沙漠蜜瓜·金火龙果"
    const specText = s.optionIndexes.map((oi, i) => specGroups[i].options[Number(oi)]).join('·');

    const item = {
      skuId,
      optionIndexes: s.optionIndexes.map(Number),
      specText,
      price, stock: stk,
      isActive: s.isActive !== false,
    };
    if (s.costPrice != null && s.costPrice !== '') {
      const c = Number(s.costPrice);
      if (!Number.isFinite(c) || c < 0) return { ok: false, error: '规格成本价必须是不小于0的数字' };
      item.costPrice = c;
    }
    if (s.commissionPerUnit != null && s.commissionPerUnit !== '') {
      const cpu = Number(s.commissionPerUnit);
      if (!Number.isFinite(cpu) || cpu < 0) return { ok: false, error: '规格返佣额必须是不小于0的数字' };
      item.commissionPerUnit = cpu;
    }
    if (s.unit != null && s.unit !== '') item.unit = String(s.unit);
    if (s.image != null && s.image !== '') item.image = String(s.image);
    out.push(item);
  }

  // 兜底给商品级 basePrice/stock：最低价 + 库存合计（仅展示/排序用，下单按 sku 为准）
  const basePrice = Math.min(...out.map(s => s.price));
  const stock = out.reduce((sum, s) => sum + s.stock, 0);
  return { ok: true, skus: out, specGroups, basePrice, stock };
}

// ===== 限时秒杀校验（服务端为准，与小程序 order/product 云函数同口径）=====
// 单规格 seckill: { active, price, endTime }
// 多规格 seckill: { active, endTime, skuPrices: { [skuId]: 秒杀价 } }（endTime 商品级统一，每个参与秒杀的 SKU 一个价）
// 入参 basePrice=单规格商品单价；skus=多规格归一化后的 skus 数组（含 skuId/price），单规格传 null
// 返回 { ok, error, seckill }。seckill=undefined 表示不设置/移除该字段。
function validateSeckill(seckill, basePrice, skus) {
  // 未传或未启用 → 移除秒杀
  if (!seckill || seckill.active !== true) return { ok: true, seckill: undefined };

  // 结束时间校验（两种类型共用）
  if (!seckill.endTime) return { ok: false, error: '缺少秒杀结束时间' };
  const end = new Date(seckill.endTime).getTime();
  if (!end || isNaN(end)) return { ok: false, error: '秒杀结束时间无效' };
  if (end <= Date.now()) return { ok: false, error: '秒杀结束时间必须晚于当前时间' };
  const endISO = new Date(end).toISOString();

  // ── 多规格：逐 SKU 校验秒杀价 ──
  // 前端传的 skuPrices key 可能是 skuId，也可能是 optionIndexes.join('-')（新建时 skuId 尚未生成）；两者都兼容。
  if (Array.isArray(skus) && skus.length) {
    const src = (seckill.skuPrices && typeof seckill.skuPrices === 'object') ? seckill.skuPrices : {};
    const skuById = {};
    const skuByIdx = {};
    skus.forEach(s => {
      skuById[s.skuId] = s;
      if (Array.isArray(s.optionIndexes)) skuByIdx[s.optionIndexes.join('-')] = s;
    });
    const skuPrices = {};
    for (const [k, raw] of Object.entries(src)) {
      const sku = skuById[k] || skuByIdx[k];
      if (!sku) continue; // 忽略不存在的 key（可能是删掉的旧规格）
      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) continue; // 留空/非法 = 该规格不参与秒杀
      if (price >= Number(sku.price)) {
        return { ok: false, error: `规格「${sku.specText || sku.skuId}」的秒杀价必须低于原价 ${sku.price}` };
      }
      skuPrices[sku.skuId] = price; // 统一用最终 skuId 入库
    }
    if (Object.keys(skuPrices).length === 0) {
      return { ok: false, error: '请至少给一个规格设置有效的秒杀价（需大于0且低于该规格原价）' };
    }
    return { ok: true, seckill: { active: true, endTime: endISO, skuPrices } };
  }

  // ── 单规格：整商品一个秒杀价 ──
  const price = Number(seckill.price);
  const base = Number(basePrice);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: '秒杀价必须大于0' };
  if (!Number.isFinite(base) || price >= base) return { ok: false, error: '秒杀价必须低于售价' };
  return { ok: true, seckill: { active: true, price, endTime: endISO } };
}

// ===== API：商品列表 =====
router.get('/api/products', requireLogin, async (req, res) => {
  try {
    const { page = 1, pageSize = 15 } = req.query;
    const result = await db.collection('products')
      .skip((page - 1) * pageSize)
      .limit(Number(pageSize))
      .orderBy('createdAt', 'desc')
      .get();
    const count = await db.collection('products').count();
    const list = resolveImageFieldsCdn(result.data, ['mainImage', 'gallery'], ['detail']);
    res.json({ list, total: count.total });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== API：添加商品 =====
router.post('/api/products', requireLogin, async (req, res) => {
  try {
    const { name, description, detail, category, basePrice, costPrice, unit, stock, mainImage, gallery, commissionPerUnit, hasSku, specGroups, skus, seckill, pickDate, originalPrice } = req.body;
    const doc = {
      name, description, detail: detail || '', category,
      basePrice: Number(basePrice),
      unit, stock: Number(stock),
      mainImage: mainImage || '', gallery: gallery || [],
      salesCount: 0, isActive: true, weight: 100, createdAt: new Date(),
    };
    if (costPrice != null && costPrice !== '') doc.costPrice = Number(costPrice);
    // 单品固定返佣额（元/件，留空=该商品走全局/分销员比例）；仅接受 ≥0 的有限数
    if (commissionPerUnit != null && commissionPerUnit !== '') {
      const cpu = Number(commissionPerUnit);
      if (!Number.isFinite(cpu) || cpu < 0) return res.json({ success: false, error: '单品返佣额必须是不小于0的数字' });
      doc.commissionPerUnit = cpu;
    }
    // 生产日期（'YYYY-MM-DD' 字符串透传，供宣传海报「X月X日生产」角标）；留空则不写
    if (pickDate != null && pickDate !== '') doc.pickDate = String(pickDate);
    // 划线零售价（元，海报用）；仅接受 ≥0 的有限数，留空则不写
    if (originalPrice != null && originalPrice !== '') {
      const op = Number(originalPrice);
      if (!Number.isFinite(op) || op < 0) return res.json({ success: false, error: '零售价必须是不小于0的数字' });
      doc.originalPrice = op;
    }
    // 多规格：启用时校验并归一化，basePrice/stock 用 sku 兜底
    if (hasSku) {
      const r = buildSkus(specGroups, skus);
      if (!r.ok) return res.json({ success: false, error: r.error });
      doc.hasSku = true;
      doc.specGroups = r.specGroups;
      doc.skus = r.skus;
      doc.basePrice = r.basePrice;
      doc.stock = r.stock;
    }
    // 限时秒杀：服务端校验（单规格用 basePrice；多规格逐 SKU 校验，传归一化后的 doc.skus）
    const sk = validateSeckill(seckill, doc.basePrice, hasSku ? doc.skus : null);
    if (!sk.ok) return res.json({ success: false, error: sk.error });
    if (sk.seckill) doc.seckill = sk.seckill;
    await db.collection('products').add(doc);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：图片上传到云存储（按 type 参数存入对应文件夹）=====
// type 可选值：product（商品封面/相册）| detail（商品详情富文本图）| banner（轮播图）| avatar（头像）| review（评价图）
// 默认存 products/
router.post('/api/upload', requireLogin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('[upload] multer error:', err.message, err.code);
      return res.json({ success: false, error: 'multer: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: '没有文件' });
    const type = req.query.type || req.body.type || 'product';
    const folderMap = {
      product: 'products',
      detail:  'details',
      banner:  'banners',
      avatar:  'avatars',
      review:  'reviews',
      popup:   'popups',
    };
    const folder = folderMap[type] || 'products';
    // 上传前压缩瘦身（限尺寸+压JPEG+修正EXIF方向）；失败自动降级用原图，不阻断上传
    const { buffer: outBuffer, ext } = await compressImage(req.file.buffer, type);
    const cloudPath = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const uploadResult = await cloud.uploadFile({ cloudPath, fileContent: outBuffer });
    const fileID = uploadResult.fileID || uploadResult;
    const result = await cloud.getTempFileURL({ fileList: [fileID] });
    const fileInfo = result.fileList[0];
    res.json({ success: true, url: fileInfo.tempFileURL, fileID, cloudPath });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：获取单个商品 =====
router.get('/api/products/:id', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('products').doc(req.params.id).get();
    const p = Array.isArray(result.data) ? result.data[0] : result.data;
    const [resolved] = resolveImageFieldsCdn([p], ['mainImage', 'gallery'], ['detail']);
    // 规格图也转 CDN 直链（供编辑表单预览），保留 Raw 字段供保存时回写 fileID
    if (resolved && Array.isArray(resolved.skus) && resolved.skus.some(s => s.image)) {
      resolved.skus = resolveImageFieldsCdn(resolved.skus, ['image']);
    }
    res.json({ data: resolved });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== API：编辑商品（替换图片时删除旧的云存储文件）=====
// 引用计数：从待删列表里剔除仍被其他商品引用的图，返回真正可物理删除的 fileID 列表
// ⚠️ COS 无版本控制，误删不可恢复——保存商品替换旧图时，先确认没有别的商品还在用这张图才删
async function filterStillReferenced(fileIds, excludeProductId) {
  const keys = fileIds.map(fileIdToCosKey).filter(Boolean);
  if (keys.length === 0) return [];
  const keySet = new Set(keys);
  const referenced = new Set();
  const r = await db.collection('products').limit(1000).get();
  (r.data || []).forEach(p => {
    if (p._id === excludeProductId) return;
    const addRef = (val) => {
      const key = val && fileIdToCosKey(val);
      if (key && keySet.has(key)) referenced.add(key);
    };
    addRef(p.mainImage);
    (p.gallery || []).forEach(addRef);
    (p.skus || []).forEach(s => addRef(s && s.image));
  });
  return fileIds.filter(f => {
    const key = fileIdToCosKey(f);
    return !key || !referenced.has(key);
  });
}

router.put('/api/products/:id', requireLogin, async (req, res) => {
  try {
    const { name, description, detail, category, basePrice, costPrice, unit, stock, mainImage, gallery, isActive, commissionPerUnit, hasSku, specGroups, skus, seckill, pickDate, originalPrice } = req.body;
    const oldRes = await db.collection('products').doc(req.params.id).get();
    const old = Array.isArray(oldRes.data) ? oldRes.data[0] : oldRes.data;
    const update = {
      name, description, detail: detail || '', category,
      basePrice: Number(basePrice),
      unit, stock: Number(stock),
      mainImage: mainImage || '', gallery: gallery || [],
      isActive: isActive !== false, updatedAt: new Date(),
    };
    if (costPrice != null && costPrice !== '') update.costPrice = Number(costPrice);
    // 单品固定返佣额：有值则设（仅 ≥0 有限数），留空则移除（回落到全局/分销员比例）
    if (commissionPerUnit != null && commissionPerUnit !== '') {
      const cpu = Number(commissionPerUnit);
      if (!Number.isFinite(cpu) || cpu < 0) return res.json({ success: false, error: '单品返佣额必须是不小于0的数字' });
      update.commissionPerUnit = cpu;
    } else {
      update.commissionPerUnit = _.remove();
    }
    // 生产日期：有值则设（'YYYY-MM-DD' 字符串透传），留空则移除（海报不显示生产日期角标）
    if (pickDate != null && pickDate !== '') {
      update.pickDate = String(pickDate);
    } else {
      update.pickDate = _.remove();
    }
    // 划线零售价：有值则设（仅 ≥0 有限数），留空则移除（海报不显示划线价）
    if (originalPrice != null && originalPrice !== '') {
      const op = Number(originalPrice);
      if (!Number.isFinite(op) || op < 0) return res.json({ success: false, error: '零售价必须是不小于0的数字' });
      update.originalPrice = op;
    } else {
      update.originalPrice = _.remove();
    }
    // 多规格：启用时校验归一化（沿用 old.skus 的 skuId）；关闭时清掉规格字段，回落单价逻辑
    if (hasSku) {
      const r = buildSkus(specGroups, skus, old && old.skus);
      if (!r.ok) return res.json({ success: false, error: r.error });
      update.hasSku = true;
      update.specGroups = r.specGroups;
      update.skus = r.skus;
      update.basePrice = r.basePrice;
      update.stock = r.stock;
    } else {
      update.hasSku = false;
      update.specGroups = _.remove();
      update.skus = _.remove();
    }
    // 限时秒杀：校验通过则设置，关闭/未传则移除该字段（多规格逐 SKU 校验，传归一化后的 update.skus）
    const sk = validateSeckill(seckill, update.basePrice, hasSku ? update.skus : null);
    if (!sk.ok) return res.json({ success: false, error: sk.error });
    update.seckill = sk.seckill ? sk.seckill : _.remove();
    await db.collection('products').doc(req.params.id).update(update);
    if (old) {
      const newSkuImages = (hasSku ? update.skus : []).map(s => s.image).filter(Boolean);
      const newSet = new Set([mainImage, ...(gallery || []), ...newSkuImages].filter(Boolean));
      const oldSkuImages = Array.isArray(old.skus) ? old.skus.map(s => s && s.image).filter(Boolean) : [];
      const removed = [old.mainImage, ...(old.gallery || []), ...oldSkuImages].filter(f => f && !newSet.has(f));
      const safeToDelete = await filterStillReferenced(removed, req.params.id);
      await deleteCloudFiles(safeToDelete);
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：修改商品上下架 =====
router.post('/api/products/:id/toggle', requireLogin, async (req, res) => {
  try {
    const { isActive } = req.body;
    await db.collection('products').doc(req.params.id).update({ isActive });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：删除商品（同步删除云存储图片）=====
router.delete('/api/products/:id', requireLogin, async (req, res) => {
  try {
    const pRes = await db.collection('products').doc(req.params.id).get();
    const p = Array.isArray(pRes.data) ? pRes.data[0] : pRes.data;
    await db.collection('products').doc(req.params.id).remove();
    if (p) {
      const toDelete = [p.mainImage, ...(p.gallery || [])].filter(Boolean);
      await deleteCloudFiles(toDelete);
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：商品分类 CRUD =====
router.get('/api/categories', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('categories').orderBy('sort', 'asc').get();
    const productsRes = await db.collection('products').field({ category: true }).limit(1000).get();
    const counts = {};
    productsRes.data.forEach(p => { if (p.category) counts[p.category] = (counts[p.category] || 0) + 1; });
    const data = result.data.map(c => ({ ...c, productCount: counts[c._id] || 0 }));
    res.json({ data });
  } catch (e) {
    res.json({ data: [], error: e.message });
  }
});

router.post('/api/categories', requireLogin, async (req, res) => {
  try {
    const { name, icon, sort } = req.body;
    const result = await db.collection('categories').add({
      name,
      icon: icon || 'category',
      sort: Number(sort) || 10,
      isActive: true,
      createdAt: new Date()
    });
    res.json({ success: true, id: result.id });
  } catch (e) {
    console.error('Add category error:', e);
    res.json({ success: false, error: e.message });
  }
});

router.put('/api/categories/:id', requireLogin, async (req, res) => {
  try {
    const update = {};
    if (req.body.name !== undefined) update.name = req.body.name;
    if (req.body.icon !== undefined) update.icon = req.body.icon;
    if (req.body.sort !== undefined) update.sort = Number(req.body.sort);
    if (req.body.isActive !== undefined) update.isActive = req.body.isActive;
    update.updatedAt = new Date();
    await db.collection('categories').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.delete('/api/categories/:id', requireLogin, async (req, res) => {
  try {
    await db.collection('categories').doc(req.params.id).remove();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== API：轮播图列表 =====
router.get('/api/banners', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('banners').orderBy('sort', 'asc').get();
    const list = resolveImageFieldsCdn(result.data, ['imageUrl']);
    res.json({ list });
  } catch (e) {
    res.json({ error: e.message, list: [] });
  }
});

router.post('/api/banners', requireLogin, async (req, res) => {
  try {
    const { imageUrl, sort = 0, isActive = true } = req.body;
    await db.collection('banners').add({ imageUrl, sort: Number(sort), isActive, createdAt: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.put('/api/banners/:id', requireLogin, async (req, res) => {
  try {
    const { sort, isActive } = req.body;
    const update = { updatedAt: new Date() };
    if (sort !== undefined) update.sort = Number(sort);
    if (isActive !== undefined) update.isActive = isActive;
    await db.collection('banners').doc(req.params.id).update(update);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.delete('/api/banners/:id', requireLogin, async (req, res) => {
  try {
    const bRes = await db.collection('banners').doc(req.params.id).get();
    const b = Array.isArray(bRes.data) ? bRes.data[0] : bRes.data;
    await db.collection('banners').doc(req.params.id).remove();
    if (b && b.imageUrl) await deleteCloudFiles([b.imageUrl]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
