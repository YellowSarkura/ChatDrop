/**
 * 扫码互传全流程测试
 *
 * 模拟真实场景：
 *   1. 电脑（A）打开页面，展示二维码
 *   2. 手机（B）扫到链接 → 打开带 ?pair= 的页面
 *   3. B 自动把 A 选为收件人
 *   4. B 发文件给 A
 *   5. 验证 A 收到、其他设备收不到
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const crypto = require('crypto');
const CDP_HTTP = 'http://127.0.0.1:9333';
const BASE = 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, '_shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const hdr = (sid, name) => Buffer.from(JSON.stringify({
  sid, name, color: '#3b82f6',
})).toString('base64url');

async function getPage() {
  const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  return list.find((t) => t.type === 'page' && t.url.includes('8787'));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result.value;
  }
  async shot(n) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
  }
}

(async () => {
  const page = await getPage();
  if (!page) throw new Error('找不到页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 清空数据
  await fetch(`${BASE}/api/clear?scope=all`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': hdr('test-admin', '管理员') },
  }).catch(() => {});

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3000);

  /* ===== 1. 电脑 A 的配对码 ===== */
  console.log('\n=== 1. 电脑生成配对码 ===');
  await cdp.eval('document.getElementById("btnMore").click()');
  await sleep(400);
  await cdp.eval('document.getElementById("btnShowPair").click()');
  await sleep(900);

  const pairInfo = await cdp.eval(`
    (() => ({
      link: document.getElementById('pairLinkInput').value,
      hasSvg: !!document.querySelector('#qrHolder svg'),
      sid: localStorage.getItem('chatdrop.sid'),
    }))()
  `);
  check('二维码已生成', pairInfo.hasSvg === true);
  check('链接含 pair 参数', /pair=/.test(pairInfo.link), pairInfo.link);

  const pcSid = pairInfo.sid;
  const pairKey = new URL(pairInfo.link).searchParams.get('pair');
  check('pair 参数等于本机 sid', pairKey === pcSid, `pair=${pairKey} sid=${pcSid}`);

  await cdp.shot('24-flow-qr.png');
  await cdp.eval('document.getElementById("btnPairCancel").click()');
  await sleep(400);

  /* ===== 2. 手机 B 打开配对链接 ===== */
  console.log('\n=== 2. 手机打开配对链接 ===');

  // 用独立身份模拟手机
  const phoneSid = 'phone-' + crypto.randomBytes(6).toString('hex');
  const phoneName = '小米手机';

  // 手机通过 API 建立 SSE（模拟打开页面）
  const phoneCtrl = new AbortController();
  fetch(`${BASE}/api/events?sid=${encodeURIComponent(phoneSid)}&name=${encodeURIComponent(phoneName)}&color=%23f59e0b`, {
    signal: phoneCtrl.signal,
  }).catch(() => {});

  await sleep(1000);

  // 手机访问带 pair 的链接 → 服务端记录不了，这是前端行为
  // 这里直接验证：手机发消息时带 to=电脑sid
  const phoneMsgs = await (await fetch(`${BASE}/api/messages`, {
    headers: { 'X-Chat-Sender': hdr(phoneSid, phoneName) },
  })).json();
  check('手机能看到自己的会话', Array.isArray(phoneMsgs.messages));

  /* ===== 3. 手机发文件给电脑 ===== */
  console.log('\n=== 3. 手机发文件给电脑 ===');

  // 用真实 PNG（假的 jpg 数据会让浏览器解码失败）
  const realPng = fs.readFileSync(path.join(ROOT, '_shots', 'real-test.png'));
  const data = realPng;
  const sha = crypto.createHash('sha256').update(data).digest('hex');

  const initR = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(phoneSid, phoneName) },
    body: JSON.stringify({
      name: '手机照片.png',
      size: data.length,
      mime: 'image/png',
      fingerprint: 'phone|' + Date.now(),
      to: pcSid,     // ← 扫码后自动带上电脑的 sid
    }),
  });
  const initJ = await initR.json();
  check('手机建立上传会话', !!initJ.sessionId, initJ.error || 'ok');

  await fetch(`${BASE}/api/upload/chunk?sessionId=${initJ.sessionId}&token=${encodeURIComponent(initJ.token)}&offset=0`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': hdr(phoneSid, phoneName), 'Content-Type': 'application/octet-stream' },
    body: data,
  });

  const compR = await fetch(`${BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(phoneSid, phoneName) },
    body: JSON.stringify({ sessionId: initJ.sessionId, token: initJ.token, sha256: sha }),
  });
  check('文件上传完成', compR.status === 200);

  /* ===== 4. 验证送达 ===== */
  console.log('\n=== 4. 验证定向送达 ===');

  const pcView = await (await fetch(`${BASE}/api/messages?sid=${pcSid}&name=电脑`, {
    headers: { 'X-Chat-Sender': hdr(pcSid, '电脑') },
  })).json();
  const pcGot = pcView.messages.find((m) => m.file && m.file.name === '手机照片.png');
  check('电脑收到手机的文件', !!pcGot, pcGot ? `to=${pcGot.to}` : '未收到');
  check('文件的收件人是电脑', pcGot && pcGot.to === pcSid, pcGot ? pcGot.to : 'n/a');

  // 第三方设备
  const otherView = await (await fetch(`${BASE}/api/messages?sid=other-device&name=第三方`, {
    headers: { 'X-Chat-Sender': hdr('other-device', '第三方') },
  })).json();
  const otherGot = otherView.messages.find((m) => m.file && m.file.name === '手机照片.png');
  check('第三方设备看不到该文件', !otherGot);

  /* ===== 5. 电脑页面实时收到 ===== */
  console.log('\n=== 5. 电脑页面实时显示 ===');
  await sleep(1500);

  const pcUi = await cdp.eval(`
    (() => {
      const msgs = [...document.querySelectorAll('.msg')];
      const fileMsg = msgs.find(n => n.textContent.includes('手机照片'));
      return {
        total: msgs.length,
        found: !!fileMsg,
        privateTag: fileMsg?.querySelector('.msg-private')?.textContent || null
      };
    })()
  `);
  check('电脑界面显示收到的文件', pcUi.found === true, JSON.stringify(pcUi));
  check('该文件标记为私密', !!pcUi.privateTag, pcUi.privateTag || '无');

  await cdp.shot('25-flow-received.png');

  /* ===== 6. 下载验证 ===== */
  console.log('\n=== 6. 文件可下载 ===');
  if (pcGot) {
    const dl = await fetch(`${BASE}/api/file/${pcGot.id}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const dlSha = crypto.createHash('sha256').update(buf).digest('hex');
    check('文件可下载且内容一致', dlSha === sha, `${buf.length} bytes`);
  }

  phoneCtrl.abort();

  /* ===== 汇总 ===== */
  const fails = results.filter((x) => !x.pass);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - fails.length}，失败 ${fails.length}`);

  ws.close();
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
