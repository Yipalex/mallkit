// AI 助手 - 后台 API 回环客户端
// 工具以「当前登录管理员」身份、通过 127.0.0.1 回环调自己的 /api/*，转发原请求的 Cookie。
// 好处：不需要 ADMIN_AGENT_TOKEN，权限天然等于当前登录人。

// 取本进程实际监听端口。app.listen 回调里 app.set('listenPort', ...) 写入。
function resolvePort(req) {
  const fromApp = req && req.app && req.app.get('listenPort');
  return fromApp || process.env.PORT || 80;
}

/**
 * 创建回环客户端。
 * @param {import('express').Request} req 当前 SSE 请求（用于取端口 + Cookie）
 */
function createClient(req) {
  const port = resolvePort(req);
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookie = (req && req.headers && req.headers.cookie) || '';
  // 也转发 Authorization（Bearer token 调用时没有 Cookie，如 Agent Token / curl 验证）
  const authorization = (req && req.headers && req.headers.authorization) || '';

  async function request(method, path, opts = {}) {
    let url = baseUrl + path;
    if (opts.query) {
      const pairs = Object.entries(opts.query)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)]);
      const qs = new URLSearchParams(pairs).toString();
      if (qs) url += '?' + qs;
    }

    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (authorization) headers.Authorization = authorization;
    const init = { method, headers };
    if (opts.body != null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error(`后台接口调用失败（回环端口 ${port}）：${e.message}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (res.status === 401) {
      throw new Error('登录态失效，请重新登录后再试。');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`请求失败 ${res.status}（回环端口 ${port}）：${String(text).slice(0, 300)}`);
    }

    // CSV 导出等非 JSON 响应，直接返回文本。
    if (!contentType.includes('application/json')) {
      return await res.text();
    }
    return await res.json();
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
  };
}

module.exports = { createClient };
