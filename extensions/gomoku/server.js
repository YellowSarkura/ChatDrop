'use strict';

/**
 * 五子棋 —— 服务端对局逻辑
 *
 * 独立于主服务的聊天/传输逻辑：主服务只需注入「广播」和「按 sid 查在线设备」
 * 两个依赖，即可获得一套完整的对局管理器。
 *
 * 同一时间只允许一场对局。
 *
 * 对局状态：
 *   { id, mode, board, turn, players:{black,white}, creator,
 *     status:'waiting'|'playing'|'finished', winner, lastMove, moveCount,
 *     history, nextAt, startsAt, undoRequest, createdAt, updatedAt, endedBy }
 *
 * 模式：
 *   1v1  发起人执黑，指定 1 位对手执白
 *   NvN  创建后进入准备期（30 秒），玩家自行选择黑/白阵营加入；
 *        开赛后只有当前回合阵营的成员可以落子
 *
 * 保护期：1v1 无保护期； NvN 每次落子后 3 秒内不允许再次落子。
 * 悔棋：1v1 需对手同意；多人模式需对方半数以上成员同意。
 */

const crypto = require('crypto');

const GOMOKU_SIZE = 19;
const GOMOKU_COOLDOWN_MS = 3000;
const GOMOKU_PREP_MS = 30000;

/**
 * 创建对局管理器
 *
 * @param {object} deps
 * @param {(payload: object) => void} deps.broadcast  广播 SSE 事件
 * @param {(sid: string) => object|undefined} deps.getDevice  查询在线设备
 * @returns {object} 对局操作集合
 */
function createGomokuGame({ broadcast, getDevice }) {
  let gomoku = null;

  function gomokuBoard() {
    return new Array(GOMOKU_SIZE * GOMOKU_SIZE).fill(null);
  }

  function gomokuPlayer(who) {
    return { sid: who.sid, name: who.name, color: who.color };
  }

  function gomokuSnapshot() {
    if (!gomoku) return { game: null };
    return {
      game: {
        id: gomoku.id,
        mode: gomoku.mode,
        size: GOMOKU_SIZE,
        board: gomoku.board.slice(),
        turn: gomoku.turn,
        players: gomoku.players,
        creator: gomoku.creator,
        status: gomoku.status,
        winner: gomoku.winner,
        lastMove: gomoku.lastMove,
        moveCount: gomoku.moveCount,
        nextAt: gomoku.nextAt,
        startsAt: gomoku.startsAt,
        undoRequest: gomoku.undoRequest ? {
          by: gomoku.undoRequest.by,
          side: gomoku.undoRequest.side,
          required: gomoku.undoRequest.required,
          approvals: gomoku.undoRequest.approvals.slice(),
          rejects: gomoku.undoRequest.rejects.slice(),
          createdAt: gomoku.undoRequest.createdAt,
        } : null,
        serverNow: Date.now(),
        createdAt: gomoku.createdAt,
        endedBy: gomoku.endedBy || null,
      },
    };
  }

  function broadcastGomoku() {
    broadcast({ type: 'gomoku', data: gomokuSnapshot().game });
  }

  /** 判断刚落下的棋子是否形成五连 */
  function gomokuHasFive(board, r, c, color) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (const sign of [1, -1]) {
        let rr = r + dr * sign;
        let cc = c + dc * sign;
        while (rr >= 0 && rr < GOMOKU_SIZE && cc >= 0 && cc < GOMOKU_SIZE &&
               board[rr * GOMOKU_SIZE + cc] === color) {
          count++;
          rr += dr * sign;
          cc += dc * sign;
        }
      }
      if (count >= 5) return true;
    }
    return false;
  }

  /** 创建对局。返回 { game } 或 { code, error } */
  function createGomoku(sender, payload) {
    if (gomoku && gomoku.status !== 'finished') {
      return { code: 409, error: '已有一场对局进行中，请等待结束' };
    }

    const mode = String(payload.mode || '');
    if (!['1v1', 'NvN'].includes(mode)) {
      return { code: 400, error: '对局模式无效' };
    }

    const raw = Array.isArray(payload.opponents)
      ? payload.opponents
      : (payload.opponent ? [payload.opponent] : []);
    const opponents = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))]
      .filter((sid) => sid !== sender.sid)
      .slice(0, 8);

    if (mode === '1v1' && opponents.length !== 1) {
      return { code: 400, error: '1v1 需要指定 1 位对手' };
    }
    if (mode === 'NvN' && opponents.length < 2) {
      return { code: 400, error: '多v多 需要指定至少 2 位对手' };
    }

    const players = { black: [], white: [] };
    if (mode !== 'NvN') {
      players.black = [gomokuPlayer(sender)];
      players.white = opponents.map((sid) => {
        const d = getDevice(sid);
        return {
          sid,
          name: (d && d.name) || '离线设备',
          color: (d && d.color) || '#64748b',
        };
      });
    }

    const now = Date.now();
    gomoku = {
      id: crypto.randomUUID(),
      mode,
      board: gomokuBoard(),
      turn: 'black',
      players,
      creator: gomokuPlayer(sender),
      status: mode === 'NvN' ? 'waiting' : 'playing',
      winner: null,
      lastMove: null,
      moveCount: 0,
      history: [],
      nextAt: 0,
      startsAt: mode === 'NvN' ? now + GOMOKU_PREP_MS : 0,
      undoRequest: null,
      createdAt: now,
      updatedAt: now,
      endedBy: null,
    };

    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  /** 某设备所在阵营（不在对局中返回 null） */
  function gomokuSideOf(sid) {
    if (!gomoku) return null;
    for (const side of ['black', 'white']) {
      if ((gomoku.players[side] || []).some((p) => p.sid === sid)) return side;
    }
    return null;
  }

  /** NvN 准备期：选择 / 切换阵营 */
  function joinGomoku(sender, payload) {
    if (!gomoku) return { code: 404, error: '当前没有对局' };
    if (gomoku.mode !== 'NvN') return { code: 400, error: '当前模式无需选择阵营' };
    if (gomoku.status !== 'waiting') return { code: 409, error: '对局已开始，无法加入' };

    const side = payload.side === 'black' ? 'black' : payload.side === 'white' ? 'white' : null;
    if (!side) return { code: 400, error: '阵营无效' };

    const other = side === 'black' ? 'white' : 'black';
    gomoku.players[other] = gomoku.players[other].filter((p) => p.sid !== sender.sid);
    const list = gomoku.players[side];
    if (!list.some((p) => p.sid === sender.sid)) list.push(gomokuPlayer(sender));

    gomoku.updatedAt = Date.now();
    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  /** NvN：发起人在准备期提前开赛（双方各至少 1 人） */
  function startGomokuNvN(sender) {
    if (!gomoku) return { code: 404, error: '当前没有对局' };
    if (gomoku.mode !== 'NvN') return { code: 400, error: '当前模式无需准备' };
    if (gomoku.status !== 'waiting') return { code: 409, error: '对局已开始' };
    if (!gomoku.creator || gomoku.creator.sid !== sender.sid) {
      return { code: 403, error: '只有发起人可以开始对局' };
    }
    if (!gomoku.players.black.length || !gomoku.players.white.length) {
      return { code: 409, error: '双方各需至少 1 人才能开始' };
    }

    gomoku.status = 'playing';
    gomoku.startsAt = 0;
    gomoku.turn = 'black';
    gomoku.nextAt = 0;
    gomoku.updatedAt = Date.now();
    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  /** 准备时间到点：双方就位则自动开赛，否则等待手动开始 */
  function tickGomoku() {
    if (!gomoku || gomoku.status !== 'waiting' || !gomoku.startsAt) return;
    const now = Date.now();
    if (now < gomoku.startsAt) return;

    if (gomoku.players.black.length && gomoku.players.white.length) {
      gomoku.status = 'playing';
      gomoku.startsAt = 0;
      gomoku.turn = 'black';
      gomoku.nextAt = 0;
    } else {
      gomoku.startsAt = 0;
    }
    gomoku.updatedAt = now;
    broadcastGomoku();
  }
  setInterval(tickGomoku, 1000).unref();

  /** 落子。返回 { game } 或 { code, error, retryAfterMs } */
  function moveGomoku(sender, payload) {
    if (!gomoku) return { code: 404, error: '当前没有对局' };
    if (gomoku.status === 'waiting') return { code: 409, error: '对局还在准备中' };
    if (gomoku.status !== 'playing') return { code: 409, error: '对局已结束' };
    if (gomoku.undoRequest) return { code: 409, error: '悔棋表决中，暂不能落子' };

    // 3 秒保护期：仅多人模式需要；1v1 两名玩家轮流落子，不设等待
    const now = Date.now();
    if (gomoku.mode !== '1v1' && now < gomoku.nextAt) {
      return {
        code: 429,
        error: `保护期中，请等待 ${Math.ceil((gomoku.nextAt - now) / 1000)} 秒`,
        retryAfterMs: gomoku.nextAt - now,
      };
    }

    const r = Number(payload.r);
    const c = Number(payload.c);
    if (!Number.isInteger(r) || !Number.isInteger(c) ||
        r < 0 || r >= GOMOKU_SIZE || c < 0 || c >= GOMOKU_SIZE) {
      return { code: 400, error: '落子位置无效' };
    }

    // 所有模式：只有当前回合阵营的成员可以落子（NvN 观战者不能代落）
    const side = gomoku.players[gomoku.turn] || [];
    if (!side.some((p) => p.sid === sender.sid)) {
      if (!gomokuSideOf(sender.sid)) return { code: 403, error: '你在观战，不能落子' };
      return { code: 403, error: gomoku.turn === 'black' ? '现在轮到黑棋' : '现在轮到白棋' };
    }

    const idx = r * GOMOKU_SIZE + c;
    if (gomoku.board[idx]) return { code: 409, error: '该位置已有棋子' };

    const color = gomoku.turn;
    gomoku.board[idx] = color;
    gomoku.moveCount++;
    gomoku.history.push({ r, c, color, by: gomokuPlayer(sender), ts: now });
    gomoku.lastMove = { r, c, color, by: gomokuPlayer(sender), ts: now };

    if (gomokuHasFive(gomoku.board, r, c, color)) {
      gomoku.status = 'finished';
      gomoku.winner = color;
    } else if (gomoku.moveCount >= GOMOKU_SIZE * GOMOKU_SIZE) {
      gomoku.status = 'finished';
      gomoku.winner = 'draw';
    } else {
      gomoku.turn = color === 'black' ? 'white' : 'black';
    }

    gomoku.undoRequest = null;
    gomoku.nextAt = gomoku.mode === '1v1' ? 0 : now + GOMOKU_COOLDOWN_MS;
    gomoku.updatedAt = now;
    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  /** 发起悔棋：1v1 需对手同意；多人模式需对方半数以上成员同意 */
  function requestUndoGomoku(sender) {
    if (!gomoku) return { code: 404, error: '当前没有对局' };
    if (gomoku.status !== 'playing') return { code: 409, error: '对局未进行中' };
    if (!gomoku.history.length) return { code: 409, error: '还没有可悔的棋' };
    if (gomoku.undoRequest) return { code: 409, error: '已有悔棋请求在表决中' };

    const side = gomokuSideOf(sender.sid);
    if (!side) return { code: 403, error: '观战中不能悔棋' };
    const opp = side === 'black' ? 'white' : 'black';
    const total = (gomoku.players[opp] || []).length;
    if (!total) return { code: 409, error: '对方阵营没有成员' };

    gomoku.undoRequest = {
      by: { sid: sender.sid, name: sender.name },
      side,
      required: Math.floor(total / 2) + 1,
      approvals: [],
      rejects: [],
      createdAt: Date.now(),
    };
    gomoku.updatedAt = Date.now();
    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  /** 悔棋表决：只有对方阵营成员可以投票 */
  function answerUndoGomoku(sender, payload) {
    if (!gomoku) return { code: 404, error: '当前没有对局' };
    const req = gomoku.undoRequest;
    if (!req) return { code: 404, error: '没有待处理的悔棋请求' };
    if (gomoku.status !== 'playing') return { code: 409, error: '对局未进行中' };

    const opp = req.side === 'black' ? 'white' : 'black';
    if (!(gomoku.players[opp] || []).some((p) => p.sid === sender.sid)) {
      return { code: 403, error: '只有对方阵营可以表决' };
    }
    if (req.approvals.includes(sender.sid) || req.rejects.includes(sender.sid)) {
      return { code: 409, error: '你已经表决过了' };
    }

    if (payload.agree === true) req.approvals.push(sender.sid);
    else req.rejects.push(sender.sid);

    const total = gomoku.players[opp].length;
    if (req.approvals.length > total / 2) {
      // 通过：撤回最后一手，轮到落子方重新落子
      const last = gomoku.history.pop();
      if (last) {
        gomoku.board[last.r * GOMOKU_SIZE + last.c] = null;
        gomoku.turn = last.color;
      }
      gomoku.moveCount = gomoku.history.length;
      gomoku.lastMove = gomoku.history.length
        ? gomoku.history[gomoku.history.length - 1]
        : null;
      gomoku.nextAt = 0;
      gomoku.undoRequest = null;
    } else if (total - req.rejects.length < req.required) {
      // 剩余可同意的人已不足以通过，请求失败
      gomoku.undoRequest = null;
    }

    gomoku.updatedAt = Date.now();
    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  /** 发起人撤回自己的悔棋请求 */
  function cancelUndoGomoku(sender) {
    if (!gomoku) return { code: 404, error: '当前没有对局' };
    const req = gomoku.undoRequest;
    if (!req) return { code: 404, error: '没有待处理的悔棋请求' };
    if (req.by.sid !== sender.sid) return { code: 403, error: '只能撤回自己的请求' };

    gomoku.undoRequest = null;
    gomoku.updatedAt = Date.now();
    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  /** 结束对局：只有发起人可以主动结束 */
  function endGomoku(sender) {
    if (!gomoku) return { code: 404, error: '当前没有对局' };
    if (gomoku.status === 'finished') return { code: 409, error: '对局已结束' };
    if (!gomoku.creator || gomoku.creator.sid !== sender.sid) {
      return { code: 403, error: '只有发起人可以结束对局' };
    }

    gomoku.status = 'finished';
    gomoku.winner = null;
    gomoku.nextAt = 0;
    gomoku.startsAt = 0;
    gomoku.undoRequest = null;
    gomoku.updatedAt = Date.now();
    gomoku.endedBy = gomokuPlayer(sender);
    broadcastGomoku();
    return { game: gomokuSnapshot().game };
  }

  return {
    getGame: () => gomoku,
    snapshot: gomokuSnapshot,
    create: createGomoku,
    join: joinGomoku,
    start: startGomokuNvN,
    move: moveGomoku,
    requestUndo: requestUndoGomoku,
    answerUndo: answerUndoGomoku,
    cancelUndo: cancelUndoGomoku,
    end: endGomoku,
  };
}

module.exports = {
  createGomokuGame,
  GOMOKU_SIZE,
  GOMOKU_COOLDOWN_MS,
  GOMOKU_PREP_MS,
};
