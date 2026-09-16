// 云存储管理 API：list/urls/delete/orphans/usage/usage-detail（直连腾讯云 COS）
const express = require('express');
const router = express.Router();

const { cloud } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const {
  getCos,
  COS_BUCKET,
  COS_REGION,
  COS_CDN_DOMAIN,
  fileIdToCosKey,
  cosKeyToFileId,
} = require('../lib/cos');
const { recompressBuffer, makeThumbnail } = require('../lib/image');

// GET /api/storage/list?prefix=products/&marker=&limit=200
router.get('/api/storage/list', requireLogin, async (req, res) => {
  try {
    const cos = getCos();
    const prefix = (req.query.prefix || '').replace(/^\//, '');
    const marker = req.query.marker || '';
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    const result = await new Promise((resolve, reject) => {
      cos.getBucket({
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Prefix: prefix,
        Delimiter: '/',
        Marker: marker,
        MaxKeys: limit,
      }, (err, data) => err ? reject(err) : resolve(data));
    });

    const folders = (result.CommonPrefixes || []).map(p => ({
      type: 'folder',
      key: p.Prefix,
      name: p.Prefix.replace(prefix, '').replace(/\/$/, ''),
    }));
    const files = (result.Contents || [])
      .filter(c => c.Key !== prefix)
      .map(c => ({
        type: 'file',
        key: c.Key,
        name: c.Key.split('/').pop(),
        size: parseInt(c.Size, 10) || 0,
        lastModified: c.LastModified,
        etag: c.ETag,
      }));

    res.json({
      success: true,
      prefix,
      folders,
      files,
      isTruncated: result.IsTruncated === 'true',
      nextMarker: result.NextMarker || '',
    });
  } catch (e) {
    console.error('storage/list error:', e);
    res.json({ success: false, error: e.message });
  }
});

// POST /api/storage/urls   { keys: [...] } → 批量取访问 URL
router.post('/api/storage/urls', requireLogin, async (req, res) => {
  try {
    const keys = Array.isArray(req.body.keys) ? req.body.keys.slice(0, 200) : [];
    if (keys.length === 0) return res.json({ success: true, urls: {} });
    const urls = {};
    for (const key of keys) {
      urls[key] = `https://${COS_CDN_DOMAIN}/${encodeURI(key)}`;
    }
    res.json({ success: true, urls });
  } catch (e) {
    console.error('storage/urls error:', e);
    res.json({ success: false, error: e.message });
  }
});

// POST /api/storage/to-fileid   { keys: [...] } → 批量把 COS key 转 cloud:// fileID
router.post('/api/storage/to-fileid', requireLogin, async (req, res) => {
  try {
    const keys = Array.isArray(req.body.keys) ? req.body.keys.slice(0, 50) : [];
    const map = {};
    for (const key of keys) map[key] = cosKeyToFileId(key);
    res.json({ success: true, fileIds: map });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// POST /api/storage/delete   { keys: [...] } 批量删除
router.post('/api/storage/delete', requireLogin, async (req, res) => {
  try {
    const cos = getCos();
    const keys = Array.isArray(req.body.keys) ? req.body.keys.slice(0, 500) : [];
    if (keys.length === 0) return res.json({ success: false, error: '未选择要删除的文件' });
    const result = await new Promise((resolve, reject) => {
      cos.deleteMultipleObject({
        Bucket: COS_BUCKET, Region: COS_REGION,
        Objects: keys.map(Key => ({ Key })),
      }, (err, data) => err ? reject(err) : resolve(data));
    });
    res.json({
      success: true,
      deleted: (result.Deleted || []).length,
      errors: result.Error || [],
    });
  } catch (e) {
    console.error('storage/delete error:', e);
    res.json({ success: false, error: e.message });
  }
});

// GET /api/storage/orphans
router.get('/api/storage/orphans', requireLogin, async (req, res) => {
  try {
    const cos = getCos();
    const folders = (req.query.folders || 'products/,banners/,details/,avatars/,logo/,popups/,gifts/,coupons/').split(',');

    const allKeys = new Set();
    for (const folder of folders) {
      let marker = '';
      let safety = 0;
      do {
        const r = await new Promise((resolve, reject) => {
          cos.getBucket({
            Bucket: COS_BUCKET, Region: COS_REGION,
            Prefix: folder, Marker: marker, MaxKeys: 1000,
          }, (err, data) => err ? reject(err) : resolve(data));
        });
        for (const c of (r.Contents || [])) {
          if (c.Key.endsWith('.keep')) continue;
          if (parseInt(c.Size, 10) === 0) continue;
          allKeys.add(c.Key);
        }
        marker = r.NextMarker || '';
        if (r.IsTruncated !== 'true') break;
        safety++;
      } while (safety < 50);
    }

    const referenced = new Set();
    const addRef = (val) => {
      if (!val) return;
      if (typeof val === 'string') {
        const key = fileIdToCosKey(val);
        if (key) referenced.add(key);
        else if (!val.startsWith('http') && !val.startsWith('data:')) {
          referenced.add(val.replace(/^\//, ''));
        }
      } else if (Array.isArray(val)) {
        val.forEach(addRef);
      }
    };
    const extractFromRichText = (html) => {
      if (!html || typeof html !== 'string') return;
      const matches = html.match(/cloud:\/\/[^\s"'<>)]+/g) || [];
      matches.forEach(addRef);
      const srcMatches = html.match(/src=["']([^"']+)["']/g) || [];
      srcMatches.forEach(s => {
        const m = s.match(/(?:products|banners|details|avatars|logo|reviews|gifts|coupons|popups)\/[^"'?\s]+/);
        if (m) referenced.add(m[0]);
      });
    };

    try {
      const r = await cloud.database().collection('products').limit(1000).get();
      (r.data || []).forEach(p => {
        addRef(p.image); addRef(p.images); addRef(p.mainImage); addRef(p.coverImage);
        addRef(p.gallery); // ⚠️ 商品相册——曾漏掉导致相册图被误判孤儿删除
        if (Array.isArray(p.skus)) p.skus.forEach(s => addRef(s && s.image)); // 多规格 SKU 图
        extractFromRichText(p.detail);
        extractFromRichText(p.description);
      });
    } catch (e) {}
    try {
      const r = await cloud.database().collection('banners').limit(500).get();
      (r.data || []).forEach(b => { addRef(b.image); addRef(b.imageUrl); });
    } catch (e) {}
    try {
      const r = await cloud.database().collection('popups').limit(500).get();
      (r.data || []).forEach(pp => { addRef(pp.image); addRef(pp.imageUrl); });
    } catch (e) {}
    try {
      const r = await cloud.database().collection('reviews').limit(2000).get();
      (r.data || []).forEach(rv => addRef(rv.images));
    } catch (e) {}
    try {
      const r = await cloud.database().collection('users').limit(2000).get();
      (r.data || []).forEach(u => addRef(u.avatarUrl));
    } catch (e) {}
    try {
      const r = await cloud.database().collection('settings').limit(100).get();
      (r.data || []).forEach(s => {
        if (s.value && typeof s.value === 'object') {
          ['logo', 'logoUrl', 'shopLogo'].forEach(k => addRef(s.value[k]));
        }
        addRef(s.logo); addRef(s.logoUrl);
      });
    } catch (e) {}
    try {
      const r = await cloud.database().collection('gifts').limit(500).get();
      (r.data || []).forEach(g => addRef(g.image));
    } catch (e) {}
    try {
      const r = await cloud.database().collection('coupons').limit(500).get();
      (r.data || []).forEach(c => addRef(c.image));
    } catch (e) {}

    const orphans = [];
    for (const key of allKeys) {
      if (!referenced.has(key)) orphans.push(key);
    }

    const orphansWithInfo = orphans.slice(0, 500);
    const result = [];
    for (const key of orphansWithInfo) {
      try {
        const info = await new Promise((resolve, reject) => {
          cos.headObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key },
            (err, data) => err ? reject(err) : resolve(data));
        });
        result.push({
          key,
          name: key.split('/').pop(),
          size: parseInt(info.headers['content-length'], 10) || 0,
          lastModified: info.headers['last-modified'] || '',
        });
      } catch (e) {
        result.push({ key, name: key.split('/').pop(), size: 0, lastModified: '' });
      }
    }

    const totalSize = result.reduce((s, f) => s + f.size, 0);
    res.json({
      success: true,
      orphans: result,
      stats: {
        totalCosFiles: allKeys.size,
        referencedFiles: referenced.size,
        orphanCount: orphans.length,
        orphanSizeBytes: totalSize,
        truncatedTo: orphansWithInfo.length < orphans.length ? orphansWithInfo.length : null,
      },
    });
  } catch (e) {
    console.error('storage/orphans error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════
// 图片引用索引（用于查"图片被谁用"）
// 一次性扫描所有集合，建立 cosKey → [{type, id, name, field}, ...] 映射
// 60 秒缓存，避免每次开页扫库
// ════════════════════════════════════════════
let _usageIndex = null;
let _usageIndexAt = 0;
const USAGE_CACHE_MS = 60 * 1000;

async function buildUsageIndex(force) {
  const now = Date.now();
  if (!force && _usageIndex && (now - _usageIndexAt < USAGE_CACHE_MS)) return _usageIndex;

  const idx = new Map();
  const addRef = (val, ref) => {
    if (!val) return;
    if (typeof val === 'string') {
      const key = fileIdToCosKey(val);
      const k = key || (!val.startsWith('http') && !val.startsWith('data:') ? val.replace(/^\//, '') : null);
      if (!k) return;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(ref);
    } else if (Array.isArray(val)) {
      val.forEach(v => addRef(v, ref));
    }
  };
  const extractFromRichText = (html, ref) => {
    if (!html || typeof html !== 'string') return;
    const cloudMatches = html.match(/cloud:\/\/[^\s"'<>)]+/g) || [];
    cloudMatches.forEach(v => addRef(v, ref));
    const srcMatches = html.match(/src=["']([^"']+)["']/g) || [];
    srcMatches.forEach(s => {
      const m = s.match(/(?:products|banners|details|avatars|logo|reviews|gifts|coupons|popups)\/[^"'?\s]+/);
      if (m) addRef(m[0], ref);
    });
  };

  try {
    const r = await cloud.database().collection('products').limit(1000).get();
    (r.data || []).forEach(p => {
      const ref = { type: 'product', id: p._id, name: p.name || p.title || p._id };
      addRef(p.image, { ...ref, field: 'image' });
      addRef(p.mainImage, { ...ref, field: 'mainImage' });
      addRef(p.coverImage, { ...ref, field: 'coverImage' });
      addRef(p.images, { ...ref, field: 'images' });
      addRef(p.gallery, { ...ref, field: 'gallery（商品相册）' }); // ⚠️ 曾漏掉导致误判孤儿
      if (Array.isArray(p.skus)) p.skus.forEach((s, si) => addRef(s && s.image, { ...ref, field: `skus[${si}].image（规格图）` }));
      extractFromRichText(p.detail, { ...ref, field: 'detail（详情图）' });
      extractFromRichText(p.description, { ...ref, field: 'description' });
    });
  } catch (e) {}
  try {
    const r = await cloud.database().collection('banners').limit(500).get();
    (r.data || []).forEach((b, i) => {
      const ref = { type: 'banner', id: b._id, name: b.title || `首页轮播 #${i+1}`, field: 'image' };
      addRef(b.image, ref); addRef(b.imageUrl, ref);
    });
  } catch (e) {}
  try {
    const r = await cloud.database().collection('popups').limit(500).get();
    (r.data || []).forEach((pp, i) => {
      const ref = { type: 'popup', id: pp._id, name: pp.title || `营销弹窗 #${i+1}`, field: 'imageUrl' };
      addRef(pp.image, ref); addRef(pp.imageUrl, ref);
    });
  } catch (e) {}
  try {
    const r = await cloud.database().collection('reviews').limit(2000).get();
    (r.data || []).forEach(rv => {
      const ref = { type: 'review', id: rv._id, name: rv.content ? '评价：' + String(rv.content).slice(0, 12) : '评价', field: 'images' };
      addRef(rv.images, ref);
    });
  } catch (e) {}
  try {
    const r = await cloud.database().collection('users').limit(2000).get();
    (r.data || []).forEach(u => {
      const ref = { type: 'user', id: u._id, name: u.nickName || ('用户' + String(u._id || '').slice(-6)), field: 'avatar' };
      addRef(u.avatarUrl, ref);
    });
  } catch (e) {}
  try {
    const r = await cloud.database().collection('settings').limit(100).get();
    (r.data || []).forEach(s => {
      const ref = { type: 'setting', id: s._id, name: s.key || '店铺设置', field: 'logo' };
      if (s.value && typeof s.value === 'object') {
        ['logo', 'logoUrl', 'shopLogo'].forEach(k => addRef(s.value[k], { ...ref, field: 'value.' + k }));
      }
      addRef(s.logo, ref); addRef(s.logoUrl, ref);
    });
  } catch (e) {}
  try {
    const r = await cloud.database().collection('gifts').limit(500).get();
    (r.data || []).forEach(g => {
      addRef(g.image, { type: 'gift', id: g._id, name: g.name || '礼品', field: 'image' });
    });
  } catch (e) {}
  try {
    const r = await cloud.database().collection('coupons').limit(500).get();
    (r.data || []).forEach(c => {
      addRef(c.image, { type: 'coupon', id: c._id, name: c.name || c.title || '优惠券', field: 'image' });
    });
  } catch (e) {}

  _usageIndex = idx;
  _usageIndexAt = now;
  return idx;
}

router.post('/api/storage/usage', requireLogin, async (req, res) => {
  try {
    const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
    if (keys.length === 0) return res.json({ success: true, usage: {} });
    const idx = await buildUsageIndex(false);
    const usage = {};
    for (const key of keys) {
      const refs = idx.get(key);
      usage[key] = refs ? refs.length : 0;
    }
    res.json({ success: true, usage });
  } catch (e) {
    console.error('storage/usage error:', e);
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/storage/usage-detail', requireLogin, async (req, res) => {
  try {
    const key = req.body.key;
    if (!key) return res.json({ success: false, error: '缺少 key 参数' });
    const idx = await buildUsageIndex(false);
    const refs = idx.get(key) || [];
    res.json({ success: true, key, refs, count: refs.length });
  } catch (e) {
    console.error('storage/usage-detail error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════
// 缩略图代理：GET /api/storage/thumb?key=products/xxx.jpg&w=300
// ⚠️ 为什么需要代理：CloudBase 默认存储域名 .tcb.qcloud.la 对所有文件强制返回
// Content-Disposition: attachment（防上传文件被当网页执行），浏览器 <img> 因此拒绝渲染。
// 后端从 COS 拉原图 → sharp 缩成小图 → 以正常 image/jpeg 返回（同源+登录态，无 CORS）。
// ════════════════════════════════════════════
router.get('/api/storage/thumb', requireLogin, async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key || key.includes('..')) return res.status(400).end();
    const w = Math.min(Number(req.query.w) || 300, 1600);
    const cos = getCos();
    const obj = await new Promise((resolve, reject) => {
      cos.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key },
        (err, data) => err ? reject(err) : resolve(data));
    });
    let buf = obj.Body;
    let contentType = 'image/jpeg';
    try {
      buf = await makeThumbnail(buf, w);
    } catch (e) {
      // 非图片或解码失败：原样返回（尽力而为），保留原 Content-Type
      contentType = (obj.headers && obj.headers['content-type']) || 'application/octet-stream';
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=86400'); // 浏览器缓存一天，重复浏览不重复拉
    res.send(buf);
  } catch (e) {
    res.status(404).end();
  }
});

// ════════════════════════════════════════════
// 历史大图批量重压（瘦身既有图片，fileID/key 不变，数据库零改动）
// 下载原图 → sharp 压缩 → 覆写回同一 key（fileID/key 不变，数据库零改动）。
// ⚠️ 防网关超时：下载+压缩很重，几十张串行会超 60 秒返回 HTML 错误页。所以：
//   mode='scan'（默认）：只列大图 key+原始体积，用经验压缩率粗估节省，不下载不压缩 → 秒回
//   mode='run' + confirm='RECOMPRESS'：从 offset 开始只处理 batchSize 张，返回 nextOffset+hasMore，
//                                       前端循环调用直到 hasMore=false，把长任务切成多个短请求
// 参数：minSizeKB（只压大于此值，默认 500）、offset、batchSize（默认 12）
// ════════════════════════════════════════════
const RECOMPRESS_PREFIXES = ['products/', 'banners/', 'details/', 'popups/', 'gifts/', 'coupons/', 'reviews/'];
const RECOMPRESS_EST_RATIO = 0.78; // scan 阶段估算用的经验压缩率（实测大图普遍压掉 ~80%）

// 列出所有候选大图（> minSizeBytes），按体积降序（大的先处理）
async function listRecompressCandidates(cos, minSizeBytes, prefixes) {
  const candidates = [];
  for (const prefix of prefixes) {
    let marker = '';
    let safety = 0;
    do {
      const r = await new Promise((resolve, reject) => {
        cos.getBucket({ Bucket: COS_BUCKET, Region: COS_REGION, Prefix: prefix, Marker: marker, MaxKeys: 1000 },
          (err, data) => err ? reject(err) : resolve(data));
      });
      for (const c of (r.Contents || [])) {
        if (c.Key.endsWith('.keep') || c.Key.endsWith('/')) continue;
        const size = parseInt(c.Size, 10) || 0;
        if (size >= minSizeBytes) candidates.push({ key: c.Key, size });
      }
      marker = r.NextMarker || '';
      if (r.IsTruncated !== 'true') break;
      safety++;
    } while (safety < 50);
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates;
}

router.post('/api/storage/recompress', requireLogin, async (req, res) => {
  try {
    const cos = getCos();
    const mode = req.body.mode === 'run' ? 'run' : 'scan';
    const minSizeBytes = (Number(req.body.minSizeKB) || 500) * 1024;
    const maxEdge = Number(req.body.maxEdge) || 1600;
    const quality = Number(req.body.quality) || 82;
    const offset = Math.max(0, Number(req.body.offset) || 0);
    const batchSize = Math.min(Number(req.body.batchSize) || 12, 30);
    const prefixes = Array.isArray(req.body.prefixes) && req.body.prefixes.length
      ? req.body.prefixes : RECOMPRESS_PREFIXES;

    if (mode === 'run' && req.body.confirm !== 'RECOMPRESS') {
      return res.json({ success: false, error: '真执行需传 confirm="RECOMPRESS"' });
    }

    const candidates = await listRecompressCandidates(cos, minSizeBytes, prefixes);
    const totalBytes = candidates.reduce((s, c) => s + c.size, 0);

    // ── scan：不下载不压缩，秒回 ──
    if (mode === 'scan') {
      return res.json({
        success: true,
        mode,
        stats: {
          candidateCount: candidates.length,
          totalBytes,
          totalMB: (totalBytes / 1024 / 1024).toFixed(2),
          estSavedMB: (totalBytes * RECOMPRESS_EST_RATIO / 1024 / 1024).toFixed(2),
        },
        // 只回前几张示例（key+原始体积），供前端预览
        sample: candidates.slice(0, 8).map(c => ({ key: c.key, size: c.size })),
      });
    }

    // ── run：从 offset 处理 batchSize 张 ──
    const slice = candidates.slice(offset, offset + batchSize);
    const results = [];
    let processed = 0, savedBytes = 0, skipped = 0, failed = 0;
    for (const cand of slice) {
      try {
        const obj = await new Promise((resolve, reject) => {
          cos.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: cand.key },
            (err, data) => err ? reject(err) : resolve(data));
        });
        const origBuf = obj.Body;
        const { buffer: outBuf, changed, format } = await recompressBuffer(origBuf, { maxEdge, quality });
        const saved = changed ? (origBuf.length - outBuf.length) : 0;
        if (!changed || saved < 10 * 1024) { skipped++; continue; }

        const contentType = format === 'png' ? 'image/png' : 'image/jpeg';
        await new Promise((resolve, reject) => {
          cos.putObject({
            Bucket: COS_BUCKET, Region: COS_REGION, Key: cand.key,
            Body: outBuf, ContentType: contentType,
          }, (err, data) => err ? reject(err) : resolve(data));
        });
        processed++;
        savedBytes += saved;
        results.push({ key: cand.key, before: origBuf.length, after: outBuf.length, ratio: Math.round((1 - outBuf.length / origBuf.length) * 100) });
      } catch (e) {
        failed++;
        results.push({ key: cand.key, error: e.message });
      }
    }

    const nextOffset = offset + slice.length;
    res.json({
      success: true,
      mode,
      stats: {
        candidateCount: candidates.length,
        batchProcessed: processed,
        batchSkipped: skipped,
        batchFailed: failed,
        batchSavedMB: (savedBytes / 1024 / 1024).toFixed(2),
        savedBytes,
        nextOffset,
        hasMore: nextOffset < candidates.length,
      },
      results,
    });
  } catch (e) {
    console.error('storage/recompress error:', e);
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
