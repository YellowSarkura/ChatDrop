/** 检查二维码实际内容是否指向局域网 IP */
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

  const info = await cdp.eval(`({ href: location.href, origin: location.origin })`);
  console.log('\n当前页面:', info.href);

  await cdp.eval(`document.getElementById("btnMore").click()`);
  await sleep(300);
  await cdp.eval(`document.getElementById("btnShowPair").click()`);
  await sleep(900);

  const link = await cdp.eval(`document.getElementById("pairLinkInput").value`);
  console.log('二维码内容:', link);

  const isLoopback = /127\.0\.0\.1|localhost/.test(link);
  console.log('');
  if (isLoopback) {
    console.log('[BUG] 二维码指向回环地址 127.x/localhost');
    console.log('      手机扫了会去连它自己，必然打不开');
  } else {
    const host = new URL(link).host;
    console.log(`[OK] 二维码指向 ${host}`);
  }

  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
