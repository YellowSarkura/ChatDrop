'use strict';

/**
 * 相亲 —— SQLite 存储
 *
 * 表头与数据放在同一张表 blind_date 里：
 *   - sort_no = 0 的那一行就是表头，c1..c7 存表头文字；
 *   - 其余行是数据，c1..c7 存单元格内容。
 * 读取时按 sort_no 排序，第一行即表头。
 *
 * 初次建库时写入默认表头；之后如果要改表头，
 * 直接在数据库里 UPDATE 第一行即可，服务重启后生效。
 *
 * 默认表头：出生年份，身高，体重，户籍，理想型，联系方式，备注
 */

const { DatabaseSync } = require('node:sqlite');

const COLUMN_COUNT = 7;
const CELL_MAX = 500;
const CELL_COLS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const DEFAULT_HEADERS = ['出生年份', '身高', '体重', '户籍', '理想型', '联系方式', '备注'];

/** 取出一行的 7 个单元格 */
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

function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);

  const columnsDDL = CELL_COLS
    .map((col) => `      ${col} TEXT NOT NULL DEFAULT ''`)
    .join(',\n');

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS blind_date (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_no    INTEGER NOT NULL DEFAULT 0,
  ${columnsDDL},
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_blind_date_sort
      ON blind_date(sort_no, id);
  `);

  // 只在没有表头行时写入默认表头，之后完全以数据库内容为准
  const hasHeader = db.prepare(
    'SELECT 1 FROM blind_date WHERE sort_no = 0 LIMIT 1'
  ).get();

  if (!hasHeader) {
    const marks = CELL_COLS.map(() => '?').join(', ');
    db.prepare(`
      INSERT INTO blind_date (sort_no, ${CELL_COLS.join(', ')}, updated_at)
      VALUES (0, ${marks}, ?)
    `).run(...DEFAULT_HEADERS, Date.now());
  }

  /* ---------------- 读取 ---------------- */

  /** 表头文字（数据库第一行），缺失时回退默认值 */
  function getHeaders() {
    const row = db.prepare(`
      SELECT ${CELL_COLS.join(', ')} FROM blind_date
      WHERE sort_no = 0 ORDER BY id LIMIT 1
    `).get();
    return row ? cellsOf(row) : DEFAULT_HEADERS.slice();
  }

  /** 数据行（不含表头行），按 sort_no、id 排序 */
  function listRows() {
    const rows = db.prepare(`
      SELECT id, ${CELL_COLS.join(', ')}, updated_at AS updatedAt
      FROM blind_date
      WHERE sort_no <> 0
      ORDER BY sort_no ASC, id ASC
    `).all();

    return rows.map((row) => ({
      id: Number(row.id),
      cells: cellsOf(row),
      updatedAt: Number(row.updatedAt),
    }));
  }

  /** 完整表格快照：表头 + 数据行 */
  function snapshot() {
    return {
      headers: getHeaders(),
      rows: listRows(),
      columnCount: COLUMN_COUNT,
    };
  }

  /* ---------------- 写入 ---------------- */

  /** 新增一行空数据，排到最后 */
  function createRow() {
    const sortNo = Number(
      db.prepare('SELECT COALESCE(MAX(sort_no), 0) + 1 AS n FROM blind_date').get().n
    );
    const marks = CELL_COLS.map(() => '?').join(', ');
    const now = Date.now();

    const info = db.prepare(`
      INSERT INTO blind_date (sort_no, ${CELL_COLS.join(', ')}, updated_at)
      VALUES (?, ${marks}, ?)
    `).run(sortNo, ...CELL_COLS.map(() => ''), now);

    return {
      row: {
        id: Number(info.lastInsertRowid),
        cells: CELL_COLS.map(() => ''),
        updatedAt: now,
      },
    };
  }

  /** 保存整行的 7 个单元格；表头行禁止修改 */
  function updateRow(id, rawCells) {
    const target = db.prepare(
      'SELECT id, sort_no FROM blind_date WHERE id = ?'
    ).get(id);
    if (!target) return { code: 404, error: '行不存在' };
    if (Number(target.sort_no) === 0) return { code: 403, error: '表头行不可编辑' };

    const parsed = normalizeCells(rawCells);
    if (parsed.error) return parsed;

    const sets = CELL_COLS.map((col) => `${col} = ?`).join(', ');
    const now = Date.now();
    db.prepare(`
      UPDATE blind_date SET ${sets}, updated_at = ? WHERE id = ?
    `).run(...parsed.cells, now, id);

    return { row: { id, cells: parsed.cells, updatedAt: now } };
  }

  /** 删除一行；表头行禁止删除 */
  function deleteRow(id) {
    const target = db.prepare(
      'SELECT id, sort_no FROM blind_date WHERE id = ?'
    ).get(id);
    if (!target) return { code: 404, error: '行不存在' };
    if (Number(target.sort_no) === 0) return { code: 403, error: '表头行不可删除' };

    db.prepare('DELETE FROM blind_date WHERE id = ?').run(id);
    return { ok: true };
  }

  return {
    getHeaders,
    snapshot,
    createRow,
    updateRow,
    deleteRow,
  };
}

module.exports = { createStore, COLUMN_COUNT, CELL_MAX, DEFAULT_HEADERS };
