// 图片压缩瘦身：上传前用 sharp 限尺寸 + 压 JPEG + 修正 EXIF 方向
// 实测 939KB 商品图 → 176KB（压掉 ~81%），列表加载体积降到 1/5
const sharp = require('sharp');

// 按上传 type 定制压缩策略：详情富文本图和封面用大图，头像/评价用小图
// maxEdge：最长边像素上限（等比缩，不放大）；quality：JPEG 质量
const PRESETS = {
  product: { maxEdge: 1600, quality: 82 },  // 商品封面/相册
  // 详情富文本图（长图多，边界略收）。keepPng：PNG 源保留 PNG 无损输出——
  // 详情里常放二维码，JPEG 有损压缩会糊掉定位块降低扫码识别率；JPEG 质量也提到 92。
  detail:  { maxEdge: 1440, quality: 92, keepPng: true },
  // 轮播图/弹窗图常用透明 PNG，保 PNG 不转 JPEG（JPEG 会把透明填黑）
  banner:  { maxEdge: 1600, quality: 82, keepPng: true },  // 轮播图
  popup:   { maxEdge: 1280, quality: 82, keepPng: true },  // 弹窗图
  avatar:  { maxEdge: 400,  quality: 80 },  // 头像
  review:  { maxEdge: 1280, quality: 78 },  // 评价晒图
};
const DEFAULT_PRESET = { maxEdge: 1600, quality: 82 };

// 压缩单张图片 buffer。失败（非图片/解码失败）时原样返回，绝不阻断上传。
// 返回 { buffer, ext, compressed }：ext 统一 jpg（转码后），compressed 标记是否真压过。
async function compressImage(buffer, type) {
  if (!buffer || !buffer.length) return { buffer, ext: 'jpg', compressed: false };
  const preset = PRESETS[type] || DEFAULT_PRESET;
  try {
    const meta = await sharp(buffer).metadata();
    // 非位图（如 svg/gif 动图）不动，避免破坏动画/矢量
    if (!meta || (meta.format === 'gif' && meta.pages > 1) || meta.format === 'svg') {
      return { buffer, ext: meta && meta.format === 'svg' ? 'svg' : 'gif', compressed: false };
    }
    const pipeline = sharp(buffer)
      .rotate() // 依据 EXIF 自动摆正方向，避免手机竖拍图旋转
      .resize({ width: preset.maxEdge, height: preset.maxEdge, fit: 'inside', withoutEnlargement: true });
    // keepPng（详情图 / 弹窗图 / 轮播图）：PNG 源走 PNG 无损，不转 JPEG——
    // 详情图里的二维码经有损压缩会降低识别率；弹窗/轮播的透明 PNG 转 JPEG 会被填成黑底
    const keepPng = preset.keepPng && meta.format === 'png';
    const outExt = keepPng ? 'png' : 'jpg';
    const out = keepPng
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: preset.quality, mozjpeg: true }).toBuffer();
    // 压完反而更大（原图已是高压小图）就用原图，格式语义保持一致交给调用方决定
    if (out.length >= buffer.length) return { buffer, ext: outExt, compressed: false };
    return { buffer: out, ext: outExt, compressed: true };
  } catch (e) {
    console.error('[image] compress skip:', e.message);
    return { buffer, ext: 'jpg', compressed: false };
  }
}

// 重压已存在的图片 buffer（用于历史大图批量瘦身）。
// 与 compressImage 不同：保留原格式语义——PNG 带透明通道时压成 PNG（不转 JPEG 免丢 alpha），
// 其余一律压 JPEG。限最大边 maxEdge。返回 { buffer, format, width, height, changed }。
// changed=false 表示压完没更小或无法处理，调用方应跳过覆写。
async function recompressBuffer(buffer, { maxEdge = 1600, quality = 82 } = {}) {
  const meta = await sharp(buffer).metadata();
  if (!meta) return { buffer, changed: false };
  // 动图 / 矢量不动
  if (meta.format === 'svg' || (meta.format === 'gif' && meta.pages > 1)) {
    return { buffer, format: meta.format, changed: false };
  }
  const pipeline = sharp(buffer)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });

  let out, outFormat;
  if (meta.format === 'png' && meta.hasAlpha) {
    // 透明 PNG：保持 PNG，用调色板 + 压缩级别瘦身，不转 JPEG
    out = await pipeline.png({ compressionLevel: 9, palette: true, quality }).toBuffer();
    outFormat = 'png';
  } else {
    out = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    outFormat = 'jpeg';
  }
  if (out.length >= buffer.length) return { buffer, format: meta.format, changed: false };
  const outMeta = await sharp(out).metadata();
  return { buffer: out, format: outFormat, width: outMeta.width, height: outMeta.height, changed: true };
}

// 生成缩略图（云存储管理页预览用）。默认300px小图，几KB级，页面加载快。
// 解码失败（非图片）时抛错，由调用方降级处理。
async function makeThumbnail(buffer, width = 300) {
  return sharp(buffer)
    .rotate()
    .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
}

module.exports = { compressImage, recompressBuffer, makeThumbnail };
