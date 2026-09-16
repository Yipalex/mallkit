// cloudfunctions/product/index.js
// 商品相关云函数：获取列表、获取详情、获取轮播图

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { withCache } = require('./utils/cache');

// 商品海报小程序码的生成参数。
// QR_ENV: 小程序码指向的版本；线上版若还没有商品详情页，getUnlimited 会报 41030，
//         体验阶段可临时改成 'trial' 并把 QR_CHECK_PATH 改成 false 绕过路径校验。
const QR_ENV = 'release';
const QR_CHECK_PATH = true;

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();
  switch (action) {
    case 'getList':       return await getList(event);
    case 'getDetail':     return await getDetail(event);
    case 'getBanners':    return await getBanners();
    case 'getHome':       return await getHome(event);
    case 'getSeckill':    return await getSeckill();
    case 'getReviews':    return await getReviews(event);
    case 'submitReview':  return await submitReview(OPENID, event);
    case 'getCoupons':    return await getCoupons(event);
    case 'receiveCoupon': return await receiveCoupon(OPENID, event);
    case 'getUserCoupons':return await getUserCoupons(OPENID);
    case 'getSettings':   return await getSettings();
    case 'getProductQrcode':   return await getProductQrcode(event);
    case 'resolveProductScene':return await resolveProductScene(event);
    default: return { code: 400, message: '未知操作' };
  }
};

// ===== 首页聚合数据（2026-07 UI 重设计：一次调用替代原来 3-4 个请求，减少冷启动等待）=====
// 返回：banners + categories + seckill + 第一页商品
async function getHome(event) {
  const { pageSize = 10 } = event;
  try {
    const [banners, categories, seckill, products] = await Promise.all([
      // 轮播图（复用已有缓存逻辑）
      getBanners().then(r => r.data || []),
      // 分类（5分钟缓存；原来小程序端直查数据库）
      withCache('categories:active', async () => {
        const res = await db.collection('categories')
          .where({ isActive: true })
          .orderBy('sort', 'asc')
          .get();
        return res.data;
      }, 300).then(r => r.data || []),
      // 秒杀
      getSeckill().then(r => r.data || []),
      // 第一页全部商品（复用 getList 的缓存）
      getList({ category: 'all', page: 1, pageSize }).then(r => r.data || { list: [], total: 0 }),
    ]);

    return { code: 200, data: { banners, categories, seckill, products } };
  } catch (err) {
    console.error('getHome error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 秒杀有效价共享 helper（口径与 getSeckill / detail.js 完全一致）=====
// 传入单个 products 文档，返回该商品当前的秒杀展示信息（不改数据库，纯计算）：
//   { active, price, isMultiSku }
//   - active：是否有有效秒杀（active===true + endTime 未过 + 秒杀价 >0 且低于原价）
//   - price：要展示的秒杀价——单规格是 seckill.price；多规格是参与秒杀 SKU 里的最低秒杀价
//   - isMultiSku：是否多规格（前端据此显示 "¥xx 起"）
// 必须每次请求实时调用（依赖当前时间判过期），不可缓存计算结果。
function computeSeckillView(p) {
  const none = { active: false, price: 0, isMultiSku: false };
  const sk = p && p.seckill;
  if (!sk || sk.active !== true) return none;
  const end = sk.endTime ? new Date(sk.endTime).getTime() : 0;
  if (end <= Date.now()) return none; // 已过期绝不显示

  if (p.hasSku && Array.isArray(p.skus) && p.skus.length) {
    // 多规格：从 skuPrices 里挑合法秒杀价（>0 且低于对应 SKU 原价），取最低
    const prices = sk.skuPrices && typeof sk.skuPrices === 'object' ? sk.skuPrices : {};
    const skuById = {};
    p.skus.forEach(s => { skuById[s.skuId] = s; });
    let minSeckill = Infinity;
    for (const [skuId, raw] of Object.entries(prices)) {
      const sku = skuById[skuId];
      if (!sku || sku.isActive === false) continue;
      const price = Number(raw), base = Number(sku.price);
      if (!(price > 0) || !Number.isFinite(base) || price >= base) continue;
      if (price < minSeckill) minSeckill = price;
    }
    if (minSeckill === Infinity) return none;
    return { active: true, price: minSeckill, isMultiSku: true };
  }

  // 单规格：整商品一个秒杀价
  const price = Number(sk.price), base = Number(p.basePrice);
  if (!Number.isFinite(base) || !(price > 0) || price >= base) return none;
  return { active: true, price, isMultiSku: false };
}

// ===== 限时秒杀商品（2026-07 新增，2026-07 补多规格）=====
// 数据约定：products 文档加 seckill 对象即参加秒杀：
//   单规格 seckill: { active, price, endTime }
//   多规格 seckill: { active, endTime, skuPrices: { [skuId]: 秒杀价 } }（每个参与秒杀的 SKU 一个价）
// endTime 过期或 active=false 即不返回。
// 多规格首页只展示"参与秒杀的 SKU 里最低秒杀价"+ isMultiSku 标记，供前端显示"¥xx 起"。
async function getSeckill() {
  try {
    const result = await withCache('seckill:active', async () => {
      const res = await db.collection('products')
        .where({ isActive: true, 'seckill.active': true })
        .limit(6)
        .get();
      return res.data;
    }, 60); // 1分钟缓存（秒杀时效性强，缓存放短）

    const now = Date.now();
    const list = [];
    for (const p of (result.data || [])) {
      const sk = p.seckill;
      const end = sk && sk.endTime ? new Date(sk.endTime).getTime() : 0;
      if (end <= now) continue;

      // 有效价判定口径与 computeSeckillView 完全一致（过期/>0/低于原价）
      if (p.hasSku && Array.isArray(p.skus) && p.skus.length) {
        // 多规格：从 skuPrices 里挑出所有合法秒杀价（>0 且低于对应 SKU 原价），取最低价展示
        const prices = sk.skuPrices && typeof sk.skuPrices === 'object' ? sk.skuPrices : {};
        const skuById = {};
        p.skus.forEach(s => { skuById[s.skuId] = s; });
        let minSeckill = Infinity, minOriginal = Infinity;
        for (const [skuId, raw] of Object.entries(prices)) {
          const sku = skuById[skuId];
          if (!sku || sku.isActive === false) continue;
          const price = Number(raw), base = Number(sku.price);
          if (!(price > 0) || !Number.isFinite(base) || price >= base) continue;
          if (price < minSeckill) { minSeckill = price; minOriginal = base; }
        }
        if (minSeckill === Infinity) continue; // 没有任何合法秒杀 SKU
        list.push({
          _id: p._id, name: p.name, mainImage: p.mainImage,
          seckillPrice: minSeckill, originalPrice: minOriginal,
          endTime: end, isMultiSku: true, // 前端据此显示"¥xx 起"
        });
      } else {
        // 单规格：整商品一个秒杀价
        const price = Number(sk.price), base = Number(p.basePrice);
        if (!Number.isFinite(base) || !(price > 0) || price >= base) continue;
        list.push({
          _id: p._id, name: p.name, mainImage: p.mainImage,
          seckillPrice: price, originalPrice: base,
          endTime: end, isMultiSku: false,
        });
      }
    }

    return { code: 200, data: list };
  } catch (err) {
    console.error('getSeckill error:', err);
    return { code: 200, data: [] }; // 出错不阻断首页
  }
}

// ===== 获取商品列表（带缓存）=====
async function getList(event) {
  const { category, keyword, page = 1, pageSize = 10 } = event;

  try {
    // 构建查询条件
    let query = { isActive: true };

    // 按分类过滤
    if (category && category !== 'all') {
      query.category = category;
    }

    // 按关键词搜索（云数据库支持正则）
    if (keyword) {
      query.name = db.RegExp({ regexp: keyword, options: 'i' });
    }

    // 如果是第一页且没有搜索关键词，使用缓存（5分钟）
    const useCache = page === 1 && !keyword;

    if (useCache) {
      const cacheKey = `products:${category || 'all'}:page1`;
      const result = await withCache(
        cacheKey,
        async () => await fetchProductsFromDb(query, page, pageSize),
        300 // 5分钟缓存
      );

      // ⚠️ 秒杀派生字段在缓存取出后每次重算（依赖当前时间判过期），不能缓存住导致过期仍显示
      return {
        code: 200,
        data: { ...result.data, list: withSeckillView(result.data.list), fromCache: result.fromCache }
      };
    }

    // 非首页或有搜索关键词，直接查询数据库
    const data = await fetchProductsFromDb(query, page, pageSize);
    return {
      code: 200,
      data: { ...data, list: withSeckillView(data.list), fromCache: false }
    };

  } catch (err) {
    console.error('getList error:', err);
    return { code: 500, message: err.message };
  }
}

// 从数据库获取商品列表
async function fetchProductsFromDb(query, page, pageSize) {
  // 计算总数（分页用）
  const countRes = await db.collection('products').where(query).count();
  const total = countRes.total;

  // 分页查询：weight 手动权重优先（调大可置顶），同权重按上架时间新品在前
  const listRes = await db.collection('products')
    .where(query)
    .orderBy('weight', 'desc')
    .orderBy('createdAt', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  return { list: listRes.data, total, page, pageSize };
}

// 给列表每个商品附加秒杀展示字段（不改数据库，只在返回数据上加）。
// 必须在从缓存取出后调用，保证 active 状态实时（依赖当前时间判过期）。
function withSeckillView(list) {
  if (!Array.isArray(list)) return list;
  return list.map(p => {
    const v = computeSeckillView(p);
    return {
      ...p,
      seckillActive: v.active,
      seckillPrice: v.active ? v.price : '',
      seckillIsMultiSku: v.isMultiSku,
    };
  });
}

// ===== 获取商品详情 =====
async function getDetail(event) {
  const { productId } = event;
  try {
    const res = await db.collection('products').doc(productId).get();
    const product = res.data;

    // 把 detail（富文本 HTML）里的 cloud:// fileID 替换成临时 URL，
    // 否则小程序的 rich-text 组件解析不出 cloud:// 协议的图片
    if (product && product.detail && typeof product.detail === 'string') {
      product.detail = await resolveCloudImagesInHtml(product.detail);
    }
    return { code: 200, data: product };
  } catch (err) {
    return { code: 404, message: '商品不存在' };
  }
}

// CloudBase 存储 CDN 域名（读公开可匿名访问）——富文本图直接拼直链，省掉 getTempFileURL 往返
const STORAGE_CDN_DOMAIN = 'your-cdn-host.example.com';
// cloud://{env}.{bucket}/{key} → https://{cdn}/{key}
function cloudIdToCdnUrl(fileId) {
  const m = /^cloud:\/\/[^.]+\.[^/]+\/(.+)$/.exec(fileId);
  if (!m) return fileId;
  return `https://${STORAGE_CDN_DOMAIN}/${m[1].split('/').map(encodeURIComponent).join('/')}`;
}

// ===== Quill 旧数据 class → 内联 style 兼容 =====
// 小程序 rich-text 只认内联 style，不认 CSS class。后台新数据已直接输出内联 font-size，
// 但历史商品详情里仍是 ql-size-* / ql-align-* 这类 class，库里不迁移，读取时在这里转换。
// ⚠️ 此映射表与 管理后台 的 public/index.html（legacyQuillClassToStyle）
//    及 lib/cloud-files.js（normalizeLegacyQuillClasses）三处必须保持一致，改一处要同步改三处。
const LEGACY_QUILL_CLASS_STYLE = {
  'ql-size-small': 'font-size:14px',
  'ql-size-large': 'font-size:24px',
  'ql-size-huge': 'font-size:32px',
  'ql-align-center': 'text-align:center',
  'ql-align-right': 'text-align:right',
  'ql-align-justify': 'text-align:justify',
};

// 把标签上的 Quill class 映射成内联 style 合并进该标签（class 保留不动）。
// 合并顺序：映射出的声明在前、原有 style 在后，保证原有内联样式优先级更高。
function normalizeLegacyQuillClasses(html) {
  if (!html || typeof html !== 'string') return html;
  return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*\bclass=["'][^"']*["'][^>]*)>/g, (tag, name, attrs) => {
    const classMatch = /\bclass=["']([^"']*)["']/.exec(attrs);
    if (!classMatch) return tag;
    const decls = classMatch[1]
      .split(/\s+/)
      .map(c => LEGACY_QUILL_CLASS_STYLE[c])
      .filter(Boolean);
    if (!decls.length) return tag;
    const injected = decls.join(';') + ';';
    const styleMatch = /\bstyle=["']([^"']*)["']/.exec(attrs);
    if (styleMatch) {
      // 原有 style 放在注入声明后面，保持其优先级
      const merged = injected + styleMatch[1];
      return `<${name}${attrs.replace(styleMatch[0], `style="${merged}"`)}>`;
    }
    return `<${name}${attrs} style="${injected}">`;
  });
}

// 把 HTML 字符串里 src="cloud://..." 的图片转换成 CDN 直链
// 同时给所有 <img> 注入自适应样式（small screen safe），因为小程序 rich-text 不支持外部 CSS 穿透
// ⚠️ 带 data-qrcode 标记的 img 例外：它会被小程序端从 HTML 里切出来用原生 <image> 渲染
//    （为了支持长按识别二维码），注入的拉满全屏样式会干扰，这里先占位抽出、只换 src 再放回。
async function resolveCloudImagesInHtml(html) {
  const regex = /src=["'](cloud:\/\/[^"']+)["']/g;

  // 先把二维码 img 抽成占位符，避开后面的自适应样式注入
  const qrImgs = [];
  let result = String(html).replace(/<img\b[^>]*>/gi, (tag) => {
    if (!/\bdata-qrcode\b/i.test(tag)) return tag;
    qrImgs.push(tag);
    return `__QR_IMG_${qrImgs.length - 1}__`;
  });

  // 直接拼 CDN 直链替换（不再逐张 getTempFileURL）
  result = result.replace(regex, (full, fid) => `src="${cloudIdToCdnUrl(fid)}"`);

  // 给所有 <img> 注入内联自适应样式——小程序 rich-text 无法被外部 wxss 穿透
  // 先移除 Quill 写入的固定宽高（如 width:480px），再统一注入自适应样式
  const ADAPTIVE_STYLE = 'max-width:100%;width:100%;height:auto;display:block;';
  // 移除 img 上现有的 width/height 内联样式（保留其他 style 属性值）
  result = result.replace(/(<img[^>]*)\sstyle="([^"]*)"/gi, (match, before, existingStyle) => {
    const cleaned = existingStyle
      .replace(/\bwidth\s*:[^;]+;?/gi, '')
      .replace(/\bheight\s*:[^;]+;?/gi, '')
      .trim();
    const merged = (cleaned ? cleaned + ';' : '') + ADAPTIVE_STYLE;
    return `${before} style="${merged}"`;
  });
  // 对没有 style 属性的 img 直接注入
  result = result.replace(/<img(?![^>]*\sstyle=)(\s)/gi, `<img style="${ADAPTIVE_STYLE}"$1`);

  // 旧数据 Quill class → 内联 style（占位符里的二维码 img 不受影响）
  result = normalizeLegacyQuillClasses(result);

  // 二维码 img 放回原位：只做 src 的 cloud://→CDN 替换，不注入样式
  // 注意用新建的正则而不是上面的 regex——带 /g 的正则在 replace 之间会残留 lastIndex，复用会漏替换
  result = result.replace(/__QR_IMG_(\d+)__/g, (ph, i) => {
    const tag = qrImgs[Number(i)];
    if (tag == null) return ph;
    return tag.replace(/src=["'](cloud:\/\/[^"']+)["']/g, (full, fid) => `src="${cloudIdToCdnUrl(fid)}"`);
  });

  return result;
}

// ===== 获取商品评价 =====
async function getReviews(event) {
  const { productId, limit = 3 } = event;
  try {
    const res = await db.collection('reviews')
      .where({ productId })
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    const total = await db.collection('reviews').where({ productId }).count();
    return { code: 200, data: res.data, total: total.total };
  } catch (err) {
    return { code: 200, data: [], total: 0 };
  }
}

// ===== 提交商品评价 =====
async function submitReview(openid, event) {
  const { productId, content, images } = event;
  let { orderId, rating } = event;

  if (!productId || !rating || !content) {
    return { code: 400, message: '缺少必要参数' };
  }
  // 入参范围校验（防止 rating 越界污染均分聚合、超长内容/超多图拖垮函数）
  rating = Number(rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { code: 400, message: '评分需为 1-5 分' };
  }
  if (typeof content !== 'string' || content.length > 500) {
    return { code: 400, message: '评价内容过长（最多 500 字）' };
  }
  if (images != null && (!Array.isArray(images) || images.length > 9)) {
    return { code: 400, message: '最多上传 9 张图片' };
  }

  try {
    // 定位并校验订单：必须是本人的 completed 订单，且订单里确实含该商品
    let order;
    if (!orderId) {
      const completedOrders = await db.collection('orders')
        .where({ userId: openid, status: 'completed' })
        .orderBy('completedAt', 'desc')
        .limit(20)
        .get();
      order = (completedOrders.data || []).find(o =>
        (o.items || []).some(i => i.productId === productId)
      );
      if (!order) {
        return { code: 403, message: '只有购买并完成收货后才能评价' };
      }
      orderId = order._id;
    } else {
      const orderRes = await db.collection('orders').doc(orderId).get();
      order = orderRes.data;
      if (!order || order.userId !== openid || order.status !== 'completed') {
        return { code: 403, message: '只有完成订单后才能评价' };
      }
      // 显式传 orderId 时也要校验该订单确实买过这个商品（否则可拿其他订单 id 评没买过的商品）
      if (!(order.items || []).some(i => i.productId === productId)) {
        return { code: 403, message: '该订单中没有这件商品' };
      }
    }

    // 快速拒绝重复评价（两道，覆盖新旧数据）：
    //  ① 订单 reviewedItems 标记——本次改动后发过奖的权威依据，删评论也不清除；
    //  ② reviews 存在性——兼容本次改动前已评价、订单还没有标记的历史数据。
    // 真正防并发双领的原子判定在下方发奖事务里，这里只是省掉后续开销的快速路径。
    if ((order.reviewedItems || []).includes(productId)) {
      return { code: 400, message: '已评价过该商品' };
    }
    const existing = await db.collection('reviews')
      .where({ productId, orderId, userId: openid })
      .count();
    if (existing.total > 0) {
      return { code: 400, message: '已评价过该商品' };
    }

    // 获取用户信息
    const userRes = await db.collection('users').doc(openid).get();
    const user = userRes.data || {};

    // ===== 内容安全检测（三合一）=====
    const security = { textPass: true, imagePass: true, userRisk: 0 };

    // 1. 文字内容安全检测（msgSecCheck）
    try {
      const textRes = await cloud.openapi.security.msgSecCheck({
        content,
        version: 2,
        scene: 4,    // 4 = 评论
        openid,
      });
      // result: 0=正常 1=违规 2=疑似
      if (textRes.result && textRes.result.suggest !== 'pass') {
        return { code: 400, message: '评价内容含有违规信息，请修改后重新提交' };
      }
    } catch (secErr) {
      // 检测失败不阻断用户（标记待人工审核）
      console.warn('文字安全检测失败:', secErr.message);
      security.textPass = false;
    }

    // 2. 用户风险等级检测（getUserRiskRank）
    try {
      const riskRes = await cloud.openapi.security.getUserRiskRank({
        openid,
        scene: 4,
      });
      security.userRisk = riskRes.risk_rank || 0;
      // risk_rank: 0=无风险 1=低风险 2=中风险 3=高风险
    } catch (riskErr) {
      console.warn('用户风险等级检测失败:', riskErr.message);
    }

    // 3. 图片安全检测（mediaCheckAsync 异步，不阻断提交，结果存入评论供管理员查阅）
    const imageCheckIds = [];
    if (Array.isArray(images) && images.length > 0) {
      for (const fileID of images) {
        try {
          // 先将 cloud:// fileID 转为临时 URL
          const urlRes = await cloud.getTempFileURL({ fileList: [fileID] });
          const tempUrl = urlRes.fileList[0]?.tempFileURL;
          if (tempUrl) {
            const mediaRes = await cloud.openapi.security.mediaCheckAsync({
              mediaUrl: tempUrl,
              mediaType: 2,  // 2 = 图片
              version: 2,
              scene: 4,
              openid,
            });
            if (mediaRes.traceId) imageCheckIds.push(mediaRes.traceId);
          }
        } catch (imgErr) {
          console.warn('图片安全检测失败:', imgErr.message);
          security.imagePass = false;
        }
      }
    }

    // 写入评论，附带安全检测元数据供管理员参考
    await db.collection('reviews').add({
      data: {
        productId,
        orderId,
        userId: openid,
        userName: user.nickName || '匿名用户',
        userAvatar: user.avatarUrl || '',
        rating,
        content,
        images: images || [],
        createdAt: new Date(),
        security: {
          textPass: security.textPass,
          userRisk: security.userRisk,
          imageTraceIds: imageCheckIds,
          // imagePass 由微信异步回调更新（当前先置 true，异步检测有问题时管理员可手动删除）
          imagePass: security.imagePass,
          checkedAt: new Date(),
        },
      }
    });

    // 更新商品的评分聚合
    try {
      const allReviews = await db.collection('reviews').where({ productId }).field({ rating: true }).get();
      const ratings = (allReviews.data || []).map(r => r.rating);
      const reviewCount = ratings.length;
      const averageRating = reviewCount > 0
        ? Math.round((ratings.reduce((s, r) => s + r, 0) / reviewCount) * 10) / 10
        : 0;
      await db.collection('products').doc(productId).update({
        data: { averageRating, reviewCount }
      });
    } catch (aggErr) {
      console.error('更新评分聚合失败（不影响评价写入）:', aggErr.message);
    }

    // ===== 评价奖励 +20 积分（原子事务发奖）=====
    // 事务内「读订单标记 → 判重 → 置标记 → 加积分」四步原子，杜绝：
    //  - 并发双提交各领一次（事务串行化，第二个看到 reviewedItems 已含该商品即抛错，不发奖）
    //  - 删评论后复评复领（标记在订单上，删 reviews 不影响）
    // 注意：CloudBase 事务内只能用 doc()，故安全检测等外部 API、reviews 写入都在事务外。
    const REVIEW_POINTS = 20;
    let earnedPoints = 0;
    let pointsBalance = 0;
    try {
      await db.runTransaction(async transaction => {
        const od = await transaction.collection('orders').doc(orderId).get();
        const ord = od.data;
        if (!ord || ord.userId !== openid || ord.status !== 'completed') {
          throw new Error('ORDER_INVALID');
        }
        const reviewed = ord.reviewedItems || [];
        if (reviewed.includes(productId)) {
          throw new Error('ALREADY_REWARDED');   // 已发过奖，判为重复，不再发
        }
        const uDoc = await transaction.collection('users').doc(openid).get();
        pointsBalance = (uDoc.data?.memberLevel?.points || 0) + REVIEW_POINTS;
        // 置不可逆标记（显式写全量数组，不依赖 push-on-undefined 行为）
        await transaction.collection('orders').doc(orderId).update({
          data: { reviewedItems: reviewed.concat([productId]), updateTime: new Date() }
        });
        await transaction.collection('users').doc(openid).update({
          data: { 'memberLevel.points': _.inc(REVIEW_POINTS), updateTime: new Date() }
        });
      });
      earnedPoints = REVIEW_POINTS;
    } catch (rwErr) {
      // ALREADY_REWARDED = 并发抢先者已发奖，本次不再发（评价已写入，仅不给分）；
      // 其他错误同样不发奖，但不回滚评价——评价本身不该因发奖失败而丢。
      if (rwErr.message !== 'ALREADY_REWARDED') {
        console.error('评价发奖事务失败（评价已保存，未发积分）:', rwErr.message);
      }
    }

    // 积分流水（best-effort，非关键；balance 用事务内读回的值，避免快照失真）
    if (earnedPoints > 0) {
      await db.collection('point_logs').add({
        data: {
          userId: openid,
          type: 'review',
          points: earnedPoints,
          description: '评价晒单奖励',
          balance: pointsBalance,
          createdAt: new Date(),
        }
      }).catch(() => {});
    }

    return {
      code: 200,
      message: earnedPoints > 0 ? '评价成功，+20积分' : '评价成功',
      data: { earnedPoints },
    };
  } catch (err) {
    console.error('submitReview error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 获取轮播图（带缓存）=====
async function getBanners() {
  try {
    // 使用缓存，10分钟有效期
    const result = await withCache(
      'banners:active',
      async () => {
        const res = await db.collection('banners')
          .where({ isActive: true })
          .orderBy('sort', 'asc')
          .limit(5)
          .get();
        return res.data;
      },
      600 // 10分钟缓存
    );

    return { code: 200, data: result.data, fromCache: result.fromCache };
  } catch (err) {
    return { code: 200, data: [] };  // 没有轮播图时返回空数组，不报错
  }
}

// ===== 生成商品海报小程序码（扫码直达商品详情页）=====
// scene 用 'p=' + 商品 _id 后 12 位（scene 上限 32 字符，塞不下完整 _id），
// 前端扫码后调 resolveProductScene 把短码还原成 productId。
async function getProductQrcode(event) {
  const { productId } = event;
  if (!productId) return { code: 400, message: '缺少 productId' };

  const short = String(productId).slice(-12);
  try {
    // 小程序码一旦生成就不会变，缓存 30 天，避免重复调 openapi + 反复写云存储
    const result = await withCache(
      `pqr:${short}`,
      async () => {
        // 云调用免 access_token
        const wxacode = await cloud.openapi.wxacode.getUnlimited({
          scene: `p=${short}`,
          page: 'pages/product/detail',
          checkPath: QR_CHECK_PATH,
          envVersion: QR_ENV,
          width: 430,
        });
        // 存云存储返回 fileID，前端用 <image> 直接渲染、可保存
        const upload = await cloud.uploadFile({
          cloudPath: `product-qrcode/${short}.png`,
          fileContent: wxacode.buffer,
        });
        return { fileID: upload.fileID };
      },
      30 * 24 * 3600 // 30天缓存
    );

    return { code: 200, data: { fileID: result.data.fileID } };
  } catch (err) {
    console.error('getProductQrcode error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 把海报码短码还原成完整 productId =====
// 用 _id 后缀正则匹配；理论上后 12 位可能撞车，命中多条时视为无法确定，返回未找到。
async function resolveProductScene(event) {
  const { short } = event;
  if (!short || !/^[A-Za-z0-9]{6,32}$/.test(String(short))) {
    return { code: 400, message: '短码格式错误' };
  }

  try {
    // 虽然字符集已限死，拼进正则前仍做一次防御式转义
    const safe = String(short).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = await withCache(
      `pscene:${short}`,
      async () => {
        const res = await db.collection('products')
          .where({ _id: db.RegExp({ regexp: `${safe}$` }) })
          .field({ _id: true })
          .limit(2)
          .get();
        // 恰好命中 1 条才认为唯一可信
        return res.data.length === 1 ? res.data[0]._id : '';
      },
      24 * 3600 // 1天缓存
    );

    if (!result.data) return { code: 404, message: '商品不存在' };
    return { code: 200, data: { productId: result.data } };
  } catch (err) {
    console.error('resolveProductScene error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 获取优惠券列表 =====
async function getCoupons(event) {
  const { type } = event;
  try {
    const now = new Date();

    // 只查 status=active 的领取型优惠券。
    // 仍排除带 createdByDistributor 的券：分销已改为扫码绑定、不再新建此类券，
    // 但库里可能残留历史分销积分码，保留此过滤避免它们出现在领券中心。
    let whereCondition = {
      status: 'active',
      createdByDistributor: _.exists(false),
    };

    if (type && type !== 'all') {
      whereCondition.type = type;
    }

    const res = await db.collection('coupons')
      .where(whereCondition)
      .orderBy('priority', 'desc')
      .orderBy('createdAt', 'desc')
      .get();

    // 统一字段名：小程序展示用 title/discount/minAmount/validDays/limitType
    const now2 = now.getTime();
    const data = res.data
      .filter(c => {
        // 二次过滤有效期（validFrom/validTo）
        const from = c.validFrom ? new Date(c.validFrom.$date || c.validFrom).getTime() : 0;
        const to = c.validTo ? new Date(c.validTo.$date || c.validTo).getTime() : Infinity;
        return now2 >= from && now2 <= to;
      })
      .map(c => ({
        ...c,
        title: c.title || c.name || '优惠券',
        discount: c.value || c.discountValue || c.discount || 0,
        minAmount: c.minAmount || c.applicableScope?.minPurchaseAmount || 0,
        validDays: c.validDays || 30,
        limitType: c.limitType || '全场',
        condition: c.condition || (c.minAmount > 0 ? `满${c.minAmount}元可用` : '无门槛'),
      }));

    return { code: 200, data };
  } catch (err) {
    console.error('getCoupons error:', err);
    return { code: 500, message: '获取优惠券失败' };
  }
}

// ===== 领取优惠券 =====
async function receiveCoupon(openid, event) {
  const { couponId } = event;

  try {
    // 1. 检查优惠券是否存在且可领取
    const couponRes = await db.collection('coupons').doc(couponId).get();
    if (!couponRes.data) {
      return { code: 404, message: '优惠券不存在' };
    }

    const coupon = couponRes.data;

    // 检查状态
    if (coupon.status !== 'active') {
      return { code: 400, message: '优惠券已停用' };
    }

    // 检查库存
    if (coupon.receivedQuantity >= coupon.totalQuantity) {
      return { code: 400, message: '优惠券已抢完' };
    }

    // 检查用户是否已领取
    const existedRes = await db.collection('user_coupons')
      .where({
        userId: openid,
        couponId: couponId
      })
      .count();

    if (existedRes.total > 0) {
      return { code: 400, message: '您已领取过该券' };
    }

    // 2. 创建用户优惠券
    const now = new Date();
    const expireAt = new Date(now.getTime() + coupon.validDays * 24 * 60 * 60 * 1000);

    await db.collection('user_coupons').add({
      data: {
        userId: openid,
        couponId: couponId,
        couponTitle: coupon.title,
        couponType: coupon.discountType,
        discountValue: coupon.discountValue,
        minAmount: coupon.minAmount,
        status: 'unused',
        receivedAt: now,
        expireAt: expireAt,
        createdAt: now
      }
    });

    // 3. 更新优惠券已领取数量
    await db.collection('coupons').doc(couponId).update({
      data: {
        receivedQuantity: coupon.receivedQuantity + 1
      }
    });

    return { code: 200, message: '领取成功' };
  } catch (err) {
    console.error('receiveCoupon error:', err);
    return { code: 500, message: '领取失败' };
  }
}

// ===== 获取用户优惠券列表（带券详情）=====
// 只返回 coupon 状态 active、未过期、未使用的券
// 兼容两套字段：老数据用 value/title/minAmount，新数据用 discountValue/discountType/name
// 只查当前用户自己的券：userId 一律用微信注入的 OPENID，不信 event.userId
// （原来收 event.userId，任何人传别人的 openid 就能拉取他人券——横向越权）
async function getUserCoupons(openid) {
  try {
    const ucRes = await db.collection('user_coupons')
      .where({ userId: openid, status: 'unused' })
      .get();

    const userCoupons = ucRes.data || [];
    if (userCoupons.length === 0) return { code: 200, data: [] };

    // 批量查 coupons 详情
    const couponIds = [...new Set(userCoupons.map(uc => uc.couponId).filter(Boolean))];
    let couponMap = {};
    if (couponIds.length > 0) {
      const cRes = await db.collection('coupons')
        .where({ _id: _.in(couponIds) })
        .get();
      (cRes.data || []).forEach(c => { couponMap[c._id] = c; });
    }

    const now = Date.now();
    const enriched = userCoupons
      .map(uc => {
        const c = couponMap[uc.couponId];
        if (!c) return null;                              // coupon 不存在
        // 只展示 active 状态的券（已被管理后台停用的不显示）
        if (c.status === 'inactive' || c.isActive === false) return null;

        // 兼容新旧两套字段
        // 老券字段: value(金额), title(名称), minAmount(门槛)
        // 新券字段: discountValue, discountType('fixed'|'percent'), name
        const discountType = c.discountType || 'fixed';
        const discountValue = c.discountValue || c.value || 0;
        const name = c.name || c.title || '';
        const minPurchase = c.applicableScope?.minPurchaseAmount || c.minAmount || 0;
        const expireAt = uc.expireAt
          ? new Date(uc.expireAt).getTime()
          : (c.endDate ? new Date(c.endDate).getTime() : Infinity);
        const expired = expireAt < now;

        return {
          _id: uc._id,
          couponId: uc.couponId,
          code: c.code || '',
          name,
          description: c.description || c.condition || '',
          discountType,
          discountValue,
          minPurchase,
          expireAt: uc.expireAt,
          expired,
          type: c.type || '',
          status: uc.status,
        };
      })
      .filter(Boolean);       // 过滤掉 null（停用/不存在的券）
      // 注意：不再过滤过期券——带 expired 标记原样返回，
      // 领券中心「已失效」tab 需要展示；pay/cart 页各自有 !expired 过滤，不受影响。

    return { code: 200, data: enriched };
  } catch (err) {
    console.error('getUserCoupons error:', err);
    return { code: 500, message: '获取用户券失败' };
  }
}

// ===== 获取店铺设置（供小程序端查运费规则）=====
async function getSettings() {
  try {
    const res = await db.collection('settings').doc('store').get();
    return { code: 200, data: res.data || {} };
  } catch (e) {
    return { code: 200, data: {} };
  }
}
