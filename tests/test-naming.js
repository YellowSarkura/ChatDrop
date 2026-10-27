/** 验证设备命名与区分能力 */
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
  await sleep(3000);

  console.log('\n=== 1. 默认设备名格式 ===\n');
  const myName = await cdp.eval(`localStorage.getItem('chatdrop.name') || '(未设置，用默认)'`);
  const shownName = await cdp.eval(`
    (() => {
      const el = document.querySelector('.me-avatar');
      return el ? el.textContent : null;
    })()
  `);
  console.log('  localStorage 名字:', myName);
  console.log('  头像首字:', shownName);

  // 验证名字是「X的Y」格式，不含 Win32/Linux 之类
  const hasPlatform = /Win32|Linux|MacIntel|armv/i.test(myName);
  console.log('  含平台字符串:', hasPlatform ? '是 [FAIL]' : '否 [PASS]');

  console.log('\n=== 2. 生成 10 个模拟设备名，检查重复率 ===\n');
  const names = await cdp.eval(`
    (() => {
      const NAME_ADJ = ['青柠','海盐','山茶','松露','雪松','柚子','薄荷','琥珀','云朵','麦穗','珊瑚','雾蓝','杏子','竹青','星尘','初雪','晨雾','晚枫','碧波','暮云','白露','霜降','惊蛰'];
      const NAME_NOUN = ['鲸鱼','狐狸','麋鹿','企鹅','海獭','云雀','山猫','水母','萤火','松鼠','白鹭','刺猬','海豚','夜莺','小熊猫','北极熊','穿山甲','蜂鸟','蜻蜓','蝴蝶','锦鲤','考拉','羊驼','鹦鹉'];
      function hash(str){let h=0;for(let i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))>>>0;return h;}
      const out = [];
      for (let i = 0; i < 10; i++) {
        const sid = 'test-device-' + i + '-' + Math.random().toString(36).slice(2, 8);
        const h = hash(sid);
        out.push(NAME_ADJ[h % NAME_ADJ.length] + '的' + NAME_NOUN[(h >> 8) % NAME_NOUN.length]);
      }
      return out;
    })()
  `);
  console.log('  ' + names.join('  '));
  const uniq = new Set(names).size;
  console.log(`  ${names.length} 个名字，去重后 ${uniq} 个  ${uniq === names.length ? '[全部唯一]' : `[有 ${names.length - uniq} 个重复]`}`);

  console.log('\n=== 3. 同名设备的区分（短 ID）===\n');
  // 造两个同名设备
  const ctrl1 = new AbortController();
  const ctrl2 = new AbortController();
  await fetch(`${BASE}/api/events?sid=AAAA1111-duplicate&name=${encodeURIComponent('测试设备')}&color=%233b82f6`, { signal: ctrl1.signal }).catch(() => {});
  await fetch(`${BASE}/api/events?sid=BBBB2222-duplicate&name=${encodeURIComponent('测试设备')}&color=%233b82f6`, { signal: ctrl2.signal }).catch(() => {});
  await sleep(1200);

  const list = await (await fetch(`${BASE}/api/devices`)).json();
  console.log('  在线设备:');
  for (const d of list.devices) {
    console.log(`    ${d.name}   sid=${d.sid.slice(0, 8)}`);
  }
  const dups = list.devices.filter((d) => d.name === '测试设备');
  console.log(`  同名设备数: ${dups.length}  ${dups.length === 2 ? '[可测试区分]' : ''}`);

  // 打开设备面板看渲染
  await cdp.eval(`document.getElementById('recipientBtn').click()`);
  await sleep(700);

  const rendered = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.device-item')];
      return items.map(n => ({
        name: n.querySelector('.dev-name')?.textContent?.trim(),
        hasId: !!n.querySelector('.dev-id'),
        sub: n.querySelector('.dev-sub')?.textContent,
      }));
    })()
  `);
  console.log('\n  面板渲染:');
  for (const r of rendered) {
    console.log(`    ${r.name}${r.hasId ? '  [有短ID]' : ''}   ${r.sub || ''}`);
  }

  const dupItems = rendered.filter((r) => r.name && r.name.includes('测试设备'));
  const allHaveId = dupItems.every((r) => r.hasId);
  console.log(`\n  同名设备都显示短ID: ${allHaveId ? '是 [PASS]' : '否 [FAIL]'}`);

  ctrl1.abort();
  ctrl2.abort();
  ws.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
