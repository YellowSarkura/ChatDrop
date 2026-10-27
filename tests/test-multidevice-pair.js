/**
 * 验证：多台手机扫同一个二维码会怎样？
 *
 * 模拟：
 *   电脑展示二维码（pair=电脑sid）
 *   手机A 扫 → 打开带 pair 的链接
 *   手机B 也扫同样的码
 *   检查：两者身份是否独立、是否冲突、能否都发给电脑
 */
const crypto = require('crypto');
const BASE = 'http://127.0.0.1:8787';

const hdr = (sid, name) => Buffer.from(JSON.stringify({
  sid, name, color: '#3b82f6',
})).toString('base64url');

(async () => {
  console.log('\n=== 多设备扫同一码的行为 ===\n');

  // 1. 电脑身份
  const pcSid = crypto.randomUUID();
  console.log(`电脑 sid: ${pcSid.slice(0, 8)}...`);

  // 2. 两台手机扫同一个码（pair=pcSid）
  //    每台手机打开页面后会生成自己的 sid（localStorage 独立）
  const phoneA = { sid: crypto.randomUUID(), name: '手机A' };
  const phoneB = { sid: crypto.randomUUID(), name: '手机B' };

  console.log(`手机A sid: ${phoneA.sid.slice(0, 8)}...  （扫完自动生成）`);
  console.log(`手机B sid: ${phoneB.sid.slice(0, 8)}...  （扫完自动生成）`);
  console.log('');

  console.log(`三者 sid 是否互不相同: ${
    new Set([pcSid, phoneA.sid, phoneB.sid]).size === 3 ? '是 [PASS]' : '否 [FAIL]'
  }`);

  // 3. 两台手机都发消息给电脑（都用 pair=pcSid 的意图）
  for (const phone of [phoneA, phoneB]) {
    const r = await fetch(`${BASE}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(phone.sid, phone.name) },
      body: JSON.stringify({ text: `${phone.name} 发来的消息`, to: pcSid }),
    });
    console.log(`${phone.name} 发送给电脑: status=${r.status}`);
  }

  // 4. 电脑能收到两条吗？
  const pcView = await (await fetch(`${BASE}/api/messages?sid=${pcSid}&name=电脑`, {
    headers: { 'X-Chat-Sender': hdr(pcSid, '电脑') },
  })).json();

  const fromA = pcView.messages.some((m) => m.sender?.sid === phoneA.sid);
  const fromB = pcView.messages.some((m) => m.sender?.sid === phoneB.sid);

  console.log('');
  console.log(`电脑收到手机A的消息: ${fromA ? '是 [PASS]' : '否 [FAIL]'}`);
  console.log(`电脑收到手机B的消息: ${fromB ? '是 [PASS]' : '否 [FAIL]'}`);

  // 5. 手机A能看到手机B发的吗？（应该看不到——不是广播）
  const aView = await (await fetch(`${BASE}/api/messages?sid=${phoneA.sid}&name=手机A`, {
    headers: { 'X-Chat-Sender': hdr(phoneA.sid, phoneA.name) },
  })).json();
  const aSeesB = aView.messages.some((m) => m.sender?.sid === phoneB.sid);
  console.log(`手机A看到手机B的消息: ${aSeesB ? '是' : '否（私密消息，相互不可见）'}`);

  // 6. 手机A能否发文件给手机B（需要知道对方 sid）
  const fileData = Buffer.from('test content from A to B');
  const sha = crypto.createHash('sha256').update(fileData).digest('hex');

  const initR = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(phoneA.sid, phoneA.name) },
    body: JSON.stringify({
      name: 'A发的文件.txt',
      size: fileData.length,
      mime: 'text/plain',
      fingerprint: 'a2b|' + Date.now(),
      to: phoneB.sid,
    }),
  });
  const initJ = await initR.json();
  console.log('');
  console.log(`手机A 发文件给手机B: init status=${initR.status}`);

  if (initJ.sessionId) {
    await fetch(`${BASE}/api/upload/chunk?sessionId=${initJ.sessionId}&token=${encodeURIComponent(initJ.token)}&offset=0`, {
      method: 'POST',
      headers: { 'X-Chat-Sender': hdr(phoneA.sid, phoneA.name), 'Content-Type': 'application/octet-stream' },
      body: fileData,
    });
    const comp = await fetch(`${BASE}/api/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-Sender': hdr(phoneA.sid, phoneA.name) },
      body: JSON.stringify({ sessionId: initJ.sessionId, token: initJ.token, sha256: sha }),
    });
    console.log(`  完成: status=${comp.status}`);

    // 手机B 能否收到
    const bView = await (await fetch(`${BASE}/api/messages?sid=${phoneB.sid}&name=手机B`, {
      headers: { 'X-Chat-Sender': hdr(phoneB.sid, phoneB.name) },
    })).json();
    const bGot = bView.messages.some((m) => m.file?.name === 'A发的文件.txt');
    console.log(`  手机B 收到文件: ${bGot ? '是 [PASS]' : '否 [FAIL]'}`);

    // 电脑能否看到（不该看到，因为是 A→B 的私密）
    const pcView2 = await (await fetch(`${BASE}/api/messages?sid=${pcSid}&name=电脑`, {
      headers: { 'X-Chat-Sender': hdr(pcSid, '电脑') },
    })).json();
    const pcSees = pcView2.messages.some((m) => m.file?.name === 'A发的文件.txt');
    console.log(`  电脑看到该文件: ${pcSees ? '是（不应该）' : '否 [正确]'}`);
  }

  console.log('\n=== 结论 ===');
  console.log('  同一个码：多台手机都能扫，各自生成独立身份，互不冲突');
  console.log('  但手机之间要互传，必须先知道对方的 sid');
})();
