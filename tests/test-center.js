/** 验证弹窗居中 */
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
  async shot(n) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
  }
}

async function measure(cdp, label) {
  const pos = await cdp.eval(`
    (() => {
      // 找真正可见的 backdrop（display 非 none）
      const backs = [...document.querySelectorAll('.sheet-backdrop')];
      const visible = backs.find(b => getComputedStyle(b).display !== 'none');
      if (!visible) return null;
      const sheet = visible.querySelector('.sheet');
      if (!sheet) return null;
      const r = sheet.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const cs = getComputedStyle(sheet);
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        vw, vh,
        offsetX: Math.round((r.left + r.width/2) - vw/2),
        offsetY: Math.round((r.top + r.height/2) - vh/2),
        gapBottom: Math.round(vh - r.bottom),
        radius: cs.borderRadius,
      };
    })()
  `);
  if (!pos) { console.log(`  ${label}: 未找到可见弹窗 FAIL`); return false; }
  const centered = Math.abs(pos.offsetX) < 3 && Math.abs(pos.offsetY) < 3;
  const notBottom = pos.gapBottom > 20;
  const rounded = /20px/.test(pos.radius);
  console.log(`  ${label}:  ${pos.w}x${pos.h}  偏移(${pos.offsetX},${pos.offsetY})  距底${pos.gapBottom}px  圆角${pos.radius}`);
  console.log(`        居中=${centered ? 'PASS' : 'FAIL'}  未贴底=${notBottom ? 'PASS' : 'FAIL'}  全圆角=${rounded ? 'PASS' : 'FAIL'}`);
  return centered && notBottom;
}

(async () => {
  const page = await getPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.eval(`
    (async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      return true;
    })()
  `);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3000);

  console.log('\n=== 弹窗居中验证 ===\n');
  let allOk = true;

  // 1. 更多菜单
  await cdp.eval('document.getElementById("btnMore").click()');
  await sleep(1000);
  allOk = (await measure(cdp, '更多菜单  ')) && allOk;
  await cdp.eval('document.getElementById("btnSheetCancel").click()');
  await sleep(400);

  // 2. 扫码配对
  await cdp.eval('document.getElementById("btnMore").click()');
  await sleep(300);
  await cdp.eval('document.getElementById("btnShowPair").click()');
  await sleep(1200);
  allOk = (await measure(cdp, '扫码配对  ')) && allOk;
  await cdp.eval('document.getElementById("btnPairCancel").click()');
  await sleep(400);

  // 3. 昵称编辑
  await cdp.eval('document.getElementById("btnMe").click()');
  await sleep(500);
  allOk = (await measure(cdp, '昵称编辑  ')) && allOk;
  await cdp.eval('document.getElementById("meCancel").click()');
  await sleep(300);

  // 4. 设备选择
  await cdp.eval('document.getElementById("recipientBtn").click()');
  await sleep(500);
  allOk = (await measure(cdp, '设备选择  ')) && allOk;

  console.log(`\n总体: ${allOk ? 'PASS 全部居中' : 'FAIL 存在未居中'}`);
  ws.close();
  setTimeout(() => process.exit(allOk ? 0 : 1), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
