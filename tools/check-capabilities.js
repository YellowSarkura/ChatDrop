/** 检查页面能力：安全上下文、BarcodeDetector、摄像头 */
const CDP_HTTP = 'http://127.0.0.1:9333';

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
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
}

(async () => {
  const page = await getPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const cap = await cdp.eval(`
    (() => ({
      href: location.href,
      isSecureContext: window.isSecureContext,
      hasBarcodeDetector: 'BarcodeDetector' in window,
      bdType: typeof window.BarcodeDetector,
      hasMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      ua: navigator.userAgent.slice(0, 60),
    }))()
  `);
  console.log('\n当前页面 (127.0.0.1):');
  console.log(JSON.stringify(cap, null, 2));

  // 换一个地址再检查（默认本机，可用 CD_URL 指定局域网地址）
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: process.env.CD_URL || 'http://localhost:8787/' });
  await new Promise((r) => setTimeout(r, 2500));

  const cap2 = await cdp.eval(`
    (() => ({
      href: location.href,
      isSecureContext: window.isSecureContext,
      hasBarcodeDetector: 'BarcodeDetector' in window,
      bdType: typeof window.BarcodeDetector,
      hasMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    }))()
  `);
  console.log('\n目标地址 (CD_URL 或 localhost):');
  console.log(JSON.stringify(cap2, null, 2));

  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
