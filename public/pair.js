'use strict';

/**
 * ChatDrop 扫码配对
 *
 * 实现参考 PairDrop（github.com/schlagmichdoch/PairDrop）：
 *   - 二维码用 qrcode-svg 库生成（与 PairDrop 同款，MIT）
 *   - 链接形式：<origin>?pair=<key>，对方扫开后自动选中
 *   - 手机扫电脑的码：用手机系统相机扫，不需要网页摄像头权限
 *
 * 为什么不用网页摄像头：
 *   浏览器只在「安全上下文」（HTTPS 或 localhost）下开放摄像头与
 *   BarcodeDetector。手机通过 http://192.168.x.x 访问时二者都不可用。
 *   用系统相机扫码只需一个静态二维码，兼容所有手机，零权限。
 */

(() => {
  const $ = (id) => document.getElementById(id);

  let currentSid = null;
  let onPickRecipient = null;
  let currentLanIp = null;   // 服务端上报的局域网 IP

  /* ---------------- 局域网 IP ---------------- */

  /** 从服务端拿局域网 IP（页面可能是用 127.0.0.1 打开的） */
  async function fetchLanIp() {
    if (currentLanIp) return currentLanIp;
    try {
      const r = await fetch('/api/info');
      const j = await r.json();
      const list = Array.isArray(j.addresses) ? j.addresses : [];
      if (list.length) {
        // 优先家用网段
        const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
        const sorted = [...list].sort((a, b) => rank(a.address) - rank(b.address));
        currentLanIp = sorted[0].address;
      }
    } catch { /* 拿不到就留空 */ }
    return currentLanIp;
  }

  /* ---------------- 配对链接 ---------------- */

  /**
   * 生成配对链接
   *
   * 关键：如果当前页面是用 localhost/127.0.0.1 打开的，
   * 二维码里必须换成局域网 IP，否则手机扫了会指向它自己。
   */
  function pairUrl(sid) {
    let base = location.origin;

    const host = location.hostname;
    const isLoopback = host === 'localhost' || host === '127.0.0.1' ||
                       host === '::1' || host === '[::1]';

    if (isLoopback && currentLanIp) {
      const port = location.port ? ':' + location.port : '';
      base = `${location.protocol}//${currentLanIp}${port}`;
    }

    const u = new URL(base + location.pathname);
    u.search = '';
    u.hash = '';
    u.searchParams.set('pair', sid);
    return u.toString();
  }

  /** 显示当前二维码指向的地址，便于排查 */
  function renderNetInfo() {
    const box = $('pairNet');
    if (!box) return;
    const link = pairUrl(currentSid);
    let host = '';
    try { host = new URL(link).host; } catch { host = '未知'; }

    const isLoopback = /^(localhost|127\.|\[?::1)/.test(host);

    box.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'pair-net-line';
    line.textContent = `二维码地址：${host}`;
    box.appendChild(line);

    if (isLoopback) {
      const warn = document.createElement('div');
      warn.className = 'pair-net-warn';
      warn.textContent = '⚠ 这是本机地址，手机打不开。请改用局域网 IP 访问本页';
      box.appendChild(warn);
    }
  }

  /** 从当前 URL 解析配对目标 */
  function readPairTarget() {
    const p = new URLSearchParams(location.search).get('pair');
    return p && /^[0-9a-zA-Z_-]{4,64}$/.test(p) ? p : null;
  }

  /** 清除地址栏 pair 参数，避免刷新重复触发 */
  function clearPairParam() {
    const u = new URL(location.href);
    if (!u.searchParams.has('pair')) return;
    u.searchParams.delete('pair');
    history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  }

  /* ---------------- 二维码渲染 ---------------- */

  async function drawMyQr() {
    const holder = $('qrHolder');
    const loading = $('qrLoading');
    if (!holder) return;

    if (!currentSid) {
      if (loading) { loading.hidden = false; loading.textContent = '尚未连接'; }
      return;
    }
    if (typeof QRCode !== 'function') {
      if (loading) { loading.hidden = false; loading.textContent = '二维码库未加载'; }
      return;
    }

    // 先确保拿到局域网 IP（页面可能是用 127.0.0.1 打开的）
    await fetchLanIp();

    const link = pairUrl(currentSid);
    const input = $('pairLinkInput');
    if (input) input.value = link;

    renderNetInfo();

    try {
      // 与 PairDrop 相同的参数（ecl L 容量更大，适合长 URL）
      const qr = new QRCode({
        content: link,
        width: 232,
        height: 232,
        padding: 2,
        background: 'white',
        color: 'rgb(11, 18, 32)',
        ecl: 'L',
        join: true,
      });
      holder.innerHTML = qr.svg();
      if (loading) loading.hidden = true;
    } catch (e) {
      if (loading) {
        loading.hidden = false;
        loading.textContent = '生成失败：' + e.message;
      }
    }
  }

  /* ---------------- 面板控制 ---------------- */

  function openPairSheet() {
    const back = $('pairBackdrop');
    if (!back) return;
    back.hidden = false;
    drawMyQr();
  }

  function closePairSheet() {
    const back = $('pairBackdrop');
    if (back) back.hidden = true;
  }

  /* ---------------- 初始化 ---------------- */

  function init({ getSid, onPick }) {
    currentSid = typeof getSid === 'function' ? getSid() : getSid;
    onPickRecipient = onPick;

    const btnShow = $('btnShowPair');
    if (btnShow) {
      btnShow.addEventListener('click', () => {
        const sheet = $('sheetBackdrop');
        if (sheet) sheet.hidden = true;
        openPairSheet();
      });
    }

    const btnClose = $('btnPairCancel');
    if (btnClose) btnClose.addEventListener('click', closePairSheet);

    const back = $('pairBackdrop');
    if (back) {
      back.addEventListener('click', (e) => {
        if (e.target === back) closePairSheet();
      });
    }

    const btnCopy = $('btnCopyPairLink');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        const input = $('pairLinkInput');
        if (!input || !input.value) return;
        const done = () => {
          btnCopy.textContent = '已复制';
          setTimeout(() => { btnCopy.textContent = '复制'; }, 1500);
        };
        if (navigator.clipboard) {
          navigator.clipboard.writeText(input.value).then(done, () => {
            input.select();
            try { document.execCommand('copy'); done(); } catch { /* ignore */ }
          });
        } else {
          input.select();
          try { document.execCommand('copy'); done(); } catch { /* ignore */ }
        }
      });
    }

    // 刷新：重新读网络信息，并明确告知结果
    const btnRefresh = $('btnRefreshQr');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', async () => {
        const oldLink = $('pairLinkInput')?.value || '';

        btnRefresh.disabled = true;
        btnRefresh.textContent = '…';

        currentLanIp = null;            // 强制重新向服务端要 IP
        await drawMyQr();

        const newLink = $('pairLinkInput')?.value || '';

        btnRefresh.disabled = false;

        if (oldLink !== newLink) {
          btnRefresh.textContent = '已更新';
          toastMini('二维码已更新（地址变了）');
        } else {
          btnRefresh.textContent = '无变化';
          toastMini('地址没变，二维码内容相同');
        }

        setTimeout(() => { btnRefresh.textContent = '刷新'; }, 1400);
      });
    }

    // 点击二维码本身也能刷新
    const holder = $('qrHolder');
    if (holder) {
      holder.style.cursor = 'pointer';
      holder.title = '点击刷新二维码';
      holder.addEventListener('click', async () => {
        currentLanIp = null;
        await drawMyQr();
      });
    }
  }

  /** 面板内的小提示 */
  function toastMini(text) {
    const box = $('pairNet');
    if (!box) return;
    let tip = box.querySelector('.pair-net-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'pair-net-tip';
      box.appendChild(tip);
    }
    tip.textContent = text;
    clearTimeout(tip.__timer);
    tip.__timer = setTimeout(() => { tip.textContent = ''; }, 2000);
  }

  /** 页面加载时若 URL 带 pair 参数，自动选中对方 */
  function consumePairParam(onPick) {
    const target = readPairTarget();
    if (!target) return null;
    clearPairParam();
    if (onPick) onPick(target, null);
    return target;
  }

  window.ChatDropPair = {
    init,
    openPairSheet,
    consumePairParam,
    pairUrl,
    readPairTarget,
    refreshQr: drawMyQr,
    setSid: (s) => { currentSid = s; },
  };
})();
