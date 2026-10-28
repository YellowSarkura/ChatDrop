'use strict';

/**
 * 技术问答 HTTP 路由
 *
 *   GET  /api/qa/questions                       问题列表（最新在前）
 *   POST /api/qa/questions                       提问          { content }
 *   GET  /api/qa/questions/:id/answers?page=N    回答分页      （每页 10 条）
 *   POST /api/qa/questions/:id/answers           回答          { content }
 *   POST /api/qa/answers/:id/vote                点赞/点踩     { vote: 'like' | 'dislike' }
 *
 * handle(req, res, pathname, method) 命中返回 true，未命中返回 false。
 */

function createTechnicalQaRoutes({ store, readBody, sendJSON }) {
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

  /** 统一返回：成功数据原样输出，失败输出 { code, error } */
  function reply(res, out) {
    if (out && out.error) {
      sendJSON(res, out.code || 400, { error: out.error });
      return;
    }
    sendJSON(res, 200, out);
  }

  return async function handle(req, res, pathname, method) {
    if (!pathname.startsWith('/api/qa')) return false;

    /* --- 问题列表 / 提问 --- */
    if (pathname === '/api/qa/questions') {
      if (method === 'GET') {
        sendJSON(res, 200, { questions: store.listQuestions() });
        return true;
      }
      if (method === 'POST') {
        const p = await readJSON(req, res);
        if (!p) return true;
        reply(res, store.createQuestion(p.content));
        return true;
      }
      return false;
    }

    /* --- 某问题的回答：分页读取 / 发布 --- */
    const answersMatch = /^\/api\/qa\/questions\/(\d+)\/answers$/.exec(pathname);
    if (answersMatch) {
      const questionId = Number(answersMatch[1]);

      if (method === 'GET') {
        const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page')) || 1;
        reply(res, store.listAnswers(questionId, page));
        return true;
      }
      if (method === 'POST') {
        const p = await readJSON(req, res);
        if (!p) return true;
        reply(res, store.createAnswer(questionId, p.content));
        return true;
      }
      return false;
    }

    /* --- 回答点赞 / 点踩 --- */
    const voteMatch = /^\/api\/qa\/answers\/(\d+)\/vote$/.exec(pathname);
    if (voteMatch && method === 'POST') {
      const answerId = Number(voteMatch[1]);
      const p = await readJSON(req, res);
      if (!p) return true;
      reply(res, store.voteAnswer(answerId, p.vote));
      return true;
    }

    return false;
  };
}

module.exports = { createTechnicalQaRoutes };
