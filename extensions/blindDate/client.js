'use strict';

/* ==================================================================
   相亲 · 左侧共享表格
   - 所有人可编辑；表头（第一行）来自数据库，只读
   - 表头粘在顶部，上下滚动时不动
   - 单元格失焦即保存整行；新增 / 删除行实时同步给所有设备
   - 与五子棋、技术问答面板互斥
   ================================================================== */

(() => {
  const COLUMN_COUNT = 7;

  let core = null;
  let pendingOpen = false;
  let loaded = false;           // 是否已拉取过整表（避免每次展开都重置未保存的输入）
  let headers = [];
  let rows = [];
  const saveTimers = new Map();   // 行 id -> 自动保存定时器
  const saving = new Set();       // 正在保存的行 id
  const pendingSave = new Set();  // 保存期间又改动的行 id

  let paneEl, headEl, bodyEl, emptyEl, countEl, statusEl;
  let addBtn, refreshBtn, collapseBtn;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------------- 初始化 ---------------- */

  async function init(api) {
    core = api;
    try {
      await loadPanel();
    } catch {
      return;
    }
    setup();
  }

  /** 拉取 /blinddate/panel.html：面板插入 .main-pane 最前面（左侧） */
  async function loadPanel() {
    const res = await fetch('/blinddate/panel.html', { cache: 'no-store' });
    if (!res.ok) throw new Error('面板加载失败');

    const tpl = document.createElement('template');
    tpl.innerHTML = (await res.text()).trim();

    const pane = tpl.content.querySelector('#blindDatePane');
    const host = document.querySelector('.main-pane');
    if (pane && host) host.insertBefore(pane, host.firstChild);
  }

  function setup() {
    paneEl = $('blindDatePane');
    if (!paneEl) return;

    headEl = $('bdHead');
    bodyEl = $('bdBody');
    emptyEl = $('bdEmpty');
    countEl = $('bdCount');
    statusEl = $('bdStatus');

    addBtn = $('btnBdAdd');
    refreshBtn = $('btnBdRefresh');
    collapseBtn = $('btnBdCollapse');

    addBtn.addEventListener('click', addRow);
    refreshBtn.addEventListener('click', loadRows);
    collapseBtn.addEventListener('click', collapsePane);

    bodyEl.addEventListener('focusout', onCellBlur);
    bodyEl.addEventListener('input', onCellInput);
    bodyEl.addEventListener('keydown', onCellKeydown);
    bodyEl.addEventListener('click', onBodyClick);

    if (pendingOpen) openPane();
  }

  /* ---------------- 面板展开 / 收起 ---------------- */

  function openPane() {
    if (!paneEl) {
      pendingOpen = true;
      return;
    }
    // 三个面板互斥（另见 app.js 的 switchView）
    if (window.ChatDropGomoku) window.ChatDropGomoku.collapsePane();
    if (window.ChatDropQA) window.ChatDropQA.collapsePane();

    pendingOpen = false;
    paneEl.hidden = false;
    if (core && core.setActiveNav) core.setActiveNav('blinddate');
    // 首次展开才拉取；之后靠 SSE 保持同步，避免覆盖正在编辑的内容
    if (!loaded) loadRows();
  }

  function collapsePane() {
    pendingOpen = false;
    if (paneEl) paneEl.hidden = true;
    if (core && core.setActiveNav) core.setActiveNav('chat');
  }

  /* ---------------- 数据加载 ---------------- */

  async function loadRows() {
    setStatus('加载中…');
    try {
      const res = await fetch('/api/blinddate/rows', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const j = await res.json();
      headers = normalizeHeaders(j.headers);
      rows = Array.isArray(j.rows) ? j.rows : [];
      renderAll();
      loaded = true;
      setStatus('共享表格 · 自动保存');
    } catch {
      setStatus('加载失败，点「刷新」重试');
    }
  }

  function normalizeHeaders(list) {
    const out = Array.isArray(list) ? list.slice(0, COLUMN_COUNT) : [];
    while (out.length < COLUMN_COUNT) out.push('');
    return out.map((h) => String(h == null ? '' : h));
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    if (!paneEl) return;
    applyHeaders();
    renderRows();
  }

  /** 表头：第一行，只读文本 */
  function applyHeaders() {
    headEl.textContent = '';
    for (let i = 0; i < COLUMN_COUNT; i++) {
      headEl.append(el('th', '', headers[i] || `第 ${i + 1} 列`));
    }
    headEl.append(el('th', 'bd-op-head', '操作'));
  }

  function renderRows() {
    bodyEl.textContent = '';
    for (const row of rows) bodyEl.append(buildRow(row));
    syncEmpty();
  }

  function syncEmpty() {
    if (emptyEl) emptyEl.hidden = rows.length !== 0;
    if (countEl) countEl.textContent = rows.length ? `${rows.length} 行` : '';
  }

  function buildRow(row) {
    const tr = el('tr');
    tr.dataset.id = String(row.id);

    for (let i = 0; i < COLUMN_COUNT; i++) {
      const td = el('td');
      const input = el('input', 'bd-cell');
      input.type = 'text';
      input.maxLength = 500;
      input.value = row.cells[i] || '';
      input.setAttribute('aria-label', headers[i] || `第 ${i + 1} 列`);
      td.append(input);
      tr.append(td);
    }

    const tdOp = el('td', 'bd-op');
    const delBtn = el('button', 'bd-del', '删除');
    delBtn.type = 'button';
    delBtn.title = '删除这一行';
    tdOp.append(delBtn);
    tr.append(tdOp);

    return tr;
  }

  /** 只更新输入框文本；正在编辑的输入框不动，避免打断输入 */
  function updateRowDom(tr, cells) {
    const inputs = tr.querySelectorAll('.bd-cell');
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (input === document.activeElement) continue;
      const value = cells[i] || '';
      if (input.value !== value) input.value = value;
    }
  }

  function findRow(id) {
    return rows.find((r) => r.id === id) || null;
  }

  function rowEl(id) {
    return bodyEl.querySelector(`tr[data-id="${id}"]`);
  }

  /* ---------------- 交互 ---------------- */

  /**
   * 保存时机：
   *   1. 停止输入 700ms 后自动保存（不依赖失焦，移动端也可靠）
   *   2. 焦点离开整行时立即保存
   */
  function onCellInput(e) {
    const tr = e.target.closest ? e.target.closest('tr') : null;
    if (!tr || !tr.dataset.id) return;

    const id = Number(tr.dataset.id);
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => {
      saveTimers.delete(id);
      saveRow(id);
    }, 700));
  }

  /** 焦点离开整行时立即保存：同一行内切换单元格 / 删除按钮不触发 */
  function onCellBlur(e) {
    const tr = e.target.closest ? e.target.closest('tr') : null;
    if (!tr || !tr.dataset.id) return;

    // 还停在这一行（Tab 会经过行尾的「删除」按钮）时先不保存
    const next = e.relatedTarget;
    if (next && tr.contains(next)) return;

    const id = Number(tr.dataset.id);
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);

    setTimeout(() => {
      const cur = rowEl(id);
      if (cur && cur.contains(document.activeElement)) return;
      saveRow(id);
    }, 0);
  }

  function onCellKeydown(e) {
    if (e.key !== 'Enter') return;
    if (!e.target.classList || !e.target.classList.contains('bd-cell')) return;
    e.preventDefault();
    e.target.blur();
  }

  function onBodyClick(e) {
    const delBtn = e.target.closest('.bd-del');
    if (!delBtn) return;

    const tr = delBtn.closest('tr');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    const row = findRow(id);
    const filled = row && row.cells.some((c) => c.trim() !== '');
    if (filled && !window.confirm('这一行有内容，确定删除吗？')) return;

    removeRow(id);
  }

  /** 保存整行到服务端 */
  async function saveRow(id) {
    const tr = rowEl(id);
    const row = findRow(id);
    if (!tr || !row) return;

    const cells = [...tr.querySelectorAll('.bd-cell')].map((i) => i.value);
    if (cells.every((c, i) => c === (row.cells[i] || ''))) return;

    // 同一行上一次保存还没返回时，标记待存，完成后自动再存一次
    if (saving.has(id)) {
      pendingSave.add(id);
      return;
    }
    saving.add(id);
    tr.classList.add('bd-saving');
    try {
      const res = await fetch(`/api/blinddate/rows/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cells }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '保存失败');

      row.cells = j.row.cells;
      row.updatedAt = j.row.updatedAt;
      if (j.headers) headers = normalizeHeaders(j.headers);
      setStatus('已保存');
    } catch (err) {
      setStatus(err.message || '保存失败');
    } finally {
      tr.classList.remove('bd-saving');
      saving.delete(id);
      if (pendingSave.delete(id)) saveRow(id);
    }
  }

  async function addRow() {
    if (addBtn.disabled) return;
    addBtn.disabled = true;
    setStatus('新增中…');
    try {
      const res = await fetch('/api/blinddate/rows', { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '新增失败');

      if (j.headers) {
        headers = normalizeHeaders(j.headers);
        applyHeaders();
      }
      upsertRow(j.row);
      setStatus('已新增一行');

      // 聚焦新行第一格，方便直接填写
      const tr = rowEl(j.row.id);
      const first = tr && tr.querySelector('.bd-cell');
      if (first) first.focus();
      if (tr) tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      setStatus(err.message || '新增失败');
    } finally {
      addBtn.disabled = false;
    }
  }

  async function removeRow(id) {
    setStatus('删除中…');
    try {
      const res = await fetch(`/api/blinddate/rows/${id}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '删除失败');

      if (j.headers) headers = normalizeHeaders(j.headers);
      dropRow(id);
      setStatus('已删除一行');
    } catch (err) {
      setStatus(err.message || '删除失败');
    }
  }

  /* ---------------- 增量更新 ---------------- */

  /** 插入或替换一行（按 id 去重） */
  function upsertRow(row) {
    if (!row) return;
    const tr = rowEl(row.id);

    if (tr) {
      updateRowDom(tr, row.cells);
      const hit = findRow(row.id);
      if (hit) {
        hit.cells = row.cells.slice();
        hit.updatedAt = row.updatedAt;
      }
      return;
    }

    rows.push({ id: row.id, cells: row.cells.slice(), updatedAt: row.updatedAt });
    bodyEl.append(buildRow(row));
    syncEmpty();
  }

  function dropRow(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    rows = rows.filter((r) => r.id !== id);
    const tr = rowEl(id);
    if (tr) tr.remove();
    syncEmpty();
  }

  /** SSE：其它设备的新增 / 修改 / 删除 */
  function onServerEvent(payload) {
    if (!payload) return;

    if (payload.headers) {
      const next = normalizeHeaders(payload.headers);
      if (next.join('|') !== headers.join('|')) {
        headers = next;
        applyHeaders();
      }
    }

    if (payload.action === 'created') {
      upsertRow(payload.row);
      return;
    }

    if (payload.action === 'updated') {
      const row = payload.row;
      if (!row) return;

      // 本设备正在这一行输入 / 有未发出的改动：保留本地内容
      const tr = rowEl(row.id);
      if (tr && tr.contains(document.activeElement)) return;
      if (saveTimers.has(row.id)) return;

      upsertRow(row);
      return;
    }

    if (payload.action === 'deleted') {
      dropRow(Number(payload.id));
    }
  }

  /* ---------------- 工具 ---------------- */

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function bindCore(api) {
    if (!api || typeof api.on !== 'function') return;
    api.on('blinddate', onServerEvent);
  }

  window.ChatDropBlindDate = {
    init: (api) => {
      bindCore(api);
      return init(api);
    },
    openPane,
    collapsePane,
  };
})();
