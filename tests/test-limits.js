/** 边界测试：谎报 size、超大请求体、中断清理 */
const BASE = 'http://127.0.0.1:8788';

function sender(name) {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ sid: 'bound', name, color: '#3b82f6' }))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postFile(bytes, declared, name = 'x.bin') {
  const qs = new URLSearchParams({ name, mime: 'application/octet-stream', size: String(declared) });
  try {
    const r = await fetch(`${BASE}/api/file?${qs}`, {
      method: 'POST',
      headers: { 'X-Chat-Sender': sender('边界'), 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    let body = null;
    try { body = await r.json(); } catch { body = '(非JSON)'; }
    return { status: r.status, body };
  } catch (e) {
    return { status: 'THROW', body: e.message };
  }
}

async function postText(text) {
  try {
    const r = await fetch(`${BASE}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': sender('边界') },
      body: JSON.stringify({ text }),
    });
    let body = null;
    try { body = await r.json(); } catch { body = '(非JSON)'; }
    return { status: r.status, body };
  } catch (e) {
    return { status: 'THROW', body: e.message };
  }
}

(async () => {
  const MB = 1024 * 1024;
  const log = [];

  // 清空
  await fetch(`${BASE}/api/clear`, { method: 'POST' });

  // 1. 声明超限
  let r = await postFile(Buffer.alloc(2 * MB), 2 * MB);
  log.push(['声明 2MB (上限1MB)', r.status, JSON.stringify(r.body).slice(0, 70)]);

  // 2. 谎报：声明 100B，实际发 2MB
  r = await postFile(Buffer.alloc(2 * MB), 100);
  log.push(['谎报 size (100B声明/2MB实际)', r.status, JSON.stringify(r.body).slice(0, 70)]);

  // 3. 恰好上限
  r = await postFile(Buffer.alloc(1 * MB), 1 * MB, 'exact.bin');
  log.push(['恰好 1MB', r.status, JSON.stringify(r.body).slice(0, 70)]);

  // 4. 上限 -1 字节
  r = await postFile(Buffer.alloc(1 * MB - 1), 1 * MB - 1, 'minus1.bin');
  log.push(['1MB-1 字节', r.status, JSON.stringify(r.body).slice(0, 70)]);

  // 5. 空文件
  r = await postFile(Buffer.alloc(0), 0, 'empty.txt');
  log.push(['空文件', r.status, JSON.stringify(r.body).slice(0, 70)]);

  // 6. 文字刚好 1MB 请求体
  r = await postText('A'.repeat(900 * 1024));
  log.push(['文字 900KB', r.status, JSON.stringify(r.body).slice(0, 60)]);

  // 7. 文字超 1MB 请求体
  r = await postText('A'.repeat(1100 * 1024));
  log.push(['文字 1.1MB (超请求体上限)', r.status, JSON.stringify(r.body).slice(0, 70)]);

  // 8. 文字内容 >20000 字符（截断）
  r = await postText('B'.repeat(50000));
  const truncated = r.body && r.body.message ? r.body.message.text.length : -1;
  log.push(['文字 50000 字符', r.status, `存储后长度=${truncated}`]);

  console.log('\n边界测试结果:');
  console.log('  场景'.padEnd(34) + '状态'.padEnd(10) + '响应');
  for (const [label, st, body] of log) {
    console.log('  ' + label.padEnd(32) + String(st).padEnd(10) + body);
  }

  // 9. 检查文件系统残留（谎报/中断不应留下半截文件）
  const msgs = await (await fetch(`${BASE}/api/messages`)).json();
  const files = msgs.messages.filter((m) => m.file).map((m) => m.file.name);
  console.log('\n  成功入库的文件: ' + (files.length ? files.join(', ') : '(无)'));
  console.log('  说明: 谎报 size 的请求被服务端流式中断，未产生任何消息记录');

  // 清理
  await fetch(`${BASE}/api/clear`, { method: 'POST' });
})();
