// pages/product/detail.js - V2

const app = getApp();
const { drawPoster, W: POSTER_W, H: POSTER_H } = require('../../utils/poster.js');

// cloud:// fileID 转 CDN https（Canvas 2D 的 createImage 不认 cloud:// 协议）
const CDN_HOST = 'your-cdn-host.example.com';
const CLOUD_FILE_RE = /^cloud:\/\/[^.]+\.[^/]+\/(.+)$/;
function cloudToHttps(url) {
  if (!url || typeof url !== 'string') return '';
  const m = CLOUD_FILE_RE.exec(url);
  if (!m) return url;
  const key = m[1].split('/').map(encodeURIComponent).join('/');
  return `https://${CDN_HOST}/${key}`;
}

// ===== 图文详情按二维码切分 =====
// rich-text 内的 <img> 不是 <image> 组件，无法挂 show-menu-by-longpress，二维码没法长按识别。
// 后台给二维码图片打了 data-qrcode="1" 标记，这里把这些 img 从 HTML 里切出来，
// 交给 wxml 用原生 <image show-menu-by-longpress> 渲染；普通图片继续留在 rich-text 内。
// 返回 [{ type:'html', content }, { type:'qrcode', src }] 的有序数组。
const IMG_RE = /<img\b[^>]*>/gi;

// 修补被切断的标签：Quill 的 image 是 inline embed，必定包在 <p> 里，
// 直接切会留下半个标签——段末未闭合就补 </p>，段首不是标签就前置 <p>。
function fixHtmlSegment(seg) {
  let s = seg || '';
  // 段首若是被切断留下的孤立 </p>（二维码原本在 <p> 中间），先去掉
  s = s.replace(/^\s*(?:<\/p\s*>\s*)+/i, '');
  // 段尾若是被切断留下的孤立 <p ...>（二维码原本紧跟在段落开头），先去掉
  s = s.replace(/<p\b[^>]*>\s*$/i, '');
  // 去掉全部标签后没有文字、且不含图片 → 空段（如 <p></p>、纯空白），丢弃
  if (!s.replace(/<[^>]*>/g, '').trim() && !/<img\b/i.test(s)) return '';
  if (!/^\s*</.test(s)) s = '<p>' + s;
  const open = (s.match(/<p\b/gi) || []).length;
  const close = (s.match(/<\/p\b/gi) || []).length;
  if (open > close) s += '</p>'.repeat(open - close);
  return s;
}

function splitDetailByQrcode(html) {
  if (!html || typeof html !== 'string') return [];
  const segments = [];
  let lastIndex = 0;
  let m;
  IMG_RE.lastIndex = 0;
  while ((m = IMG_RE.exec(html)) !== null) {
    const tag = m[0];
    if (!/\bdata-qrcode\s*=\s*["']?1/i.test(tag)) continue; // 普通图片不切
    const srcMatch = /\bsrc=["']([^"']+)["']/i.exec(tag);
    const src = srcMatch ? srcMatch[1] : '';
    if (!src) continue;
    const before = fixHtmlSegment(html.slice(lastIndex, m.index));
    if (before) segments.push({ type: 'html', content: before });
    segments.push({ type: 'qrcode', src });
    lastIndex = m.index + tag.length;
  }
  const tail = fixHtmlSegment(html.slice(lastIndex));
  if (tail) segments.push({ type: 'html', content: tail });
  return segments;
}

Page({
  data: {
    productId: '',
    product: null,
    quantity: 1,
    isLoading: true,
    galleryIndex: 1,       // 轮播当前页码（右下角 1/6 指示）
    displayGallery: [],    // 当前展示的相册（切换规格时跟随命中 sku.image）
    vipPrice: '',
    detailFallback: '<p style="color:#999;text-align:center;padding:32px 0">暂无详情</p>',
    detailSegments: [],    // 图文详情按二维码切分后的段（html 段 + 原生二维码图）
    addressText: '请选择收货地址',  // 「送至」行：默认收货地址
    cartCount: 0,                   // 底栏购物车角标
    // 评价
    reviews: [],
    reviewTotal: 0,
    reviewsExpanded: false,   // 「查看全部」是否已展开（默认只显示 3 条）
    // ===== 多规格（SKU） =====
    showSkuModal: false,        // 规格选择弹窗
    skuModalAction: '',         // 'cart' | 'buy'，弹窗确认后的去向
    selectedOptionIndexes: [],  // 各维度已选的选项下标，未选为 undefined
    matchedSku: null,           // 当前选项组合命中的 sku（全选齐才有）
    matchedSkuSeckillPrice: '', // 命中 sku 的秒杀价（该规格参与秒杀且有效时），空=按原价
    skuMinPrice: '',            // 多规格时"¥X 起"的最低价
    skuHasSeckill: false,       // 多规格：是否有任一规格在秒杀（顶部显示秒杀标签）
    skuSeckillMinPrice: '',     // 多规格：参与秒杀规格的最低秒杀价（顶部"¥X 起"）
    isSoldOut: false,           // 整品售罄（单规格 stock<=0 或多规格全部 sku 售罄）
    // ===== 服务承诺栏（后台可配，空则用下面默认值）=====
    serviceLabel: '服务',
    serviceText: '正品保障 · 极速发货 · 质量问题包退换',
    serviceVisible: true,
    // ===== 宣传海报 =====
    posterPath: '',            // 已生成的海报本地临时路径（生成一次复用）
    posterBuilding: false,       // 生成中（防重入）
    posterBadgeText: '新享折扣',           // 海报价格角标（后台可配）
    posterPriceLabel: '优惠价',            // 海报价格前缀标签（后台可配）
    posterTopSlogan: '自营好商品，品质有保障', // 海报顶部标语（后台可配）
    posterBottomSlogan: '从产地到身边，品质看得见', // 海报底部标语（后台可配）
    showSharePanel: false,       // 底栏「分享」面板
  },

  onLoad(options) {
    // 截图监听回调只构造一次，onShow/onHide 用同一引用注册与解绑
    this._onCapture = () => this._handleCaptureScreen();
    // 扫码进入（小程序码 scene 只带短码，需换回 productId）
    if (!options.id && options.scene) {
      const scene = decodeURIComponent(options.scene || '');
      const m = /^p=([A-Za-z0-9]{6,32})$/.exec(scene);
      if (m) {
        this._loadByShortCode(m[1]);
      } else {
        wx.showToast({ title: '商品不存在', icon: 'none' });
      }
    } else {
      this.setData({ productId: options.id });
      this.loadProduct(options.id);
    }
    this.loadServiceInfo();
    // 让右上角 "..." 菜单出现"发给朋友"和"分享到朋友圈"
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline'],
    });
  },

  // 扫码短码 → productId → 走正常详情加载
  async _loadByShortCode(short) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'resolveProductScene', short }
      });
      const pid = res.result?.data?.productId;
      if (res.result?.code === 200 && pid) {
        this.setData({ productId: pid });
        this.loadProduct(pid);
        return;
      }
      throw new Error('not found');
    } catch (e) {
      this.setData({ isLoading: false });
      wx.showToast({ title: '商品不存在', icon: 'none' });
    }
  },

  onShow() {
    // 底栏购物车角标 + 「送至」默认地址（从缓存读，改完地址回来会刷新）
    const cart = wx.getStorageSync('cart') || [];
    const cartCount = cart.reduce((s, c) => s + (c.quantity || 0), 0);
    const addr = wx.getStorageSync('defaultAddress');
    const addressText = (addr && addr.province)
      ? `${addr.province}${addr.city || ''}${addr.district || ''}`
      : '请选择收货地址';
    this.setData({ cartCount, addressText });
    // 监听用户截图 → 引导生成宣传海报
    if (wx.onUserCaptureScreen) wx.onUserCaptureScreen(this._onCapture);
  },

  onHide() {
    this._offCapture();
  },

  onUnload() {
    this._offCapture();
  },

  // 解绑截图监听
  _offCapture() {
    if (wx.offUserCaptureScreen) wx.offUserCaptureScreen(this._onCapture);
  },

  // 截图触发（5 秒频控 + 防重入）：生成海报后直接弹微信系统分享弹窗
  _handleCaptureScreen() {
    if (this.data.posterBuilding) return;
    const now = Date.now();
    if (this._lastCaptureAt && now - this._lastCaptureAt < 5000) return;
    this._lastCaptureAt = now;
    this.buildPoster();
  },

  // 拉取后台配置的服务承诺栏，字段为空则保留 data 里的默认文案
  async loadServiceInfo() {
    try {
      const r = await wx.cloud.callFunction({ name: 'product', data: { action: 'getSettings' } });
      const s = r.result?.data || {};
      const patch = {};
      if (s.serviceLabel) patch.serviceLabel = s.serviceLabel;
      if (s.serviceText) patch.serviceText = s.serviceText;
      if (s.serviceVisible === false) patch.serviceVisible = false;
      // 海报文案同一份 settings 顺手带回，非空才覆盖默认
      if (s.posterTopSlogan) patch.posterTopSlogan = s.posterTopSlogan;
      if (s.posterBottomSlogan) patch.posterBottomSlogan = s.posterBottomSlogan;
      if (s.posterBadgeText) patch.posterBadgeText = s.posterBadgeText;
      if (s.posterPriceLabel) patch.posterPriceLabel = s.posterPriceLabel;
      if (Object.keys(patch).length) this.setData(patch);
    } catch (e) {
      console.error('loadServiceInfo error', e);
    }
  },

  // 「送至」行：去地址管理页（选默认地址）
  onGoAddress() {
    wx.navigateTo({ url: '/pages/address/list' });
  },

  async loadProduct(productId) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getDetail', productId }
      });
      if (res.result.code === 200) {
        const product = res.result.data;
        // 确保 gallery 有封面图
        if (product.mainImage && !(product.gallery || []).includes(product.mainImage)) {
          product.gallery = [product.mainImage, ...(product.gallery || [])];
        }
        if (!product.gallery || !product.gallery.length) {
          product.gallery = product.mainImage ? [product.mainImage] : [];
        }
        // ===== 秒杀有效价判定（与首页 getSeckill / order 计价规则一致）=====
        // 仅单规格商品；须 active + 未过 endTime + 秒杀价 >0 且低于原价，任一不满足按原价。
        let seckillActive = false;
        let seckillPrice = '';
        const sk = product.seckill;
        if (sk && sk.active && !product.hasSku) {
          const end = sk.endTime ? new Date(sk.endTime).getTime() : 0;
          const sp = Number(sk.price);
          const base = Number(product.basePrice);
          if (end > Date.now() && Number.isFinite(base) && sp > 0 && sp < base) {
            seckillActive = true;
            seckillPrice = String(sk.price);
          }
        }

        // 计算会员价（WXML 不支持 toFixed，在 JS 里算好）。秒杀期间会员价基于秒杀价。
        let vipPrice = '';
        if (product.memberDiscount && product.memberDiscount.level1) {
          const baseForVip = seckillActive ? Number(seckillPrice) : product.basePrice;
          vipPrice = (baseForVip * product.memberDiscount.level1).toFixed(1);
        }
        // ===== 多规格：算最低价 + 整品是否售罄 + 秒杀最低价（顶部展示"¥X 起"）=====
        let skuMinPrice = '';
        let isSoldOut = false;
        let skuHasSeckill = false;    // 是否有任一规格在秒杀（顶部显示秒杀标签）
        let skuSeckillMinPrice = '';  // 参与秒杀规格里的最低秒杀价（顶部显示"¥X 起"）
        if (product.hasSku && Array.isArray(product.skus) && product.skus.length) {
          const activeSkus = product.skus.filter(s => s.isActive !== false);
          if (activeSkus.length) {
            skuMinPrice = Math.min(...activeSkus.map(s => Number(s.price))).toString();
            isSoldOut = activeSkus.every(s => Number(s.stock) <= 0);
            // 秒杀最低价：商品级 active + endTime 未过时，取各规格有效秒杀价的最低值
            const sk = product.seckill;
            const skEnd = sk && sk.endTime ? new Date(sk.endTime).getTime() : 0;
            if (sk && sk.active && sk.skuPrices && skEnd > Date.now()) {
              let minSk = Infinity;
              activeSkus.forEach(s => {
                const sp = Number(sk.skuPrices[s.skuId]), base = Number(s.price);
                if (sp > 0 && sp < base && sp < minSk) minSk = sp;
              });
              if (minSk !== Infinity) { skuHasSeckill = true; skuSeckillMinPrice = String(minSk); }
            }
          } else {
            isSoldOut = true;
          }
        } else {
          // 单规格：库存<=0 即售罄
          isSoldOut = Number(product.stock) <= 0;
        }
        // 图文详情走 rich-text 分支时，按二维码切分（口径与 wxml 里的三级兜底一致）
        const detailHtml = product.detail || product.detailContent || this.data.detailFallback;
        const detailSegments = splitDetailByQrcode(detailHtml);
        this.setData({
          product, isLoading: false, vipPrice, skuMinPrice, isSoldOut, detailSegments,
          seckillActive, seckillPrice, skuHasSeckill, skuSeckillMinPrice,
          selectedOptionIndexes: [], matchedSku: null, matchedSkuSeckillPrice: '',
          displayGallery: product.gallery,
        });
        wx.setNavigationBarTitle({ title: product.name });
        this.loadReviews(productId);
        // 后台预生成海报：延迟 300ms 让首屏先渲染完；失败静默（用到时再重试）
        setTimeout(() => this.ensurePoster().catch(() => {}), 300);
      } else {
        wx.showToast({ title: '商品不存在', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
      }
    } catch (err) {
      console.error('加载商品详情失败', err);
      this.setData({ isLoading: false });
    }
  },

  async loadReviews(productId, limit = 3) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'product',
        data: { action: 'getReviews', productId, limit }
      });
      if (res.result && res.result.code === 200) {
        const reviews = (res.result.data || []).map(r => ({
          ...r,
          starsArr: [1,2,3,4,5].map(n => n <= (r.rating || 5)),
          dateText: this.formatDate(r.createdAt)
        }));
        this.setData({ reviews, reviewTotal: res.result.total || reviews.length });
      }
    } catch (e) {
      // 评价加载失败不影响主流程
    }
  },

  formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  },

  // 轮播翻页：更新右下角页码
  onGalleryChange(e) {
    this.setData({ galleryIndex: e.detail.current + 1 });
  },

  // 数量增减
  onQuantityChange(e) {
    const action = e.currentTarget.dataset.action;
    let q = this.data.quantity;
    if (action === 'minus' && q > 1) q--;
    if (action === 'plus' && q < 99) q++;
    this.setData({ quantity: q });
  },

  noop() {},

  // 构建加购商品对象（多规格时带上选中 sku 的价格/skuId/specText）
  _buildCartItem() {
    const { product, quantity, matchedSku, matchedSkuSeckillPrice } = this.data;
    if (product.hasSku && matchedSku) {
      // 该规格秒杀有效时用秒杀价（服务端 order 云函数会以数据库秒杀价重算，前端价仅展示/占位）
      const price = matchedSkuSeckillPrice ? Number(matchedSkuSeckillPrice) : matchedSku.price;
      return {
        productId: product._id,
        skuId: matchedSku.skuId,
        specText: matchedSku.specText || '',
        name: product.name,
        image: matchedSku.image || product.mainImage,
        price,
        unit: matchedSku.unit || product.unit || 'kg',
        quantity,
      };
    }
    // 单规格秒杀有效时用秒杀价（服务端 order 云函数会再次以数据库秒杀价重算，前端价仅展示/占位）
    const unitPrice = this.data.seckillActive ? Number(this.data.seckillPrice) : product.basePrice;
    return {
      productId: product._id,
      name: product.name,
      image: product.mainImage,
      price: unitPrice,
      unit: product.unit || 'kg',
      quantity,
    };
  },

  // ===== 多规格弹窗逻辑 =====
  // 打开规格弹窗。两种调用：直接传字符串 openSkuModal('cart')，或 bindtap 事件（读 data-action）
  openSkuModal(action) {
    const act = (typeof action === 'string') ? action : (action?.currentTarget?.dataset?.action || 'cart');
    this.setData({ showSkuModal: true, skuModalAction: act });
  },
  onCloseSkuModal() {
    this.setData({ showSkuModal: false });
  },

  // 点击某维度的某个选项
  onSelectSkuOption(e) {
    const { gi, oi } = e.currentTarget.dataset;
    const selected = [...this.data.selectedOptionIndexes];
    selected[gi] = Number(oi);
    this.setData({ selectedOptionIndexes: selected });
    this._matchSku(selected);
  },

  // 某个 SKU 的有效秒杀价（与 order/product 云函数同口径）：商品级 active+endTime未过 + skuPrices[skuId]>0且低于原价
  _skuSeckillPrice(sku) {
    const { product } = this.data;
    const sk = product && product.seckill;
    if (!sk || !sk.active || !sk.skuPrices || !sku) return '';
    const end = sk.endTime ? new Date(sk.endTime).getTime() : 0;
    if (end <= Date.now()) return '';
    const price = Number(sk.skuPrices[sku.skuId]);
    const base = Number(sku.price);
    if (!Number.isFinite(base) || !(price > 0) || price >= base) return '';
    return String(price);
  },

  // 根据已选的各维度下标匹配 sku（全选齐才算命中）
  _matchSku(selected) {
    const { product } = this.data;
    const groupCount = (product.specGroups || []).length;
    const allChosen = selected.length === groupCount && selected.every(v => v !== undefined && v !== null);
    let matchedSku = null;
    if (allChosen) {
      matchedSku = (product.skus || []).find(s =>
        s.isActive !== false &&
        Array.isArray(s.optionIndexes) &&
        s.optionIndexes.length === selected.length &&
        s.optionIndexes.every((v, i) => Number(v) === Number(selected[i]))
      ) || null;
    }
    // 选中 SKU 的秒杀价（供弹窗展示秒杀价+划线原价）；未命中或不参与秒杀为空串
    const matchedSkuSeckillPrice = matchedSku ? this._skuSeckillPrice(matchedSku) : '';
    // 命中 sku 且该规格配了图，则主图切到规格图；否则回退商品原始相册
    const displayGallery = (matchedSku && matchedSku.image)
      ? [matchedSku.image]
      : this.data.product.gallery;
    // 切换规格时数量回到 1，避免超过新规格库存
    this.setData({ matchedSku, matchedSkuSeckillPrice, quantity: 1, displayGallery });
  },

  // 弹窗内确认：校验已选 + 有货后，按 action 加购或立即购买
  onConfirmSku() {
    const { matchedSku, product, skuModalAction } = this.data;
    if (!matchedSku) return wx.showToast({ title: '请选择规格', icon: 'none' });
    if (Number(matchedSku.stock) <= 0) return wx.showToast({ title: '该规格已售罄', icon: 'none' });
    this.setData({ showSkuModal: false });
    if (skuModalAction === 'buy') this._doBuyNow();
    else this._addToCartLogic();
  },

  // 购物车去重 key：同商品同规格(skuId+specText)合并数量
  _cartKey(item) {
    return (item.productId || '') + '|' + (item.skuId || '') + '|' + (item.specText || '');
  },

  _addToCartLogic() {
    const item = this._buildCartItem();
    let cart = wx.getStorageSync('cart') || [];
    const key = this._cartKey(item);
    const idx = cart.findIndex(c => this._cartKey(c) === key);
    if (idx >= 0) {
      cart[idx].quantity += item.quantity;
    } else {
      cart.push(item);
    }
    wx.setStorageSync('cart', cart);
    const total = cart.reduce((s, c) => s + c.quantity, 0);
    if (app.updateCartBadge) app.updateCartBadge(total);
    this.setData({ cartCount: total });   // 底栏角标同步
    wx.showToast({ title: '已加入购物车', icon: 'success' });
  },

  onAddToCart() {
    const { product, isSoldOut } = this.data;
    if (!product) return;
    if (isSoldOut) return wx.showToast({ title: '商品已售罄', icon: 'none' });
    // 多规格未选齐 → 弹规格框；已选齐直接加购
    if (product.hasSku && !this.data.matchedSku) return this.openSkuModal('cart');
    this._addToCartLogic();
  },

  onBuyNow() {
    const { product, isSoldOut } = this.data;
    if (!product) return;
    if (isSoldOut) return wx.showToast({ title: '商品已售罄', icon: 'none' });
    if (product.hasSku && !this.data.matchedSku) return this.openSkuModal('buy');
    this._doBuyNow();
  },

  _doBuyNow() {
    const item = this._buildCartItem();
    wx.setStorageSync('buyNow', { items: [item] });
    wx.navigateTo({ url: '/pages/order/pay?from=buyNow' });
  },

  // 跳转到购物车页面
  onGoToCart() {
    wx.switchTab({ url: '/pages/cart/index' });
  },

  // 查看全部评价：就地展开（详情页默认只拉 3 条），再次点击收起
  async onViewAllReviews() {
    if (this.data.reviewsExpanded) {
      this.setData({ reviewsExpanded: false });
      await this.loadReviews(this.data.productId, 3);
      return;
    }
    if (!this.data.reviewTotal) {
      wx.showToast({ title: '暂无评价', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '加载中...' });
    await this.loadReviews(this.data.productId, 100);
    wx.hideLoading();
    this.setData({ reviewsExpanded: true });
  },

  // 写评价
  onWriteReview() {
    const { product, productId } = this.data;
    if (!product) return;
    const app = getApp();
    if (!app.globalData.userInfo) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/review/add?productId=${productId}&productName=${product.name}` });
  },

  // ===== 宣传海报 =====

  // 底栏「分享」面板开合
  onOpenSharePanel() {
    this.setData({ showSharePanel: true });
  },
  onCloseSharePanel() {
    this.setData({ showSharePanel: false });
  },
  // 面板内「生成宣传海报」
  onPanelBuildPoster() {
    this.setData({ showSharePanel: false });
    this.buildPoster();
  },

  // 海报价格模型：严格复用 data，口径与 wxml 价格行（多规格起价 / 秒杀价 / 划线原价）一致
  getPosterPriceModel() {
    const {
      product, skuHasSeckill, skuSeckillMinPrice, skuMinPrice,
      seckillActive, seckillPrice,
    } = this.data;
    if (!product) return { price: '', priceSuffix: '', oldPrice: '' };
    if (product.hasSku) {
      return {
        price: skuHasSeckill ? skuSeckillMinPrice : skuMinPrice,
        priceSuffix: '起',
        oldPrice: skuHasSeckill ? skuMinPrice : (product.originalPrice || ''),
      };
    }
    return {
      price: seckillActive ? seckillPrice : product.basePrice,
      priceSuffix: '',
      oldPrice: seckillActive ? product.basePrice : (product.originalPrice || ''),
    };
  },

  // 'YYYY-MM-DD' → 'M月D日生产'（去前导零）；非 ISO 原样返回；空返回 ''
  formatPickDate(v) {
    if (!v) return '';
    const s = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    return `${Number(m[2])}月${Number(m[3])}日生产`;
  },

  // 组装海报绘制模型：拉小程序码（失败不阻断）+ 主图转 https + 文案
  async _buildPosterModel() {
    const { product } = this.data;
    const priceModel = this.getPosterPriceModel();

    // 小程序码：8 秒超时兜底，任何失败都降级为不画码
    let qrLocalPath = '';
    try {
      const res = await Promise.race([
        wx.cloud.callFunction({
          name: 'product',
          data: { action: 'getProductQrcode', productId: this.data.productId }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('qrcode timeout')), 8000)),
      ]);
      const fileID = res?.result?.data?.fileID;
      if (res?.result?.code === 200 && fileID) {
        const dl = await wx.cloud.downloadFile({ fileID });
        qrLocalPath = dl.tempFilePath || '';
      }
    } catch (e) {
      console.warn('海报小程序码获取失败，降级为无码海报', e);
    }

    return {
      topSlogan: this.data.posterTopSlogan,
      bottomSlogan: this.data.posterBottomSlogan,
      pickDateText: this.formatPickDate(product && product.pickDate),
      mainImageUrl: cloudToHttps(product && product.mainImage),
      qrLocalPath,
      name: product ? product.name : '',
      price: priceModel.price,
      priceSuffix: priceModel.priceSuffix,
      oldPrice: priceModel.oldPrice,
      priceLabel: this.data.posterPriceLabel,
      badgeText: this.data.posterBadgeText,
    };
  },

  // 确保海报已生成，返回 Promise<posterPath>。纯生成，不弹 loading / 不弹弹窗，
  // 供预生成与 buildPoster 共用。
  // 三态：已有路径直接复用；生成中复用同一个进行中的 Promise（防并发重复绘制）；否则真绘制。
  ensurePoster() {
    if (this.data.posterPath) return Promise.resolve(this.data.posterPath);
    if (this._posterPromise) return this._posterPromise;
    if (!this.data.product) return Promise.reject(new Error('product not loaded'));

    this.setData({ posterBuilding: true });
    const task = (async () => {
      const canvas = await new Promise((resolve, reject) => {
        wx.createSelectorQuery().in(this)
          .select('#posterCanvas')
          .fields({ node: true, size: true })
          .exec((res) => {
            if (res && res[0] && res[0].node) resolve(res[0].node);
            else reject(new Error('canvas node not found'));
          });
      });
      const ctx = canvas.getContext('2d');
      const dpr = Math.min(wx.getSystemInfoSync().pixelRatio || 2, 3);
      canvas.width = POSTER_W * dpr;
      canvas.height = POSTER_H * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, POSTER_W, POSTER_H);

      const model = await this._buildPosterModel();
      await drawPoster(canvas, ctx, model);

      const { tempFilePath } = await wx.canvasToTempFilePath({
        canvas,
        destWidth: POSTER_W * 2,
        destHeight: POSTER_H * 2,
        fileType: 'jpg',
        quality: 0.92,
      });
      this.setData({ posterPath: tempFilePath });
      return tempFilePath;
    })();

    // 无论成败都清掉进行中的 Promise：成功后走 posterPath 复用，失败后允许重试
    this._posterPromise = task.then(
      (p) => { this._posterPromise = null; this.setData({ posterBuilding: false }); return p; },
      (err) => { this._posterPromise = null; this.setData({ posterBuilding: false }); throw err; }
    );
    return this._posterPromise;
  },

  // 分享面板/截图走这里：带 loading 生成 → 直接拉起微信系统分享图片弹窗
  async buildPoster() {
    if (!this.data.product) return;
    wx.showLoading({ title: '生成中...', mask: true });
    try {
      await this.ensurePoster();
      wx.hideLoading();
      this._showShareImageMenu();
    } catch (err) {
      wx.hideLoading();
      console.error('buildPoster error', err);
      wx.showToast({ title: '海报生成失败，请重试', icon: 'none' });
    }
  },

  // 拉起微信系统「分享图片」弹窗（发好友/朋友圈/收藏/保存/贴图，2.14.3+）
  _showShareImageMenu() {
    const path = this.data.posterPath;
    if (!path || !wx.showShareImageMenu) return;
    wx.showShareImageMenu({
      path,
      needShowEntrance: false,  // 不带小程序入口角标，引流靠海报里的小程序码
      fail: (e) => {
        console.warn('showShareImageMenu fail, 降级 previewImage', e);
        wx.previewImage({ urls: [path] });
      },
    });
  },

  // 微信分享钩子：右上角"..."→"发给朋友"时触发
  onShareAppMessage() {
    const { product } = this.data;
    return {
      title: product ? product.name : '示例商城 - 优选好物',
      path: `/pages/product/detail?id=${this.data.productId}`,
      imageUrl: product ? product.mainImage : '',
    };
  },

  // 微信分享钩子：右上角"..."→"分享到朋友圈"时触发
  onShareTimeline() {
    const { product } = this.data;
    return {
      title: product ? `【示例商城】${product.name} - 品质保证` : '示例商城 - 优选好物',
      imageUrl: product ? product.mainImage : '',
      query: `id=${this.data.productId}`,
    };
  },

  noop() {},
});
