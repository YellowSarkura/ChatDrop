'use strict';

/* ==================================================================
   五子棋
   - 1v1 / 1v多 / 多v多（19 路棋盘）
   - 同一时间只允许一场对局
   - 1v1 无保护期；1v多 / 多v多 每次落子后 3 秒保护期（服务端计时，前端倒计时展示）
   - 多v多有 30 秒准备期，玩家自行选择黑/白阵营加入，只能操作自己一方
   - 悔棋：1v1 需对手同意；多人模式需对方半数以上成员同意
   - 棋盘透明度可在界面调节
   - 聊天常驻右侧，游戏面板在左侧，可观战、可收起

   坐标约定（全文件统一）：
     x 轴 → 列 c，y 轴 → 行 r；
     服务端棋盘是行优先一维数组：index = r * 19 + c
   ================================================================== */

(() => {
  const BOARD_N = 19;
  const MODE_LABEL = { '1v1': '1v1', '1vN': '1v多', 'NvN': '多v多' };

  let core = null;
  let game = null;
  let mode = '1v1';
  let picked = new Set();
  let showLobby = true;
  let busy = false;
  let active = false;
  let paneCollapsed = true;
  let lastGameId = null;
  let serverOffset = 0;   // 服务端与本地时钟的偏差
  let hover = null;

  let canvas = null;
  let ctx = null;
  let cssSize = 0;
  let pad = 0;
  let gap = 0;

  let lobbyEl, gameEl, statusEl, badgeEl, modePicker;
  let opponentWrap, opponentList, opponentHint, startBtn;
  let playersEl, turnEl, cooldownEl, boardWrap;
  let resultEl, resultTitle, resultSub, newBtn, endBtn;
  let boardSurface, opacityRange, opacityValue;
  let paneEl, collapseBtn, floatBtn, floatText;
  let prepEl, prepClockEl, prepStartBtn, prepHintEl;
  let joinBtns, prepCountEls, prepListEls, prepCheckEls;
  let undoBtn, undoPanel, undoTextEl, undoAgreeBtn, undoRejectBtn, undoCancelBtn;

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

  function init(api) {
    core = api;

    lobbyEl = $('gomokuLobby');
    gameEl = $('gomokuGame');
    statusEl = $('gomokuStatus');
    badgeEl = $('gomokuModeBadge');
    modePicker = $('gomokuModePicker');
    opponentWrap = $('gomokuOpponentWrap');
    opponentList = $('gomokuOpponents');
    opponentHint = $('gomokuOpponentHint');
    startBtn = $('btnGomokuStart');
    playersEl = $('gomokuPlayers');
    turnEl = $('gomokuTurn');
    cooldownEl = $('gomokuCooldown');
    boardWrap = document.querySelector('.board-wrap');
    resultEl = $('gomokuResult');
    resultTitle = $('gomokuResultTitle');
    resultSub = $('gomokuResultSub');
    newBtn = $('btnGomokuNew');
    endBtn = $('btnGomokuEnd');
    canvas = $('gomokuBoard');
    boardSurface = document.querySelector('.board-surface');
    opacityRange = $('gomokuOpacity');
    opacityValue = $('gomokuOpacityValue');

    paneEl = $('gamePane');
    collapseBtn = $('btnGameCollapse');
    floatBtn = $('gomokuFloat');
    floatText = $('gomokuFloatText');
    prepEl = $('gomokuPrep');
    prepClockEl = $('gomokuPrepClock');
    prepStartBtn = $('btnGomokuPrepStart');
    prepHintEl = $('gomokuPrepHint');
    joinBtns = [$('btnJoinBlack'), $('btnJoinWhite')].filter(Boolean);
    prepCountEls = { black: $('prepBlackCount'), white: $('prepWhiteCount') };
    prepListEls = { black: $('prepBlackList'), white: $('prepWhiteList') };
    prepCheckEls = { black: $('prepBlackCheck'), white: $('prepWhiteCheck') };
    undoBtn = $('btnGomokuUndo');
    undoPanel = $('gomokuUndoPanel');
    undoTextEl = $('gomokuUndoText');
    undoAgreeBtn = $('btnUndoAgree');
    undoRejectBtn = $('btnUndoReject');
    undoCancelBtn = $('btnUndoCancel');

    if (!canvas) return;
    ctx = canvas.getContext('2d');

    if (opacityRange) {
      opacityRange.addEventListener('input', applyBoardOpacity);
      applyBoardOpacity();
    }

    modePicker.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    startBtn.addEventListener('click', createGame);
    endBtn.addEventListener('click', endGame);
    newBtn.addEventListener('click', () => {
      showLobby = true;
      hover = null;
      syncUI();
      renderOpponents();
    });

    if (collapseBtn) collapseBtn.addEventListener('click', collapsePane);
    if (floatBtn) floatBtn.addEventListener('click', openPane);
    joinBtns.forEach((btn) => {
      btn.addEventListener('click', () => joinSide(btn.dataset.side));
    });
    if (prepStartBtn) prepStartBtn.addEventListener('click', startNvN);
    if (undoBtn) undoBtn.addEventListener('click', requestUndo);
    if (undoAgreeBtn) undoAgreeBtn.addEventListener('click', () => answerUndo(true));
    if (undoRejectBtn) undoRejectBtn.addEventListener('click', () => answerUndo(false));
    if (undoCancelBtn) undoCancelBtn.addEventListener('click', cancelUndo);

    canvas.addEventListener('click', onBoardClick);
    canvas.addEventListener('mousemove', onBoardMove);
    canvas.addEventListener('mouseleave', () => {
      if (!hover) return;
      hover = null;
      draw();
    });

    window.addEventListener('resize', () => {
      if (active) requestAnimationFrame(resize);
    });

    // 棋盘从隐藏（发起对局前 / 面板收起）变为可见时，同步画布尺寸
    if (window.ResizeObserver && boardWrap) {
      new ResizeObserver(() => {
        if (!active) return;
        requestAnimationFrame(resize);
      }).observe(boardWrap);
    }

    core.on('gomoku', (g) => setGame(g));
    core.on('presence', () => {
      if (!game || game.status === 'waiting' || showLobby) renderOpponents();
    });

    setInterval(renderClock, 200);
    setMode('1v1');
    fetchState();
  }

  /* ---------------- 左侧游戏面板 ---------------- */

  /** 展开左侧游戏面板（聊天始终保留在右侧） */
  function openPane() {
    if (!paneEl) return;
    paneCollapsed = false;
    paneEl.hidden = false;
    active = true;
    if (floatBtn) floatBtn.hidden = true;
    if (core.setActiveNav) core.setActiveNav('gomoku');

    requestAnimationFrame(() => {
      resize();
      draw();
      // 布局刚完成时再补一次，避免隐藏 → 可见切换后尺寸没跟上
      setTimeout(() => {
        if (!active) return;
        resize();
      }, 60);
    });
  }

  /** 收起游戏面板：观战过程中也可以随时折叠 */
  function collapsePane() {
    paneCollapsed = true;
    active = false;
    if (paneEl) paneEl.hidden = true;
    if (core.setActiveNav) core.setActiveNav('chat');
    updateFloat();
  }

  /** 收起后若仍有对局，保留一个悬浮观战入口 */
  function updateFloat() {
    if (!floatBtn) return;
    const visible = !!game && paneCollapsed;
    floatBtn.hidden = !visible;
    if (visible && floatText) {
      floatText.textContent = game.status === 'waiting'
        ? '五子棋准备中 · 加入观战'
        : game.status === 'playing'
          ? '五子棋对局进行中 · 观战'
          : '五子棋对局已结束 · 查看结果';
    }
  }

  /* ---------------- 状态 ---------------- */

  /** 接收服务端对局快照（HTTP 响应或 SSE 广播），同时校准本地时钟 */
  function setGame(g) {
    if (g && g.serverNow) serverOffset = g.serverNow - Date.now();
    game = g || null;
    if (!game) showLobby = true;
    if (game && (game.status === 'playing' || game.status === 'waiting')) showLobby = false;

    // 新开一局时自动在左侧展开游戏面板（用户手动收起过的同一局不再打扰）
    if (game && game.id !== lastGameId) {
      lastGameId = game.id;
      if (paneCollapsed) openPane();
    }

    busy = false;
    hover = null;
    syncUI();
    draw();
    updateFloat();
  }

  async function fetchState() {
    try {
      const res = await fetch('/api/gomoku/state', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      setGame(j.game || null);
    } catch {
      /* 网络异常时保持当前画面 */
    }
  }

  function syncUI() {
    const hasGame = !!game && !showLobby;
    const waiting = hasGame && game.status === 'waiting';

    lobbyEl.hidden = hasGame;
    gameEl.hidden = !hasGame;
    if (prepEl) prepEl.hidden = !waiting;

    if (!hasGame) {
      badgeEl.hidden = true;
      statusEl.textContent = game && game.status === 'finished'
        ? '上一局已结束，可以发起新对局'
        : '同一时间只能进行一场对局';
      renderOpponents();
      return;
    }

    badgeEl.hidden = false;
    badgeEl.textContent = MODE_LABEL[game.mode] || game.mode;

    if (waiting) {
      statusEl.textContent = '准备中 · 选择阵营加入';
    } else if (game.status === 'playing') {
      statusEl.textContent = isParticipant() ? '对局进行中' : '观战中 · 对局进行中';
    } else {
      statusEl.textContent = resultText();
    }

    renderPrep();
    renderPlayers();
    renderTurn();
    renderResult();
    renderUndo();
    endBtn.hidden = !((game.status === 'playing' || waiting) &&
      game.creator && game.creator.sid === core.getSid());

    requestAnimationFrame(resize);
  }

  function sideNames(side) {
    if (!game) return '';
    const list = (game.players && game.players[side]) || [];
    if (!list.length) return game.mode === 'NvN' ? '等待加入' : '—';
    return list.map((p) => p.name || '匿名设备').join('、');
  }

  function resultText() {
    if (!game) return '同一时间只能进行一场对局';
    if (game.status === 'waiting') return '准备中';
    if (game.status === 'playing') return '对局进行中';
    if (game.winner === 'draw') return '平局';
    if (game.winner === 'black') return '黑棋获胜';
    if (game.winner === 'white') return '白棋获胜';
    return '对局已结束';
  }

  function resultSubText() {
    if (!game) return '';
    if (game.winner === 'black' || game.winner === 'white') {
      return `${sideNames(game.winner)}连成五子`;
    }
    if (game.winner === 'draw') return '棋盘已满，双方平局';
    if (game.endedBy) return `由 ${game.endedBy.name || '发起人'} 结束`;
    return '';
  }

  function cooldownRemaining() {
    if (!game || game.status !== 'playing') return 0;
    return Math.max(0, (game.nextAt || 0) - (Date.now() + serverOffset));
  }

  /** 我所在的阵营（观战返回 null） */
  function mySide() {
    if (!game) return null;
    for (const side of ['black', 'white']) {
      if (((game.players && game.players[side]) || []).some((p) => p.sid === core.getSid())) {
        return side;
      }
    }
    return null;
  }

  function isParticipant() {
    return !!mySide();
  }

  /** 能否落子：对局中 + 无表决在途 + 保护期结束 + 自己属于当前回合阵营 */
  function canIMove() {
    if (!game || game.status !== 'playing' || busy) return false;
    if (game.undoRequest) return false;
    if (cooldownRemaining() > 0) return false;
    return mySide() === game.turn;
  }

  /* ---------------- 发起对局 ---------------- */

  function setMode(m) {
    if (!MODE_LABEL[m]) return;
    mode = m;

    modePicker.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === m);
    });

    if (m === '1v1') {
      if (picked.size > 1) picked = new Set([...picked].slice(0, 1));
    } else if (m === 'NvN') {
      picked.clear();
    }

    renderOpponents();
  }

  function renderOpponents() {
    if (!opponentList) return;

    if (mode === 'NvN') {
      opponentWrap.hidden = true;
      picked.clear();
      updateLobbyHint();
      syncStart();
      return;
    }

    opponentWrap.hidden = false;

    const others = core.getDevices().filter((d) => d.sid !== core.getSid());
    const online = new Set(others.map((d) => d.sid));
    for (const sid of [...picked]) {
      if (!online.has(sid)) picked.delete(sid);
    }

    opponentList.innerHTML = '';

    if (!others.length) {
      opponentList.appendChild(el(
        'div',
        'gomoku-opponents-empty',
        '暂无其他设备在线。让其他设备用同一 WiFi 打开本页后再来。'
      ));
      updateLobbyHint();
      syncStart();
      return;
    }

    for (const d of others) {
      const isOn = picked.has(d.sid);
      const btn = el('button', 'gomoku-opponent' + (isOn ? ' active' : ''));
      btn.type = 'button';

      const av = el('span', 'go-avatar', (d.name || '?').trim().slice(0, 1));
      av.style.background = d.color || '#3b82f6';

      const info = el('span', 'go-info');
      info.appendChild(el('span', 'go-name', d.name || '匿名设备'));
      info.appendChild(el('span', 'go-sub', '在线 · 点击选择'));

      const check = el('span', 'go-check', isOn ? '✓' : '');
      btn.append(av, info, check);

      btn.addEventListener('click', () => {
        if (mode === '1v1') {
          if (isOn) picked.clear();
          else {
            picked.clear();
            picked.add(d.sid);
          }
        } else if (isOn) {
          picked.delete(d.sid);
        } else {
          picked.add(d.sid);
        }
        renderOpponents();
      });

      opponentList.appendChild(btn);
    }

    updateLobbyHint();
    syncStart();
  }

  function updateLobbyHint() {
    if (!opponentHint) return;
    if (mode === '1v1') {
      opponentHint.textContent = picked.size === 1
        ? '已选择 1 位对手'
        : '选择 1 位对手';
    } else if (mode === '1vN') {
      opponentHint.textContent = picked.size >= 2
        ? `已选择 ${picked.size} 位对手`
        : '选择至少 2 位对手';
    } else {
      opponentHint.textContent = '无需指定对手';
    }
  }

  function syncStart() {
    if (!startBtn) return;
    let ok;
    if (mode === 'NvN') ok = true;
    else if (mode === '1v1') ok = picked.size === 1;
    else ok = picked.size >= 2;
    startBtn.disabled = !ok || busy;
  }

  /** 统一的 POST 调用，返回服务端快照 */
  async function postAction(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Sender': core.senderHeader(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || '操作失败');
    if (j.game !== undefined) setGame(j.game);
    return j;
  }

  /** 发起对局：1v1/1vN 必须选够对手，NvN 无需指定对手 */
  async function createGame() {
    if (busy) return;
    if (game && (game.status === 'playing' || game.status === 'waiting')) {
      core.toast('已有一场对局进行中');
      return;
    }

    const opponents = [...picked];
    if (mode === '1v1' && opponents.length !== 1) {
      core.toast('请选择 1 位对手');
      return;
    }
    if (mode === '1vN' && opponents.length < 2) {
      core.toast('请选择至少 2 位对手');
      return;
    }

    busy = true;
    startBtn.disabled = true;
    startBtn.textContent = '发起中…';

    try {
      const j = await postAction('/api/gomoku/create', { mode, opponents });
      showLobby = false;
      setGame(j.game);
      core.toast(mode === 'NvN'
        ? '对局创建成功，30 秒准备时间，选择阵营加入'
        : (mode === '1v1' ? '对局已开始，1v1 无保护期' : '对局已开始，落子后有 3 秒保护期'));
    } catch (err) {
      core.toast(err.message || '发起失败', 3000);
    } finally {
      busy = false;
      startBtn.textContent = '发起对局';
      syncStart();
    }
  }

  async function endGame() {
    if (!game || game.status === 'finished') return;
    if (!game.creator || game.creator.sid !== core.getSid()) {
      core.toast('只有发起人可以结束对局');
      return;
    }
    const tip = game.status === 'waiting' ? '取消当前准备中的对局？' : '结束当前对局？';
    if (!confirm(tip)) return;

    try {
      await postAction('/api/gomoku/end');
    } catch (err) {
      core.toast(err.message || '结束失败', 3000);
    }
  }

  /* ---------------- 多v多准备期 ---------------- */

  async function joinSide(side) {
    if (!game || game.mode !== 'NvN' || game.status !== 'waiting') return;
    if (mySide() === side) return;
    try {
      await postAction('/api/gomoku/join', { side });
    } catch (err) {
      core.toast(err.message || '加入失败', 3000);
    }
  }

  async function startNvN() {
    if (!game || game.mode !== 'NvN' || game.status !== 'waiting') return;
    try {
      await postAction('/api/gomoku/start');
      core.toast('对局开始');
    } catch (err) {
      core.toast(err.message || '开始失败', 3000);
    }
  }

  /* ---------------- 悔棋 ---------------- */

  async function requestUndo() {
    if (!game || game.status !== 'playing' || !isParticipant()) return;
    try {
      await postAction('/api/gomoku/undo/request');
    } catch (err) {
      core.toast(err.message || '悔棋请求失败', 3000);
    }
  }

  async function answerUndo(agree) {
    if (!game || !game.undoRequest) return;
    try {
      await postAction('/api/gomoku/undo/answer', { agree });
    } catch (err) {
      core.toast(err.message || '表决失败', 3000);
    }
  }

  async function cancelUndo() {
    if (!game || !game.undoRequest) return;
    try {
      await postAction('/api/gomoku/undo/cancel');
    } catch (err) {
      core.toast(err.message || '取消失败', 3000);
    }
  }

  /* ---------------- 落子 ---------------- */

  function onBoardClick(e) {
    const p = boardPoint(e);
    if (!p) return;
    placeStone(p.r, p.c);
  }

  function onBoardMove(e) {
    if (!canIMove()) {
      if (hover) {
        hover = null;
        draw();
      }
      return;
    }
    const p = boardPoint(e);
    if (!p) {
      if (hover) {
        hover = null;
        draw();
      }
      return;
    }
    if (hover && hover.r === p.r && hover.c === p.c) return;
    hover = p;
    draw();
  }

  function boardPoint(e) {
    if (!canvas || !cssSize) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // 屏幕坐标 → 画布内部坐标
    const x = (e.clientX - rect.left) * (cssSize / rect.width);
    const y = (e.clientY - rect.top) * (cssSize / rect.height);
    // x 映射到列，y 映射到行（canvas 的 y 向下增长，与行号方向一致）
    const c = Math.round((x - pad) / gap);
    const r = Math.round((y - pad) / gap);
    if (r < 0 || r >= BOARD_N || c < 0 || c >= BOARD_N) return null;
    if (Math.abs(x - (pad + c * gap)) > gap * 0.55) return null;
    if (Math.abs(y - (pad + r * gap)) > gap * 0.55) return null;
    return { r, c };
  }

  /** 落子：本地先校验保护期与轮次，最终以服务端返回的对局状态为准 */
  async function placeStone(r, c) {
    if (!game || game.status !== 'playing' || busy) return;

    const remain = cooldownRemaining();
    if (remain > 0) {
      core.toast(`保护期中，还需 ${(remain / 1000).toFixed(1)} 秒`);
      return;
    }
    if (!isParticipant()) {
      core.toast('你在观战，不能落子');
      return;
    }
    if (!canIMove()) {
      core.toast(game.mode === 'NvN'
        ? (mySide() === game.turn ? '现在还不能落子' : '等待队友落子')
        : '还没轮到你');
      return;
    }
    // 与服务端保持一致：行优先下标 index = r * 19 + c
    if (game.board[r * BOARD_N + c]) return;

    busy = true;
    updateBoardCursor();

    try {
      const res = await fetch('/api/gomoku/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Sender': core.senderHeader(),
        },
        body: JSON.stringify({ r, c }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        core.toast(j.error || '落子失败');
      } else {
        setGame(j.game);
      }
    } catch {
      core.toast('落子失败，请检查连接', 3000);
    } finally {
      busy = false;
      hover = null;
      renderTurn();
      updateBoardCursor();
      draw();
    }
  }

  /* ---------------- 渲染对局信息 ---------------- */

  function renderPlayers() {
    if (!playersEl || !game) return;
    playersEl.innerHTML = '';

    ['black', 'white'].forEach((side) => {
      const isTurn = game.status === 'playing' && game.turn === side;
      const box = el('div', 'gp-side' + (isTurn ? ' active' : ''));
      box.appendChild(el('span', 'gp-stone ' + side));
      const text = el('div', 'gp-text');
      text.appendChild(el('span', 'gp-role', side === 'black' ? '黑棋' : '白棋'));
      text.appendChild(el('span', 'gp-name', sideNames(side)));
      box.appendChild(text);
      playersEl.appendChild(box);
    });
  }

  function renderTurn() {
    if (!turnEl || !game) return;

    const colorName = game.turn === 'black' ? '黑棋' : '白棋';
    const remain = cooldownRemaining();
    let text;

    if (game.status === 'waiting') {
      text = '准备中 · 选择阵营加入';
    } else if (game.status !== 'playing') {
      text = resultText();
    } else if (remain > 0) {
      text = `轮到${colorName} · 保护期中`;
    } else if (game.mode === 'NvN') {
      if (mySide() === game.turn) text = `轮到${colorName} · 请你或队友落子`;
      else if (isParticipant()) text = `轮到${colorName} · 等待队友`;
      else text = `轮到${colorName} · 观战中`;
    } else if (canIMove()) {
      text = `轮到${colorName} · 请你落子`;
    } else if (isParticipant()) {
      text = `轮到${colorName} · 等待对手`;
    } else {
      text = `轮到${colorName} · 观战中`;
    }

    turnEl.textContent = text;
    cooldownEl.textContent = game.status === 'playing' && remain > 0
      ? `保护期 ${(remain / 1000).toFixed(1)}s`
      : '';
    updateBoardCursor();
  }

  /** 多v多准备期：阵营人数、加入状态、开始按钮 */
  function renderPrep() {
    if (!prepEl || !game || game.status !== 'waiting') return;

    for (const side of ['black', 'white']) {
      const list = (game.players && game.players[side]) || [];
      const countEl = prepCountEls[side];
      const listEl = prepListEls[side];
      const checkEl = prepCheckEls[side];
      const btn = side === 'black' ? joinBtns[0] : joinBtns[1];
      const mine = mySide() === side;

      if (countEl) countEl.textContent = `${list.length} 人`;
      if (listEl) {
        listEl.textContent = list.length
          ? list.map((p) => p.name || '匿名设备').join('、')
          : '等待加入';
      }
      if (checkEl) checkEl.textContent = mine ? '✓' : '';
      if (btn) btn.classList.toggle('active', mine);
    }

    const ready = ((game.players && game.players.black) || []).length > 0 &&
      ((game.players && game.players.white) || []).length > 0;
    const isCreator = game.creator && game.creator.sid === core.getSid();

    if (prepStartBtn) {
      prepStartBtn.hidden = !isCreator;
      prepStartBtn.disabled = !ready;
    }
    if (prepHintEl) {
      prepHintEl.textContent = ready
        ? (game.startsAt ? '双方已就位，倒计时结束自动开始' : '双方已就位，可开始对局')
        : '双方各至少 1 人即可开始';
    }
  }

  function renderPrepClock() {
    if (!prepClockEl || !game || game.status !== 'waiting') return;
    if (!game.startsAt) {
      prepClockEl.textContent = '准备时间已结束';
      return;
    }
    const remain = Math.max(0, game.startsAt - (Date.now() + serverOffset));
    prepClockEl.textContent = `准备时间 ${Math.ceil(remain / 1000)}s`;
  }

  /** 悔棋按钮与表决面板 */
  function renderUndo() {
    if (!undoBtn || !game) return;

    const req = game.undoRequest;
    undoBtn.hidden = !(game.status === 'playing' && game.moveCount > 0 &&
      isParticipant() && !req);
    undoPanel.hidden = !req;
    if (!req) return;

    const approved = (req.approvals || []).length;
    const required = req.required || 1;
    const opp = req.side === 'black' ? 'white' : 'black';
    const isOpponent = ((game.players && game.players[opp]) || [])
      .some((p) => p.sid === core.getSid());
    const mine = req.by && req.by.sid === core.getSid();
    const voted = (req.approvals || []).includes(core.getSid());

    let text;
    if (mine) {
      text = `已发起悔棋，等待对方同意（${approved}/${required}）`;
    } else if (isOpponent) {
      text = voted
        ? `你已同意悔棋，等待其他成员（${approved}/${required}）`
        : `${req.by.name || '对方'} 请求悔棋（${approved}/${required} 已同意）`;
    } else {
      text = `悔棋表决中（${approved}/${required}）`;
    }

    undoTextEl.textContent = text;

    const canVote = isOpponent && !voted;
    undoAgreeBtn.hidden = !canVote;
    undoRejectBtn.hidden = !canVote;
    undoCancelBtn.hidden = !mine;
  }

  function updateBoardCursor() {
    if (boardWrap) boardWrap.classList.toggle('can-play', canIMove());
  }

  /** 透明度滑块：0% 为完全不透明，数值越大棋盘越透明 */
  function applyBoardOpacity() {
    if (!boardSurface || !opacityRange) return;
    const value = Math.min(80, Math.max(0, Number(opacityRange.value) || 0));
    boardSurface.style.opacity = String(1 - value / 100);
    if (opacityValue) opacityValue.textContent = `${value}%`;
  }

  function renderResult() {
    if (!resultEl || !game) return;

    if (game.status !== 'finished') {
      resultEl.hidden = true;
      return;
    }

    resultEl.hidden = false;
    resultTitle.textContent = resultText();
    resultSub.textContent = resultSubText();
  }

  function renderClock() {
    if (!active || !game) return;
    if (game.status === 'waiting') {
      renderPrepClock();
      return;
    }
    if (game.status === 'playing') renderTurn();
  }

  /* ---------------- 棋盘绘制 ---------------- */

  /** 画布像素尺寸跟随显示尺寸与 DPR，避免模糊；坐标计算统一使用 cssSize */
  function resize() {
    if (!canvas || !ctx) return;
    // 优先按棋盘容器测量：画布在隐藏状态下自身尺寸不可靠
    const wrapRect = boardWrap ? boardWrap.getBoundingClientRect() : null;
    const rect = (wrapRect && wrapRect.width >= 10 && wrapRect.height >= 10)
      ? wrapRect
      : canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const size = Math.min(rect.width, rect.height);
    const dpr = window.devicePixelRatio || 1;
    const pixels = Math.round(size * dpr);

    if (canvas.width !== pixels || canvas.height !== pixels) {
      canvas.width = pixels;
      canvas.height = pixels;
    }

    cssSize = size;
    pad = size * 0.06;
    gap = (size - pad * 2) / (BOARD_N - 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    draw();
  }

  /** 重绘顺序：网格 → 外框 → 星位 → 棋子 → 最后一手标记 → 悬停预览 */
  function draw() {
    if (!ctx || !cssSize) return;

    const size = cssSize;
    ctx.clearRect(0, 0, size, size);

    // 网格
    ctx.strokeStyle = 'rgba(85, 55, 20, .55)';
    ctx.lineWidth = Math.max(1, size / 700);
    ctx.beginPath();
    for (let i = 0; i < BOARD_N; i++) {
      const p = pad + i * gap;
      ctx.moveTo(pad, p);
      ctx.lineTo(size - pad, p);
      ctx.moveTo(p, pad);
      ctx.lineTo(p, size - pad);
    }
    ctx.stroke();

    // 外框
    ctx.lineWidth = Math.max(1.5, size / 380);
    ctx.strokeStyle = 'rgba(70, 45, 15, .7)';
    ctx.strokeRect(pad, pad, size - pad * 2, size - pad * 2);

    // 星位
    const stars = [[3, 3], [3, 15], [15, 3], [15, 15], [9, 9]];
    ctx.fillStyle = 'rgba(70, 45, 15, .8)';
    for (const [r, c] of stars) {
      ctx.beginPath();
      ctx.arc(pad + c * gap, pad + r * gap, Math.max(2, gap * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }

    // 棋子
    if (game && Array.isArray(game.board)) {
      // 行优先数组还原坐标：整除得到行 r，取余得到列 c
      for (let i = 0; i < game.board.length; i++) {
        const color = game.board[i];
        if (!color) continue;
        drawStone(Math.floor(i / BOARD_N), i % BOARD_N, color);
      }
      if (game.lastMove) {
        drawLastMark(game.lastMove.r, game.lastMove.c);
      }
    }

    // 悬停预览
    if (hover && canIMove() && game && !game.board[hover.r * BOARD_N + hover.c]) {
      ctx.globalAlpha = 0.34;
      drawStone(hover.r, hover.c, game.turn);
      ctx.globalAlpha = 1;
    }
  }

  /** 参数顺序固定为 (行 r, 列 c)：x 由列算，y 由行算 */
  function drawStone(r, c, color) {
    const x = pad + c * gap;
    const y = pad + r * gap;
    const radius = gap * 0.34;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(0, 0, 0, .28)';
    ctx.shadowBlur = radius * 0.5;
    ctx.shadowOffsetY = radius * 0.16;

    const g = ctx.createRadialGradient(
      x - radius * 0.35, y - radius * 0.4, radius * 0.12,
      x, y, radius
    );
    if (color === 'black') {
      g.addColorStop(0, '#6b7280');
      g.addColorStop(0.45, '#1f2937');
      g.addColorStop(1, '#020617');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.6, '#f1f5f9');
      g.addColorStop(1, '#cbd5e1');
    }
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color === 'black'
      ? 'rgba(0, 0, 0, .7)'
      : 'rgba(100, 116, 139, .55)';
    ctx.lineWidth = Math.max(1, gap * 0.035);
    ctx.stroke();
  }

  /** 红圈标记最后一手，参数顺序与 drawStone 一致 */
  function drawLastMark(r, c) {
    const x = pad + c * gap;
    const y = pad + r * gap;
    ctx.beginPath();
    ctx.arc(x, y, gap * 0.1, 0, Math.PI * 2);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = Math.max(1.5, gap * 0.055);
    ctx.stroke();
  }

  window.ChatDropGomoku = { init, openPane, collapsePane };
})();
