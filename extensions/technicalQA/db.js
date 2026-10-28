'use strict';

/**
 * 技术问答 —— SQLite 存储
 *
 * 使用 Node 24 内置的 node:sqlite（DatabaseSync），不引入第三方依赖。
 *
 * 表结构：
 *   questions  问题表：id 主键、content 问题内容、created_at 提问时间
 *   answers    回答表：id 主键、question_id 所属问题、content 回答内容、
 *              created_at 回答时间、likes 点赞数、dislikes 点踩数
 *
 * 不记录任何提问者 / 回答者身份；点赞点踩只累计数量。
 * 回答按「赞 + 踩」总数倒序排列，同热度按时间正序。
 */

const { DatabaseSync } = require('node:sqlite');

const QUESTION_MAX = 2000;
const ANSWER_MAX = 2000;
const PAGE_SIZE = 10;

/** 规范化内容：统一换行、去首尾空白、校验长度 */
function normalizeContent(raw, max) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
  if (!text) return { code: 400, error: '内容不能为空' };
  if (text.length > max) return { code: 400, error: `内容不能超过 ${max} 字` };
  return { text };
}

/** 本地时间 YYYY-MM-DD HH:mm，用于启动日志 */
function fmtTime(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单行化，避免启动日志被换行撑散 */
function oneLine(text) {
  return String(text || '').replace(/\s*\n\s*/g, ' ').trim();
}

function toAnswer(row) {
  return {
    id: Number(row.id),
    content: row.content,
    createdAt: Number(row.createdAt),
    likes: Number(row.likes),
    dislikes: Number(row.dislikes),
  };
}

/**
 * 打开（或创建）数据库，返回对局无关的纯数据操作集合。
 * @param {string} dbPath 数据库文件路径
 */
function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS answers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      content     TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      likes       INTEGER NOT NULL DEFAULT 0,
      dislikes    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_answers_question
      ON answers(question_id, created_at);
  `);

  /* ---------------- 问题 ---------------- */

  /** 全部问题（最新在前），附带回答数 */
  function listQuestions() {
    const rows = db.prepare(`
      SELECT q.id, q.content, q.created_at AS createdAt,
             (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) AS answerCount
      FROM questions q
      ORDER BY q.created_at DESC, q.id DESC
    `).all();

    return rows.map((row) => ({
      id: Number(row.id),
      content: row.content,
      createdAt: Number(row.createdAt),
      answerCount: Number(row.answerCount),
    }));
  }

  /** 新建问题 */
  function createQuestion(raw) {
    const parsed = normalizeContent(raw, QUESTION_MAX);
    if (parsed.error) return parsed;

    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO questions (content, created_at) VALUES (?, ?)'
    ).run(parsed.text, now);

    return {
      question: {
        id: Number(info.lastInsertRowid),
        content: parsed.text,
        createdAt: now,
        answerCount: 0,
      },
    };
  }

  function questionExists(id) {
    return !!db.prepare('SELECT 1 FROM questions WHERE id = ?').get(id);
  }

  /* ---------------- 回答 ---------------- */

  /**
   * 某问题的回答分页（每页最多 10 条）
   * 排序：赞 + 踩 总数倒序，同热度按时间正序
   */
  function listAnswers(questionId, page) {
    if (!questionExists(questionId)) return { code: 404, error: '问题不存在' };

    const total = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM answers WHERE question_id = ?'
    ).get(questionId).n);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, Math.floor(Number(page)) || 1), totalPages);
    const offset = (safePage - 1) * PAGE_SIZE;

    const rows = db.prepare(`
      SELECT id, content, created_at AS createdAt, likes, dislikes
      FROM answers
      WHERE question_id = ?
      ORDER BY (likes + dislikes) DESC, created_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(questionId, PAGE_SIZE, offset);

    return {
      answers: rows.map(toAnswer),
      total,
      page: safePage,
      pageSize: PAGE_SIZE,
      totalPages,
    };
  }

  /** 新建回答 */
  function createAnswer(questionId, raw) {
    if (!questionExists(questionId)) return { code: 404, error: '问题不存在' };

    const parsed = normalizeContent(raw, ANSWER_MAX);
    if (parsed.error) return parsed;

    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO answers (question_id, content, created_at, likes, dislikes)
      VALUES (?, ?, ?, 0, 0)
    `).run(questionId, parsed.text, now);

    return {
      answer: {
        id: Number(info.lastInsertRowid),
        content: parsed.text,
        createdAt: now,
        likes: 0,
        dislikes: 0,
      },
    };
  }

  /** 点赞 / 点踩：只累加数量，不做任何用户去重 */
  function voteAnswer(answerId, vote) {
    if (vote !== 'like' && vote !== 'dislike') {
      return { code: 400, error: '投票类型无效' };
    }

    const column = vote === 'like' ? 'likes' : 'dislikes';
    const info = db.prepare(
      `UPDATE answers SET ${column} = ${column} + 1 WHERE id = ?`
    ).run(answerId);
    if (!info.changes) return { code: 404, error: '回答不存在' };

    const row = db.prepare(`
      SELECT id, content, created_at AS createdAt, likes, dislikes
      FROM answers WHERE id = ?
    `).get(answerId);

    return { answer: toAnswer(row) };
  }

  /* ---------------- 启动日志 ---------------- */

  /** 启动时把数据库里的全部问题和回答打印到控制台 */
  function dumpAll() {
    const questions = db.prepare(
      'SELECT id, content, created_at AS createdAt FROM questions ORDER BY id'
    ).all();
    const answers = db.prepare(`
      SELECT id, question_id AS questionId, content, created_at AS createdAt, likes, dislikes
      FROM answers ORDER BY id
    `).all();

    if (!questions.length) return;

    const byQuestion = new Map();
    for (const a of answers) {
      const qid = Number(a.questionId);
      if (!byQuestion.has(qid)) byQuestion.set(qid, []);
      byQuestion.get(qid).push(a);
    }
  }

  return {
    listQuestions,
    createQuestion,
    listAnswers,
    createAnswer,
    voteAnswer,
    dumpAll,
  };
}

module.exports = { createStore, PAGE_SIZE, QUESTION_MAX, ANSWER_MAX };
