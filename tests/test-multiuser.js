/**
 * 多用户隔离测试（修复后验证）
 *
 * 验证 LocalSend 式的三重隔离：
 *   - token：服务端生成的不可伪造凭证
 *   - ownerSid：会话归属
 *   - 消息归属：只能删自己的
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const BASE = 'http://127.0.0.1:8787';
const FILES = path.join(ROOT, 'data', 'files');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const hdr = (sid, name) => Buffer.from(JSON.stringify({
  sid, name, color: '#3b82f6',
})).toString('base64url');

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

async function init(sid, name, fname, size, fp) {
  const r = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(sid, name) },
    body: JSON.stringify({ name: fname, size, mime: 'application/octet-stream', fingerprint: fp }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function chunk(sid, name, sessionId, token, offset, buf) {
  const r = await fetch(
    `${BASE}/api/upload/chunk?sessionId=${sessionId}&token=${encodeURIComponent(token || '')}&offset=${offset}`,
    {
      method: 'POST',
      headers: { 'X-Chat-Sender': hdr(sid, name), 'Content-Type': 'application/octet-stream' },
      body: buf,
    }
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function complete(sid, name, sessionId, token, sha) {
  const r = await fetch(`${BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(sid, name) },
    body: JSON.stringify({ sessionId, token, sha256: sha }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  await fetch(`${BASE}/api/clear?scope=all`, { method: 'POST' }).catch(() => {});
  await sleep(400);

  const MB = 1024 * 1024;

  /* ===== 1. 秒传不再跨用户 ===== */
  console.log('\n=== 1. 秒传不能跨用户命中 ===');

  const aData = crypto.randomBytes(2 * MB);
  const bData = crypto.randomBytes(2 * MB);
  const sameFp = `会议记录.docx|${2 * MB}|1700000000000`;

  const iA = await init('user-A', '小王', '会议记录.docx', aData.length, sameFp);
  check('A 拿到 token', !!iA.body.token, iA.body.token ? '有' : '无');
  await chunk('user-A', '小王', iA.body.sessionId, iA.body.token, 0, aData);
  const dA = await complete('user-A', '小王', iA.body.sessionId, iA.body.token, sha256(aData));
  check('A 上传完成', dA.status === 200);

  const iB = await init('user-B', '小李', '会议记录.docx', bData.length, sameFp);
  check('B 不会被秒传命中（拿到新会话）',
    !iB.body.instant && !!iB.body.sessionId,
    `instant=${iB.body.instant} hasSession=${!!iB.body.sessionId}`);

  // B 正常上传自己的文件
  await chunk('user-B', '小李', iB.body.sessionId, iB.body.token, 0, bData);
  const dB = await complete('user-B', '小李', iB.body.sessionId, iB.body.token, sha256(bData));
  check('B 能正常上传自己的文件', dB.status === 200);

  const msgs1 = (await (await fetch(`${BASE}/api/messages`)).json()).messages;
  const sameName = msgs1.filter((m) => m.file && m.file.name === '会议记录.docx');
  check('两条同名文件各自独立存在', sameName.length === 2, `count=${sameName.length}`);

  /* ===== 2. token 不可伪造 ===== */
  console.log('\n=== 2. token 校验 ===');

  const sA2 = await init('user-A', '小王', 'token测试.bin', 3 * MB, 'tok|1');
  const fakeToken = 'this-is-a-forged-token';

  const forged = await chunk('user-B', '小李', sA2.body.sessionId, fakeToken, 0, Buffer.alloc(MB));
  check('伪造 token 被拒绝', forged.status === 403, `status=${forged.status}`);

  const noToken = await chunk('user-B', '小李', sA2.body.sessionId, '', 0, Buffer.alloc(MB));
  check('无 token 被拒绝', noToken.status === 403, `status=${noToken.status}`);

  const rightToken = await chunk('user-A', '小王', sA2.body.sessionId, sA2.body.token, 0, Buffer.alloc(MB));
  check('正确 token 可写', rightToken.status === 200, `status=${rightToken.status}`);

  /* ===== 3. 不能接管他人会话 ===== */
  console.log('\n=== 3. 断点续传不能跨用户接管 ===');

  const fp3 = `项目资料.zip|${4 * MB}|1700000001000`;
  const bigA = crypto.randomBytes(4 * MB);
  const sA3 = await init('user-A', '小王', '项目资料.zip', bigA.length, fp3);
  await chunk('user-A', '小王', sA3.body.sessionId, sA3.body.token, 0, bigA.subarray(0, MB));

  // B 用同样指纹 init
  const sB3 = await init('user-B', '小李', '项目资料.zip', 4 * MB, fp3);
  const hijacked = sB3.body.resumed === true && sB3.body.sessionId === sA3.body.sessionId;
  check('B 无法接管 A 的会话', !hijacked,
    `B 得到 ${sB3.body.sessionId ? sB3.body.sessionId.slice(0, 8) : 'none'}, A 是 ${sA3.body.sessionId.slice(0, 8)}`);

  /* ===== 4. 消息删除权限 ===== */
  console.log('\n=== 4. 只能删除自己的消息 ===');

  const msgs2 = (await (await fetch(`${BASE}/api/messages`)).json()).messages;
  const aMsg = msgs2.find((m) => m.sender && m.sender.sid === 'user-A');
  const bMsg = msgs2.find((m) => m.sender && m.sender.sid === 'user-B');

  if (aMsg) {
    const r = await fetch(`${BASE}/api/message/${aMsg.id}`, {
      method: 'DELETE',
      headers: { 'X-Chat-Sender': hdr('user-B', '小李') },
    });
    check('B 删除 A 的消息被拒绝', r.status === 403, `status=${r.status}`);
  }

  if (bMsg) {
    const r = await fetch(`${BASE}/api/message/${bMsg.id}`, {
      method: 'DELETE',
      headers: { 'X-Chat-Sender': hdr('user-B', '小李') },
    });
    check('B 删除自己的消息成功', r.status === 200, `status=${r.status}`);
  }

  /* ===== 5. 清空权限 ===== */
  console.log('\n=== 5. 清空全部需要管理员 ===');

  const beforeCount = (await (await fetch(`${BASE}/api/messages`)).json()).messages.length;

  const allClear = await fetch(`${BASE}/api/clear?scope=all`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': hdr('user-B', '小李') },
  });
  const afterAll = (await (await fetch(`${BASE}/api/messages`)).json()).messages.length;
  check('非管理员清空全部被拒绝', allClear.status === 403 && afterAll === beforeCount,
    `status=${allClear.status} 消息数 ${beforeCount}->${afterAll}`);

  const mineClear = await fetch(`${BASE}/api/clear?scope=mine`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': hdr('user-B', '小李') },
  });
  const afterMine = (await (await fetch(`${BASE}/api/messages`)).json()).messages;
  const aStill = afterMine.some((m) => m.sender && m.sender.sid === 'user-A');
  check('清空自己的消息成功，A 的不受影响',
    mineClear.status === 200 && aStill,
    `status=${mineClear.status} A的消息还在=${aStill}`);

  /* ===== 汇总 ===== */
  const fails = results.filter((x) => !x.pass);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - fails.length}，失败 ${fails.length}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
