'use strict';

/* ==================================================================
   共享表格 · 左侧面板
   - 总表 shared_sheets 登记所有表格：table_id（A1、A2…）+ table_name
   - 新建时只需输入表名，数据库里的真实表名是 table_id
   - 每张表固定 7 列，第一行按惯例当表头，但所有格子都能改
   - 停止输入 700ms 自动保存，离开整行也会立即保存
   - 只有空表（行数 <= 1）才允许删除整张表
   - 与五子棋、技术问答面板互斥
   ================================================================== */

(() => {
  const COLUMN_COUNT = 7;

  let core = null;
  let pendingOpen = false;
  let loaded = false;          // 是否已拉取过总表
  let sheets = [];             // [{ id, name, rowCount, deletable }]
  let currentId = '';          // 当前表格的 table_id
  let currentName = '';        // 当前表格的显示名
  let rows = [];

  const saveTimers = new Map();  // 行 id -> 自动保存定时器
  const saving = new Set();      // 正在保存的行 id
  const pendingSave = new Set(); // 保存期间又改动的行 id

  let paneEl, tabsEl, bodyEl, emptyEl, countEl, statusEl;
  let newSheetBtn, delSheetBtn, addRowBtn, refreshBtn, collapseBtn;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sheetOf(id) {
    return sheets.find((s) => s.id === id) || null;
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

  /** 拉取 /sharedsheet/panel.html：面板插入 .main-pane 最前面（左侧） */
  async function loadPanel() {
    const res = await fetch('/sharedsheet/panel.html', { cache: 'no-store' });
    if (!res.ok) throw new Error('面板加载失败');

    const tpl = document.createElement('template');
    tpl.innerHTML = (await res.text()).trim();

    const pane = tpl.content.querySelector('#sharedSheetPane');
    const host = document.querySelector('.main-pane');
    if (pane && host) host.insertBefore(pane, host.firstChild);
  }

  function setup() {
    paneEl = $('sharedSheetPane');
    if (!paneEl) return;

    tabsEl = $('ssTabs');
    bodyEl = $('ssBody');
    emptyEl = $('ssEmpty');
    countEl = $('ssCount');
    statusEl = $('ssStatus');

    newSheetBtn = $('btnSsNewSheet');
    delSheetBtn = $('btnSsDelSheet');
    addRowBtn = $('btnSsAddRow');
    refreshBtn = $('btnSsRefresh');
    collapseBtn = $('btnSsCollapse');

    newSheetBtn.addEventListener('click', createSheet);
    delSheetBtn.addEventListener('click', removeSheet);
    addRowBtn.addEventListener('click', addRow);
    refreshBtn.addEventListener('click', loadAll);
    collapseBtn.addEventListener('click', collapsePane);

    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('.ss-tab') : null;
      if (btn && btn.dataset.id) switchSheet(btn.dataset.id);
    });

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
    if (core && core.setActiveNav) core.setActiveNav('sharedsheet');
    // 首次展开才拉取；之后靠 SSE 保持同步，避免覆盖正在编辑的内容
    if (!loaded) loadAll();
  }

  function collapsePane() {
    pendingOpen = false;
    if (paneEl) paneEl.hidden = true;
    if (core && core.setActiveNav) core.setActiveNav('chat');
  }

  /* ---------------- 总表 ---------------- */

  async function loadAll() {
    if (!paneEl) return;
    setStatus('加载中…');
    try {
      const res = await fetch('/api/sharedsheet/sheets', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const j = await res.json();

      sheets = Array.isArray(j.sheets) ? j.sheets : [];
      if (!sheetOf(currentId)) {
        const first = sheets[0];
        currentId = first ? first.id : '';
        currentName = first ? first.name : '';
      }
      loaded = true;
      renderTabs();

      if (currentId) {
        await loadRows(currentId);
      } else {
        rows = [];
        renderRows();
        setStatus('还没有表格，点「＋ 新建表格」创建');
      }
    } catch {
      setStatus('加载失败，点「刷新」重试');
    }
  }

  /** 顶部横向页签：显示 table_name，点击切换 */
  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.textContent = '';

    if (!sheets.length) {
      tabsEl.append(el('span', 'ss-tabs-empty', '还没有表格，点「＋ 新建表格」创建'));
      if (addRowBtn) addRowBtn.disabled = true;
      if (delSheetBtn) delSheetBtn.disabled = true;
      return;
    }

    if (addRowBtn) addRowBtn.disabled = false;
    if (delSheetBtn) delSheetBtn.disabled = false;

    for (const sheet of sheets) {
      const btn = el('button', 'ss-tab', sheet.name);
      btn.type = 'button';
      btn.dataset.id = sheet.id;
      btn.title = `${sheet.name}（${sheet.id}）`;
      if (sheet.id === currentId) btn.classList.add('active');
      tabsEl.append(btn);
    }

    // 页签太多时，把当前页签滚进可视区
    const active = tabsEl.querySelector('.ss-tab.active');
    if (active) {
      const left = active.offsetLeft;
      const right = left + active.offsetWidth;
      if (left < tabsEl.scrollLeft) tabsEl.scrollLeft = left - 8;
      else if (right > tabsEl.scrollLeft + tabsEl.clientWidth) {
        tabsEl.scrollLeft = right - tabsEl.clientWidth + 8;
      }
    }
  }

  /** 切换表格：先把当前表还没发出的改动存掉，再读新表 */
  function switchSheet(id) {
    if (!id || id === currentId) return;
    flushSaves();
    currentId = id;
    currentName = (sheetOf(id) || {}).name || '';
    loadRows(id);
    document.querySelectorAll('.ss-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.id === currentId);
    });
  }

  /* ---------------- 行数据 ---------------- */

  async function loadRows(id) {
    if (!id) {
      rows = [];
      renderRows();
      return;
    }
    setStatus('加载中…');
    try {
      const res = await fetch(`/api/sharedsheet/sheets/${encodeURIComponent(id)}/rows`, {
        cache: 'no-store',
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '加载失败');

      currentId = id;
      currentName = j.name || (sheetOf(id) || {}).name || '';
      rows = Array.isArray(j.rows) ? j.rows : [];
      renderRows();
      setStatus('共享表格 · 自动保存');
    } catch (err) {
      setStatus(err.message || '加载失败');
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderRows() {
    if (!bodyEl) return;
    bodyEl.textContent = '';
    for (const row of rows) bodyEl.append(buildRow(row));
    syncState();
  }

  function syncState() {
    const hasSheet = !!currentId;

    if (emptyEl) {
      if (!hasSheet) {
        emptyEl.hidden = false;
        emptyEl.textContent = '还没有表格，点「＋ 新建表格」输入表名创建一个';
      } else if (!rows.length) {
        emptyEl.hidden = false;
        emptyEl.textContent = '这张表还是空的，点「＋ 新增一行」开始填写';
      } else {
        emptyEl.hidden = true;
      }
    }

    if (countEl) countEl.textContent = hasSheet ? `${rows.length} 行` : '';
  }

  function buildRow(row) {
    const tr = el('tr');
    tr.dataset.id = String(row.id);
    tr.dataset.sheet = currentId;

    for (let i = 0; i < COLUMN_COUNT; i++) {
      const td = el('td');
      const input = el('input', 'ss-cell');
      input.type = 'text';
      input.maxLength = 500;
      input.value = row.cells[i] || '';
      input.setAttribute('aria-label', `第 ${i + 1} 列`);
      td.append(input);
      tr.append(td);
    }

    const tdOp = el('td', 'ss-op');
    const delBtn = el('button', 'ss-del', '删除');
    delBtn.type = 'button';
    delBtn.title = '删除这一行';
    tdOp.append(delBtn);
    tr.append(tdOp);

    return tr;
  }

  /** 只更新输入框文本；正在编辑的输入框不动，避免打断输入 */
  function updateRowDom(tr, cells) {
    const inputs = tr.querySelectorAll('.ss-cell');
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

  /* ---------------- 保存 ---------------- */

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
    if (!e.target.classList || !e.target.classList.contains('ss-cell')) return;
    e.preventDefault();
    e.target.blur();
  }

  /** 把还没发出去的改动立即保存（切换表格 / 收起前用） */
  function flushSaves() {
    for (const [id, timer] of saveTimers) {
      clearTimeout(timer);
      saveRow(id);
    }
    saveTimers.clear();
  }

  /** 保存整行到服务端 */
  async function saveRow(id) {
    const tr = rowEl(id);
    const row = findRow(id);
    if (!tr || !row) return;

    const tableId = tr.dataset.sheet || currentId;
    const cells = [...tr.querySelectorAll('.ss-cell')].map((i) => i.value);
    if (cells.every((c, i) => c === (row.cells[i] || ''))) return;

    // 同一行上一次保存还没返回时，标记待存，完成后自动再存一次
    if (saving.has(id)) {
      pendingSave.add(id);
      return;
    }
    saving.add(id);
    tr.classList.add('ss-saving');
    try {
      const res = await fetch(`/api/sharedsheet/sheets/${encodeURIComponent(tableId)}/rows/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cells }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '保存失败');

      row.cells = j.row.cells;
      row.updatedAt = j.row.updatedAt;
      setStatus('已保存');
    } catch (err) {
      setStatus(err.message || '保存失败');
    } finally {
      tr.classList.remove('ss-saving');
      saving.delete(id);
      if (pendingSave.delete(id)) saveRow(id);
    }
  }

  /* ---------------- 表格 / 行的增删 ---------------- */

  async function createSheet() {
    const input = window.prompt('请输入表格名称（数据库里会另用 A1、A2… 作为表名）');
    if (input == null) return;

    const name = input.trim();
    if (!name) {
      setStatus('表格名称不能为空');
      return;
    }

    setStatus('创建中…');
    try {
      const res = await fetch('/api/sharedsheet/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '创建失败');

      sheets = Array.isArray(j.sheets) ? j.sheets : sheets;
      currentId = j.sheet.id;
      currentName = j.sheet.name;
      renderTabs();

      rows = j.row ? [j.row] : [];
      renderRows();
      setStatus(`已创建「${currentName}」（${currentId}）`);

      const tr = j.row && rowEl(j.row.id);
      const first = tr && tr.querySelector('.ss-cell');
      if (first) first.focus();
    } catch (err) {
      setStatus(err.message || '创建失败');
    }
  }

  async function removeSheet() {
    if (!currentId) return;

    // 行数包含第一行（表头），所以 > 1 就不能删
    if (rows.length > 1) {
      setStatus(`没有权限删除删除`);
      return;
    }
    if (!window.confirm(`确定删除表格「${currentName}」吗？`)) return;

    setStatus('删除中…');
    try {
      const res = await fetch(`/api/sharedsheet/sheets/${encodeURIComponent(currentId)}`, {
        method: 'DELETE',
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '删除失败');

      sheets = Array.isArray(j.sheets) ? j.sheets : sheets.filter((s) => s.id !== currentId);
      const first = sheets[0];
      currentId = first ? first.id : '';
      currentName = first ? first.name : '';
      renderTabs();

      if (currentId) await loadRows(currentId);
      else {
        rows = [];
        renderRows();
      }
      setStatus('已删除表格');
    } catch (err) {
      setStatus(err.message || '删除失败');
    }
  }

  async function addRow() {
    if (!currentId || addRowBtn.disabled) return;
    addRowBtn.disabled = true;
    setStatus('新增中…');
    try {
      const res = await fetch(`/api/sharedsheet/sheets/${encodeURIComponent(currentId)}/rows`, {
        method: 'POST',
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '新增失败');

      upsertRow(j.row);
      setStatus('已新增一行');

      // 聚焦新行第一格，方便直接填写
      const tr = rowEl(j.row.id);
      const first = tr && tr.querySelector('.ss-cell');
      if (first) first.focus();
      if (tr) tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
      setStatus(err.message || '新增失败');
    } finally {
      addRowBtn.disabled = false;
    }
  }

  function onBodyClick(e) {
    const delBtn = e.target.closest('.ss-del');
    if (!delBtn) return;

    const tr = delBtn.closest('tr');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    const row = findRow(id);
    const filled = row && row.cells.some((c) => c.trim() !== '');
    if (filled && !window.confirm('这一行有内容，确定删除吗？')) return;

    removeRow(id);
  }

  async function removeRow(id) {
    if (!currentId) return;
    setStatus('删除中…');
    try {
      const res = await fetch(
        `/api/sharedsheet/sheets/${encodeURIComponent(currentId)}/rows/${id}`,
        { method: 'DELETE' },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '删除失败');

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
    syncState();
  }

  function dropRow(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    rows = rows.filter((r) => r.id !== id);
    const tr = rowEl(id);
    if (tr) tr.remove();
    syncState();
  }

  /** SSE：其它设备的表格 / 行变化 */
  function onServerEvent(payload) {
    if (!payload || !paneEl) return;

    if (Array.isArray(payload.sheets)) {
      sheets = payload.sheets;

      if (!sheetOf(currentId)) {
        flushSaves();
        const first = sheets[0];
        currentId = first ? first.id : '';
        currentName = first ? first.name : '';
        rows = [];
        renderTabs();

        if (currentId) loadRows(currentId);
        else {
          renderRows();
          setStatus('表格已被删除');
        }
        return; // 总表变了，本次不再处理行事件
      }

      renderTabs();
    }

    if (payload.tableId && payload.tableId !== currentId) return;

    if (payload.action === 'row-created') {
      upsertRow(payload.row);
      return;
    }

    if (payload.action === 'row-updated') {
      const row = payload.row;
      if (!row) return;

      // 本设备正在这一行输入 / 有未发出的改动：保留本地内容
      const tr = rowEl(row.id);
      if (tr && tr.contains(document.activeElement)) return;
      if (saveTimers.has(row.id)) return;

      upsertRow(row);
      return;
    }

    if (payload.action === 'row-deleted') {
      dropRow(Number(payload.rowId));
    }
  }

  /* ---------------- 工具 ---------------- */

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function bindCore(api) {
    if (!api || typeof api.on !== 'function') return;
    api.on('sharedsheet', onServerEvent);
  }

  window.ChatDropSharedSheet = {
    init: (api) => {
      bindCore(api);
      return init(api);
    },
    openPane,
    collapsePane,
  };
})();
