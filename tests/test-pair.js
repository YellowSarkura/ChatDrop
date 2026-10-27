/**
 * 验证自研 QR 编码器 + 扫码配对
 *  1. 生成的 QR 能被 BarcodeDetector 正确解出
 *  2. ?pair= 参数能自动选中对方
 *  3. 扫码后定向发送生效
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
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
  await sleep(3200);

  /* ===== 1. QR 编码器可用 ===== */
  const qrReady = await cdp.eval('typeof window.MiniQR === "object" && typeof window.MiniQR.encode === "function"');
  check('QR 模块加载', qrReady === true);

  /* ===== 2. 编码短文本并自解码验证 ===== */
  const encTest = await cdp.eval(`
    (async () => {
      const text = 'http://localhost:8787/?pair=test-sid-1234';
      const r = window.MiniQR.encode(text);
      if (!r) return { ok: false, reason: 'encode 返回 null' };

      // 渲染到 canvas
      const c = document.createElement('canvas');
      c.width = 400; c.height = 400;
      const ok = window.MiniQR.render(c, text, { margin: 3 });
      if (!ok) return { ok: false, reason: 'render 失败' };

      // 用 BarcodeDetector 反解
      if (!('BarcodeDetector' in window)) return { ok: false, reason: '浏览器无 BarcodeDetector', size: r.size };

      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (!formats.includes('qr_code')) return { ok: false, reason: '不支持 qr_code', size: r.size };

      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const codes = await det.detect(c);
      if (!codes.length) return { ok: false, reason: '解码失败（码可能不合法）', size: r.size };

      return {
        ok: true,
        size: r.size,
        expected: text,
        decoded: codes[0].rawValue,
        match: codes[0].rawValue === text
      };
    })()
  `);
  check('QR 生成成功', encTest.ok === true, JSON.stringify(encTest).slice(0, 200));
  if (encTest.ok) {
    check('QR 可被扫码器正确解码', encTest.match === true,
      `期望「${encTest.expected}」实得「${encTest.decoded}」`);
  }

  /* ===== 3. 多组文本验证 ===== */
  const multi = await cdp.eval(`
    (async () => {
      const tests = [
        'SHORT',
        'http://192.168.1.5:8787/?pair=abc',
        'http://10.0.0.2:8080/?pair=' + 'x'.repeat(40),
        'http://localhost:8787/?pair=' + 'a1b2-c3d4-e5f6'
      ];
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const out = [];
      for (const t of tests) {
        const c = document.createElement('canvas');
        c.width = 420; c.height = 420;
        window.MiniQR.render(c, t, { margin: 3 });
        const codes = await det.detect(c);
        out.push({
          text: t.length > 40 ? t.slice(0, 40) + '…' : t,
          len: t.length,
          ok: codes.length > 0 && codes[0].rawValue === t
        });
      }
      return out;
    })()
  `);
  const allOk = Array.isArray(multi) && multi.every((m) => m.ok);
  check('多种长度的文本都能正确编码解码', allOk === true, JSON.stringify(multi));

  /* ===== 4. 配对面板打开 ===== */
  await cdp.eval('document.getElementById("btnMore").click()');
  await sleep(400);
  await cdp.eval('document.getElementById("btnShowPair").click()');
  await sleep(700);

  const pairOpen = await cdp.eval(
    'getComputedStyle(document.getElementById("pairBackdrop")).display !== "none"'
  );
  check('配对面板打开', pairOpen === true);

  const qrDrawn = await cdp.eval(`
    (() => {
      const c = document.getElementById('qrCanvas');
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 128) dark++;
      }
      return { darkRatio: dark / (data.length / 4), w: c.width };
    })()
  `);
  check('二维码已绘制到画布', qrDrawn.darkRatio > 0.1 && qrDrawn.darkRatio < 0.7,
    JSON.stringify(qrDrawn));

  const linkVal = await cdp.eval('document.getElementById("pairLinkInput").value');
  check('配对链接包含 pair 参数', /pair=/.test(linkVal), linkVal);

  await cdp.shot('21-pair-qr.png');

  /* ===== 5. 解码画布上的真实二维码 ===== */
  const decReal = await cdp.eval(`
    (async () => {
      const c = document.getElementById('qrCanvas');
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const codes = await det.detect(c);
      return codes.length ? codes[0].rawValue : null;
    })()
  `);
  check('画布上的配对码可被扫出', !!decReal, decReal);
  check('扫出的内容与输入框一致', decReal === linkVal,
    `画布「${decReal}」输入框「${linkVal}」`);

  /* ===== 6. ?pair= 参数自动选中 ===== */
  await cdp.eval(`
    (() => {
      const u = new URL(location.href);
      u.searchParams.set('pair', 'demo-target-sid');
      location.href = u.toString();
      return true;
    })()
  `);
  await sleep(3000);

  const autoPick = await cdp.eval(`
    (() => {
      const label = document.getElementById('recipientLabel')?.textContent || '';
      const isDirect = document.getElementById('recipientBtn')?.classList.contains('direct');
      const urlClean = !location.search.includes('pair=');
      return { label, isDirect, urlClean };
    })()
  `);
  check('带 pair 参数自动选中收件人', autoPick.isDirect === true, autoPick.label);
  check('参数已从地址栏清除', autoPick.urlClean === true);

  await cdp.shot('22-pair-autoselect.png');

  /* ===== 7. 定向发送生效 ===== */
  await cdp.eval(`
    (() => {
      const i = document.getElementById('input');
      i.value = '扫码后定向发送测试';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSend').click();
      return true;
    })()
  `);
  await sleep(1200);

  const sentMsg = await cdp.eval(`
    (() => {
      const msgs = [...document.querySelectorAll('.msg')];
      const last = msgs[msgs.length - 1];
      return {
        text: last?.querySelector('.bubble')?.textContent,
        privateTag: last?.querySelector('.msg-private')?.textContent || null
      };
    })()
  `);
  check('扫码后发送的是私密消息',
    sentMsg.text === '扫码后定向发送测试' && !!sentMsg.privateTag,
    JSON.stringify(sentMsg));

  /* ===== 汇总 ===== */
  console.log('\n=========== 扫码配对测试 ===========\n');
  for (const l of log) console.log('  ' + l);
  const fails = log.filter((l) => l.startsWith('FAIL'));
  console.log(`\n  合计 ${log.length} 项，通过 ${log.length - fails.length}，失败 ${fails.length}`);

  await fetch('http://127.0.0.1:8787/api/clear?scope=all', {
    method: 'POST',
    headers: { 'X-Chat-Sender': Buffer.from(JSON.stringify({ sid: 'test-admin', name: '管理员', color: '#ef4444' })).toString('base64url') },
  }).catch(() => {});

  ws.close();
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
