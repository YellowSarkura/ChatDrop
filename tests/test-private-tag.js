/** 验证私密标记真实渲染 + 截图 */
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
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

  // 清空数据 + 清 SW + 硬刷新
  await fetch('http://127.0.0.1:8787/api/clear?scope=all', { method: 'POST' }).catch(() => {});
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

  // 制造一个虚拟在线设备
  await cdp.eval(`
    (async () => {
      const sender = btoa(unescape(encodeURIComponent(JSON.stringify({
        sid: 'phone-demo', name: '小米手机', color: '#f59e0b'
      })))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      const ctrl = new AbortController();
      window.__demoAbort = ctrl;
      fetch('/api/events?sid=phone-demo&name=' + encodeURIComponent('小米手机') + '&color=%23f59e0b',
        { signal: ctrl.signal }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      return true;
    })()
  `);
  await sleep(1200);

  // 选中小米手机
  await cdp.eval('document.getElementById("recipientBtn").click()');
  await sleep(500);
  await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.device-item')];
      const t = items.find(n => n.querySelector('.dev-name')?.textContent === '小米手机');
      if (t) t.click();
      return !!t;
    })()
  `);
  await sleep(600);

  // 发一条私密文字
  await cdp.eval(`
    (() => {
      const i = document.getElementById('input');
      i.value = '这条只有小米手机能收到';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSend').click();
      return true;
    })()
  `);
  await sleep(1000);

  // 切回所有人，再发一条广播
  await cdp.eval('document.getElementById("recipientBtn").click()');
  await sleep(400);
  await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.device-item')];
      const all = items.find(n => n.querySelector('.dev-name')?.textContent === '所有人');
      if (all) all.click();
      return !!all;
    })()
  `);
  await sleep(400);

  await cdp.eval(`
    (() => {
      const i = document.getElementById('input');
      i.value = '这条所有人都能看到';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSend').click();
      return true;
    })()
  `);
  await sleep(1000);

  // 检查标记
  const state = await cdp.eval(`
    (() => {
      const msgs = [...document.querySelectorAll('.msg')];
      return msgs.map(n => ({
        text: n.querySelector('.bubble')?.textContent?.slice(0, 20),
        privateTag: n.querySelector('.msg-private')?.textContent || null
      }));
    })()
  `);
  console.log('\n消息渲染状态:');
  for (const m of state) {
    console.log(`  [${m.privateTag || '公开'}] ${m.text}`);
  }

  const priv = state.filter(s => s.privateTag);
  const pub = state.filter(s => !s.privateTag);
  console.log(`\n  私密标记渲染: ${priv.length > 0 ? 'PASS' : 'FAIL'} (${priv.length} 条)`);
  console.log(`  公开消息无标记: ${pub.length > 0 ? 'PASS' : 'FAIL'} (${pub.length} 条)`);

  await cdp.shot('20-private-tag.png');

  await cdp.eval('window.__demoAbort && window.__demoAbort.abort(); true');
  ws.close();
  setTimeout(() => process.exit(priv.length > 0 ? 0 : 1), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
