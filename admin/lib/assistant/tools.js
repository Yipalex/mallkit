// AI 助手 - 13 个后台运营工具
// 两点设计约定：
//   1. client 改成回环客户端（当前登录管理员身份），不再用长期 Agent Token；
//   2. 写操作 ship_order / set_distributor 增加必填参数 confirmed，
//      服务端硬校验 —— confirmed !== true 一律拒绝执行（不再只靠提示词护栏）；
//      执行成功后写一条 role:'tool_write' 审计记录。

const { createClient } = require('./client');
const session = require('./session');

// 写操作工具清单：这两个会真实改线上数据。
const WRITE_TOOLS = new Set(['ship_order', 'set_distributor']);

const CONFIRMED_SCHEMA = {
  type: 'boolean',
  description: '必须先向用户复述参数并得到用户明确确认后才可置 true，否则置 false',
};

class ToolRegistry {
  constructor() {
    this.tools = [];
    this.handlers = new Map();
  }

  hasTools() {
    return this.tools.length > 0;
  }

  register(name, schema, handler) {
    if (this.handlers.has(name)) return;
    this.tools.push(schema);
    this.handlers.set(name, handler);
  }

  // 返回字符串结果（喂回模型用）
  async execute(name, argumentsJson) {
    return stringifyResult(await this.executeRaw(name, argumentsJson));
  }

  // 返回原始结果（对象或字符串）
  async executeRaw(name, argumentsJson) {
    const handler = this.handlers.get(name);
    if (!handler) return { error: `Unknown tool: ${name}` };

    let args = {};
    try {
      args = argumentsJson ? JSON.parse(argumentsJson) : {};
    } catch (e) {
      args = {};
    }
    if (!args || typeof args !== 'object') args = {};

    try {
      return await handler(args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: `Tool execution failed: ${message}` };
    }
  }
}

// 便捷：构造一个 OpenAI function-tool schema。
function fnSchema(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

// 把订单详情拼成可直接转发给供应商的纯文本。
function formatOrderForSupplier(o) {
  if (!o) return '未找到订单。';
  const addr = o.shippingAddress || {};
  const items = (o.items || [])
    .map((it) => `  · ${it.productName || it.name} ×${it.quantity}（${it.unit || ''}）`)
    .join('\n');
  return [
    `订单号：${o._id}`,
    `下单时间：${o.createTimeStr || o.createTime || ''}`,
    `状态：${o.status}`,
    `收货人：${addr.name || ''}　${addr.phone || ''}`,
    `地址：${addr.province || ''}${addr.city || ''}${addr.district || ''}${addr.detail || ''}`,
    `商品：\n${items}`,
    `实付：¥${o.finalPrice != null ? o.finalPrice : ''}　运费：¥${o.shippingFee != null ? o.shippingFee : ''}`,
    o.remark ? `备注：${o.remark}` : '',
  ].filter(Boolean).join('\n');
}

// 13 个 mallkit-admin 运营工具。
const SHOP_TOOLS = {
  overview: {
    schema: fnSchema('overview', '一句话概览今天该处理的事：今日营收、今日订单数、待发货数、待审提现数、低库存预警、总用户数。问「今天有什么要处理的」时用这个。'),
    handler: (c) => c.get('/api/overview'),
  },
  list_pending_orders: {
    schema: fnSchema('list_pending_orders', '列出待发货订单（status=paid）。供应商发货前先看有哪些单。', {
      page: { type: 'number', description: '页码，默认 1' },
      pageSize: { type: 'number', description: '每页数量，默认 20' },
    }),
    handler: (c, a) => c.get('/api/orders', { status: 'paid', page: a.page, pageSize: a.pageSize }),
  },
  get_order: {
    schema: fnSchema('get_order', '查单个订单详情，并整理成可直接复制转发给供应商的文本（收货人/地址/商品/实付）。', {
      orderId: { type: 'string', description: '订单号，如 O1234567890123456' },
      raw: { type: 'boolean', description: 'true 则返回原始 JSON 而非转发文本' },
    }, ['orderId']),
    handler: async (c, a) => {
      const r = await c.get(`/api/orders/${encodeURIComponent(a.orderId)}`);
      const order = r.data || r;
      return a.raw ? order : formatOrderForSupplier(order);
    },
  },
  today_revenue: {
    schema: fnSchema('today_revenue', '查看今日营收与今日订单数等仪表盘核心指标。'),
    handler: (c) => c.get('/api/dashboard'),
  },
  user_count: {
    schema: fnSchema('user_count', '查看注册用户数、近 7 天新增、会员数、分销员数等客户分析统计。'),
    handler: (c) => c.get('/api/customers/stats'),
  },
  ship_order: {
    schema: fnSchema('ship_order', '为订单填写运单信息并发货上报（同时上报微信物流）。供应商给了快递公司+单号后用。这是写操作，执行前必须先请用户确认参数。', {
      orderId: { type: 'string', description: '订单号' },
      expressCompany: { type: 'string', description: '快递公司名称，如 顺丰速运 / 圆通速递' },
      expressNo: { type: 'string', description: '运单号' },
      confirmed: CONFIRMED_SCHEMA,
    }, ['orderId', 'expressCompany', 'expressNo', 'confirmed']),
    handler: (c, a) => c.post(`/api/orders/${encodeURIComponent(a.orderId)}/ship`, {
      shippingMethod: 'express',
      packages: [{ expressCompany: a.expressCompany, expressNo: a.expressNo }],
    }),
  },
  list_reviews: {
    schema: fnSchema('list_reviews', '查看商品评价列表，可按星级筛选。', {
      page: { type: 'number' },
      limit: { type: 'number' },
      ratings: { type: 'string', description: '星级筛选，如 "1,2" 只看差评' },
    }),
    handler: (c, a) => c.get('/api/reviews', { page: a.page, limit: a.limit, ratings: a.ratings }),
  },
  monthly_finance: {
    schema: fnSchema('monthly_finance', '月度交易统计：营收、订单数、退款额、分销佣金、净收入。不传 month 则查当月。', {
      month: { type: 'string', description: '月份 YYYY-MM，如 2026-05' },
    }),
    handler: (c, a) => c.get('/api/finance/monthly', { month: a.month }),
  },
  export_finance_csv: {
    schema: fnSchema('export_finance_csv', '导出指定月份的订单财务报表 CSV（用于与微信支付商户后台对账）。返回 CSV 文本内容。', {
      month: { type: 'string', description: '月份 YYYY-MM，如 2026-05' },
    }, ['month']),
    handler: (c, a) => c.get('/api/finance/export', { month: a.month }),
  },
  rankings: {
    schema: fnSchema('rankings', '营销当红榜：单王（下单最多）、复购王。range 可选 today/week/month/all，默认 month。', {
      range: { type: 'string', enum: ['today', 'week', 'month', 'all'] },
    }),
    handler: (c, a) => c.get('/api/marketing/rankings', { range: a.range || 'month' }),
  },
  find_user: {
    schema: fnSchema('find_user', '按手机号（或昵称关键词）搜索用户，返回用户列表含 openid——设分销员前先用这个拿到 openid。', {
      keyword: { type: 'string', description: '手机号或昵称关键词' },
      pageSize: { type: 'number' },
    }, ['keyword']),
    handler: (c, a) => c.get('/api/users', { keyword: a.keyword, pageSize: a.pageSize || 30 }),
  },
  set_distributor: {
    schema: fnSchema('set_distributor', '把指定用户设为分销员（需先用 find_user 拿到 openid）。返回生成的分销码。这是写操作，执行前必须先请用户确认。', {
      openid: { type: 'string', description: '用户 openid（find_user 返回的 _id）' },
      confirmed: CONFIRMED_SCHEMA,
    }, ['openid', 'confirmed']),
    handler: (c, a) => c.post(`/api/users/${encodeURIComponent(a.openid)}/set-distributor`, {}),
  },
  list_distributors: {
    schema: fnSchema('list_distributors', '查看分销员列表，含每人的订单数、销售额、佣金、下线数统计。'),
    handler: (c) => c.get('/api/distributors'),
  },
};

/**
 * 构建工具注册表。
 * @param {object} ctx { req, conversationId } —— req 用于回环调用带 Cookie，
 *                     conversationId 用于写操作审计记录。
 */
function buildTools(ctx = {}) {
  const registry = new ToolRegistry();
  const client = createClient(ctx.req);

  for (const [name, def] of Object.entries(SHOP_TOOLS)) {
    registry.register(name, def.schema, async (args) => {
      const a = args || {};

      // 写操作硬护栏：模型没带 confirmed:true 就不放行（提示词可能被绕过，这里是最后一道）。
      if (WRITE_TOOLS.has(name) && a.confirmed !== true) {
        return { error: '写操作需先向用户复述参数并获得明确确认，请先询问用户' };
      }

      const result = await def.handler(client, a);

      // 写操作审计：落库一条 tool_write，便于事后追溯谁在什么时候改了什么。
      if (WRITE_TOOLS.has(name)) {
        const auditArgs = Object.assign({}, a);
        delete auditArgs.confirmed;
        await session.saveToolWrite(ctx.conversationId, name, auditArgs);
      }
      return result;
    });
  }

  console.log(`[assistant/tools] 已注册 ${registry.tools.length} 个后台工具`);
  return registry;
}

function stringifyResult(result) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch (e) {
    return String(result);
  }
}

module.exports = { ToolRegistry, buildTools, stringifyResult, formatOrderForSupplier, fnSchema };
