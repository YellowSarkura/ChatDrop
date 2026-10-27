/**
 * ChatDrop 界面自动化测试 + 截图
 * 使用 Node 24 内置 WebSocket 直连 CDP，零依赖。
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const CDP_HTTP = 'http://127.0.0.1:9333';
const OUT = path.join(ROOT, '_shots');

fs.mkdirSync(OUT, { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPageTarget() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('8787'));
  if (!page) throw new Error('找不到 ChatDrop 页面');
  return page;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
    }
    return r.result.value;
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(path.join(OUT, name), buf);
    return buf.length;
  }
}

async function connect() {
  const page = await getPageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
    setTimeout(() => reject(new Error('ws 连接超时')), 8000);
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

(async () => {
  const cdp = await connect();
  const log = [];

  const ok = (label, cond, extra = '') => {
    log.push(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
    return cond;
  };

  /* ---------- 1. 页面基础状态 ---------- */
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2200);

  const title = await cdp.eval('document.title');
  ok('页面标题', title.includes('ChatDrop'), title);

  const swReady = await cdp.eval(
    'navigator.serviceWorker.getRegistration().then(r => !!(r && (r.active || r.installing)))'
  );
  ok('Service Worker 已注册', swReady === true);

  const manifest = await cdp.eval(
    'fetch("/manifest.webmanifest").then(r=>r.json()).then(j=>j.name)'
  );
  ok('Manifest 可读', typeof manifest === 'string', manifest);

  const dotClass = await cdp.eval('document.getElementById("statusDot").className');
  ok('SSE 连接状态', dotClass.includes('online'), dotClass);

  /* ---------- 1b. 关键：弹层必须真正不可见（不能只靠 hidden 属性） ---------- */
  const overlayState = await cdp.eval(`
    (() => {
      const ids = ['lightbox', 'sheetBackdrop', 'meBackdrop', 'dropzone'];
      return ids.map(id => {
        const n = document.getElementById(id);
        const cs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return {
          id,
          display: cs.display,
          visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
        };
      });
    })()
  `);
  const anyOverlay = overlayState.filter((o) => o.visible);
  ok(
    '初始无弹层遮挡',
    anyOverlay.length === 0,
    anyOverlay.length ? JSON.stringify(anyOverlay) : 'all hidden'
  );

  /* ---------- 1c. 点击中心点确实命中输入框，而非被遮罩拦截 ---------- */
  const hitTest = await cdp.eval(`
    (() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 60);
      return el ? (el.id || el.className || el.tagName) : null;
    })()
  `);
  ok(
    '输入区未被遮挡',
    typeof hitTest === 'string' && !/lightbox|backdrop/i.test(hitTest),
    String(hitTest)
  );

  /* ---------- 2. 空状态 ---------- */
  const emptyShown = await cdp.eval('!!document.getElementById("emptyState")');
  ok('空状态显示', emptyShown === true);
  await cdp.shot('01-empty.png');

  /* ---------- 3. 发送文字 ---------- */
  await cdp.eval(`
    (() => {
      const i = document.getElementById('input');
      i.value = '你好！这是 ChatDrop 的第一条消息 🎉';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(200);
  const sendEnabled = await cdp.eval('!document.getElementById("btnSend").disabled');
  ok('发送按钮激活', sendEnabled === true);

  await cdp.eval('document.getElementById("btnSend").click()');
  await sleep(900);

  const textBubbles = await cdp.eval(
    '[...document.querySelectorAll(".bubble")].map(n=>n.textContent)'
  );
  ok('文字消息渲染', textBubbles.some((t) => t.includes('第一条消息')), JSON.stringify(textBubbles));

  const inputCleared = await cdp.eval('document.getElementById("input").value === ""');
  ok('发送后清空输入框', inputCleared === true);

  /* ---------- 4. 发送多条，测试气泡分组 ---------- */
  for (const t of ['第二条：多行测试', '第三条：带 emoji 🚀🔥', '第四条：确认分组效果']) {
    await cdp.eval(`
      (() => {
        const i = document.getElementById('input');
        i.value = ${JSON.stringify(t)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btnSend').click();
        return true;
      })()
    `);
    await sleep(600);
  }

  const grouped = await cdp.eval('document.querySelectorAll(".msg.grouped").length');
  ok('连续消息分组', grouped >= 2, `grouped=${grouped}`);

  /* ---------- 5. 上传文件（通过 fetch 模拟，走真实 API） ---------- */
  const upResult = await cdp.eval(`
    (async () => {
      const blob = new Blob(['ChatDrop 图片/文件测试内容\\n第二行'], { type: 'text/plain' });
      const fd = new FormData();
      fd.append('f', blob, '测试文档.txt');
      const file = fd.get('f');
      const qs = new URLSearchParams({ name: file.name, mime: file.type, size: String(file.size) });
      const r = await fetch('/api/file?' + qs, {
        method: 'POST',
        headers: {
          'X-Chat-Sender': btoa(unescape(encodeURIComponent(JSON.stringify({
            sid: localStorage.getItem('chatdrop.sid'),
            name: localStorage.getItem('chatdrop.name') || '我',
            color: '#3b82f6'
          })))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''),
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });
      const j = await r.json();
      return { status: r.status, type: j.message && j.message.type, name: j.message && j.message.file.name };
    })()
  `);
  ok('文件上传 API', upResult.status === 200 && upResult.type === 'file', JSON.stringify(upResult));

  await sleep(800);
  const fileCards = await cdp.eval('document.querySelectorAll(".bubble.file").length');
  ok('文件卡片渲染', fileCards >= 1, `cards=${fileCards}`);

  /* ---------- 6. 上传图片 ---------- */
  const imgResult = await cdp.eval(`
    (async () => {
      const c = document.createElement('canvas');
      c.width = 480; c.height = 300;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 480, 300);
      g.addColorStop(0, '#3b82f6');
      g.addColorStop(1, '#8b5cf6');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 480, 300);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('图片消息测试', 240, 145);
      ctx.font = '16px sans-serif';
      ctx.fillText('ChatDrop · 局域网互传', 240, 185);

      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const file = new File([blob], '测试图片.png', { type: 'image/png' });
      const qs = new URLSearchParams({ name: file.name, mime: file.type, size: String(file.size) });
      const r = await fetch('/api/file?' + qs, {
        method: 'POST',
        headers: {
          'X-Chat-Sender': btoa(unescape(encodeURIComponent(JSON.stringify({
            sid: localStorage.getItem('chatdrop.sid'),
            name: localStorage.getItem('chatdrop.name') || '我',
            color: '#3b82f6'
          })))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''),
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });
      const j = await r.json();
      return { status: r.status, type: j.message && j.message.type };
    })()
  `);
  ok('图片上传 API', imgResult.status === 200 && imgResult.type === 'image', JSON.stringify(imgResult));

  await sleep(1000);
  const imgLoaded = await cdp.eval(`
    (async () => {
      const imgs = [...document.querySelectorAll('.bubble.image img')];
      // 等待图片解码完成（避免读太早拿到 naturalWidth=0）
      await Promise.all(imgs.map(i => i.complete ? Promise.resolve() :
        new Promise(r => { i.onload = r; i.onerror = r; setTimeout(r, 4000); })));
      return imgs.map(i => ({ w: i.naturalWidth, h: i.naturalHeight, done: i.complete }));
    })()
  `);
  ok('图片气泡加载', imgLoaded.length >= 1 && imgLoaded[0].w > 0, JSON.stringify(imgLoaded));

  await cdp.shot('02-messages.png');

  /* ---------- 7. 灯箱 ---------- */
  await cdp.eval('document.querySelector(".bubble.image img").click()');
  await sleep(500);
  const lbOpen = await cdp.eval(`
    (() => {
      const n = document.getElementById('lightbox');
      return getComputedStyle(n).display !== 'none';
    })()
  `);
  ok('灯箱打开', lbOpen === true);
  await cdp.shot('03-lightbox.png');
  await cdp.eval('document.getElementById("lightboxClose").click()');
  await sleep(400);
  const lbClosed = await cdp.eval(`
    (() => {
      const n = document.getElementById('lightbox');
      return getComputedStyle(n).display === 'none';
    })()
  `);
  ok('灯箱关闭后隐藏', lbClosed === true);

  /* ---------- 8. 拖拽遮罩（模拟 dragenter） ---------- */
  const dzActive = await cdp.eval(`
    (() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      return document.getElementById('dropzone').classList.contains('active');
    })()
  `);
  ok('拖拽遮罩激活', dzActive === true);
  await cdp.shot('04-drag.png');
  await cdp.eval(`
    (() => {
      const dt = new DataTransfer();
      window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }));
      return true;
    })()
  `);

  /* ---------- 9. 移动端视口 ---------- */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(700);
  await cdp.eval('window.scrollTo(0,0); document.getElementById("messages").scrollTop = 99999;');
  await sleep(400);
  await cdp.shot('05-mobile.png');

  const mobileOk = await cdp.eval(`
    (() => {
      const c = document.querySelector('.composer');
      const r = c.getBoundingClientRect();
      return { visible: r.height > 30, bottom: Math.round(r.bottom), vw: window.innerWidth };
    })()
  `);
  ok('移动端输入区可见', mobileOk.visible === true, JSON.stringify(mobileOk));

  /* ---------- 10. 底部菜单 ---------- */
  await cdp.eval('document.getElementById("btnMore").click()');
  await sleep(400);
  const sheetOpen = await cdp.eval(
    'getComputedStyle(document.getElementById("sheetBackdrop")).display !== "none"'
  );
  ok('底部菜单打开', sheetOpen === true);
  await cdp.shot('06-sheet.png');
  await cdp.eval('document.getElementById("btnSheetCancel").click()');
  await sleep(400);
  const sheetClosed = await cdp.eval(
    'getComputedStyle(document.getElementById("sheetBackdrop")).display === "none"'
  );
  ok('底部菜单关闭后隐藏', sheetClosed === true);

  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ---------- 11. 控制台错误 ---------- */
  const errs = await cdp.eval(`
    (() => {
      return window.__chatdropErrors || [];
    })()
  `);

  console.log('\n=========== ChatDrop 界面测试 ===========\n');
  for (const line of log) console.log('  ' + line);

  const fails = log.filter((l) => l.startsWith('FAIL'));
  console.log(`\n  合计 ${log.length} 项，通过 ${log.length - fails.length}，失败 ${fails.length}`);
  console.log('\n  截图已保存到: ' + OUT);

  if (fails.length) process.exitCode = 1;
})().catch((e) => {
  console.error('测试失败:', e.message);
  process.exitCode = 1;
});
