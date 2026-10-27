/** 前端暂停/继续 UI 测试（限速制造时间窗口） */
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
  await cdp.send('Network.enable');

  // 限速 250KB/s，5MB 约需 20 秒
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 20,
    downloadThroughput: 2 * 1024 * 1024,
    uploadThroughput: 250 * 1024,
  });

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2800);
  await fetch('http://127.0.0.1:8787/api/clear', { method: 'POST' });

  // 加一个 5MB 文件
  await cdp.eval(`
    (() => {
      const f = new File([new Uint8Array(5 * 1024 * 1024)], '暂停测试.bin',
        { type: 'application/octet-stream', lastModified: 777777 });
      window.ChatDropUploader.addFiles([f]);
      return true;
    })()
  `);
  await sleep(2500);

  const before = await cdp.eval(`
    (() => {
      const it = document.querySelector('.up-item');
      return {
        cls: it?.className.replace('up-item ',''),
        btns: [...(it?.querySelectorAll('.up-btn') || [])].map(b => b.textContent),
        meta: it?.querySelector('.up-meta')?.textContent || ''
      };
    })()
  `);
  check('上传中显示「暂停」按钮', before.btns.includes('暂停'), JSON.stringify(before.btns));
  await cdp.shot('14-uploading-pause.png');

  // 点暂停
  await cdp.eval(`
    (() => {
      const btn = [...document.querySelectorAll('.up-btn')].find(b => b.textContent === '暂停');
      if (btn) btn.click();
      return !!btn;
    })()
  `);
  await sleep(1500);

  const afterPause = await cdp.eval(`
    (() => {
      const it = document.querySelector('.up-item');
      return {
        cls: it?.className.replace('up-item ',''),
        btns: [...(it?.querySelectorAll('.up-btn') || [])].map(b => b.textContent),
        meta: it?.querySelector('.up-meta')?.textContent || ''
      };
    })()
  `);
  check('暂停后状态为 paused', afterPause.cls === 'paused', afterPause.cls);
  check('暂停后显示「继续」按钮', afterPause.btns.includes('继续'), JSON.stringify(afterPause.btns));
  check('暂停后显示已传进度', /已传/.test(afterPause.meta), afterPause.meta);
  await cdp.shot('15-paused.png');

  // 点继续
  await cdp.eval(`
    (() => {
      const btn = [...document.querySelectorAll('.up-btn')].find(b => b.textContent === '继续');
      if (btn) btn.click();
      return !!btn;
    })()
  `);
  await sleep(1500);

  const afterResume = await cdp.eval(`
    (() => {
      const it = document.querySelector('.up-item');
      return {
        cls: it?.className.replace('up-item ',''),
        meta: it?.querySelector('.up-meta')?.textContent || ''
      };
    })()
  `);
  check('继续后恢复上传状态', afterResume.cls === 'uploading' || afterResume.cls === 'hashing',
    afterResume.cls);

  // 恢复网速，等完成
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await sleep(6000);

  const fin = await cdp.eval(`
    (() => {
      const it = document.querySelector('.up-item');
      return {
        cls: it?.className.replace('up-item ',''),
        meta: it?.querySelector('.up-meta')?.textContent || ''
      };
    })()
  `);
  check('最终完成', fin.cls === 'done', fin.cls + ' / ' + fin.meta);

  const cards = await cdp.eval('document.querySelectorAll(".bubble.file").length');
  check('文件已进入消息列表', cards >= 1, `cards=${cards}`);

  await cdp.shot('16-resumed-done.png');

  console.log('\n=========== 前端暂停/继续测试 ===========\n');
  for (const l of log) console.log('  ' + l);
  const fails = log.filter((l) => l.startsWith('FAIL'));
  console.log(`\n  合计 ${log.length} 项，通过 ${log.length - fails.length}，失败 ${fails.length}`);

  await fetch('http://127.0.0.1:8787/api/clear', { method: 'POST' });
  ws.close();
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
