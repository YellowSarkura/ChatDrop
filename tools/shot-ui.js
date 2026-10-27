/** 截取当前界面 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CDP_HTTP = 'http://127.0.0.1:9333';
const OUT = path.join(ROOT, '_shots');
fs.mkdirSync(OUT, { recursive: true });
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

  // 桌面
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  console.log('桌面:', await cdp.shot('ui-desktop.png') ? 'OK' : 'FAIL');

  // 手机
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(900);
  console.log('手机:', await cdp.shot('ui-mobile.png') ? 'OK' : 'FAIL');

  const info = await cdp.eval(`
    (() => {
      const chip = document.querySelector('.recipient-chip');
      const attach = document.querySelector('.icon-btn.attach');
      const mascot = document.querySelector('.empty-mascot');
      const cs = chip ? getComputedStyle(chip) : null;
      return {
        chipText: chip?.textContent?.trim(),
        chipFontSize: cs?.fontSize,
        chipPadding: cs?.padding,
        hasAttach: !!attach,
        attachSize: attach ? attach.getBoundingClientRect().width : null,
        mascotSize: mascot ? mascot.getBoundingClientRect().width : null,
        emptyTitle: document.getElementById('emptyTitle')?.textContent,
      };
    })()
  `);
  console.log('\n元素状态:');
  for (const [k, v] of Object.entries(info || {})) {
    console.log(`  ${k}: ${v}`);
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
