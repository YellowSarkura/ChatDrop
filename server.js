'use strict';

/**
 * ChatDrop — 局域网聊天式互传服务
 * 零第三方依赖，仅用 Node 内置模块。
 *
 * 特性:
 *   - 文字消息是一等公民（不是伪装成文件的文本）
 *   - 图片内联预览、文件原样流式传输
 *   - SSE 实时广播，多端同步
 *   - 多任务并发上传 + 断点续传（借鉴 LocalSend 协议精华）
 *   - 分片传输，中断后从断点继续，不影响其他任务
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const PART_DIR = path.join(DATA_DIR, 'parts');   // 未完成的分片/断点数据
const MSG_FILE = path.join(DATA_DIR, 'messages.jsonl');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_MB || 4096) * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 3000;
// 同时进行的上传任务上限（LocalSend 允许多 upload 并行，这里给个合理上限）
const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT || 4);
// 分片大小：4MB。分片便于断点续传与并发
const CHUNK_SIZE = Number(process.env.CHUNK_MB || 4) * 1024 * 1024;
// 管理员设备 ID 列表（逗号分隔）。只有管理员能「清空全部」
const ADMIN_SIDS = (process.env.ADMIN_SIDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// 上传空闲超时：连接上「连续多久没有数据流动」才判定失败。
// Node 默认的 server.requestTimeout(5min) 是按整个请求计时，
// 慢速网络下大文件会被中途切断，所以上传路由单独放宽。
const UPLOAD_IDLE_TIMEOUT = Number(process.env.UPLOAD_IDLE_MS || 10 * 60 * 1000);

fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(PART_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 消息存储                                                            */
/* ------------------------------------------------------------------ */

let messages = loadMessages();

function loadMessages() {
  let raw = '';
  try {
    raw = fs.readFileSync(MSG_FILE, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && m.id && m.type) out.push(m);
    } catch {
      /* 忽略损坏行 */
    }
  }
  return out;
}

function addMessage(msg) {
  messages.push(msg);
  if (messages.length > HISTORY_LIMIT) messages = messages.slice(-HISTORY_LIMIT);
  fs.appendFile(MSG_FILE, JSON.stringify(msg) + '\n', (err) => {
    if (err) console.error('[warn] 写入消息失败:', err.message);
  });

  // 定向消息只推给收发双方；广播消息推给所有人
  broadcastMessage(msg);
  return msg;
}

/* ------------------------------------------------------------------ */
/* 在线设备 + 定向推送                                                  */
/* ------------------------------------------------------------------ */

/** SSE 连接表：连接 -> 设备身份 */
const sseClients = new Set();

/** 在线设备表：sid -> { sid, name, color, connections:Set, lastSeen } */
const onlineDevices = new Map();

function deviceList() {
  const now = Date.now();
  return [...onlineDevices.values()]
    // 超过 90 秒没有任何连接或心跳的设备不显示
    .filter((d) => d.connections.size > 0 || (now - d.lastSeen) < 90000)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((d) => ({
      sid: d.sid,
      name: d.name,
      color: d.color,
      connections: d.connections.size,
    }));
}

/**
 * 设备上线/刷新
 *
 * connections 用 Set 记录每条 SSE 连接，而不是数字计数：
 *   同一设备开多个标签页会真的累加，
 *   关掉一个也只移除对应那条，不会把整个设备删掉。
 */
function touchDevice(sender, connId) {
  if (!sender || !sender.sid) return;
  const cur = onlineDevices.get(sender.sid) || {
    sid: sender.sid,
    name: sender.name,
    color: sender.color,
    connections: new Set(),
    lastSeen: Date.now(),
  };
  cur.name = sender.name || cur.name;
  cur.color = sender.color || cur.color;
  if (connId) cur.connections.add(connId);
  cur.lastSeen = Date.now();
  onlineDevices.set(sender.sid, cur);
  broadcast({ type: 'presence', data: { devices: deviceList() } });
}

/** 某条连接断开 */
function dropDevice(sid, connId) {
  const cur = onlineDevices.get(sid);
  if (!cur) return;
  if (connId) cur.connections.delete(connId);
  else cur.connections.clear();

  if (cur.connections.size === 0) {
    onlineDevices.delete(sid);
  } else {
    cur.lastSeen = Date.now();
  }
  broadcast({ type: 'presence', data: { devices: deviceList() } });
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

/**
 * 消息定向投递
 *
 * msg.to 为空 → 广播，所有人可见
 * msg.to 有值 → 只有发送者和目标设备可见
 *
 * 这样既能公开聊天，也能私聊传文件，互不干扰。
 */
function broadcastMessage(msg) {
  const frame = `data: ${JSON.stringify({ type: 'message', data: msg })}\n\n`;

  for (const client of sseClients) {
    try {
      if (shouldDeliver(msg, client.sid)) {
        client.res.write(frame);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

/** 判断某条消息是否对指定设备可见 */
function isVisibleTo(msg, sid) {
  if (!msg.to || msg.to === '*') return true;             // 广播
  if (msg.to === sid) return true;                        // 单播收件人
  if (Array.isArray(msg.to) && msg.to.includes(sid)) return true; // 多播收件人
  if (msg.sender && msg.sender.sid === sid) return true;  // 发件人自己
  return false;
}

/**
 * 规范化收件人
 *   undefined / null / '*' / [] → null（广播）
 *   'sid'                        → 'sid'（单播）
 *   ['a','b']                    → ['a','b']（多播，对齐 LocalSend SendMode.multiple）
 */
function normalizeRecipient(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === '*') return null;
  if (Array.isArray(raw)) {
    const list = raw.map((s) => String(s).trim()).filter(Boolean).slice(0, 64);
    if (!list.length) return null;
    return list.length === 1 ? list[0] : list;
  }
  return String(raw).trim().slice(0, 64) || null;
}

/** 判断消息是否投递给某设备（用于 SSE 定向推送） */
function shouldDeliver(msg, sid) {
  return isVisibleTo(msg, sid);
}

setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(': ping\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, 25000).unref();

/* ------------------------------------------------------------------ */
/* 扩展（extensions/<name>/index.js 导出 create(context)）             */
/* ------------------------------------------------------------------ */

const EXTENSION_DEFS = [
  require('./extensions/gomoku'),
  require('./extensions/technicalQA'),
  require('./extensions/sharedSheet'),
];

// 注入主服务通用能力；扩展内部不直接访问设备表 / SSE 连接
const extensions = EXTENSION_DEFS.map((ext) => ext.create({
  broadcast,
  getDevice: (sid) => onlineDevices.get(sid),
  readBody,
  sendJSON,
  parseSender,
  dataDir: DATA_DIR,
}));

/* ------------------------------------------------------------------ */
/* 多任务上传会话管理                                                  */
/* ------------------------------------------------------------------ */

/**
 * 上传会话：
 *   { id, name, size, mime, fingerprint, sender, received, status,
 *     partPath, hash, createdAt, updatedAt, error, stored }
 *
 * 借鉴 LocalSend 的 sessionId + 断点续传思路：
 *   - 用指纹(fingerprint)识别同一文件，中断后从已接收字节继续
 *   - 分片写入同一 .part 文件，全部到齐后再校验并改名
 *   - 每个会话独立，互不阻塞（弃掉 LocalSend 的单会话 409 阻塞）
 */
const sessions = new Map();

function sessionSummary(s) {
  return {
    id: s.id,
    name: s.name,
    size: s.size,
    mime: s.mime,
    received: s.received,
    status: s.status,
    progress: s.size > 0 ? Math.min(100, (s.received / s.size) * 100) : 0,
    error: s.error || null,
    createdAt: s.createdAt,
  };
}

/**
 * 活跃上传数
 *
 * 两个关键设计：
 *   1. 只有「最近确实有数据流动」的会话才计入（避免僵尸会话永久占位）
 *   2. 按用户统计，不按全局（一个人占满不应挡住其他人）
 */
const ACTIVE_WINDOW_MS = 30 * 1000; // 30 秒内有数据流动才算活跃

function activeUploads(ownerSid) {
  const now = Date.now();
  let n = 0;
  for (const s of sessions.values()) {
    if (s.status !== 'uploading') continue;
    if (now - s.updatedAt >= ACTIVE_WINDOW_MS) continue;
    if (ownerSid !== undefined && s.ownerSid !== ownerSid) continue;
    n++;
  }
  return n;
}

/** 把长期无活动的 uploading 会话降级为 paused，释放并发槽位 */
function releaseStaleSlots() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === 'uploading' && now - s.updatedAt >= ACTIVE_WINDOW_MS) {
      s.status = 'paused';
      s.error = '长时间无活动，已自动暂停';
    }
  }
}

/** 找出可用于续传的会话（同指纹、同大小、未完成） */
function findResumable(fingerprint, size, ownerSid) {
  if (!fingerprint || !ownerSid) return null;
  for (const s of sessions.values()) {
    // 关键：必须同一个上传者，否则 B 会接管 A 的会话导致文件被污染
    if (s.fingerprint === fingerprint && s.size === size &&
        s.ownerSid === ownerSid &&
        (s.status === 'uploading' || s.status === 'paused' || s.status === 'pending')) {
      return s;
    }
  }
  return null;
}

/** 已完成的同指纹文件（秒传）—— 仅限同一上传者 */
function findCompleted(fingerprint, ownerSid) {
  if (!fingerprint || !ownerSid) return null;
  for (const m of messages) {
    if (m.file && m.file.fingerprint === fingerprint && m.file.stored &&
        m.sender && m.sender.sid === ownerSid) {
      const full = path.join(FILES_DIR, m.file.stored);
      if (fs.existsSync(full)) return m;
    }
  }
  return null;
}

/**
 * 会话鉴权（借鉴 LocalSend 的 sessionId + token + IP 三重校验）
 *
 * 返回 { ok: true, session } 或 { ok: false, code, error }
 *
 * 校验顺序：
 *   1. 会话存在
 *   2. token 匹配（服务端生成，不可伪造）
 *   3. ownerSid 匹配（辅助，防止同一浏览器多标签串号）
 */
function authorizeSession(url, req) {
  const sessionId = url.searchParams.get('sessionId') || '';
  const token = url.searchParams.get('token') || '';
  const session = sessions.get(sessionId);

  if (!session) {
    return { ok: false, code: 404, error: '会话不存在或已过期' };
  }

  // token 校验：这是真正的安全边界
  if (session.token && token !== session.token) {
    return { ok: false, code: 403, error: '令牌无效' };
  }

  // 归属校验：辅助防线
  const who = parseSender(req);
  if (session.ownerSid && who.sid !== session.ownerSid) {
    return { ok: false, code: 403, error: '无权操作他人的上传会话' };
  }

  return { ok: true, session, sender: who };
}

/** 清理长时间无进展的会话及其 .part 文件 */
function sweepSessions(maxIdleMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, s] of sessions) {
    // 已完成/已取消的会话，短暂保留供客户端查询，之后清掉
    if (s.status === 'done' || s.status === 'canceled') {
      if (now - s.updatedAt > 2 * 60 * 1000) sessions.delete(id);
      continue;
    }
    // 长期无活动的会话：删除并清理 .part
    if (now - s.updatedAt > maxIdleMs) {
      sessions.delete(id);
      if (s.partPath) fsp.rm(s.partPath, { force: true }).catch(() => {});
    }
  }
}
setInterval(sweepSessions, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 流式计算文件 sha256，避免大文件占内存 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 清理用户提交的文件名，去掉路径与危险字符 */
function sanitizeName(name) {
  let n = String(name || 'file').replace(/[\\/\x00-\x1f\x7f]/g, '_').trim();
  if (!n) n = 'file';
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 16);
    n = n.slice(0, 160) + ext;
  }
  return n;
}

/** 从请求头解析发送者身份（base64url JSON） */
function parseSender(req) {
  const raw = req.headers['x-chat-sender'];
  let sender = { sid: 'anon', name: '匿名设备', color: '#64748b' };
  if (raw) {
    try {
      const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
      if (decoded && typeof decoded === 'object') {
        sender = {
          sid: String(decoded.sid || 'anon').slice(0, 64),
          name: String(decoded.name || '匿名设备').slice(0, 40),
          color: /^#[0-9a-f]{3,8}$/i.test(decoded.color || '') ? decoded.color : '#64748b',
        };
      }
    } catch {
      /* 保持默认 */
    }
  }
  return sender;
}

/**
 * 解析身份（含 URL 参数回退）
 *
 * 浏览器原生 EventSource 无法自定义请求头，
 * 所以 SSE 连接的身份必须通过 ?sid=&name=&color= 传递。
 * 优先用请求头，缺失时回退到查询参数。
 */
function parseIdentity(req, url) {
  const fromHeader = parseSender(req);
  if (fromHeader.sid !== 'anon') return fromHeader;

  if (url) {
    const sid = url.searchParams.get('sid');
    if (sid) {
      const color = url.searchParams.get('color') || '#64748b';
      return {
        sid: String(sid).slice(0, 64),
        name: String(url.searchParams.get('name') || '匿名设备').slice(0, 40),
        color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#64748b',
      };
    }
  }
  return fromHeader;
}

/** 枚举本机可供手机访问的 IPv4 地址 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      out.push({ iface: name, address: info.address });
    }
  }
  // 常见家用网段优先
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  out.sort((a, b) => rank(a.address) - rank(b.address));
  return out;
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

// 启动时的时间戳，作为资源版本号。进程重启即变化。
const ASSET_VERSION = Date.now().toString(36);

// 是否启用 Service Worker 缓存。
// 开发/内网使用时默认关闭：SW 的缓存优先策略会让改了代码
// 的手机一直加载旧版本，而旧 SW 又会缓存 sw.js 自身，
// 导致永远检测不到更新，形成死锁。
const ENABLE_SW = process.env.ENABLE_SW === '1';

function serveStatic(req, res, pathname, baseDir = PUBLIC_DIR) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);

  // 去掉 ?v=xxx 查询串（只用于击穿缓存）
  const cleanPath = rel.split('?')[0];

  // 关闭 SW 时，对 sw.js 返回一个能自我注销的脚本
  if (!ENABLE_SW && cleanPath === '/sw.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    res.end(`
/* Service Worker 已在此实例禁用。
   这个脚本会注销自身并清空所有缓存，让浏览器回到无 SW 状态。 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', async (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      const regs = await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.navigate(c.url));
    } catch (e) {}
  })());
});
self.addEventListener('fetch', () => {});
`);
    return;
  }

  const target = path.join(baseDir, path.normalize(cleanPath).replace(/^([/\\])+/, ''));

  // 目录穿越防护
  const normalizedRoot = path.resolve(baseDir) + path.sep;
  if (!path.resolve(target).startsWith(normalizedRoot)) {
    sendJSON(res, 403, { error: 'forbidden' });
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    // 开发阶段一律禁用缓存，避免改了代码看不到效果。
    // HTML 还要额外注入版本号替换。
    const isHtml = ext === '.html';

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (isHtml) {
      // 读取 HTML，把静态资源引用补上版本号，强制刷新
      fs.readFile(target, 'utf8', (e, html) => {
        if (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('500');
          return;
        }
        const tagged = html
          // 给所有本地 css / js / manifest 引用补版本号（含扩展资源），强制刷新
          .replace(/(href|src)="(\/[^"]+\.(?:css|js|webmanifest))"/g,
                   `$1="$2?v=${ASSET_VERSION}"`)
          // 把版本号注入到页面，供 app.js 自检对比
          .replace('<head>', `<head>\n<script>window.__APP_VERSION__="${ASSET_VERSION}";</script>`);
        const buf = Buffer.from(tagged, 'utf8');
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': buf.length,
        });
        res.end(buf);
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 文件下载（支持 Range）                                              */
/* ------------------------------------------------------------------ */

function serveFileById(req, res, id, url) {
  const msg = messages.find((m) => m.id === id);
  if (!msg || !msg.file || !msg.file.stored) {
    sendJSON(res, 404, { error: 'not found' });
    return;
  }
  const full = path.join(FILES_DIR, msg.file.stored);
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      sendJSON(res, 404, { error: 'file missing' });
      return;
    }

    const encodedName = encodeURIComponent(msg.file.name);
    const disposition = url.searchParams.get('dl') === '1' ? 'attachment' : 'inline';

    const headers = {
      'Content-Type': msg.file.mime || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) {
          start = Math.max(0, st.size - end);
          end = st.size - 1;
        }
        if (start !== null && end === null) end = st.size - 1;
        if (start === null || start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          res.end();
          return;
        }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(full, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(full).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJSON(res, 400, { error: 'bad url' });
    return;
  }
  const pathname = url.pathname;
  const method = req.method || 'GET';

  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    /* --- 服务信息 --- */
    if (pathname === '/api/info' && method === 'GET') {
      sendJSON(res, 200, {
        app: 'ChatDrop',
        version: '1.0.0',
        assetVersion: ASSET_VERSION,   // 用于前端检测服务端是否已更新
        port: PORT,
        addresses: lanAddresses(),
        count: messages.length,
      });
      return;
    }

    /* --- 历史消息 --- */
    if (pathname === '/api/messages' && method === 'GET') {
      const since = url.searchParams.get('since');
      const who = parseIdentity(req, url);
      const sid = who.sid;

      // 只返回对该设备可见的消息（广播 + 发给它的 + 它发出的）
      let visible = messages.filter((m) => isVisibleTo(m, sid));

      if (since) {
        const idx = visible.findIndex((m) => m.id === since);
        if (idx >= 0) visible = visible.slice(idx + 1);
      }
      sendJSON(res, 200, { messages: visible, devices: deviceList() });
      return;
    }

    /* --- 在线设备列表 --- */
    if (pathname === '/api/devices' && method === 'GET') {
      sendJSON(res, 200, { devices: deviceList() });
      return;
    }

    /* --- SSE 实时流（带设备身份） --- */
    if (pathname === '/api/events' && method === 'GET') {
      // EventSource 不能设请求头，身份从查询参数取
      const who = parseIdentity(req, url);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');

      const connId = crypto.randomUUID();
      const client = { res, sid: who.sid, connId };
      sseClients.add(client);

      res.write(`data: ${JSON.stringify({
        type: 'hello',
        count: messages.length,
        sid: who.sid,
        devices: deviceList(),
      })}\n\n`);

      touchDevice(who, connId);

      const cleanup = () => {
        sseClients.delete(client);
        dropDevice(who.sid, connId);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    /* --- 发送文字 --- */
    if (pathname === '/api/text' && method === 'POST') {
      const body = await readBody(req, MAX_TEXT_BYTES);
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendJSON(res, 400, { error: 'invalid json' });
        return;
      }
      const text = String(payload.text || '').trim();
      if (!text) {
        sendJSON(res, 400, { error: 'empty text' });
        return;
      }

      // 收件人：'*' 表示广播，否则是目标设备的 sid
      // 对齐 LocalSend 的 SendMode：single(1:1) / multiple(1:n)
      const to = normalizeRecipient(payload.to);

      const msg = addMessage({
        id: crypto.randomUUID(),
        type: 'text',
        text: text.slice(0, 20000),
        sender: parseSender(req),
        to,
        ts: Date.now(),
      });
      sendJSON(res, 200, { message: msg });
      return;
    }

    /* --- 扩展路由（五子棋等） --- */
    for (const ext of extensions) {
      if (await ext.handle(req, res, pathname, method)) return;
    }

    /* ================================================================
       多任务上传 API
       ================================================================ */

    /* --- 列出所有上传任务 --- */
    if (pathname === '/api/upload/list' && method === 'GET') {
      sendJSON(res, 200, {
        sessions: [...sessions.values()].map(sessionSummary),
        active: activeUploads(),
        max: MAX_CONCURRENT_UPLOADS,
      });
      return;
    }

    /* --- 初始化上传会话（断点续传握手） --- */
    if (pathname === '/api/upload/init' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      let p;
      try { p = JSON.parse(body.toString('utf8')); } catch {
        sendJSON(res, 400, { error: 'invalid json' });
        return;
      }

      const name = sanitizeName(p.name);
      const size = Number(p.size || 0);
      const mime = String(p.mime || 'application/octet-stream');
      const fingerprint = String(p.fingerprint || '').slice(0, 128);

      const sender = parseSender(req);
      const ownerSid = sender.sid;
      // 收件人：文件也要能定向发送（对齐 LocalSend 的发送到指定设备）
      const to = normalizeRecipient(p.to);

      if (size <= 0) { sendJSON(res, 400, { error: '文件大小无效' }); return; }
      if (size > MAX_FILE_BYTES) {
        sendJSON(res, 413, { error: `文件超过上限 ${Math.round(MAX_FILE_BYTES / 1048576)} MB` });
        return;
      }

      // 秒传：仅当同一上传者已传过完全相同的文件
      // （不能跨用户命中，否则 B 会拿到 A 的文件）
      const done = findCompleted(fingerprint, ownerSid);
      if (done) {
        sendJSON(res, 200, {
          instant: true,
          message: done,
          messageId: done.id,
        });
        return;
      }

      // 断点续传：仅限同一上传者的未完成会话
      const existing = findResumable(fingerprint, size, ownerSid);
      if (existing) {
        existing.status = 'uploading';
        existing.updatedAt = Date.now();
        sendJSON(res, 200, {
          sessionId: existing.id,
          token: existing.token,   // 续传必须把原 token 交回，否则后续请求会被 403
          offset: existing.received,
          resumed: true,
          chunkSize: CHUNK_SIZE,
        });
        return;
      }

      // 并发控制说明：
      // 借鉴 LocalSend —— 协议层不对并发设硬上限，因为每个会话天然独立
      // （各自独立的 .part 文件与 token），强行限制只会制造「自己卡自己」。
      // 真正的资源保护交给：单文件大小上限 + 会话超时清理 + 磁盘配额。
      // 前端负责把并行数控制在合理范围（默认 3）。

      const id = crypto.randomUUID();
      // 借鉴 LocalSend：每个会话一个不可猜的 token，
      // 后续所有操作都必须同时提供 sessionId + token。
      // ownerSid 是客户端自报的（可伪造），token 是服务端生成的（不可伪造）。
      const token = crypto.randomBytes(24).toString('base64url');

      const session = {
        id,
        token,
        name,
        size,
        mime,
        fingerprint,
        sender,
        ownerSid,           // 会话归属（辅助校验）
        to,                 // 收件人
        received: 0,
        status: 'uploading',
        partPath: path.join(PART_DIR, id + '.part'),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
      };
      sessions.set(id, session);
      broadcast({ type: 'upload', data: { action: 'start', session: sessionSummary(session) } });

      sendJSON(res, 200, {
        sessionId: id,
        token,              // 客户端需保存并在后续请求中带回
        offset: 0,
        resumed: false,
        chunkSize: CHUNK_SIZE,
      });
      return;
    }

    /* --- 上传分片（支持任意偏移，实现断点续传） --- */
    if (pathname === '/api/upload/chunk' && method === 'POST') {
      req.setTimeout(UPLOAD_IDLE_TIMEOUT);

      const auth = authorizeSession(url, req);
      if (!auth.ok) { sendJSON(res, auth.code, { error: auth.error }); return; }

      const session = auth.session;
      const offset = Number(url.searchParams.get('offset') || 0);

      if (session.status === 'canceled') { sendJSON(res, 409, { error: '会话已取消' }); return; }
      if (offset !== session.received) {
        // 偏移不匹配：告知客户端应从何处继续
        sendJSON(res, 409, {
          error: '偏移不匹配',
          expectedOffset: session.received,
        });
        return;
      }

      let written = 0;
      let aborted = false;
      let abortReason = '';

      const out = fs.createWriteStream(session.partPath, { flags: 'a' });

      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };

        const fail = (reason) => {
          if (aborted) return;
          aborted = true;
          abortReason = reason;
          try { req.unpipe(out); } catch { /* ignore */ }
          if (!req.destroyed) req.destroy();
          if (out.closed || out.destroyed) { done(); return; }
          let h = false;
          const once = () => { if (!h) { h = true; done(); } };
          out.once('close', once);
          out.once('error', once);
          out.destroy();
          setTimeout(once, 500);
        };

        req.setTimeout(UPLOAD_IDLE_TIMEOUT, () => fail('idle timeout'));

        req.on('data', (c) => {
          written += c.length;
          session.received += c.length;
          session.updatedAt = Date.now();
          if (session.received > session.size) fail('overflow');
        });
        req.on('aborted', () => fail('client aborted'));
        req.on('timeout', () => fail('timeout'));
        req.pipe(out);
        out.on('finish', () => { if (!aborted) done(); });
        out.on('error', () => fail('write error'));
        req.on('error', () => fail('read error'));
      });

      if (aborted) {
        // 已写入的字节保留在 .part 中，便于下次续传
        session.status = 'paused';
        session.updatedAt = Date.now();
        session.error = abortReason;
        broadcast({ type: 'upload', data: { action: 'pause', session: sessionSummary(session) } });
        if (!res.headersSent) {
          sendJSON(res, abortReason === 'idle timeout' ? 408 : 400, {
            error: abortReason === 'idle timeout' ? '分片传输超时' : '分片传输中断',
            received: session.received,
          });
        }
        return;
      }

      broadcast({ type: 'upload', data: { action: 'progress', session: sessionSummary(session) } });
      sendJSON(res, 200, { received: session.received, offset: session.received });
      return;
    }

    /* --- 完成上传：校验 + 落库 --- */
    if (pathname === '/api/upload/complete' && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      let p;
      try { p = JSON.parse(body.toString('utf8')); } catch {
        sendJSON(res, 400, { error: 'invalid json' });
        return;
      }

      const session = sessions.get(String(p.sessionId || ''));
      if (!session) { sendJSON(res, 404, { error: '会话不存在或已过期' }); return; }

      // 完成请求的鉴权：token 放在 body 里
      const token = String(p.token || '');
      if (session.token && token !== session.token) {
        sendJSON(res, 403, { error: '令牌无效' });
        return;
      }
      const who = parseSender(req);
      if (session.ownerSid && who.sid !== session.ownerSid) {
        sendJSON(res, 403, { error: '无权操作他人的上传会话' });
        return;
      }

      const expectSha = String(p.sha256 || '').toLowerCase();

      // 核对大小
      let stat;
      try { stat = await fsp.stat(session.partPath); } catch {
        sendJSON(res, 400, { error: '上传数据不完整' });
        return;
      }
      if (stat.size !== session.size) {
        session.status = 'paused';
        session.received = stat.size;
        session.updatedAt = Date.now();
        sendJSON(res, 409, {
          error: '大小不匹配',
          expected: session.size,
          actual: stat.size,
          offset: stat.size,
        });
        return;
      }

      // 校验 sha256（借鉴 LocalSend 的 422 Checksum mismatch）
      if (expectSha) {
        const actual = await hashFile(session.partPath);
        if (actual !== expectSha) {
          await fsp.rm(session.partPath, { force: true }).catch(() => {});
          session.status = 'failed';
          session.error = 'checksum mismatch';
          session.received = 0;
          session.updatedAt = Date.now();
          broadcast({ type: 'upload', data: { action: 'fail', session: sessionSummary(session) } });
          sendJSON(res, 422, { error: '校验失败，请重新上传', expected: expectSha, actual });
          return;
        }
      }

      // 改名到正式目录
      const ext = path.extname(session.name).slice(0, 20);
      const stored = session.id + ext;
      const finalPath = path.join(FILES_DIR, stored);

      try {
        await fsp.rename(session.partPath, finalPath);
      } catch (e) {
        // 跨盘等情况回退为复制
        try {
          await fsp.copyFile(session.partPath, finalPath);
          await fsp.rm(session.partPath, { force: true });
        } catch {
          sendJSON(res, 500, { error: '保存文件失败' });
          return;
        }
      }

      session.status = 'done';
      session.stored = stored;
      session.updatedAt = Date.now();

      const isImage = /^image\//i.test(session.mime);
      const msg = addMessage({
        id: session.id,
        type: isImage ? 'image' : 'file',
        sender: session.sender,
        to: session.to || null,
        ts: Date.now(),
        file: {
          name: session.name,
          size: session.size,
          mime: session.mime,
          stored,
          fingerprint: session.fingerprint || null,
        },
      });

      broadcast({ type: 'upload', data: { action: 'done', session: sessionSummary(session) } });
      sendJSON(res, 200, { message: msg });
      return;
    }

    /* --- 取消上传（只影响该任务，丢弃已传数据） --- */
    if (pathname === '/api/upload/cancel' && method === 'POST') {
      const auth = authorizeSession(url, req);
      if (!auth.ok) { sendJSON(res, auth.code, { error: auth.error }); return; }
      const session = auth.session;

      session.status = 'canceled';
      session.updatedAt = Date.now();
      await fsp.rm(session.partPath, { force: true }).catch(() => {});
      sessions.delete(session.id);
      broadcast({ type: 'upload', data: { action: 'cancel', session: { id: session.id } } });
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* --- 暂停上传（保留已传数据，可随时继续） --- */
    if (pathname === '/api/upload/pause' && method === 'POST') {
      const auth = authorizeSession(url, req);
      if (!auth.ok) { sendJSON(res, auth.code, { error: auth.error }); return; }
      const session = auth.session;

      if (session.status === 'done') {
        sendJSON(res, 409, { error: '该任务已完成' });
        return;
      }

      // 已写入磁盘的字节数才是真实可续传位置
      let onDisk = session.received;
      try {
        const st = await fsp.stat(session.partPath);
        onDisk = st.size;
      } catch { /* 文件还不存在则保持 received */ }

      session.status = 'paused';
      session.received = onDisk;
      session.updatedAt = Date.now();
      broadcast({ type: 'upload', data: { action: 'pause', session: sessionSummary(session) } });
      sendJSON(res, 200, { ok: true, offset: onDisk });
      return;
    }

    /* --- 恢复上传（返回断点位置） --- */
    if (pathname === '/api/upload/resume' && method === 'POST') {
      const auth = authorizeSession(url, req);
      if (!auth.ok) { sendJSON(res, auth.code, { error: auth.error }); return; }
      const session = auth.session;

      if (session.status === 'done') {
        sendJSON(res, 409, { error: '该任务已完成' });
        return;
      }

      let onDisk = session.received;
      try {
        const st = await fsp.stat(session.partPath);
        onDisk = st.size;
      } catch { onDisk = 0; }

      session.status = 'uploading';
      session.received = onDisk;
      session.updatedAt = Date.now();
      broadcast({ type: 'upload', data: { action: 'resume', session: sessionSummary(session) } });
      sendJSON(res, 200, { ok: true, offset: onDisk, size: session.size });
      return;
    }

    /* --- 单请求上传（兼容旧接口 / 小文件） --- */
    if (pathname === '/api/file' && method === 'POST') {
      // 上传是长耗时请求：解除全局 requestTimeout（默认 5 分钟），
      // 改为「无数据流动才超时」的空闲超时，避免慢速大文件被中途切断。
      req.setTimeout(UPLOAD_IDLE_TIMEOUT);

      const rawName = url.searchParams.get('name') || 'file';
      const mime = url.searchParams.get('mime') || 'application/octet-stream';
      const declared = Number(url.searchParams.get('size') || 0);
      const name = sanitizeName(rawName);

      if (declared > MAX_FILE_BYTES) {
        sendJSON(res, 413, { error: `文件超过上限 ${Math.round(MAX_FILE_BYTES / 1048576)} MB` });
        return;
      }

      const id = crypto.randomUUID();
      const ext = path.extname(name).slice(0, 20);
      const stored = id + ext;
      const full = path.join(FILES_DIR, stored);

      const out = fs.createWriteStream(full);
      let size = 0;
      let aborted = false;
      let abortReason = '';

      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const fail = (reason) => {
          if (aborted) return;
          aborted = true;
          abortReason = reason;

          // 先解除管道，避免 req.destroy() 让 pipe 自动 end(out)
          try { req.unpipe(out); } catch { /* ignore */ }

          if (!req.destroyed) req.destroy();

          // 等待写入流彻底关闭（fd 释放）后才 resolve。
          // 不能在 'finish' 上就 resolve：finish 只代表数据交给了内核，
          // 此时 fd 仍打开，Windows 上删除会 EBUSY，文件就残留了。
          const finish = () => done();
          if (out.closed || out.destroyed) {
            finish();
            return;
          }
          let handled = false;
          const once = () => {
            if (handled) return;
            handled = true;
            finish();
          };
          out.once('close', once);
          out.once('error', once);
          out.destroy();
          setTimeout(once, 500);
        };

        // 空闲超时：连接建立后长时间没有数据流入才判失败
        req.setTimeout(UPLOAD_IDLE_TIMEOUT, () => fail('idle timeout'));

        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_FILE_BYTES) {
            fail('size exceeded');
          }
        });
        req.on('aborted', () => fail('client aborted'));
        req.on('timeout', () => fail('timeout'));
        req.pipe(out);
        out.on('finish', () => {
          if (!aborted) done();
        });
        out.on('error', () => fail('write error'));
        req.on('error', () => fail('read error'));
      });

      if (aborted) {
        // 流此时已关闭（fd 已释放），可以安全删除半截文件
        await new Promise((r) => fs.rm(full, { force: true }, () => r()));
        if (!res.headersSent) {
          const msg = abortReason === 'size exceeded'
            ? `文件超过上限 ${Math.round(MAX_FILE_BYTES / 1048576)} MB`
            : abortReason === 'idle timeout' || abortReason === 'timeout'
              ? '上传超时（长时间无数据传输）'
              : '上传已中断';
          sendJSON(res, abortReason === 'size exceeded' ? 413 : 400, { error: msg });
        }
        return;
      }
      if (size === 0) {
        await new Promise((r) => fs.rm(full, { force: true }, () => r()));
        sendJSON(res, 400, { error: '空文件' });
        return;
      }

      const isImage = /^image\//i.test(mime);
      const msg = addMessage({
        id,
        type: isImage ? 'image' : 'file',
        sender: parseSender(req),
        to: normalizeRecipient(url.searchParams.get('to')),
        ts: Date.now(),
        file: { name, size, mime, stored },
      });
      sendJSON(res, 200, { message: msg });
      return;
    }

    /* --- 文件下载 --- */
    const fileMatch = /^\/api\/file\/([0-9a-f-]{36})$/.exec(pathname);
    if (fileMatch && method === 'GET') {
      serveFileById(req, res, fileMatch[1], url);
      return;
    }

    /* --- 删除单条 --- */
    const delMatch = /^\/api\/message\/([0-9a-f-]{36})$/.exec(pathname);
    if (delMatch && method === 'DELETE') {
      const id = delMatch[1];
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 0) {
        sendJSON(res, 404, { error: '消息不存在' });
        return;
      }

      const who = parseSender(req);
      const target = messages[idx];

      // 默认允许删除任意消息（局域网共用场景）。
      // 设置了 ADMIN_SIDS 时才限制为只能删自己的。
      if (ADMIN_SIDS.length > 0 && target.sender && target.sender.sid &&
          target.sender.sid !== who.sid && !ADMIN_SIDS.includes(who.sid)) {
        sendJSON(res, 403, { error: '只能删除自己发送的消息' });
        return;
      }

      const [removed] = messages.splice(idx, 1);
      rewriteMessages();
      if (removed.file && removed.file.stored) {
        fs.unlink(path.join(FILES_DIR, removed.file.stored), () => {});
      }
      broadcast({ type: 'delete', data: { id } });
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* --- 清空消息 --- */
    if (pathname === '/api/clear' && method === 'POST') {
      const who = parseSender(req);
      const scope = url.searchParams.get('scope') || 'mine';

      // 默认允许清空全部：这是运行在自己电脑上的局域网工具，
      // 只有打开这个页面的人才能操作，不属于多租户场景。
      // 需要严格隔离时设置 ADMIN_SIDS 环境变量即可收紧。
      const restriction = ADMIN_SIDS.length > 0 && !ADMIN_SIDS.includes(who.sid);

      if (scope === 'all') {
        if (restriction) {
          sendJSON(res, 403, {
            error: '清空全部需要管理员权限（服务端已设置 ADMIN_SIDS 限制）',
          });
          return;
        }
        messages = [];
        rewriteMessages();
        for (const f of fs.readdirSync(FILES_DIR)) {
          fs.unlink(path.join(FILES_DIR, f), () => {});
        }
        for (const f of fs.readdirSync(PART_DIR)) {
          fs.unlink(path.join(PART_DIR, f), () => {});
        }
        sessions.clear();
        broadcast({ type: 'clear', data: {} });
        sendJSON(res, 200, { ok: true, scope: 'all' });
        return;
      }

      // 默认：只清自己的消息
      const mine = messages.filter((m) => m.sender && m.sender.sid === who.sid);
      const keep = messages.filter((m) => !(m.sender && m.sender.sid === who.sid));
      messages = keep;
      rewriteMessages();
      for (const m of mine) {
        if (m.file && m.file.stored) {
          fs.unlink(path.join(FILES_DIR, m.file.stored), () => {});
        }
      }
      broadcast({ type: 'clear-mine', data: { sid: who.sid } });
      sendJSON(res, 200, { ok: true, scope: 'mine', removed: mine.length });
      return;
    }

    /* --- 静态资源 --- */
    if (method === 'GET' || method === 'HEAD') {
      const ext = extensions.find((e) =>
        pathname === e.mount || pathname.startsWith(e.mount + '/'));
      if (ext) {
        serveStatic(req, res, pathname.slice(ext.mount.length) || '/', ext.staticDir);
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    sendJSON(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (err && err.code === 413) {
      sendJSON(res, 413, { error: '内容过大' });
      return;
    }
    console.error('[error]', err);
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' });
    else res.end();
  }
});

function rewriteMessages() {
  const tmp = MSG_FILE + '.tmp';
  const body = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, MSG_FILE);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

server.listen(PORT, HOST, () => {
  const ips = lanAddresses();
  console.log('');
  console.log('  ChatDrop 已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  本机访问 : http://localhost:${PORT}`);
  for (const i of ips) {
    console.log(`  手机访问 : http://${i.address}:${PORT}   (${i.iface})`);
  }
  console.log(`  数据目录 : ${DATA_DIR}`);
  console.log(`  文件上限 : ${Math.round(MAX_FILE_BYTES / 1048576)} MB`);
  console.log('  ─────────────────────────────────────────');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
