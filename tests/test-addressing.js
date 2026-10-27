/**
 * 设备寻址与定向发送测试
 * 验证对齐 LocalSend SendMode 的三种模式：
 *   - 广播（所有人可见）
 *   - 单播（1:1，只有目标能看到）
 *   - 多播（1:n，指定多台）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hdr = (sid, name) => Buffer.from(JSON.stringify({
  sid, name, color: '#3b82f6',
})).toString('base64url');

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

async function sendText(sid, name, text, to) {
  const r = await fetch(`${BASE}/api/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(sid, name) },
    body: JSON.stringify({ text, to }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function getMessages(sid, name) {
  const r = await fetch(`${BASE}/api/messages`, {
    headers: { 'X-Chat-Sender': hdr(sid, name) },
  });
  return (await r.json()).messages;
}

(async () => {
  await fetch(`${BASE}/api/clear?scope=all`, { method: 'POST' }).catch(() => {});
  await sleep(400);

  /* ===== 1. 广播 ===== */
  console.log('\n=== 1. 广播消息（所有人可见）===');

  const b1 = await sendText('dev-A', '小王', '这是广播消息', undefined);
  check('广播发送成功', b1.status === 200);
  check('广播消息无 to 字段', !b1.body.message.to, `to=${b1.body.message.to}`);

  const aMsgs = await getMessages('dev-A', '小王');
  const bMsgs = await getMessages('dev-B', '小李');
  const cMsgs = await getMessages('dev-C', '小张');

  check('A 能看到广播', aMsgs.some((m) => m.text === '这是广播消息'));
  check('B 能看到广播', bMsgs.some((m) => m.text === '这是广播消息'));
  check('C 能看到广播', cMsgs.some((m) => m.text === '这是广播消息'));

  /* ===== 2. 单播 ===== */
  console.log('\n=== 2. 单播消息（1:1，仅目标可见）===');

  const p1 = await sendText('dev-A', '小王', '这是给B的私密消息', 'dev-B');
  check('单播发送成功', p1.status === 200);
  check('单播消息带 to 字段', p1.body.message.to === 'dev-B', `to=${p1.body.message.to}`);

  const aMsgs2 = await getMessages('dev-A', '小王');
  const bMsgs2 = await getMessages('dev-B', '小李');
  const cMsgs2 = await getMessages('dev-C', '小张');

  check('A（发件人）能看到自己的私密消息',
    aMsgs2.some((m) => m.text === '这是给B的私密消息'));
  check('B（收件人）能看到私密消息',
    bMsgs2.some((m) => m.text === '这是给B的私密消息'));
  check('C（第三方）看不到私密消息',
    !cMsgs2.some((m) => m.text === '这是给B的私密消息'));

  /* ===== 3. 多播 ===== */
  console.log('\n=== 3. 多播消息（1:n，指定多台）===');

  const m1 = await sendText('dev-A', '小王', '发给B和C', ['dev-B', 'dev-C']);
  check('多播发送成功', m1.status === 200);
  check('多播消息 to 是数组', Array.isArray(m1.body.message.to),
    JSON.stringify(m1.body.message.to));

  const aMsgs3 = await getMessages('dev-A', '小王');
  const bMsgs3 = await getMessages('dev-B', '小李');
  const cMsgs3 = await getMessages('dev-C', '小张');
  const dMsgs3 = await getMessages('dev-D', '小赵');

  check('B 能看到多播', bMsgs3.some((m) => m.text === '发给B和C'));
  check('C 能看到多播', cMsgs3.some((m) => m.text === '发给B和C'));
  check('D（未在列表）看不到多播',
    !dMsgs3.some((m) => m.text === '发给B和C'));

  /* ===== 4. 文件定向 ===== */
  console.log('\n=== 4. 文件也能定向发送 ===');

  const data = crypto.randomBytes(64 * 1024);
  const initR = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr('dev-A', '小王') },
    body: JSON.stringify({
      name: '私密文件.bin', size: data.length,
      mime: 'application/octet-stream', fingerprint: 'priv|1', to: 'dev-B',
    }),
  });
  const initJ = await initR.json();
  check('文件会话建立', !!initJ.sessionId);

  await fetch(`${BASE}/api/upload/chunk?sessionId=${initJ.sessionId}&token=${initJ.token}&offset=0`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': hdr('dev-A', '小王'), 'Content-Type': 'application/octet-stream' },
    body: data,
  });

  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const compR = await fetch(`${BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr('dev-A', '小王') },
    body: JSON.stringify({ sessionId: initJ.sessionId, token: initJ.token, sha256: sha }),
  });
  check('文件上传完成', compR.status === 200);

  const bFinal = await getMessages('dev-B', '小李');
  const cFinal = await getMessages('dev-C', '小张');
  const fileInB = bFinal.find((m) => m.file && m.file.name === '私密文件.bin');
  const fileInC = cFinal.find((m) => m.file && m.file.name === '私密文件.bin');

  check('B 能收到定向文件', !!fileInB);
  check('C 收不到定向文件', !fileInC);
  check('定向文件的 to 正确', fileInB && fileInB.to === 'dev-B',
    fileInB ? `to=${fileInB.to}` : 'n/a');

  /* ===== 5. 在线设备 ===== */
  console.log('\n=== 5. 在线设备列表 ===');

  // 开一个 SSE 连接注册设备
  const ctrl = new AbortController();
  const ssePromise = fetch(`${BASE}/api/events`, {
    headers: { 'X-Chat-Sender': hdr('dev-ONLINE', '在线测试') },
    signal: ctrl.signal,
  }).catch(() => null);

  await sleep(800);

  const devR = await fetch(`${BASE}/api/devices`);
  const devJ = await devR.json();
  check('在线设备出现在列表',
    devJ.devices.some((d) => d.sid === 'dev-ONLINE'),
    JSON.stringify(devJ.devices.map((d) => d.name)));

  ctrl.abort();
  await sleep(600);

  const devR2 = await fetch(`${BASE}/api/devices`);
  const devJ2 = await devR2.json();
  check('断开后从在线列表移除',
    !devJ2.devices.some((d) => d.sid === 'dev-ONLINE'),
    JSON.stringify(devJ2.devices.map((d) => d.name)));

  /* ===== 汇总 ===== */
  const fails = results.filter((x) => !x.pass);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - fails.length}，失败 ${fails.length}`);
  await fetch(`${BASE}/api/clear?scope=all`, { method: 'POST' }).catch(() => {});
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
