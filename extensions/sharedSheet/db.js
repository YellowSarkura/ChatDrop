'use strict';

/**
 * 共享表格 —— SQLite 存储
 *
 * 总表 shared_sheets 登记所有已创建的表格：
 *   table_id   TEXT  数据库里真正的表名，英文 + 数字（A1、A2…）
 *   table_name TEXT  创建时输入的表名，只用于显示（可中文）
 *   created_at INTEGER
 *
 * 用户每新建一张表格，就往总表写一条记录，并建一张名为 table_id 的数据表：
 *   id + c1..c7 + updated_at
 * 第一行按惯例当表头，但所有行都可以随意编辑。
 * 只有空表（行数 <= 1）才允许删除整张表。
 */

const { DatabaseSync } = require('node:sqlite');

const COLUMN_COUNT = 7;
const CELL_MAX = 500;
const NAME_MAX = 40;
const CELL_COLS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const REGISTRY = 'shared_sheets';
const COLUMNS_DDL = CELL_COLS.map((col) => `${col} TEXT NOT NULL DEFAULT ''`).join(', ');

const REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS ${REGISTRY} (
    table_id   TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0
  )
`;

/** 用双引号包裹表名，避免保留字 / 特殊字符出错 */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function cellsOf(row) {
  return CELL_COLS.map((col) => (row[col] == null ? '' : row[col]));
}

/** 校验并规范化 7 个单元格内容 */
function normalizeCells(raw) {
  if (!Array.isArray(raw) || raw.length !== COLUMN_COUNT) {
    return { code: 400, error: `需要 ${COLUMN_COUNT} 列数据` };
  }

  const cells = raw.map((value) => String(value == null ? '' : value)
    .replace(/\s*\n\s*/g, ' ')
    .trim());

  for (const cell of cells) {
    if (cell.length > CELL_MAX) {
      return { code: 400, error: `单元格不能超过 ${CELL_MAX} 字` };
    }
  }
  return { cells };
}

/** 校验表名：只作为显示名，允许中文与常见符号 */
function normalizeName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return { code: 400, error: '请输入表格名称' };
  if (name.length > NAME_MAX) {
    return { code: 400, error: `表格名称不能超过 ${NAME_MAX} 个字符` };
  }
  if (/[\u0000-\u001f]/.test(name)) {
    return { code: 400, error: '表格名称不能包含换行或控制字符' };
  }
  return { name };
}

function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');

  /* ---------------- 总表 ---------------- */

  /** 旧版总表（只有 name 列）升级为 table_id + table_name */
  function migrateLegacyRegistry() {
    const old = db.prepare(`
      SELECT name, created_at AS createdAt FROM ${REGISTRY}_legacy
      ORDER BY created_at ASC, name ASC
    `).all();

    let seq = 0;
    for (const item of old) {
      seq += 1;
      const id = `A${seq}`;

      // 旧版直接用中文名建表，这里改名为 table_id
      try {
        db.exec(`ALTER TABLE ${quoteIdent(item.name)} RENAME TO ${quoteIdent(id)}`);
      } catch {
        // 旧数据表已不存在，只迁登记
      }
      db.prepare(`
        INSERT INTO ${REGISTRY} (table_id, table_name, created_at) VALUES (?, ?, ?)
      `).run(id, item.name, Number(item.createdAt) || Date.now());
    }
  }

  function ensureRegistry() {
    const cols = db.prepare(`PRAGMA table_info(${REGISTRY})`).all();
    const exists = cols.length > 0;
    const isNew = cols.some((c) => c.name === 'table_id');

    if (exists && !isNew) {
      db.exec('BEGIN');
      try {
        db.exec(`ALTER TABLE ${REGISTRY} RENAME TO ${REGISTRY}_legacy`);
        db.exec(`${REGISTRY_DDL};`);
        migrateLegacyRegistry();
        db.exec(`DROP TABLE ${REGISTRY}_legacy`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return;
    }

    db.exec(`${REGISTRY_DDL};`);
  }

  ensureRegistry();

  /* ---------------- 内部查询 ---------------- */

  function tableExists(name) {
    return !!db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = ? COLLATE NOCASE
    `).get(name);
  }

  function sheetById(id) {
    return db.prepare(`
      SELECT table_id AS id, table_name AS name, created_at AS createdAt
      FROM ${REGISTRY} WHERE table_id = ?
    `).get(id) || null;
  }

  function countRows(id) {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(id)}`).get().n);
  }

  /** 下一个可用 ID：A1、A2…（跳过被手工占用/遗留的表名） */
  function nextTableId() {
    const rows = db.prepare(`SELECT table_id FROM ${REGISTRY}`).all();
    let max = 0;
    for (const row of rows) {
      const m = /^A(\d+)$/.exec(row.table_id);
      if (m) max = Math.max(max, Number(m[1]));
    }

    let seq = max + 1;
    while (tableExists(`A${seq}`)) seq += 1;
    return `A${seq}`;
  }

  function insertEmptyRow(id) {
    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO ${quoteIdent(id)} (${CELL_COLS.join(', ')}, updated_at)
      VALUES (${CELL_COLS.map(() => '?').join(', ')}, ?)
    `).run(...CELL_COLS.map(() => ''), now);

    return {
      row: {
        id: Number(info.lastInsertRowid),
        cells: CELL_COLS.map(() => ''),
        updatedAt: now,
      },
    };
  }

  /* ---------------- 表格 ---------------- */

  /** 总表 + 每张表的行数；数据表被手工删掉时顺手清掉登记 */
  function listSheets() {
    const rows = db.prepare(`
      SELECT table_id AS id, table_name AS name, created_at AS createdAt
      FROM ${REGISTRY} ORDER BY created_at ASC, table_id ASC
    `).all();

    const out = [];
    for (const item of rows) {
      if (!tableExists(item.id)) {
        db.prepare(`DELETE FROM ${REGISTRY} WHERE table_id = ?`).run(item.id);
        continue;
      }
      const rowCount = countRows(item.id);
      out.push({
        id: item.id,
        name: item.name,
        rowCount,
        deletable: rowCount <= 1,
        createdAt: Number(item.createdAt),
      });
    }
    return out;
  }

  /** 新建表格：登记到总表，数据表用 table_id 命名，并写入一行空白 */
  function createSheet(rawName) {
    const parsed = normalizeName(rawName);
    if (parsed.error) return parsed;

    const name = parsed.name;
    const dup = db.prepare(`
      SELECT 1 FROM ${REGISTRY} WHERE table_name = ? COLLATE NOCASE
    `).get(name);
    if (dup) return { code: 409, error: '已存在同名表格' };

    const id = nextTableId();

    db.exec(`
      CREATE TABLE ${quoteIdent(id)} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ${COLUMNS_DDL},
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);

    const createdAt = Date.now();
    db.prepare(`
      INSERT INTO ${REGISTRY} (table_id, table_name, created_at) VALUES (?, ?, ?)
    `).run(id, name, createdAt);

    const inserted = insertEmptyRow(id);
    return {
      sheet: { id, name, rowCount: 1, deletable: true, createdAt },
      row: inserted.row,
    };
  }

  /** 删除整张表：只有空表（行数 <= 1）允许 */
  function deleteSheet(id) {
    const sheet = sheetById(id);
    if (!sheet) return { code: 404, error: '表格不存在' };

    const rowCount = countRows(id);
    if (rowCount > 1) {
      return { code: 403, error: `没有权限删除删除` };
    }

    db.exec(`DROP TABLE ${quoteIdent(id)}`);
    db.prepare(`DELETE FROM ${REGISTRY} WHERE table_id = ?`).run(id);
    return { ok: true, id, name: sheet.name };
  }

  /** 整张表快照 */
  function snapshot(id) {
    const sheet = sheetById(id);
    if (!sheet) return { code: 404, error: '表格不存在' };

    const rows = db.prepare(`
      SELECT id, ${CELL_COLS.join(', ')}, updated_at AS updatedAt
      FROM ${quoteIdent(id)}
      ORDER BY id ASC
    `).all();

    return {
      id,
      name: sheet.name,
      columnCount: COLUMN_COUNT,
      rows: rows.map((row) => ({
        id: Number(row.id),
        cells: cellsOf(row),
        updatedAt: Number(row.updatedAt),
      })),
    };
  }

  /* ---------------- 行 ---------------- */

  function createRow(id) {
    if (!sheetById(id)) return { code: 404, error: '表格不存在' };
    return insertEmptyRow(id);
  }

  /** 保存整行的 7 个单元格（任何行都可编辑，包括第一行） */
  function updateRow(id, rowId, rawCells) {
    if (!sheetById(id)) return { code: 404, error: '表格不存在' };

    const parsed = normalizeCells(rawCells);
    if (parsed.error) return parsed;

    const target = db.prepare(`SELECT id FROM ${quoteIdent(id)} WHERE id = ?`).get(rowId);
    if (!target) return { code: 404, error: '行不存在' };

    const sets = CELL_COLS.map((col) => `${col} = ?`).join(', ');
    const now = Date.now();
    db.prepare(`
      UPDATE ${quoteIdent(id)} SET ${sets}, updated_at = ? WHERE id = ?
    `).run(...parsed.cells, now, rowId);

    return { row: { id: rowId, cells: parsed.cells, updatedAt: now } };
  }

  function deleteRow(id, rowId) {
    if (!sheetById(id)) return { code: 404, error: '表格不存在' };

    const target = db.prepare(`SELECT id FROM ${quoteIdent(id)} WHERE id = ?`).get(rowId);
    if (!target) return { code: 404, error: '行不存在' };

    db.prepare(`DELETE FROM ${quoteIdent(id)} WHERE id = ?`).run(rowId);
    return { ok: true };
  }

  return {
    listSheets,
    createSheet,
    deleteSheet,
    snapshot,
    createRow,
    updateRow,
    deleteRow,
  };
}

module.exports = { createStore, COLUMN_COUNT, CELL_MAX };
