/** 检查 SSE 连接状态 */
const CDP_HTTP = 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve(null); } }, 20000);
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

(async () => {
  const page = await getPage();
  if (!page) { console.log('无页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  console.log('\n=== SSE 连接状态 ===\n');
  const st = await cdp.eval(`
    (() => ({
      href: location.href,
      dotClass: document.getElementById('statusDot')?.className,
      text: document.getElementById('statusText')?.textContent,
      onlineCount: document.getElementById('onlineCount')?.textContent,
      recipientLabel: document.getElementById('recipientLabel')?.textContent,
      isTouch: document.body.classList.contains('touch-device'),
      hasImageBtn: !!document.getElementById('btnPickImage'),
      hasFileBtn: !!document.getElementById('btnPickFile'),
      emptyTitle: document.getElementById('emptyTitle')?.textContent,
    }))()
  `);
  for (const [k, v] of Object.entries(st || {})) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== 等待 3 秒后重查 ===\n');
  await sleep(3000);
  const st2 = await cdp.eval(`
    (() => ({
      dotClass: document.getElementById('statusDot')?.className,
      text: document.getElementById('statusText')?.textContent,
    }))()
  `);
  console.log('  状态点:', st2.dotClass);
  console.log('  文字:', st2.text);
  console.log('');
  console.log((st2.dotClass || '').includes('online') ? '  [PASS] 已连接' : '  [FAIL] 未连接');

  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
