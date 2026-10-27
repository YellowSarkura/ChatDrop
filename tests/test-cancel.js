/**
 * 慢速上传下的取消测试（模拟真实网速）
 * 用 CDP 的 Network.emulateNetworkConditions 限速，制造可操作的时间窗口
 */
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
const check = (label, pass, detail = '') => {
  log.push(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

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
  await cdp.send('Network.enable');

  // 限速：上传 300KB/s，让 3MB 文件需要约 10 秒
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: 2 * 1024 * 1024,
    uploadThroughput: 300 * 1024,
  });

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2800);

  await fetch('http://127.0.0.1:8787/api/clear', { method: 'POST' });

  // 加 2 个 3MB 文件（限速下约需 10 秒各）
  await cdp.eval(`
    (() => {
      const files = [1,2].map(i => new File(
        [new Uint8Array(3 * 1024 * 1024)],
        '慢速' + i + '.bin',
        { type: 'application/octet-stream', lastModified: Date.now() + i }
      ));
      window.ChatDropUploader.addFiles(files);
      return true;
    })()
  `);

  await sleep(2500);

  const mid = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.up-item')];
      return items.map(n => ({
        cls: n.className.replace('up-item ',''),
        meta: n.querySelector('.up-meta')?.textContent || '',
        hasCancel: !!n.querySelector('.up-btn')
      }));
    })()
  `);
  check('限速后任务处于上传中', mid.some(x => x.cls === 'uploading'), JSON.stringify(mid.map(x => x.cls)));

  await cdp.shot('11-uploading.png');

  // 取消第一个
  const clicked = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.up-item')];
      const target = items.find(n => n.classList.contains('uploading'));
      if (!target) return false;
      const btn = [...target.querySelectorAll('.up-btn')].find(b => b.textContent === '取消');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  check('点击取消按钮', clicked === true);

  await sleep(1200);

  const after = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.up-item')];
      return items.map(n => ({
        cls: n.className.replace('up-item ',''),
        meta: n.querySelector('.up-meta')?.textContent || ''
      }));
    })()
  `);
  const canceled = after.filter(x => x.cls === 'canceled');
  check('被取消任务标记为 canceled', canceled.length >= 1, JSON.stringify(after.map(x => x.cls)));
  check('另一任务仍在传输（未被连带取消）',
    after.some(x => x.cls === 'uploading'),
    JSON.stringify(after.map(x => x.cls)));

  await cdp.shot('12-canceled.png');

  // 恢复网速，等剩余任务完成
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0,
    downloadThroughput: -1, uploadThroughput: -1,
  });
  await sleep(6000);

  const fin = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.up-item')];
      return {
        total: items.length,
        done: items.filter(n => n.classList.contains('done')).length,
        canceled: items.filter(n => n.classList.contains('canceled')).length,
        failed: items.filter(n => n.classList.contains('failed')).length
      };
    })()
  `);
  check('剩余任务最终完成', fin.done >= 1 && fin.failed === 0, JSON.stringify(fin));

  await cdp.shot('13-final.png');

  console.log('\n=========== 慢速取消测试 ===========\n');
  for (const l of log) console.log('  ' + l);
  const fails = log.filter((l) => l.startsWith('FAIL'));
  console.log(`\n  合计 ${log.length} 项，通过 ${log.length - fails.length}，失败 ${fails.length}`);

  await fetch('http://127.0.0.1:8787/api/clear', { method: 'POST' });
  ws.close();
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
