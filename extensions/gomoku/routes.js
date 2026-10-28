'use strict';

/**
 * 五子棋 HTTP 路由
 *
 * 由扩展入口注入对局管理器与主服务的通用工具，
 * 这样路由不需要了解主服务内部的设备表、SSE 连接等实现。
 *
 * 返回的 handle(req, res, pathname, method) 命中返回 true，未命中返回 false，
 * 主服务据此决定是否继续匹配后续路由。
 */

function createGomokuRoutes({ game, readBody, sendJSON, parseSender }) {
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

  /** 统一返回：成功 { game }，失败 { code, error, retryAfterMs } */
  function reply(res, out) {
    if (!out.game) {
      sendJSON(res, out.code, {
        error: out.error,
        retryAfterMs: out.retryAfterMs,
      });
      return;
    }
    sendJSON(res, 200, out);
  }

  return async function handle(req, res, pathname, method) {
    if (!pathname.startsWith('/api/gomoku/')) return false;

    /* --- 当前对局 --- */
    if (pathname === '/api/gomoku/state' && method === 'GET') {
      sendJSON(res, 200, game.snapshot());
      return true;
    }

    if (method !== 'POST') return false;

    switch (pathname) {
      /* --- 发起对局 --- */
      case '/api/gomoku/create': {
        const p = await readJSON(req, res);
        if (!p) return true;
        reply(res, game.create(parseSender(req), p));
        return true;
      }

      /* --- 落子 --- */
      case '/api/gomoku/move': {
        const p = await readJSON(req, res);
        if (!p) return true;
        reply(res, game.move(parseSender(req), p));
        return true;
      }

      /* --- 结束对局 --- */
      case '/api/gomoku/end':
        reply(res, game.end(parseSender(req)));
        return true;

      /* --- NvN 准备期选择阵营 --- */
      case '/api/gomoku/join': {
        const p = await readJSON(req, res);
        if (!p) return true;
        reply(res, game.join(parseSender(req), p));
        return true;
      }

      /* --- NvN 提前开始 --- */
      case '/api/gomoku/start':
        reply(res, game.start(parseSender(req)));
        return true;

      /* --- 发起悔棋 --- */
      case '/api/gomoku/undo/request':
        reply(res, game.requestUndo(parseSender(req)));
        return true;

      /* --- 悔棋表决 --- */
      case '/api/gomoku/undo/answer': {
        const p = await readJSON(req, res);
        if (!p) return true;
        reply(res, game.answerUndo(parseSender(req), p));
        return true;
      }

      /* --- 撤回悔棋请求 --- */
      case '/api/gomoku/undo/cancel':
        reply(res, game.cancelUndo(parseSender(req)));
        return true;

      default:
        return false;
    }
  };
}

module.exports = { createGomokuRoutes };
