'use strict';

/**
 * 相亲 HTTP 路由
 *
 *   GET    /api/blinddate/rows        读取整张表（表头 + 数据行）
 *   POST   /api/blinddate/rows        新增一行空数据
 *   PUT    /api/blinddate/rows/:id    保存整行  { cells: [7 个值] }
 *   DELETE /api/blinddate/rows/:id    删除一行
 *
 * 表头行由数据库第一行决定，服务端拒绝修改 / 删除。
 * 写操作成功后通过 onChange 通知外部（主服务用 SSE 广播给所有设备）。
 */

function createBlindDateRoutes({ store, readBody, sendJSON, onChange }) {
  /** 读取并解析 JSON 请求体；解析失败时直接响应并返回 null */
  async function readJSON(req, res) {
    const body = await readBody(req, 64 * 1024);
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      sendJSON(res, 400, { error: 'invalid json' });
      return null;
    }
  }

  /** 统一返回：失败输出 { code, error } */
  function reply(res, out) {
    if (out && out.error) {
      sendJSON(res, out.code || 400, { error: out.error });
      return;
    }
    sendJSON(res, 200, out);
  }

  return async function handle(req, res, pathname, method) {
    if (!pathname.startsWith('/api/blinddate')) return false;

    /* --- 整表读取 / 新增一行 --- */
    if (pathname === '/api/blinddate/rows') {
      if (method === 'GET') {
        sendJSON(res, 200, store.snapshot());
        return true;
      }
      if (method === 'POST') {
        const out = store.createRow();
        if (out.error) {
          reply(res, out);
          return true;
        }
        onChange({ action: 'created', row: out.row, headers: store.getHeaders() });
        sendJSON(res, 200, { headers: store.getHeaders(), row: out.row });
        return true;
      }
      return false;
    }

    /* --- 保存 / 删除某一行 --- */
    const match = /^\/api\/blinddate\/rows\/(\d+)$/.exec(pathname);
    if (match) {
      const id = Number(match[1]);

      if (method === 'PUT') {
        const p = await readJSON(req, res);
        if (!p) return true;

        const out = store.updateRow(id, p.cells);
        if (out.error) {
          reply(res, out);
          return true;
        }
        onChange({ action: 'updated', row: out.row, headers: store.getHeaders() });
        sendJSON(res, 200, { headers: store.getHeaders(), row: out.row });
        return true;
      }

      if (method === 'DELETE') {
        const out = store.deleteRow(id);
        if (out.error) {
          reply(res, out);
          return true;
        }
        onChange({ action: 'deleted', id, headers: store.getHeaders() });
        sendJSON(res, 200, { headers: store.getHeaders(), ok: true });
        return true;
      }

      return false;
    }

    return false;
  };
}

module.exports = { createBlindDateRoutes };
