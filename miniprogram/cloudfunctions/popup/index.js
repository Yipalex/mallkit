const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { action } = event;

  if (action === 'getActive') {
    try {
      const res = await db.collection('popups')
        .where({ isActive: true })
        .orderBy('sort', 'asc')
        .limit(1)
        .get();
      const popup = res.data[0] || null;
      return { code: 200, data: popup };
    } catch (e) {
      return { code: 500, error: e.message };
    }
  }

  return { code: 400, error: 'unknown action' };
};
