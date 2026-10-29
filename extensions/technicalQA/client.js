'use strict';

/* ==================================================================
   技术问答
   - 左侧面板，聊天常驻右侧，与五子棋面板互斥
   - 任何人都可以提问 / 回答，不记录发布者
   - 回答在问题下方分页展示，每页最多 10 条
   - 回答按「赞 + 踩」总数排序；点赞 / 点踩只累计数量
   ================================================================== */

(() => {
  const PAGE_SIZE = 10;

  let core = null;
  let pendingOpen = false;
  let questions = [];
  let expandedId = null;
  let answerCache = new Map();   // questionId -> { page, total, totalPages, items, loading }
  let drafts = new Map();        // questionId -> 未提交的回答草稿
  let busy = false;

  let paneEl, listEl, emptyEl, totalEl, statusEl;
  let questionInput, askBtn, refreshBtn, collapseBtn;

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

  /** 拉取 /qa/panel.html：面板插入 .main-pane 最前面（左侧） */
  async function loadPanel() {
    const res = await fetch('/qa/panel.html', { cache: 'no-store' });
    if (!res.ok) throw new Error('面板加载失败');

    const tpl = document.createElement('template');
    tpl.innerHTML = (await res.text()).trim();

    const pane = tpl.content.querySelector('#qaPane');
    const host = document.querySelector('.main-pane');
    if (pane && host) host.insertBefore(pane, host.firstChild);
  }

  function setup() {
    paneEl = $('qaPane');
    if (!paneEl) return;

    listEl = $('qaQuestions');
    emptyEl = $('qaEmpty');
    totalEl = $('qaTotal');
    statusEl = $('qaStatus');
    questionInput = $('qaQuestionInput');
    askBtn = $('btnQaAsk');
    refreshBtn = $('btnQaRefresh');
    collapseBtn = $('btnQaCollapse');

    askBtn.addEventListener('click', submitQuestion);
    refreshBtn.addEventListener('click', refreshAll);
    collapseBtn.addEventListener('click', collapsePane);

    questionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitQuestion();
    });

    listEl.addEventListener('click', onListClick);

    if (pendingOpen) openPane();
  }

  /* ---------------- 面板展开 / 收起 ---------------- */

  function openPane() {
    if (!paneEl) {
      pendingOpen = true;
      return;
    }
    // 与五子棋 / 共享表格面板互斥（另见 app.js 的 switchView）
    if (window.ChatDropGomoku) window.ChatDropGomoku.collapsePane();
    if (window.ChatDropSharedSheet) window.ChatDropSharedSheet.collapsePane();

    pendingOpen = false;
    paneEl.hidden = false;
    if (core && core.setActiveNav) core.setActiveNav('qa');
    loadQuestions();
  }

  function collapsePane() {
    pendingOpen = false;
    if (paneEl) paneEl.hidden = true;
    if (core && core.setActiveNav) core.setActiveNav('chat');
  }

  /* ---------------- 数据加载 ---------------- */

  async function loadQuestions() {
    setStatus('加载中…');
    try {
      const res = await fetch('/api/qa/questions', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const j = await res.json();
      questions = Array.isArray(j.questions) ? j.questions : [];
      if (expandedId && !questions.some((q) => q.id === expandedId)) expandedId = null;
      renderQuestions();
      setStatus(`共 ${questions.length} 个问题 · 每个回答列表每页 ${PAGE_SIZE} 条`);
    } catch {
      setStatus('加载失败，点「刷新」重试');
    }
  }

  async function loadAnswers(questionId, page) {
    const prev = answerCache.get(questionId) || {};
    answerCache.set(questionId, { ...prev, loading: true });
    renderQuestions();

    try {
      const res = await fetch(`/api/qa/questions/${questionId}/answers?page=${page}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error();
      const j = await res.json();
      answerCache.set(questionId, {
        loading: false,
        page: j.page,
        total: j.total,
        totalPages: j.totalPages,
        items: Array.isArray(j.answers) ? j.answers : [],
      });
    } catch {
      answerCache.set(questionId, { loading: false, page: 1, total: 0, totalPages: 1, items: [] });
      setStatus('回答加载失败');
    }
    renderQuestions();
  }

  /** 刷新按钮：清空回答缓存，重新拉取问题与当前展开的回答 */
  function refreshAll() {
    answerCache.clear();
    loadQuestions();
  }

  /* ---------------- 渲染 ---------------- */

  function saveDrafts() {
    listEl.querySelectorAll('.qa-card').forEach((card) => {
      const ta = card.querySelector('.qa-answer-input');
      if (!ta) return;
      const id = Number(card.dataset.qid);
      if (ta.value.trim()) drafts.set(id, ta.value);
      else drafts.delete(id);
    });
  }

  function renderQuestions() {
    saveDrafts();
    listEl.textContent = '';
    emptyEl.hidden = questions.length !== 0;
    totalEl.textContent = questions.length ? `${questions.length} 个问题` : '';

    for (const q of questions) listEl.append(buildCard(q));
  }

  function buildCard(q) {
    const open = expandedId === q.id;

    const card = el('article', `qa-card${open ? ' open' : ''}`);
    card.dataset.qid = String(q.id);

    const head = el('button', 'qa-q-head');
    head.type = 'button';
    head.append(
      el('span', 'qa-q-text', q.content),
      el('span', 'qa-q-meta', `${fmtTime(q.createdAt)} · ${q.answerCount} 条回答`)
    );
    card.append(head);

    const body = el('div', 'qa-q-body');
    body.hidden = !open;
    card.append(body);

    if (open) {
      if (!answerCache.has(q.id)) {
        answerCache.set(q.id, { loading: true, page: 1, total: 0, totalPages: 1, items: [] });
        loadAnswers(q.id, 1);   // 完成后会重新渲染
      }
      fillBody(body, q.id);
    }

    return card;
  }

  function fillBody(body, questionId) {
    const state = answerCache.get(questionId);

    /* 回答输入区 */
    const input = el('textarea', 'qa-answer-input');
    input.maxLength = 2000;
    input.placeholder = '写下你的回答…';
    input.value = drafts.get(questionId) || '';

    const submit = el('button', 'btn-primary qa-answer-submit', '发布回答');
    submit.type = 'button';
    submit.dataset.qid = String(questionId);

    const formFoot = el('div', 'qa-answer-foot');
    formFoot.append(el('span', 'qa-hint', '回答按赞 + 踩总数排序'), submit);

    const form = el('div', 'qa-answer-form');
    form.append(input, formFoot);
    body.append(form);

    /* 回答列表 */
    if (!state || state.loading) {
      body.append(el('div', 'qa-loading', '正在加载回答…'));
      return;
    }

    const list = el('div', 'qa-answer-list');
    if (!state.items.length) {
      list.append(el('div', 'qa-empty-mini', '还没有回答，来写第一条吧'));
    }
    for (const a of state.items) list.append(buildAnswer(a));
    body.append(list, buildPager(questionId, state));
  }

  function buildAnswer(a) {
    const item = el('div', 'qa-answer');
    item.append(el('div', 'qa-answer-text', a.content));

    const meta = el('div', 'qa-answer-meta');
    meta.append(el('span', 'qa-time', fmtTime(a.createdAt)));

    const like = el('button', 'qa-vote', '👍 ');
    like.type = 'button';
    like.dataset.vote = 'like';
    like.dataset.aid = String(a.id);
    like.title = '点赞';
    like.append(el('b', '', String(a.likes)));

    const dislike = el('button', 'qa-vote', '👎 ');
    dislike.type = 'button';
    dislike.dataset.vote = 'dislike';
    dislike.dataset.aid = String(a.id);
    dislike.title = '点踩';
    dislike.append(el('b', '', String(a.dislikes)));

    meta.append(like, dislike);
    item.append(meta);
    return item;
  }

  function buildPager(questionId, state) {
    const pager = el('div', 'qa-pager');

    const prev = el('button', 'qa-page-btn', '上一页');
    prev.type = 'button';
    prev.dataset.qid = String(questionId);
    prev.dataset.page = String(state.page - 1);
    prev.disabled = state.page <= 1;

    const next = el('button', 'qa-page-btn', '下一页');
    next.type = 'button';
    next.dataset.qid = String(questionId);
    next.dataset.page = String(state.page + 1);
    next.disabled = state.page >= state.totalPages;

    pager.append(prev, el('span', 'qa-page-info',
      `第 ${state.page} / ${state.totalPages} 页 · 共 ${state.total} 条回答`), next);
    return pager;
  }

  /* ---------------- 交互 ---------------- */

  function onListClick(e) {
    const head = e.target.closest('.qa-q-head');
    if (head) {
      const card = head.closest('.qa-card');
      toggleQuestion(Number(card.dataset.qid));
      return;
    }

    const voteBtn = e.target.closest('.qa-vote');
    if (voteBtn) {
      vote(voteBtn.dataset.aid, voteBtn.dataset.vote);
      return;
    }

    const pageBtn = e.target.closest('.qa-page-btn');
    if (pageBtn && !pageBtn.disabled) {
      loadAnswers(Number(pageBtn.dataset.qid), Number(pageBtn.dataset.page));
      return;
    }

    const submit = e.target.closest('.qa-answer-submit');
    if (submit) submitAnswer(Number(submit.dataset.qid));
  }

  function toggleQuestion(id) {
    expandedId = expandedId === id ? null : id;
    renderQuestions();
  }

  async function submitQuestion() {
    const text = questionInput.value.trim();
    if (!text) {
      setStatus('请先填写问题内容');
      return;
    }
    if (busy) return;

    busy = true;
    askBtn.disabled = true;
    try {
      const res = await fetch('/api/qa/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '发布失败');

      questionInput.value = '';
      if (j.question) expandedId = j.question.id;
      await loadQuestions();
      setStatus('问题已发布');
    } catch (err) {
      setStatus(err.message || '发布失败');
    } finally {
      busy = false;
      askBtn.disabled = false;
    }
  }

  async function submitAnswer(questionId) {
    const card = listEl.querySelector(`.qa-card[data-qid="${questionId}"]`);
    const input = card && card.querySelector('.qa-answer-input');
    const text = input ? input.value.trim() : '';
    if (!text) {
      setStatus('请先填写回答内容');
      return;
    }
    if (busy) return;

    busy = true;
    try {
      const res = await fetch(`/api/qa/questions/${questionId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '发布失败');

      drafts.delete(questionId);
      // 新回答赞踩为 0，按热度会排在最后：直接跳到最后一页
      await loadAnswers(questionId, 999999);
      await loadQuestions();
      setStatus('回答已发布');
    } catch (err) {
      setStatus(err.message || '发布失败');
    } finally {
      busy = false;
    }
  }

  async function vote(answerId, voteType) {
    try {
      const res = await fetch(`/api/qa/answers/${answerId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote: voteType }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || '操作失败');

      // 热度变化会改变排序，重新加载当前展开问题的当前页
      if (expandedId) {
        const page = (answerCache.get(expandedId) || {}).page || 1;
        await loadAnswers(expandedId, page);
      }
    } catch (err) {
      setStatus(err.message || '操作失败');
    }
  }

  /* ---------------- 工具 ---------------- */

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function fmtTime(ts) {
    const d = new Date(Number(ts) || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
           `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  window.ChatDropQA = { init, openPane, collapsePane };
})();
