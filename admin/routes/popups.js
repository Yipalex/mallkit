// 营销弹窗管理
const express = require('express');
const router = express.Router();

const { db } = require('../config/cloud');
const { requireLogin } = require('../middleware/auth');
const { resolveImageFieldsCdn, deleteCloudFiles } = require('../lib/cloud-files');

// ===== 弹窗列表 =====
router.get('/api/popups', requireLogin, async (req, res) => {
  try {
    const result = await db.collection('popups')
      .orderBy('sort', 'asc')
      .orderBy('createdAt', 'desc')
      .get();
    const list = resolveImageFieldsCdn(result.data, ['imageUrl']);
    res.json({ list });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== 新增弹窗 =====
router.post('/api/popups', requireLogin, async (req, res) => {
  try {
    const { title, imageUrl, linkType, linkValue, frequency, sort, isActive } = req.body;
    const doc = {
      title: title || '',
      imageUrl: imageUrl || '',
      linkType: linkType || 'none',
      linkValue: linkValue || '',
      frequency: frequency || 'daily',
      sort: Number(sort) || 1,
      isActive: isActive !== false,
      createdAt: new Date(),
    };
    const result = await db.collection('popups').add(doc);
    res.json({ success: true, id: result.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== 编辑弹窗 =====
router.put('/api/popups/:id', requireLogin, async (req, res) => {
  try {
    const { title, imageUrl, linkType, linkValue, frequency, sort, isActive } = req.body;

    // 如果换了图片，删除旧图
    const old = await db.collection('popups').doc(req.params.id).get();
    const oldDoc = Array.isArray(old.data) ? old.data[0] : old.data;
    if (oldDoc && oldDoc.imageUrl && imageUrl && oldDoc.imageUrl !== imageUrl) {
      await deleteCloudFiles([oldDoc.imageUrl]);
    }

    await db.collection('popups').doc(req.params.id).update({
      title: title || '',
      imageUrl: imageUrl || '',
      linkType: linkType || 'none',
      linkValue: linkValue || '',
      frequency: frequency || 'daily',
      sort: Number(sort) || 1,
      isActive: isActive !== false,
      updatedAt: new Date(),
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== 启用/禁用弹窗 =====
router.post('/api/popups/:id/toggle', requireLogin, async (req, res) => {
  try {
    const { isActive } = req.body;
    await db.collection('popups').doc(req.params.id).update({ isActive: !!isActive });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== 删除弹窗 =====
router.delete('/api/popups/:id', requireLogin, async (req, res) => {
  try {
    const old = await db.collection('popups').doc(req.params.id).get();
    const oldDoc = Array.isArray(old.data) ? old.data[0] : old.data;
    if (oldDoc && oldDoc.imageUrl) {
      await deleteCloudFiles([oldDoc.imageUrl]);
    }
    await db.collection('popups').doc(req.params.id).remove();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
