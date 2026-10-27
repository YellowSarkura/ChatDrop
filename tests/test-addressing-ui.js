/** 设备选择 UI 测试 */
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  }
}

const log = [];
const check = (l, p, d = '') => { log.push(`${p ? 'PASS' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); };

(async () => {
  const page = await getPage();
  if (!page) throw new Error('找不到页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 清缓存硬刷新
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

  // 1. 收件人栏存在
  const barOk = await cdp.eval(`
    (() => {
      const bar = document.getElementById('recipientBar');
      const btn = document.getElementById('recipientBtn');
      const label = document.getElementById('recipientLabel');
      return {
        visible: bar && getComputedStyle(bar).display !== 'none',
        label: label ? label.textContent : null,
        hasBtn: !!btn
      };
    })()
  `);
  check('收件人栏显示', barOk.visible === true, JSON.stringify(barOk));
  check('默认「发送给所有人」', /所有人|还没有其他设备/.test(barOk.label || ''), barOk.label);

  // 2. 打开设备选择器
  await cdp.eval('document.getElementById("recipientBtn").click()');
  await sleep(600);

  const sheetOpen = await cdp.eval(
    'getComputedStyle(document.getElementById("recipientBackdrop")).display !== "none"'
  );
  check('设备选择器打开', sheetOpen === true);

  const items = await cdp.eval(`
    (() => {
      const list = document.getElementById('deviceList');
      const names = [...list.querySelectorAll('.dev-name')].map(n => n.textContent);
      return {
        count: list.querySelectorAll('.device-item').length,
        names,
        hasAll: names.includes('所有人'),
        empty: !!list.querySelector('.device-empty')
      };
    })()
  `);
  check('有「所有人」选项', items.hasAll === true, JSON.stringify(items));
  check('无其他设备时显示提示', items.empty === true || items.count > 1,
    JSON.stringify(items));

  await cdp.shot('17-device-picker.png');

  await cdp.eval('document.getElementById("btnRecipientCancel").click()');
  await sleep(400);

  // 3. 模拟另一台设备上线（直接调 API 制造在线记录）
  const online = await cdp.eval(`
    (async () => {
      // 用 fetch 建立一条 SSE 连接，注册一个虚拟设备
      const sid = 'virtual-phone';
      const sender = btoa(unescape(encodeURIComponent(JSON.stringify({
        sid, name: '小米手机', color: '#f59e0b'
      })))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      const ctrl = new AbortController();
      window.__virtualAbort = ctrl;
      fetch('/api/events', { headers: { 'X-Chat-Sender': sender }, signal: ctrl.signal })
        .catch(() => {});
      await new Promise(r => setTimeout(r, 1200));
      const r = await fetch('/api/devices');
      const j = await r.json();
      return j.devices.map(d => d.name);
    })()
  `);
  check('虚拟设备上线', online.includes('小米手机'), JSON.stringify(online));

  // 等前端收到 presence 推送
  await sleep(1200);

  const labelAfter = await cdp.eval(
    'document.getElementById("recipientLabel").textContent'
  );
  const countAfter = await cdp.eval(
    'document.getElementById("onlineCount").textContent'
  );
  check('前端感知到在线设备', /[1-9]\d* 台在线/.test(countAfter), countAfter);

  // 4. 选择该设备
  await cdp.eval('document.getElementById("recipientBtn").click()');
  await sleep(600);

  const devItems = await cdp.eval(`
    (() => {
      const list = document.getElementById('deviceList');
      return [...list.querySelectorAll('.device-item')].map(n => ({
        name: n.querySelector('.dev-name')?.textContent,
        active: n.classList.contains('active')
      }));
    })()
  `);
  check('设备出现在列表', devItems.some(d => d.name === '小米手机'), JSON.stringify(devItems));

  await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.device-item')];
      const target = items.find(n => n.querySelector('.dev-name')?.textContent === '小米手机');
      if (target) target.click();
      return !!target;
    })()
  `);
  await sleep(600);

  const labelDirect = await cdp.eval(
    'document.getElementById("recipientLabel").textContent'
  );
  const isDirect = await cdp.eval(
    'document.getElementById("recipientBtn").classList.contains("direct")'
  );
  check('选择后标签变为「发送给 小米手机」',
    labelDirect.includes('小米手机'), labelDirect);
  check('收件人按钮高亮', isDirect === true);

  await cdp.shot('18-recipient-selected.png');

  // 5. 发送定向消息
  await cdp.eval(`
    (() => {
      const i = document.getElementById('input');
      i.value = '这条只发给小米手机';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSend').click();
      return true;
    })()
  `);
  await sleep(1200);

  const sent = await cdp.eval(`
    (() => {
      const msgs = [...document.querySelectorAll('.msg')];
      const last = msgs[msgs.length - 1];
      return {
        text: last?.querySelector('.bubble')?.textContent,
        hasPrivate: !!last?.querySelector('.msg-private'),
        privateText: last?.querySelector('.msg-private')?.textContent
      };
    })()
  `);
  check('定向消息已发送', sent.text === '这条只发给小米手机', sent.text);
  check('消息带「私密」标记', sent.hasPrivate === true, sent.privateText);

  await cdp.shot('19-private-message.png');

  // 6. 切回所有人
  await cdp.eval('document.getElementById("recipientBtn").click()');
  await sleep(500);
  await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.device-item')];
      const all = items.find(n => n.querySelector('.dev-name')?.textContent === '所有人');
      if (all) all.click();
      return !!all;
    })()
  `);
  await sleep(500);

  const labelBack = await cdp.eval(
    'document.getElementById("recipientLabel").textContent'
  );
  check('可切回所有人', /所有人/.test(labelBack), labelBack);

  // 清理虚拟设备
  await cdp.eval('window.__virtualAbort && window.__virtualAbort.abort(); true');

  console.log('\n=========== 设备寻址 UI 测试 ===========\n');
  for (const l of log) console.log('  ' + l);
  const fails = log.filter((l) => l.startsWith('FAIL'));
  console.log(`\n  合计 ${log.length} 项，通过 ${log.length - fails.length}，失败 ${fails.length}`);

  await fetch('http://127.0.0.1:8787/api/clear?scope=all', { method: 'POST' }).catch(() => {});
  ws.close();
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
