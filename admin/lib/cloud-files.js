// CloudBase 文件工具：cloud:// fileID 转临时 URL、批量删除
const { cloud } = require('../config/cloud');
const { COS_CDN_DOMAIN, fileIdToCosKey } = require('./cos');

// cloud:// fileID → CDN 域名直链。实测该 .tcb.qcloud.la 域名读公开可匿名访问，
// 且 getTempFileURL 返回的就是同一裸 URL——所以纯拼接即可，省掉批量 getTempFileURL 网络往返。
function fileIdToCdnUrl(fileId) {
  const key = fileIdToCosKey(fileId);
  if (!key) return fileId;
  return `https://${COS_CDN_DOMAIN}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

// 旧富文本兼容：Quill class 版字号/对齐 → 内联 style（小程序 <rich-text> 只认内联 style）。
// class 保留不动，原有 style 放在转换值之后以保持其优先级。
// ⚠️ 此映射表与 public/index.html 的 legacyQuillClassToStyle
//    及小程序云函数 cloudfunctions/product/index.js 的同名逻辑，三处必须保持完全一致。
const LEGACY_QUILL_CLASS_STYLE = {
  'ql-size-small': 'font-size:14px',
  'ql-size-large': 'font-size:24px',
  'ql-size-huge':  'font-size:32px',
  'ql-align-center':  'text-align:center',
  'ql-align-right':   'text-align:right',
  'ql-align-justify': 'text-align:justify',
};
function normalizeLegacyQuillClasses(html) {
  if (!html || typeof html !== 'string') return html;
  return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (full, tag, attrs) => {
    const classMatch = attrs.match(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/);
    if (!classMatch) return full;
    const classValue = classMatch[2] != null ? classMatch[2] : (classMatch[3] || '');
    const extra = classValue.split(/\s+/)
      .map(c => LEGACY_QUILL_CLASS_STYLE[c])
      .filter(Boolean);
    if (extra.length === 0) return full;
    const prefix = extra.join(';') + ';';
    const styleMatch = attrs.match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/);
    let newAttrs;
    if (styleMatch) {
      const styleValue = (styleMatch[2] != null ? styleMatch[2] : (styleMatch[3] || '')).trim();
      const merged = styleValue ? (prefix + styleValue) : prefix;
      newAttrs = attrs.replace(styleMatch[0], 'style="' + merged.replace(/"/g, '&quot;') + '"');
    } else {
      newAttrs = attrs + ' style="' + prefix + '"';
    }
    return '<' + tag + newAttrs + '>';
  });
}

// resolveImageFields 的 CDN 版：同样的字段处理逻辑，但不调 getTempFileURL，直接拼 CDN 直链。
// 同样保留 xxxRaw 原始 fileID（前端保存时回写用），行为与临时链接版对齐。
function resolveImageFieldsCdn(items, imageFields, htmlFields = []) {
  if (!items || items.length === 0) return items;
  return items.map(item => {
    const patched = { ...item };
    for (const field of imageFields) {
      const val = item[field];
      if (!val) continue;
      if (Array.isArray(val)) {
        patched[field + 'Raw'] = val;
        patched[field] = val.map(u => (u && u.startsWith('cloud://')) ? fileIdToCdnUrl(u) : u);
      } else if (typeof val === 'string' && val.startsWith('cloud://')) {
        patched[field + 'Raw'] = val;
        patched[field] = fileIdToCdnUrl(val);
      }
    }
    for (const field of htmlFields) {
      if (patched[field]) {
        patched[field] = patched[field].replace(/cloud:\/\/[^"'\s>]+/g, id => fileIdToCdnUrl(id));
        // 旧富文本的 class 版字号/对齐补成内联 style，保证小程序端能渲染出后台设置的字号
        patched[field] = normalizeLegacyQuillClasses(patched[field]);
      }
    }
    return patched;
  });
}

// 把任意字段列表里的 cloud:// fileID 批量转成临时 URL
// items: 对象数组，imageFields: 要处理的字段名列表（支持数组字段）
// htmlFields: HTML 字符串字段，里面内嵌 cloud:// 的 src 也会被替换
async function resolveImageFields(items, imageFields, htmlFields = []) {
  if (!items || items.length === 0) return items;
  const allIds = [];
  for (const item of items) {
    for (const field of imageFields) {
      const val = item[field];
      if (!val) continue;
      if (Array.isArray(val)) {
        val.forEach(u => { if (u && u.startsWith('cloud://')) allIds.push(u); });
      } else if (typeof val === 'string' && val.startsWith('cloud://')) {
        allIds.push(val);
      }
    }
    for (const field of htmlFields) {
      const html = item[field];
      if (!html) continue;
      const matches = html.match(/cloud:\/\/[^"'\s>]+/g) || [];
      matches.forEach(id => allIds.push(id));
    }
  }
  if (allIds.length === 0) return items;
  const unique = [...new Set(allIds)];
  try {
    const r = await cloud.getTempFileURL({ fileList: unique });
    const map = {};
    for (const f of r.fileList) map[f.fileID] = f.tempFileURL;
    return items.map(item => {
      const patched = { ...item };
      for (const field of imageFields) {
        const val = item[field];
        if (!val) continue;
        if (Array.isArray(val)) {
          patched[field + 'Raw'] = val;
          patched[field] = val.map(u => (u && u.startsWith('cloud://')) ? (map[u] || u) : u);
        } else if (typeof val === 'string' && val.startsWith('cloud://')) {
          patched[field + 'Raw'] = val;
          patched[field] = map[val] || val;
        }
      }
      for (const field of htmlFields) {
        if (patched[field]) {
          patched[field] = patched[field].replace(/cloud:\/\/[^"'\s>]+/g, id => map[id] || id);
        }
      }
      return patched;
    });
  } catch (e) {
    return items;
  }
}

// 旧接口保持兼容
async function resolveImageUrls(products) {
  return resolveImageFields(products, ['mainImage', 'gallery']);
}

// 删除云存储文件（cloud:// fileID 或 cloudPath，忽略错误）
async function deleteCloudFiles(fileIds) {
  const ids = (Array.isArray(fileIds) ? fileIds : [fileIds])
    .filter(f => f && typeof f === 'string' && f.startsWith('cloud://'));
  if (ids.length === 0) return;
  try {
    await cloud.deleteFile({ fileList: ids });
  } catch (e) {
    console.error('deleteCloudFiles error:', e.message);
  }
}

module.exports = { resolveImageFields, resolveImageFieldsCdn, resolveImageUrls, deleteCloudFiles, fileIdToCdnUrl, normalizeLegacyQuillClasses };
