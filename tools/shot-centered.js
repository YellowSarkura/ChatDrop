/** 截取居中后的弹窗 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CDP_HTTP = 'http://127.0.0.1:9333';
const OUT = path.join(ROOT, '_shots');
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
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
      return true;
    }
    return false;
  }
}

(async () => {
  const page = await getPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 更多菜单
  await cdp.eval(`document.getElementById("btnMore").click()`);
  await sleep(900);
  console.log('更多菜单截图:', await cdp.shot('29-sheet-centered.png') ? 'OK' : 'FAIL');
  await cdp.eval(`document.getElementById("btnSheetCancel").click()`);
  await sleep(400);

  // 扫码配对
  await cdp.eval(`document.getElementById("btnMore").click()`);
  await sleep(300);
  await cdp.eval(`document.getElementById("btnShowPair").click()`);
  await sleep(1100);
  console.log('扫码配对截图:', await cdp.shot('30-qr-centered.png') ? 'OK' : 'FAIL');

  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
