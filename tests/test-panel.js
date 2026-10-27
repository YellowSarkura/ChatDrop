/** 验证设备面板渲染 + 同名设备区分 */
const CDP_HTTP = 'http://127.0.0.1:9333';
const BASE = 'http://127.0.0.1:8787';
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
  if (!page) { console.log('无页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3200);

  console.log('\n=== 1. 清空本地名字，触发新默认名 ===\n');
  await cdp.eval(`localStorage.removeItem('chatdrop.name')`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3000);

  const myName = await cdp.eval(`
    (() => {
      const stored = localStorage.getItem('chatdrop.name');
      const avatar = document.querySelector('.me-avatar')?.textContent;
      return { stored, avatar };
    })()
  `);
  console.log('  localStorage:', myName.stored || '(未存，用默认)');
  console.log('  头像首字:', myName.avatar);
  const hasUndef = String(myName.avatar || '').includes('u') && String(myName.avatar || '').length > 1;
  console.log('  含平台字符串:', /Win32|Linux|Mac|armv/i.test(myName.stored || '') ? '是 [FAIL]' : '否 [PASS]');

  console.log('\n=== 2. 制造两个同名设备 ===\n');
  const c1 = new AbortController();
  const c2 = new AbortController();
  await fetch(`${BASE}/api/events?sid=AAAA0001-test&name=${encodeURIComponent('同名设备')}&color=%23f59e0b`, { signal: c1.signal }).catch(() => {});
  await fetch(`${BASE}/api/events?sid=BBBB0002-test&name=${encodeURIComponent('同名设备')}&color=%2310b981`, { signal: c2.signal }).catch(() => {});
  await sleep(1500);

  const devList = await (await fetch(`${BASE}/api/devices`)).json();
  console.log('  服务端在线设备:');
  for (const d of devList.devices) {
    console.log(`    ${d.name}  sid=${d.sid}`);
  }

  console.log('\n=== 3. 打开设备面板 ===\n');
  const opened = await cdp.eval(`
    (() => {
      const btn = document.getElementById('recipientBtn');
      if (!btn) return { err: 'btn 不存在' };
      btn.click();
      return { clicked: true };
    })()
  `);
  console.log('  点击收件人按钮:', JSON.stringify(opened));
  await sleep(900);

  const panel = await cdp.eval(`
    (() => {
      const back = document.getElementById('recipientBackdrop');
      const list = document.getElementById('deviceList');
      const items = list ? [...list.querySelectorAll('.device-item')] : [];
      return {
        backdropHidden: back ? back.hidden : null,
        display: back ? getComputedStyle(back).display : null,
        itemCount: items.length,
        items: items.map(n => ({
          name: n.querySelector('.dev-name')?.textContent?.trim() || '',
          hasId: !!n.querySelector('.dev-id'),
          sub: n.querySelector('.dev-sub')?.textContent || '',
        }))
      };
    })()
  `);
  console.log('  面板 hidden:', panel.backdropHidden);
  console.log('  面板 display:', panel.display);
  console.log('  设备项数量:', panel.itemCount);
  console.log('  渲染内容:');
  for (const it of panel.items || []) {
    console.log(`    ${it.name}${it.hasId ? ' [有短ID]' : ''}  — ${it.sub}`);
  }

  const dup = (panel.items || []).filter((it) => it.name.includes('同名设备'));
  console.log('');
  console.log(`  同名设备数: ${dup.length}`);
  console.log(`  都带短ID: ${dup.length > 0 && dup.every((d) => d.hasId) ? '是 [PASS]' : '否 [FAIL]'}`);

  c1.abort();
  c2.abort();
  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
