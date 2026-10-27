/** 界面删除消息测试 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CDP_HTTP = 'http://127.0.0.1:9333';
const BASE = 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, '_shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

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
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
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

(async () => {
  const page = await getPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 清空 + 刷新
  await fetch(`${BASE}/api/clear?scope=all`, {
    method: 'POST',
    headers: { 'X-Chat-Sender': Buffer.from(JSON.stringify({ sid: 'test-admin', name: '管理员', color: '#ef4444' })).toString('base64url') },
  }).catch(() => {});
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3200);

  // 关掉 confirm 弹窗（自动确认）
  await cdp.eval('window.confirm = () => true');

  console.log('\n=== 删除消息 UI 测试 ===\n');

  // 1. 发两条消息
  for (const t of ['第一条待删消息', '第二条保留消息']) {
    await cdp.eval(`
      (() => {
        const i = document.getElementById('input');
        i.value = ${JSON.stringify(t)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btnSend').click();
        return true;
      })()
    `);
    await sleep(800);
  }

  const before = await cdp.eval('document.querySelectorAll(".msg").length');
  check('发送了 2 条消息', before === 2, `count=${before}`);

  // 2. 点第一条的删除
  const clicked = await cdp.eval(`
    (() => {
      const msgs = [...document.querySelectorAll('.msg')];
      const first = msgs[0];
      const btn = first?.querySelector('.msg-del');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  check('找到并点击删除按钮', clicked === true);

  await sleep(1500);

  // 3. 界面上应只剩一条
  const after = await cdp.eval(`
    (() => {
      const msgs = [...document.querySelectorAll('.msg')];
      return {
        count: msgs.length,
        texts: msgs.map(n => n.querySelector('.bubble')?.textContent)
      };
    })()
  `);
  check('界面已移除该消息', after.count === 1, `count=${after.count} texts=${JSON.stringify(after.texts)}`);
  check('保留的是第二条', after.texts && after.texts[0] === '第二条保留消息', JSON.stringify(after.texts));

  // 4. 服务端也应删除
  const serverList = await (await fetch(`${BASE}/api/messages`)).json();
  const serverCount = serverList.messages.length;
  check('服务端已删除', serverCount === 1, `服务端 ${serverCount} 条`);

  // 5. 刷新后仍是 1 条（验证持久化）
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2800);
  const afterReload = await cdp.eval('document.querySelectorAll(".msg").length');
  check('刷新后仍为 1 条', afterReload === 1, `count=${afterReload}`);

  await cdp.shot('31-after-delete.png');

  const fails = results.filter((x) => !x.pass);
  console.log(`\n  合计 ${results.length} 项，通过 ${results.length - fails.length}，失败 ${fails.length}`);

  ws.close();
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
