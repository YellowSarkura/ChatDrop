/**
 * 多任务上传 + 断点续传 端到端测试
 *
 * 验证点：
 *   A. 多文件并发上传（不是排队等前一个）
 *   B. 上传中途取消一个任务，其他任务不受影响  ← 用户核心诉求
 *   C. 断点续传：中断后重新上传同一文件，从断点继续而非从零开始
 *   D. 秒传：完全相同的文件二次上传直接命中
 *   E. 校验和：错误 sha256 返回 422
 *   F. 分片偏移错误时服务端返回正确 offset
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const sender = () => Buffer.from(JSON.stringify({
  sid: 'multi-test', name: '多任务测试', color: '#8b5cf6',
})).toString('base64url');

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

/* ---------------- 底层调用 ---------------- */

async function initUpload({ name, size, mime, fingerprint }) {
  const r = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': sender() },
    body: JSON.stringify({ name, size, mime, fingerprint }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function putChunk(sessionId, token, offset, buf) {
  const r = await fetch(`${BASE}/api/upload/chunk?sessionId=${sessionId}&token=${encodeURIComponent(token || '')}&offset=${offset}`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': sender(), 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function complete(sessionId, token, sha) {
  const r = await fetch(`${BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': sender() },
    body: JSON.stringify({ sessionId, token, sha256: sha }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function cancel(sessionId, token) {
  const r = await fetch(`${BASE}/api/upload/cancel?sessionId=${sessionId}&token=${encodeURIComponent(token || '')}`, { method: 'POST' });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const listTasks = async () =>
  (await (await fetch(`${BASE}/api/upload/list`)).json());

/* ---------------- 测试 ---------------- */

(async () => {
  // 清空
  await fetch(`${BASE}/api/clear`, { method: 'POST' });
  await sleep(300);

  const MB = 1024 * 1024;

  /* ============ A. 并发上传 3 个文件 ============ */
  console.log('\n=== A. 并发上传 3 个文件（应同时进行）===');

  const files = [
    { name: 'a.bin', data: crypto.randomBytes(2 * MB) },
    { name: 'b.bin', data: crypto.randomBytes(2 * MB) },
    { name: 'c.bin', data: crypto.randomBytes(2 * MB) },
  ];

  const inits = [];
  for (const f of files) {
    const r = await initUpload({
      name: f.name, size: f.data.length, mime: 'application/octet-stream',
      fingerprint: `${f.name}|${f.data.length}|1`,
    });
    inits.push(r);
  }

  const allOk = inits.every((r) => r.status === 200 && r.body.sessionId);
  check('3 个会话同时建立', allOk,
    inits.map((r) => r.body.sessionId ? 'ok' : r.body.error).join(','));

  const taskList = await listTasks();
  check('服务端同时跟踪 3 个活跃会话', taskList.active === 3, `active=${taskList.active}`);

  // 并发发送分片
  const sends = inits.map((r, i) =>
    putChunk(r.body.sessionId, r.body.token, 0, files[i].data)
  );
  const sendRes = await Promise.all(sends);
  check('3 个文件并发写入成功',
    sendRes.every((x) => x.status === 200),
    sendRes.map((x) => x.status).join(','));

  // 完成
  const comps = [];
  for (let i = 0; i < files.length; i++) {
    comps.push(await complete(inits[i].body.sessionId, inits[i].body.token, sha256(files[i].data)));
  }
  check('3 个文件全部完成并入库',
    comps.every((x) => x.status === 200 && x.body.message),
    comps.map((x) => x.status).join(','));

  /* ============ B. 取消一个，其他不受影响 ============ */
  console.log('\n=== B. 取消一个任务，其他任务不受影响 ===');

  const big1 = crypto.randomBytes(3 * MB);
  const big2 = crypto.randomBytes(3 * MB);

  const r1 = await initUpload({ name: 'keep.bin', size: big1.length, mime: 'application/octet-stream', fingerprint: 'keep|1' });
  const r2 = await initUpload({ name: 'drop.bin', size: big2.length, mime: 'application/octet-stream', fingerprint: 'drop|1' });

  // 两个都先发一半
  await putChunk(r1.body.sessionId, r1.body.token, 0, big1.subarray(0, MB));
  await putChunk(r2.body.sessionId, r2.body.token, 0, big2.subarray(0, MB));

  // 取消 drop，keep 继续
  const cancelRes = await cancel(r2.body.sessionId, r2.body.token);
  check('取消 drop.bin', cancelRes.status === 200);

  // keep 继续传完
  const keepRest = await putChunk(r1.body.sessionId, r1.body.token, MB, big1.subarray(MB));
  check('keep.bin 未受取消影响，继续写入', keepRest.status === 200, `status=${keepRest.status}`);

  const keepDone = await complete(r1.body.sessionId, r1.body.token, sha256(big1));
  check('keep.bin 正常完成', keepDone.status === 200);

  // drop 的会话应已消失
  const afterCancel = await listTasks();
  const dropStill = afterCancel.sessions.some((s) => s.id === r2.body.sessionId);
  check('drop.bin 会话已移除', !dropStill);

  /* ============ C. 断点续传 ============ */
  console.log('\n=== C. 断点续传（中断后从断点继续）===');

  const resumeData = crypto.randomBytes(4 * MB);
  const fp = `resume.bin|${resumeData.length}|999`;

  // 第一次：只传 1MB 就"断线"（模拟）
  const init1 = await initUpload({ name: 'resume.bin', size: resumeData.length, mime: 'application/octet-stream', fingerprint: fp });
  await putChunk(init1.body.sessionId, init1.body.token, 0, resumeData.subarray(0, MB));

  // 第二次：同指纹重新 init，应返回 offset=1MB
  const init2 = await initUpload({ name: 'resume.bin', size: resumeData.length, mime: 'application/octet-stream', fingerprint: fp });
  const resumed = init2.body.resumed === true && init2.body.offset === MB;
  check('重新上传时返回续传偏移', resumed,
    `resumed=${init2.body.resumed} offset=${init2.body.offset} (期望 ${MB})`);

  // 从断点继续传剩余部分
  const rest = await putChunk(init2.body.sessionId, init2.body.token, MB, resumeData.subarray(MB));
  check('从断点继续写入', rest.status === 200);

  const resumeDone = await complete(init2.body.sessionId, init2.body.token, sha256(resumeData));
  check('续传后校验通过并完成', resumeDone.status === 200,
    resumeDone.body.error || 'ok');

  /* ============ D. 秒传 ============ */
  console.log('\n=== D. 秒传（相同文件二次上传）===');

  const instant = await initUpload({
    name: 'resume.bin', size: resumeData.length,
    mime: 'application/octet-stream', fingerprint: fp,
  });
  check('相同指纹直接秒传命中', instant.body.instant === true,
    `instant=${instant.body.instant}`);

  /* ============ E. 校验和不匹配 ============ */
  console.log('\n=== E. 校验和错误应拒绝 ===');

  const badData = crypto.randomBytes(1 * MB);
  const badInit = await initUpload({
    name: 'bad.bin', size: badData.length,
    mime: 'application/octet-stream', fingerprint: 'bad|1',
  });
  await putChunk(badInit.body.sessionId, badInit.body.token, 0, badData);
  const badDone = await complete(badInit.body.sessionId, badInit.body.token, '0'.repeat(64));
  check('错误 sha256 返回 422', badDone.status === 422, `status=${badDone.status}`);

  /* ============ F. 偏移错误 ============ */
  console.log('\n=== F. 偏移不匹配应返回正确 offset ===');

  const offData = crypto.randomBytes(2 * MB);
  const offInit = await initUpload({
    name: 'off.bin', size: offData.length,
    mime: 'application/octet-stream', fingerprint: 'off|1',
  });
  await putChunk(offInit.body.sessionId, offInit.body.token, 0, offData.subarray(0, MB));
  // 故意用错误偏移
  const wrong = await putChunk(offInit.body.sessionId, offInit.body.token, 999999, Buffer.from('x'));
  check('错误偏移返回 409 且告知 expectedOffset',
    wrong.status === 409 && typeof wrong.body.expectedOffset === 'number',
    `status=${wrong.status} expected=${wrong.body.expectedOffset}`);

  /* ============ 汇总 ============ */
  const failed = results.filter((r) => !r.pass);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);

  // 清理
  await fetch(`${BASE}/api/clear`, { method: 'POST' });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常:', e.message);
  process.exit(1);
});
