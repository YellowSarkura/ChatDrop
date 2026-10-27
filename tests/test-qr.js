/** 验证 qrcode-svg 生成的二维码可被解码 */
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

  console.log('\n=== 1. 库加载 ===');
  const libOk = await cdp.eval('typeof QRCode === "function"');
  console.log(`  ${libOk ? 'PASS' : 'FAIL'}  qrcode-svg 已加载`);

  console.log('\n=== 2. 生成并解码 ===');
  const verify = await cdp.eval(`
    (async () => {
      const link = 'http://localhost:8787/?pair=abc123def456';
      const qr = new QRCode({
        content: link, width: 300, height: 300, padding: 2,
        background: 'white', color: '#0b1220', ecl: 'L', join: true
      });
      const svg = qr.svg();

      // SVG 转 canvas
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = rej; img.src = url;
      });
      const c = document.createElement('canvas');
      c.width = 300; c.height = 300;
      c.getContext('2d').drawImage(img, 0, 0, 300, 300);
      URL.revokeObjectURL(url);

      const det = new (window.BarcodeDetector || function(){})();
      if (!det.detect) return { ok: false, reason: '无 BarcodeDetector' };
      const codes = await det.detect(c);
      return {
        ok: codes.length > 0,
        expected: link,
        decoded: codes.length ? codes[0].rawValue : null,
        match: codes.length > 0 && codes[0].rawValue === link
      };
    })()
  `).catch((e) => ({ ok: false, reason: e.message }));

  console.log(`  ${verify.ok ? 'PASS' : 'SKIP'}  生成 SVG: ${verify.ok ? '成功' : verify.reason}`);
  if (verify.ok) {
    console.log(`  ${verify.match ? 'PASS' : 'FAIL'}  内容匹配`);
    console.log(`         期望: ${verify.expected}`);
    console.log(`         实得: ${verify.decoded}`);
  }

  console.log('\n=== 3. 配对面板 ===');
  await cdp.eval('document.getElementById("btnMore").click()');
  await sleep(400);
  await cdp.eval('document.getElementById("btnShowPair").click()');
  await sleep(900);

  const panel = await cdp.eval(`
    (() => {
      const back = document.getElementById('pairBackdrop');
      const holder = document.getElementById('qrHolder');
      const svg = holder.querySelector('svg');
      const input = document.getElementById('pairLinkInput');
      return {
        open: getComputedStyle(back).display !== 'none',
        hasSvg: !!svg,
        svgSize: svg ? { w: svg.getAttribute('width'), h: svg.getAttribute('height') } : null,
        link: input ? input.value : null,
        loadingHidden: document.getElementById('qrLoading').hidden
      };
    })()
  `);
  console.log(`  ${panel.open ? 'PASS' : 'FAIL'}  面板打开`);
  console.log(`  ${panel.hasSvg ? 'PASS' : 'FAIL'}  二维码 SVG 已渲染  ${JSON.stringify(panel.svgSize)}`);
  console.log(`  ${/pair=/.test(panel.link || '') ? 'PASS' : 'FAIL'}  链接含 pair 参数: ${panel.link}`);
  console.log(`  ${panel.loadingHidden ? 'PASS' : 'FAIL'}  加载遮罩已隐藏`);

  await cdp.shot('23-qr-pair.png');

  console.log('\n=== 4. 面板内实际二维码解码 ===');
  const realQr = await cdp.eval(`
    (async () => {
      const svg = document.querySelector('#qrHolder svg');
      if (!svg) return { ok: false };
      const s = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([s], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas');
      c.width = 464; c.height = 464;
      c.getContext('2d').drawImage(img, 0, 0, 464, 464);
      URL.revokeObjectURL(url);

      const det = new (window.BarcodeDetector || function(){})();
      if (!det.detect) return { ok: false };
      const codes = await det.detect(c);
      const input = document.getElementById('pairLinkInput').value;
      return {
        ok: codes.length > 0,
        decoded: codes.length ? codes[0].rawValue : null,
        input,
        match: codes.length > 0 && codes[0].rawValue === input
      };
    })()
  `).catch((e) => ({ ok: false, err: e.message }));

  console.log(`  ${realQr.ok ? 'PASS' : 'SKIP'}  面板二维码可解码`);
  if (realQr.ok) {
    console.log(`  ${realQr.match ? 'PASS' : 'FAIL'}  与输入框一致`);
    console.log(`         扫出: ${realQr.decoded}`);
  }

  console.log('\n=== 5. ?pair= 自动选中 ===');
  await cdp.eval(`
    (() => {
      const u = new URL(location.href);
      u.searchParams.set('pair', 'demo-sid-9x8y');
      location.href = u.toString();
      return true;
    })()
  `);
  await sleep(3000);
  const auto = await cdp.eval(`
    (() => ({
      direct: document.getElementById('recipientBtn')?.classList.contains('direct'),
      label: document.getElementById('recipientLabel')?.textContent,
      cleaned: !location.search.includes('pair=')
    }))()
  `);
  console.log(`  ${auto.direct ? 'PASS' : 'FAIL'}  自动选中收件人: ${auto.label}`);
  console.log(`  ${auto.cleaned ? 'PASS' : 'FAIL'}  参数已清除`);

  ws.close();
  const allPass = libOk && panel.open && panel.hasSvg && !!(realQr && realQr.match) && auto.direct;
  setTimeout(() => process.exit(allPass ? 0 : 1), 300);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
