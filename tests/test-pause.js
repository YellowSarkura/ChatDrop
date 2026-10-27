/**
 * 暂停 / 继续 / 取消 行为差异测试（含 token 鉴权）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:8787';
const PARTS = path.join(ROOT, 'data', 'parts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const sender = () => Buffer.from(JSON.stringify({
  sid: 'pause-test', name: '暂停测试', color: '#10b981',
})).toString('base64url');

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const partFiles = () => { try { return fs.readdirSync(PARTS); } catch { return []; } };

async function init(name, size, fp) {
  const r = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': sender() },
    body: JSON.stringify({ name, size, mime: 'application/octet-stream', fingerprint: fp }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function chunk(sid, token, offset, buf) {
  const r = await fetch(
    `${BASE}/api/upload/chunk?sessionId=${sid}&token=${encodeURIComponent(token)}&offset=${offset}`,
    {
      method: 'POST',
      headers: { 'X-Chat-Sender': sender(), 'Content-Type': 'application/octet-stream' },
      body: buf,
    }
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function pause(sid, token) {
  const r = await fetch(
    `${BASE}/api/upload/pause?sessionId=${sid}&token=${encodeURIComponent(token)}`,
    { method: 'POST', headers: { 'X-Chat-Sender': sender() } }
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function resume(sid, token) {
  const r = await fetch(
    `${BASE}/api/upload/resume?sessionId=${sid}&token=${encodeURIComponent(token)}`,
    { method: 'POST', headers: { 'X-Chat-Sender': sender() } }
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function cancel(sid, token) {
  const r = await fetch(
    `${BASE}/api/upload/cancel?sessionId=${sid}&token=${encodeURIComponent(token)}`,
    { method: 'POST', headers: { 'X-Chat-Sender': sender() } }
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function complete(sid, token, sha) {
  const r = await fetch(`${BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': sender() },
    body: JSON.stringify({ sessionId: sid, token, sha256: sha }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const list = async () => (await (await fetch(`${BASE}/api/upload/list`)).json());

(async () => {
  await fetch(`${BASE}/api/clear?scope=all`, { method: 'POST' }).catch(() => {});
  await sleep(400);
  const MB = 1024 * 1024;

  /* ===== A. 暂停保留数据 ===== */
  console.log('\n=== A. 暂停：保留已传数据 ===');

  const data = crypto.randomBytes(4 * MB);
  const fp = `pause-test.bin|${data.length}|111`;

  const i1 = await init('pause-test.bin', data.length, fp);
  check('建立会话', i1.status === 200 && !!i1.body.sessionId);
  check('会话带 token', !!i1.body.token);

  await chunk(i1.body.sessionId, i1.body.token, 0, data.subarray(0, MB));
  await chunk(i1.body.sessionId, i1.body.token, MB, data.subarray(MB, 2 * MB));

  const beforeParts = partFiles().length;
  const p = await pause(i1.body.sessionId, i1.body.token);
  const afterParts = partFiles().length;

  check('暂停成功', p.status === 200, `offset=${p.body.offset}`);
  check('暂停返回正确偏移', p.body.offset === 2 * MB, `offset=${p.body.offset} 期望=${2 * MB}`);
  check('.part 文件保留（未删除）', afterParts >= beforeParts && afterParts > 0, `parts=${afterParts}`);

  const afterPauseList = await list();
  const pausedTask = afterPauseList.sessions.find((s) => s.id === i1.body.sessionId);
  check('会话仍在，状态为 paused', pausedTask && pausedTask.status === 'paused',
    pausedTask ? pausedTask.status : 'not found');

  /* ===== B. 继续 ===== */
  console.log('\n=== B. 继续：从暂停点续传 ===');

  const r = await resume(i1.body.sessionId, i1.body.token);
  check('恢复成功', r.status === 200);
  check('恢复返回断点位置', r.body.offset === 2 * MB, `offset=${r.body.offset}`);

  await chunk(i1.body.sessionId, i1.body.token, 2 * MB, data.subarray(2 * MB));
  const done = await complete(i1.body.sessionId, i1.body.token, sha256(data));
  check('续传后完成并校验通过', done.status === 200, done.body.error || 'ok');

  /* ===== C. 取消 ===== */
  console.log('\n=== C. 取消：删除已传数据 ===');

  const data2 = crypto.randomBytes(3 * MB);
  const i2 = await init('cancel-test.bin', data2.length, 'cancel|1');
  await chunk(i2.body.sessionId, i2.body.token, 0, data2.subarray(0, MB));

  const partsBefore = partFiles().length;
  const c = await cancel(i2.body.sessionId, i2.body.token);
  await sleep(400);
  const partsAfter = partFiles().length;

  check('取消成功', c.status === 200);
  check('.part 文件已删除', partsAfter < partsBefore, `before=${partsBefore} after=${partsAfter}`);

  const afterCancel = await list();
  check('会话已移除', !afterCancel.sessions.some((s) => s.id === i2.body.sessionId));

  /* ===== D. 暂停不影响其他任务 ===== */
  console.log('\n=== D. 暂停一个，另一个照常完成 ===');

  const dA = crypto.randomBytes(2 * MB);
  const dB = crypto.randomBytes(2 * MB);

  const ia = await init('taskA.bin', dA.length, 'taskA|1');
  const ib = await init('taskB.bin', dB.length, 'taskB|1');

  await chunk(ia.body.sessionId, ia.body.token, 0, dA.subarray(0, MB));
  await chunk(ib.body.sessionId, ib.body.token, 0, dB.subarray(0, MB));

  await pause(ia.body.sessionId, ia.body.token);

  await chunk(ib.body.sessionId, ib.body.token, MB, dB.subarray(MB));
  const bDone = await complete(ib.body.sessionId, ib.body.token, sha256(dB));
  check('暂停 A 后 B 仍能完成', bDone.status === 200, bDone.body.error || 'ok');

  await resume(ia.body.sessionId, ia.body.token);
  await chunk(ia.body.sessionId, ia.body.token, MB, dA.subarray(MB));
  const aDone = await complete(ia.body.sessionId, ia.body.token, sha256(dA));
  check('A 恢复后也能完成', aDone.status === 200, aDone.body.error || 'ok');

  const fails = results.filter((x) => !x.pass);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - fails.length}，失败 ${fails.length}`);
  await fetch(`${BASE}/api/clear?scope=all`, { method: 'POST' }).catch(() => {});
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
