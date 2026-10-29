'use strict';

/**
 * 共享表格 HTTP 路由
 *
 * 路径里的 :id 是总表 shared_sheets 里的 table_id（如 A1），
 * 而不是用户输入的中文表名。
 *
 *   GET    /api/sharedsheet/sheets                       总表列表
 *   POST   /api/sharedsheet/sheets                       新建表格 { name }
 *   DELETE /api/sharedsheet/sheets/:id                   删除表格（仅空表）
 *   GET    /api/sharedsheet/sheets/:id/rows              读取整张表
 *   POST   /api/sharedsheet/sheets/:id/rows              新增一行
 *   PUT    /api/sharedsheet/sheets/:id/rows/:rowId       保存整行 { cells: [7 个值] }
 *   DELETE /api/sharedsheet/sheets/:id/rows/:rowId       删除一行
 *
 * 写操作成功后通过 onChange 通知外部（主服务用 SSE 广播给所有设备）。
 */

function createSharedSheetRoutes({ store, readBody, sendJSON, onChange }) {
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
    if (!pathname.startsWith('/api/sharedsheet')) return false;

    /* --- 总表列表 / 新建 --- */
    if (pathname === '/api/sharedsheet/sheets') {
      if (method === 'GET') {
        sendJSON(res, 200, { sheets: store.listSheets() });
        return true;
      }
      if (method === 'POST') {
        const p = await readJSON(req, res);
        if (!p) return true;

        const out = store.createSheet(p.name);
        if (out.error) {
          reply(res, out);
          return true;
        }
        const sheets = store.listSheets();
        onChange({ action: 'sheet-created', sheet: out.sheet, sheets });
        sendJSON(res, 200, { sheet: out.sheet, row: out.row, sheets });
        return true;
      }
      return false;
    }

    /* --- 删除整张表 --- */
    let match = /^\/api\/sharedsheet\/sheets\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (match) {
      if (method === 'DELETE') {
        const id = match[1];
        const out = store.deleteSheet(id);
        if (out.error) {
          reply(res, out);
          return true;
        }
        const sheets = store.listSheets();
        onChange({ action: 'sheet-deleted', id: out.id, name: out.name, sheets });
        sendJSON(res, 200, { ok: true, sheets });
        return true;
      }
      return false;
    }

    /* --- 整表读取 / 新增一行 --- */
    match = /^\/api\/sharedsheet\/sheets\/([A-Za-z0-9_-]+)\/rows$/.exec(pathname);
    if (match) {
      const id = match[1];

      if (method === 'GET') {
        const out = store.snapshot(id);
        if (out.error) {
          reply(res, out);
          return true;
        }
        sendJSON(res, 200, out);
        return true;
      }

      if (method === 'POST') {
        const out = store.createRow(id);
        if (out.error) {
          reply(res, out);
          return true;
        }
        onChange({ action: 'row-created', tableId: id, row: out.row });
        sendJSON(res, 200, { row: out.row });
        return true;
      }

      return false;
    }

    /* --- 保存 / 删除某一行 --- */
    match = /^\/api\/sharedsheet\/sheets\/([A-Za-z0-9_-]+)\/rows\/(\d+)$/.exec(pathname);
    if (match) {
      const id = match[1];
      const rowId = Number(match[2]);

      if (method === 'PUT') {
        const p = await readJSON(req, res);
        if (!p) return true;

        const out = store.updateRow(id, rowId, p.cells);
        if (out.error) {
          reply(res, out);
          return true;
        }
        onChange({ action: 'row-updated', tableId: id, row: out.row });
        sendJSON(res, 200, { row: out.row });
        return true;
      }

      if (method === 'DELETE') {
        const out = store.deleteRow(id, rowId);
        if (out.error) {
          reply(res, out);
          return true;
        }
        onChange({ action: 'row-deleted', tableId: id, rowId });
        sendJSON(res, 200, { ok: true });
        return true;
      }

      return false;
    }

    return false;
  };
}

module.exports = { createSharedSheetRoutes };
