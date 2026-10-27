/** 测试清空全部消息 */
const BASE = 'http://127.0.0.1:8787';
const CDP_HTTP = 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const r = this.pending.get(m.id);
        this.pending.delete(m.id);
        r(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve(null); } }, 25000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { __err: (d.exception && (d.exception.description || d.exception.value)) || d.text };
    }
    return r && r.result ? r.result.value : null;
  }
}

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  /* ===== 1. API 层测试 ===== */
  console.log('\n=== 1. API 清空 ===\n');

  // 先造几条消息
  for (const i of [1, 2, 3]) {
    await fetch(`${BASE}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr('user-' + i, '用户' + i) },
      body: JSON.stringify({ text: `测试消息 ${i}` }),
    });
  }

  let list = await (await fetch(`${BASE}/api/messages`)).json();
  check('造了 3 条消息', list.messages.length >= 3, `count=${list.messages.length}`);

  // 不带身份头清空（模拟前端原来的 bug）
  const noHdr = await fetch(`${BASE}/api/clear?scope=all`, { method: 'POST' });
  console.log(`  不带身份头: status=${noHdr.status}`);

  // 带身份头
  const withHdr = await fetch(`${BASE}/api/clear?scope=all`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': hdr('clear-user', '清空者') },
  });
  const body = await withHdr.json().catch(() => ({}));
  check('带身份头清空成功', withHdr.status === 200, `status=${withHdr.status} ${JSON.stringify(body)}`);

  list = await (await fetch(`${BASE}/api/messages`)).json();
  check('清空后消息为 0', list.messages.length === 0, `count=${list.messages.length}`);

  /* ===== 2. 界面层测试 ===== */
  console.log('\n=== 2. 界面清空 ===\n');

  const page = await getPage();
  if (!page) { console.log('  无页面，跳过界面测试'); process.exit(0); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3500);

  // 自动确认 confirm
  await cdp.eval(`window.confirm = () => true`);

  // 发两条消息
  for (const t of ['界面测试消息A', '界面测试消息B']) {
    await cdp.eval(`
      (() => {
        const i = document.getElementById('input');
        i.value = ${JSON.stringify(t)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btnSend').click();
        return true;
      })()
    `);
    await sleep(700);
  }

  const beforeCount = await cdp.eval(`document.querySelectorAll('.msg').length`);
  check('界面有 2 条消息', beforeCount === 2, `count=${beforeCount}`);

  // 打开菜单点清空
  await cdp.eval(`document.getElementById('btnMore').click()`);
  await sleep(400);
  await cdp.eval(`document.getElementById('btnClear').click()`);
  await sleep(1500);

  const afterCount = await cdp.eval(`document.querySelectorAll('.msg').length`);
  check('清空后界面无消息', afterCount === 0, `count=${afterCount}`);

  const hasEmpty = await cdp.eval(`!!document.getElementById('emptyState')`);
  check('显示空状态', hasEmpty === true);

  // 服务端确认
  const serverList = await (await fetch(`${BASE}/api/messages`)).json();
  check('服务端也已清空', serverList.messages.length === 0, `count=${serverList.messages.length}`);

  const fails = results.filter((x) => !x.pass);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - fails.length}，失败 ${fails.length}`);

  ws.close();
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
