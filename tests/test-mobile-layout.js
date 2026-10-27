/** 手机端布局实测（iPhone / Android 尺寸） */
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
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { __err: (d.exception && (d.exception.description || d.exception.value)) || d.text };
    }
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

const devices = [
  { name: 'iPhone-SE', w: 375, h: 667 },
  { name: 'iPhone-14', w: 390, h: 844 },
  { name: 'Android', w: 360, h: 800 },
];

(async () => {
  const page = await getPage();
  if (!page) { console.log('无页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (const d of devices) {
    console.log(`\n=== ${d.name} (${d.w}x${d.h}) ===\n`);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: d.w, height: d.h, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(700);

    const layout = await cdp.eval(`
      (() => {
        const q = (s) => document.querySelector(s);
        const r = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) };
        };
        return {
          vh: window.innerHeight,
          vw: window.innerWidth,
          topbar: r(q('.topbar')),
          messages: r(q('.messages')),
          recipientBar: r(q('.recipient-bar')),
          composer: r(q('.composer')),
          input: r(q('#input')),
          sendBtn: r(q('#btnSend')),
          attachBtn: r(q('#btnAttach')),
          hasDropzone: !!q('.dropzone'),
          // 关键：输入框是否在视口内
          inputVisible: (() => {
            const b = q('#input')?.getBoundingClientRect();
            return b ? (b.bottom <= window.innerHeight && b.top >= 0) : false;
          })(),
          // 是否超出底部
          composerOverflow: (() => {
            const b = q('.composer')?.getBoundingClientRect();
            return b ? Math.max(0, Math.round(b.bottom - window.innerHeight)) : 0;
          })(),
        };
      })()
    `);

    console.log(`  视口: ${layout.vw}x${layout.vh}`);
    console.log(`  顶栏:     ${layout.topbar ? layout.topbar.h + 'px' : 'X'}`);
    console.log(`  消息区:   ${layout.messages ? layout.messages.h + 'px' : 'X'}`);
    console.log(`  收件人栏: ${layout.recipientBar ? layout.recipientBar.h + 'px' : 'X'}`);
    console.log(`  输入区:   ${layout.composer ? layout.composer.h + 'px' : 'X'}  bottom=${layout.composer?.b}`);
    console.log(`  输入框可见: ${layout.inputVisible ? '是 [PASS]' : '否 [FAIL]'}`);
    console.log(`  底部溢出: ${layout.composerOverflow}px ${layout.composerOverflow > 0 ? '[FAIL 被截断]' : '[OK]'}`);

    await cdp.shot(`mobile-${d.name}.png`);
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
