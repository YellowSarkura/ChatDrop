/** 检查服务端实际下发的资源内容 */
const BASE = 'http://127.0.0.1:8787';

(async () => {
  const checks = [];

  const get = async (path) => {
    const r = await fetch(BASE + path);
    return { status: r.status, text: await r.text() };
  };

  console.log('\n=== 服务端下发的资源 ===\n');

  // CSS
  const css = await get('/style.css');
  console.log(`style.css: ${css.status}  ${css.text.length} 字节`);
  console.log(`  含 recipient-chip: ${css.text.includes('.recipient-chip')}`);
  console.log(`  含 tool-chip: ${css.text.includes('.tool-chip')}`);
  console.log(`  含 100dvh: ${css.text.includes('100dvh')}`);
  console.log(`  composer padding: ${/\.composer\s*\{[^}]*padding:\s*([^;]+)/.exec(css.text)?.[1] || '未找到'}`);

  // JS
  const js = await get('/app.js');
  console.log(`\napp.js: ${js.status}  ${js.text.length} 字节`);
  const posName = js.text.indexOf('let myName =');
  const posAdj = js.text.indexOf('const NAME_ADJ');
  console.log(`  NAME_ADJ 位置: ${posAdj}`);
  console.log(`  let myName 位置: ${posName}`);
  console.log(`  顺序正确(AIJ在前): ${posAdj > 0 && posAdj < posName}`);
  console.log(`  含 syncViewport: ${js.text.includes('syncViewport')}`);
  console.log(`  含 applyDeviceCopy: ${js.text.includes('applyDeviceCopy')}`);

  // SW
  const sw = await get('/sw.js');
  console.log(`\nsw.js: ${sw.status}  ${sw.text.length} 字节`);
  const cacheVer = /chatdrop-shell-v(\d+)/.exec(sw.text)?.[0] || '未找到';
  console.log(`  缓存版本: ${cacheVer}`);
  console.log(`  网络优先: ${sw.text.includes('.then((res) =>')}`);
  console.log(`  旧版缓存优先残留(cached || network): ${sw.text.includes('return cached || network')}`);

  // HTML
  const html = await get('/');
  console.log(`\nindex.html: ${html.status}  ${html.text.length} 字节`);
  console.log(`  含 recipient-chip: ${html.text.includes('recipient-chip')}`);
  console.log(`  含 btnPickFile: ${html.text.includes('btnPickFile')}`);
  console.log(`  空状态文案: ${/id="emptyTitle"[^>]*>([^<]+)/.exec(html.text)?.[1] || '未找到'}`);

  console.log('\n=== 结论 ===\n');
  const cssOk = css.text.includes('.recipient-chip') && !css.text.includes('.tool-chip');
  const jsOk = posAdj > 0 && posAdj < posName;
  const swOk = sw.text.includes('chatdrop-shell-v3') && !sw.text.includes('return cached || network');
  console.log(`  CSS ${cssOk ? 'OK' : 'FAIL'}`);
  console.log(`  JS  ${jsOk ? 'OK' : 'FAIL'}`);
  console.log(`  SW  ${swOk ? 'OK' : 'FAIL'}`);

  if (cssOk && jsOk && swOk) {
    console.log('\n  服务端全部是最新版本。手机端仍有问题 → 手机浏览器缓存未清。');
  }
})();
