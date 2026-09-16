// utils/poster.js - 商品宣传海报绘制（纯绘制模块，不依赖页面实例）
// 只负责在 Canvas 2D 上画图：调用方准备好 model（文案 / 图片本地路径），
// 这里把 750×1200 的逻辑坐标画满，页面再自行 canvasToTempFilePath 导出。

const W = 750;   // 海报逻辑宽（实际像素 = W * dpr）
const H = 1200;  // 海报逻辑高

// ===== 内部工具 =====

// 加载图片：Canvas 2D 必须用 canvas.createImage()，普通 Image 构造不可用
function loadImage(canvas, src) {
  return new Promise((resolve, reject) => {
    if (!src) return reject(new Error('empty src'));
    const img = canvas.createImage();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed: ' + src));
    img.src = src;
  });
}

// 圆角矩形路径（调用方自行 fill / clip）
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// 逐字断行（中文没有空格，只能按字符宽度累加）。
// 最多画 maxLines 行，末行放不下时截断加省略号。返回实际绘制行数。
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const str = String(text || '');
  if (!str) return 0;
  const lines = [];
  let line = '';
  for (let i = 0; i < str.length; i++) {
    const test = line + str[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = str[i];
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  // 末行若还有剩余内容（被 break 掉），加省略号
  const drawnChars = lines.join('').length;
  if (drawnChars < str.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(last + '...').width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last + '...';
  }
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return lines.length;
}

// aspectFill 圆角裁切绘制：等比放大铺满目标框，超出部分居中裁掉
function drawCover(ctx, img, x, y, w, h, r) {
  const iw = img.width || w;
  const ih = img.height || h;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

// 图片位缺失/加载失败时的占位块（不抛错，保证海报仍能出图）
function drawImagePlaceholder(ctx, x, y, w, h, r) {
  ctx.save();
  ctx.fillStyle = '#F2F5F1';
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.fillStyle = '#9AA79A';
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('图片加载失败', x + w / 2, y + h / 2);
  ctx.restore();
  // 复位，避免污染后续文字绘制
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// ===== 主绘制 =====
// model: { topSlogan, bottomSlogan, pickDateText, mainImageUrl, qrLocalPath,
//          name, priceLabel, price, priceSuffix, oldPrice, badgeText }
async function drawPoster(canvas, ctx, model) {
  const m = model || {};

  // 1. 竖向渐变背景
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#5CAE52');
  bg.addColorStop(1, '#4A9A42');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 2. 顶部标语（大而醒目，白字压在绿底上）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText(m.topSlogan || '', W / 2, 72);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 3. 白卡：几乎占满整张海报，绿底只留上下标语条 + 窄边
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, 36, 128, 678, 952, 28);
  ctx.fill();

  // 4. 日期胶囊：白卡顶部空白条，主图上方（实底绿 + 白字），不压主图
  //    没有日期时留白不画，主图位置固定，版式不跳动
  if (m.pickDateText) {
    ctx.font = 'bold 26px sans-serif';
    const padX = 20;
    const cw = ctx.measureText(m.pickDateText).width + padX * 2;
    ctx.fillStyle = '#5CAE52';
    roundRect(ctx, 60, 150, cw, 48, 24);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(m.pickDateText, 60 + padX, 150 + 24);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // 5. 主图：日期条下方，固定 y=216（下沿 722），失败画占位
  try {
    const img = await loadImage(canvas, m.mainImageUrl);
    drawCover(ctx, img, 60, 216, 630, 506, 16);
  } catch (e) {
    drawImagePlaceholder(ctx, 60, 216, 630, 506, 16);
  }

  // 6. 价格行：从左往右依次测量推进
  const priceBaseline = 790;
  let px = 60;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#E8963F';

  // 价格标签（如「优惠价」），非空才画；为空时直接从 ¥ 起画，不留空洞
  if (m.priceLabel) {
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(m.priceLabel, px, priceBaseline);
    px += ctx.measureText(m.priceLabel).width + 8;
  }

  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('¥', px, priceBaseline);
  px += ctx.measureText('¥').width + 4;

  const priceText = String(m.price == null ? '' : m.price);
  ctx.font = 'bold 68px sans-serif';
  ctx.fillText(priceText, px, priceBaseline);
  px += ctx.measureText(priceText).width + 8;

  if (m.priceSuffix) {
    ctx.font = '26px sans-serif';
    ctx.fillText(m.priceSuffix, px, priceBaseline);
    px += ctx.measureText(m.priceSuffix).width + 14;
  }

  // 角标：与价格垂直居中对齐（价格 baseline 上方约 22px 为视觉中线）
  if (m.badgeText) {
    ctx.font = 'bold 26px sans-serif';
    const bw = ctx.measureText(m.badgeText).width + 28;
    const bh = 44;
    const by = priceBaseline - 22 - bh / 2;
    ctx.fillStyle = '#E8963F';
    roundRect(ctx, px, by, bw, bh, 8);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(m.badgeText, px + 14, by + bh / 2);
    ctx.textBaseline = 'alphabetic';
    px += bw + 14;
  }

  // 7. 划线零售价：价格行下一行，整段画中划线
  if (m.oldPrice) {
    const oldText = '零售价 ¥' + m.oldPrice;
    ctx.font = '26px sans-serif';
    ctx.fillStyle = '#9AA79A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(oldText, 60, 838);
    const ow = ctx.measureText(oldText).width;
    ctx.fillRect(60, 838 - 9, ow, 2);
  }

  // 8. 商品名（最多 2 行，maxW 给右侧二维码让位）
  ctx.fillStyle = '#243426';
  ctx.font = 'bold 38px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  wrapText(ctx, m.name || '', 60, 906, 420, 52, 2);

  // 9. 白卡内右下角小程序码 + 正下方引导文案（码缺失/失败则整块省略）
  if (m.qrLocalPath) {
    try {
      const qr = await loadImage(canvas, m.qrLocalPath);
      ctx.drawImage(qr, 500, 780, 190, 190);
      ctx.fillStyle = '#243426';
      ctx.font = '26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('长按图片去购买', 595, 1010);
      ctx.textAlign = 'left';
    } catch (e) {
      // 码加载失败：文案一并省略，不留突兀空位
    }
  }

  // 10. 底部标语（大而醒目）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(m.bottomSlogan || '', W / 2, 1142);

  // 复位，避免调用方复用 ctx 时串染
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

module.exports = { drawPoster, W, H };
