/** 模拟手机首次访问，验证无缓存干扰 */
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

(async () => {
  const page = await getPage();
  if (!page) { console.log('无页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  console.log('\n=== 1. 完全清理 ===\n');
  const cleared = await cdp.eval(`
    (async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      return { sw: regs.length, caches: keys.length };
    })()
  `);
  console.log('  清理 SW:', cleared?.sw, '缓存:', cleared?.caches);
  await cdp.send('Network.clearBrowserCache');

  console.log('\n=== 2. 手机尺寸 + 硬刷新 ===\n');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(4000);

  console.log('=== 3. 验证状态 ===\n');
  const st = await cdp.eval(`
    (async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const keys = await caches.keys();
      const composer = document.querySelector('.composer')?.getBoundingClientRect();
      const input = document.getElementById('input')?.getBoundingClientRect();
      return {
        // 连接
        dot: document.getElementById('statusDot')?.className,
        statusText: document.getElementById('statusText')?.textContent,
        // SW 状态
        swCount: regs.length,
        cacheCount: keys.length,
        // 布局
        vh: window.innerHeight,
        composerBottom: composer ? Math.round(composer.bottom) : null,
        inputBottom: input ? Math.round(input.bottom) : null,
        overflow: composer ? Math.max(0, Math.round(composer.bottom - window.innerHeight)) : null,
        // 样式版本
        chipClass: document.querySelector('.recipient-chip')?.className || null,
        hasToolChip: !!document.querySelector('.tool-chip'),
        emptyTitle: document.getElementById('emptyTitle')?.textContent,
        appVersion: window.__APP_VERSION__,
      };
    })()
  `);
  for (const [k, v] of Object.entries(st || {})) {
    if (k === '__err') { console.log('  错误:', v); continue; }
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== 结论 ===\n');
  const connected = st && st.dot && st.dot.includes('online');
  const noSW = st && st.swCount === 0;
  const noOverflow = st && st.overflow === 0;
  const oldStyle = st && st.chipClass && !st.hasToolChip;

  console.log(`  ${connected ? 'PASS' : 'FAIL'}  已连接`);
  console.log(`  ${noSW ? 'PASS' : 'FAIL'}  SW 已清理`);
  console.log(`  ${noOverflow ? 'PASS' : 'FAIL'}  底部无溢出`);
  console.log(`  ${oldStyle ? 'PASS' : 'FAIL'}  样式为旧版`);

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
