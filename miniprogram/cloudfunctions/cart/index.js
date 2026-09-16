// cloudfunctions/cart/index.js
// 购物车云同步功能：将购物车数据同步到云端，支持多设备

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { action } = event;
  const { OPENID } = cloud.getWXContext();

  switch (action) {
    case 'get':      return await getCart(OPENID);
    case 'sync':     return await syncCart(OPENID, event.items);
    case 'add':      return await addItem(OPENID, event.item);
    case 'update':   return await updateItem(OPENID, event.item);
    case 'remove':   return await removeItem(OPENID, event.productId);
    case 'clear':    return await clearCart(OPENID);
    default: return { code: 400, message: '未知操作' };
  }
};

// ===== 获取购物车 =====
async function getCart(openid) {
  try {
    const res = await db.collection('carts')
      .where({ userId: openid })
      .get();

    if (res.data.length === 0) {
      return { code: 200, data: [] };
    }

    return { code: 200, data: res.data[0].items || [] };
  } catch (err) {
    // 集合不存在视为空购物车，避免前端报错
    if (err && (err.errCode === -502005 || /not exist/i.test(err.errMsg || err.message || ''))) {
      return { code: 200, data: [] };
    }
    console.error('getCart error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 同步购物车（批量更新）=====
async function syncCart(openid, items) {
  try {
    // 验证 items 格式
    if (!Array.isArray(items)) {
      return { code: 400, message: '购物车数据格式错误' };
    }

    // 过滤无效数据
    const validItems = items.filter(item =>
      item &&
      item.productId &&
      item.quantity > 0 &&
      item.price >= 0
    );

    // 查找现有购物车
    const existing = await db.collection('carts')
      .where({ userId: openid })
      .get();

    if (existing.data.length === 0) {
      // 新建购物车
      await db.collection('carts').add({
        data: {
          userId: openid,
          items: validItems,
          updateTime: new Date(),
          createTime: new Date(),
        }
      });
    } else {
      // 更新现有购物车
      await db.collection('carts').doc(existing.data[0]._id).update({
        data: {
          items: validItems,
          updateTime: new Date(),
        }
      });
    }

    return { code: 200, message: '同步成功', data: validItems };
  } catch (err) {
    console.error('syncCart error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 添加商品到购物车 =====
async function addItem(openid, item) {
  try {
    if (!item || !item.productId) {
      return { code: 400, message: '商品信息不完整' };
    }

    if (item.quantity <= 0 || item.quantity > 999) {
      return { code: 400, message: '商品数量异常' };
    }

    // 查找现有购物车
    const existing = await db.collection('carts')
      .where({ userId: openid })
      .get();

    let items = [];

    if (existing.data.length === 0) {
      // 新建购物车
      items = [item];
      await db.collection('carts').add({
        data: {
          userId: openid,
          items: items,
          updateTime: new Date(),
          createTime: new Date(),
        }
      });
    } else {
      items = existing.data[0].items || [];

      // 查找是否已有该商品
      const existingIndex = items.findIndex(i => i.productId === item.productId);

      if (existingIndex >= 0) {
        // 已存在，更新数量
        items[existingIndex].quantity += item.quantity;
      } else {
        // 不存在，添加新商品
        items.push(item);
      }

      await db.collection('carts').doc(existing.data[0]._id).update({
        data: {
          items: items,
          updateTime: new Date(),
        }
      });
    }

    return { code: 200, message: '添加成功', data: items };
  } catch (err) {
    console.error('addItem error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 更新购物车商品数量 =====
async function updateItem(openid, item) {
  try {
    if (!item || !item.productId) {
      return { code: 400, message: '商品信息不完整' };
    }

    if (item.quantity <= 0 || item.quantity > 999) {
      return { code: 400, message: '商品数量异常' };
    }

    const existing = await db.collection('carts')
      .where({ userId: openid })
      .get();

    if (existing.data.length === 0) {
      return { code: 404, message: '购物车不存在' };
    }

    let items = existing.data[0].items || [];
    const index = items.findIndex(i => i.productId === item.productId);

    if (index < 0) {
      return { code: 404, message: '商品不存在' };
    }

    items[index] = item;

    await db.collection('carts').doc(existing.data[0]._id).update({
      data: {
        items: items,
        updateTime: new Date(),
      }
    });

    return { code: 200, message: '更新成功', data: items };
  } catch (err) {
    console.error('updateItem error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 删除购物车商品 =====
async function removeItem(openid, productId) {
  try {
    if (!productId) {
      return { code: 400, message: '商品ID不能为空' };
    }

    const existing = await db.collection('carts')
      .where({ userId: openid })
      .get();

    if (existing.data.length === 0) {
      return { code: 404, message: '购物车不存在' };
    }

    let items = existing.data[0].items || [];
    items = items.filter(i => i.productId !== productId);

    await db.collection('carts').doc(existing.data[0]._id).update({
      data: {
        items: items,
        updateTime: new Date(),
      }
    });

    return { code: 200, message: '删除成功', data: items };
  } catch (err) {
    console.error('removeItem error:', err);
    return { code: 500, message: err.message };
  }
}

// ===== 清空购物车 =====
async function clearCart(openid) {
  try {
    const existing = await db.collection('carts')
      .where({ userId: openid })
      .get();

    if (existing.data.length === 0) {
      return { code: 200, message: '购物车为空' };
    }

    await db.collection('carts').doc(existing.data[0]._id).update({
      data: {
        items: [],
        updateTime: new Date(),
      }
    });

    return { code: 200, message: '清空成功' };
  } catch (err) {
    if (err && (err.errCode === -502005 || /not exist/i.test(err.errMsg || err.message || ''))) {
      return { code: 200, message: '购物车为空' };
    }
    console.error('clearCart error:', err);
    return { code: 500, message: err.message };
  }
}
