/** 检查触屏检测逻辑 */
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
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 667, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(800);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3500);

  const info = await cdp.eval(`
    (() => ({
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
      hoverNone: window.matchMedia('(hover: none)').matches,
      anyCoarse: window.matchMedia('(any-pointer: coarse)').matches,
      ua: navigator.userAgent.slice(0, 90),
      maxTouchPoints: navigator.maxTouchPoints,
      bodyClass: document.body.className,
      emptyTitle: document.getElementById('emptyTitle')?.textContent,
      placeholder: document.getElementById('input')?.placeholder,
      isTouchVar: (typeof isTouchDevice !== 'undefined') ? isTouchDevice : 'undefined(闭包内)',
    }))()
  `);

  console.log('\n=== 触屏检测 ===\n');
  for (const [k, v] of Object.entries(info || {})) {
    console.log(`  ${k}: ${v}`);
  }

  const isTouch = info && (info.pointerCoarse || info.hoverNone);
  console.log('');
  console.log(`  判定为触屏: ${isTouch ? '是' : '否'}`);
  console.log(`  文案是否已切换: ${info && info.emptyTitle && info.emptyTitle.includes('发个文件') ? '是 [PASS]' : '否 [FAIL]'}`);
  console.log(`  body 有 touch-device 类: ${info && info.bodyClass && info.bodyClass.includes('touch-device') ? '是' : '否 [FAIL]'}`);

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
