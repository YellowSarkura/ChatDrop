'use strict';

/* ==================================================================
   ChatDrop 前端
   - 文字 / 图片 / 文件三类消息
   - 拖拽、粘贴、选择器三种入口
   - SSE 实时同步、多端在线
   - XHR 上传带真实进度与取消
   ================================================================== */

(() => {
  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);

  const el = {
    messages: $('messages'),
    emptyState: $('emptyState'),
    input: $('input'),
    btnSend: $('btnSend'),
    btnAttach: $('btnAttach'),
    fileInput: $('fileInput'),
    dropzone: $('dropzone'),
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    meAvatar: $('meAvatar'),
    btnMe: $('btnMe'),
    btnMore: $('btnMore'),
    uploadPanel: $('uploadPanel'),
    uploadList: $('uploadList'),
    uploadCount: $('uploadCount'),
    sheetBackdrop: $('sheetBackdrop'),
    btnSheetCancel: $('btnSheetCancel'),
    btnReload: $('btnReload'),
    btnClear: $('btnClear'),
    btnInfo: $('btnInfo'),
    lightbox: $('lightbox'),
    lightboxImg: $('lightboxImg'),
    lightboxClose: $('lightboxClose'),
    meBackdrop: $('meBackdrop'),
    meNameInput: $('meNameInput'),
    meSave: $('meSave'),
    meCancel: $('meCancel'),
    toast: $('toast'),
    // 收件人相关
    recipientBar: $('recipientBar'),
    recipientBtn: $('recipientBtn'),
    recipientLabel: $('recipientLabel'),
    recipientBackdrop: $('recipientBackdrop'),
    deviceList: $('deviceList'),
    btnRecipientCancel: $('btnRecipientCancel'),
    onlineCount: $('onlineCount'),
  };

  /* ---------------- 在线设备与收件人 ---------------- */

  /** 在线设备（不含自己） */
  let devices = [];
  /** 当前收件人：null=所有人，'sid'=单发，['a','b']=多发 */
  let recipient = null;

  function otherDevices() {
    return devices.filter((d) => d.sid !== sid);
  }

  function recipientText() {
    const others = otherDevices();
    if (!recipient) {
      return others.length ? '发送给所有人' : '还没有其他设备';
    }
    if (Array.isArray(recipient)) {
      const names = recipient
        .map((s) => others.find((d) => d.sid === s)?.name || '离线设备')
        .slice(0, 2);
      const more = recipient.length > 2 ? ` 等${recipient.length}台` : '';
      return `发送给 ${names.join('、')}${more}`;
    }
    const d = others.find((x) => x.sid === recipient);
    return d ? `发送给 ${d.name}` : '发送给 离线设备';
  }

  function syncRecipientUI() {
    if (el.recipientLabel) el.recipientLabel.textContent = recipientText();
    const others = otherDevices();
    if (el.onlineCount) {
      el.onlineCount.textContent = others.length
        ? `${others.length} 台在线`
        : '';
    }
    if (el.recipientBtn) {
      el.recipientBtn.classList.toggle('direct', !!recipient);
    }
    // 同步二维码（若面板存在）
    if (window.ChatDropPair) window.ChatDropPair.setSid(sid);
  }

  function renderDeviceList() {
    if (!el.deviceList) return;
    const others = otherDevices();
    el.deviceList.innerHTML = '';

    // 「所有人」选项
    const all = document.createElement('button');
    all.className = 'device-item' + (recipient === null ? ' active' : '');
    all.innerHTML = `
      <span class="dev-avatar" style="background:#64748b">全</span>
      <span class="dev-info">
        <span class="dev-name">所有人</span>
        <span class="dev-sub">公开可见，所有设备都能收到</span>
      </span>
      <span class="dev-check">${recipient === null ? '✓' : ''}</span>`;
    all.onclick = () => {
      recipient = null;
      syncRecipientUI();
      renderDeviceList();
      el.recipientBackdrop.hidden = true;
    };
    el.deviceList.appendChild(all);

    if (!others.length) {
      const empty = document.createElement('div');
      empty.className = 'device-empty';
      empty.textContent = '暂无其他设备在线。让其他设备用同一 WiFi 打开本页即可。';
      el.deviceList.appendChild(empty);
      return;
    }

    for (const d of others) {
      const isOn = Array.isArray(recipient)
        ? recipient.includes(d.sid)
        : recipient === d.sid;

      // 名字重复时追加短 ID，确保能区分
      const dupCount = others.filter((x) => (x.name || '') === (d.name || '')).length;
      const shortId = (d.sid || '').slice(0, 4).toUpperCase();
      const showId = dupCount > 1;

      const item = document.createElement('button');
      item.className = 'device-item' + (isOn ? ' active' : '');
      item.innerHTML = `
        <span class="dev-avatar" style="background:${d.color || '#3b82f6'}">${(d.name || '?').trim().slice(0, 1)}</span>
        <span class="dev-info">
          <span class="dev-name">${escapeHtml(d.name || '匿名设备')}${showId ? `<span class="dev-id">#${shortId}</span>` : ''}</span>
          <span class="dev-sub">在线 · 点击选择</span>
        </span>
        <span class="dev-check">${isOn ? '✓' : ''}</span>`;

      item.onclick = () => {
        // 单击切换：已选中则取消，否则单选该设备
        if (isOn && !Array.isArray(recipient)) {
          recipient = null;
        } else {
          recipient = d.sid;
        }
        syncRecipientUI();
        renderDeviceList();
        el.recipientBackdrop.hidden = true;
      };
      el.deviceList.appendChild(item);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function setDevices(list) {
    devices = Array.isArray(list) ? list : [];
    // 收件人离线时提示但仍保留，避免误发
    syncRecipientUI();
    if (!el.recipientBackdrop.hidden) renderDeviceList();
  }

  /* ---------------- 身份 ---------------- */
  const SID_KEY = 'chatdrop.sid';
  const NAME_KEY = 'chatdrop.name';
  const COLOR_KEY = 'chatdrop.color';

  const PALETTE = [
    '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
    '#06b6d4', '#f43f5e', '#6366f1', '#14b8a6', '#a855f7',
  ];

  const sid = (() => {
    let v = localStorage.getItem(SID_KEY);
    if (!v) {
      v = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).slice(0, 36);
      localStorage.setItem(SID_KEY, v);
    }
    return v;
  })();

  /**
   * 默认设备名
   *
   * 参考 PairDrop（11.6k stars）用 unique-names-generator 的做法：
   * 「形容词 + 名词」两个词，简短好记，用设备 id 做种子保证稳定。
   *
   * 两个必须注意的点：
   *   1. 常量必须在调用之前声明（const/let 有暂时性死区，
   *      先调用再声明会抛 ReferenceError，整个脚本中止）
   *   2. 不能用 h >> 8 —— hash 是无符号 32 位，超过 2^31 时
   *      >> 会变成负数，取模得到负索引，名字里出现 undefined
   */
  const NAME_ADJ = [
    '青柠', '海盐', '山茶', '松露', '雪松', '柚子', '薄荷', '琥珀',
    '云朵', '麦穗', '珊瑚', '雾蓝', '杏子', '竹青', '星尘', '初雪',
    '晨雾', '晚枫', '碧波', '暮云', '白露', '霜降', '惊蛰', '谷雨',
  ];
  const NAME_NOUN = [
    '鲸鱼', '狐狸', '麋鹿', '企鹅', '海獭', '云雀', '山猫', '水母',
    '萤火', '松鼠', '白鹭', '刺猬', '海豚', '夜莺', '熊猫', '北极熊',
    '穿山甲', '蜂鸟', '蜻蜓', '蝴蝶', '锦鲤', '考拉', '羊驼', '鹦鹉',
  ];

  function defaultName() {
    const h = hash(sid);
    // >>> 保证结果是非负整数
    const ai = (h >>> 0) % NAME_ADJ.length;
    const ni = ((h >>> 8) >>> 0) % NAME_NOUN.length;
    return `${NAME_ADJ[ai]}的${NAME_NOUN[ni]}`;
  }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  // 必须在 defaultName 与 NAME_ADJ 都定义之后才能求值
  let myName = localStorage.getItem(NAME_KEY) || defaultName();
  let myColor = localStorage.getItem(COLOR_KEY) || PALETTE[hash(sid) % PALETTE.length];

  function senderHeader() {
    const payload = JSON.stringify({ sid, name: myName, color: myColor });
    return btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function syncMeUI() {
    el.meAvatar.textContent = (myName || '我').trim().slice(0, 1);
    el.meAvatar.style.background = myColor;
  }

  /* ---------------- 功能扩展接口 ---------------- */

  /**
   * 轻量事件总线：后续新增功能（五子棋等）通过 window.ChatDrop 接入，
   * 不需要改动聊天主流程。
   */
  const featureListeners = new Map();

  function onFeatureEvent(type, fn) {
    if (!featureListeners.has(type)) featureListeners.set(type, []);
    featureListeners.get(type).push(fn);
  }

  function emitFeatureEvent(type, data) {
    const list = featureListeners.get(type);
    if (!list) return;
    for (const fn of list) {
      try { fn(data); } catch (err) { console.error('[feature]', err); }
    }
  }

  window.ChatDrop = {
    getSid: () => sid,
    getName: () => myName,
    getColor: () => myColor,
    getDevices: () => devices.slice(),
    senderHeader,
    toast,
    escapeHtml,
    setActiveNav,
    on: onFeatureEvent,
  };

  /* ---------------- 消息渲染 ---------------- */
  const seen = new Set();          // 已渲染的 id
  let lastDay = null;              // 日期分隔
  let lastSender = null;           // 连续消息合并

  function fmtTime(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtDay(ts) {
    const d = new Date(ts);
    const now = new Date();
    const same = d.toDateString() === now.toDateString();
    if (same) return '今天';
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
  }

  function extLabel(name) {
    const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
    return m ? m[1].toUpperCase() : 'FILE';
  }

  function el_(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderMessage(msg, { scroll = true } = {}) {
    if (seen.has(msg.id)) return;
    seen.add(msg.id);

    if (el.emptyState && el.emptyState.parentNode) el.emptyState.remove();

    // 日期分隔
    const day = fmtDay(msg.ts);
    if (day !== lastDay) {
      el.messages.appendChild(el_('div', 'day-sep', day));
      lastDay = day;
      lastSender = null;
    }

    const mine = msg.sender && msg.sender.sid === sid;
    const grouped = lastSender === msg.sender.sid &&
      el.messages.lastElementChild &&
      !el.messages.lastElementChild.classList.contains('day-sep');

    const wrap = el_('div', 'msg' + (mine ? ' mine' : '') + (grouped ? ' grouped' : ''));
    wrap.dataset.id = msg.id;

    // 头像
    const av = el_('div', 'avatar');
    av.textContent = (msg.sender?.name || '?').trim().slice(0, 1);
    av.style.background = msg.sender?.color || '#64748b';

    const body = el_('div', 'msg-body');

    // 私密标记独立成行，避免被「连续消息隐藏 meta」的规则吃掉
    if (msg.to) {
      const isMulti = Array.isArray(msg.to);
      const badge = el_('div', 'msg-badge');
      badge.appendChild(el_('span', 'msg-private', isMulti ? '私密 · 多设备' : '私密发送'));
      body.appendChild(badge);
    }

    // 元信息
    const meta = el_('div', 'msg-meta');
    meta.appendChild(el_('span', 'msg-name', mine ? '我' : (msg.sender?.name || '匿名')));
    meta.appendChild(el_('span', '', fmtTime(msg.ts)));
    body.appendChild(meta);

    // 内容
    if (msg.type === 'text') {
      const b = el_('div', 'bubble');
      b.textContent = msg.text;
      body.appendChild(b);
    } else if (msg.type === 'image') {
      const b = el_('div', 'bubble image');
      const img = new Image();
      // 不用 loading="lazy"：图片容器初始高度为 0 时，
      // 懒加载会判定「不在视口内」→ 不加载 → 高度仍为 0 的死循环。
      img.decoding = 'async';
      img.alt = msg.file?.name || '图片';
      img.src = `/api/file/${msg.id}`;
      img.addEventListener('click', () => openLightbox(img.src));
      // 加载完成后修正一次滚动位置，避免图片撑开高度导致视口跳动
      img.addEventListener('load', () => {
        if (nearBottom()) scrollToBottom();
      }, { once: true });
      img.addEventListener('error', () => {
        b.classList.add('broken');
        b.textContent = '图片加载失败';
      }, { once: true });
      b.appendChild(img);
      body.appendChild(b);
    } else {
      const a = el_('a', 'bubble file');
      a.href = `/api/file/${msg.id}?dl=1`;
      a.setAttribute('download', msg.file?.name || 'file');

      const icon = el_('div', 'file-icon', extLabel(msg.file?.name));
      const info = el_('div', 'file-info');
      info.appendChild(el_('span', 'file-name', msg.file?.name || '文件'));
      info.appendChild(el_('span', 'file-size', fmtSize(msg.file?.size)));

      const dl = el_('div', 'file-dl');
      dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>';

      a.append(icon, info, dl);
      body.appendChild(a);
    }

    // 删除按钮
    const del = el_('button', 'msg-del', '删除');
    del.addEventListener('click', async () => {
      if (!confirm('删除这条消息？')) return;
      try {
        // 必须带上身份头，否则服务端无法判断归属，会返回 403
        const res = await fetch(`/api/message/${msg.id}`, {
          method: 'DELETE',
          headers: { 'X-Chat-Sender': senderHeader() },
        });

        if (!res.ok) {
          let reason = '删除失败';
          try {
            const j = await res.json();
            if (j && j.error) reason = j.error;
          } catch { /* ignore */ }
          toast(reason);
          return;
        }

        // 立即从界面移除，不等 SSE（自己发的删除广播可能先到）
        removeMessage(msg.id);
      } catch (e) {
        toast('删除失败：' + (e.message || '网络错误'));
      }
    });

    wrap.append(av, body, del);
    el.messages.appendChild(wrap);

    lastSender = msg.sender?.sid || null;

    if (scroll) scrollToBottom();
  }

  function removeMessage(id) {
    const node = el.messages.querySelector(`.msg[data-id="${id}"]`);
    if (node) node.remove();
    seen.delete(id);
    if (!el.messages.querySelector('.msg')) showEmpty();
  }

  function showEmpty() {
    lastDay = null;
    lastSender = null;
    if (el.emptyState.parentNode) return;
    el.messages.appendChild(el.emptyState);
  }

  let scrollPending = false;
  function scrollToBottom() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      el.messages.scrollTop = el.messages.scrollHeight;
      scrollPending = false;
    });
  }

  function nearBottom() {
    const m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
  }

  /* ---------------- 提示 ---------------- */
  let toastTimer = null;
  function toast(text, ms = 2200) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  /* ---------------- 灯箱 ---------------- */
  function openLightbox(src) {
    el.lightboxImg.src = src;
    el.lightbox.hidden = false;
  }
  el.lightboxClose.addEventListener('click', () => {
    el.lightbox.hidden = true;
    el.lightboxImg.src = '';
  });
  el.lightbox.addEventListener('click', (e) => {
    if (e.target === el.lightbox) {
      el.lightbox.hidden = true;
      el.lightboxImg.src = '';
    }
  });

  /* ---------------- 按设备类型调整文案 ---------------- */

  /**
   * 手机没有鼠标，不能拖拽；也没有 Ctrl+V 粘贴。
   * 所以空状态和输入框提示要按设备类型切换，
   * 避免在手机上出现"拖进来"这种做不到的引导。
   */
  const isTouchDevice = (() => {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
    return (coarse && noHover) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  })();

  function applyDeviceCopy() {
    const title = $('emptyTitle');
    const desc = $('emptyDesc');
    const input = $('input');

    if (isTouchDevice) {
      if (title) title.textContent = '说点什么，或者发个文件';
      if (desc) desc.textContent = '点下方的图片或文件按钮发送，也能直接打字。同一 WiFi 下的设备会实时同步。';
      if (input) input.placeholder = '说点什么…';
    } else {
      if (title) title.textContent = '拖进来，或者直接打字';
      if (desc) desc.textContent = '把文件拖进窗口即可发送，也能 Ctrl+V 粘贴截图。';
      if (input) input.placeholder = '说点什么，或把文件拖进来…';
    }

    // 拖拽遮罩在触屏设备上没有意义
    document.body.classList.toggle('touch-device', isTouchDevice);
  }

  applyDeviceCopy();

  /* ---------------- 发送文字 ---------------- */
  async function sendText() {
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    autoGrow();
    updateSendState();

    try {
      const res = await fetch('/api/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Sender': senderHeader(),
        },
        body: JSON.stringify({ text, to: recipient || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || '发送失败');
      }
    } catch (err) {
      toast(err.message || '发送失败，请检查连接');
      el.input.value = text;
      autoGrow();
      updateSendState();
    }
  }

  /* ---------------- 上传文件（多任务并发 + 断点续传） ---------------- */

  // 把发送者信息暴露给 uploader.js
  window.__chatdropSenderHeader = senderHeader;

  // 上传完成后插入消息（由 uploader 回调）
  window.__chatdropOnUploaded = (msg) => {
    if (!msg) return;
    const stick = nearBottom();
    renderMessage(msg, { scroll: stick });
  };

  // 秒传命中：文件已存在，直接提示
  window.__chatdropOnInstant = (msg) => {
    toast('该文件已在列表中（秒传）');
    if (msg) {
      const stick = nearBottom();
      renderMessage(msg, { scroll: stick });
    }
  };

  function uploadFiles(fileList) {
    if (!window.ChatDropUploader) {
      toast('上传模块未加载');
      return;
    }
    // 把当前收件人传给上传器，文件也会定向发送
    window.ChatDropUploader.addFiles(fileList, { to: recipient || undefined });
  }

  // 暴露给 uploader.js 读取当前收件人
  window.__chatdropRecipient = () => recipient || undefined;

  /* ---------------- 输入框 ---------------- */
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 132) + 'px';
  }

  function updateSendState() {
    el.btnSend.disabled = el.input.value.trim().length === 0;
  }

  el.input.addEventListener('input', () => {
    autoGrow();
    updateSendState();
  });

  el.input.addEventListener('keydown', (e) => {
    // Enter 发送；Shift+Enter 换行；移动端不拦截（回车换行更符合习惯）
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isMobile) {
      e.preventDefault();
      sendText();
    }
  });

  el.btnSend.addEventListener('click', sendText);

  /* ---------------- 文件选择 ---------------- */

  const btnPickFile = $('btnPickFile');
  const fileInput = $('fileInput');

  if (btnPickFile && fileInput) {
    btnPickFile.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      uploadFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  // 兼容旧 id
  if (el.btnAttach && fileInput) {
    el.btnAttach.addEventListener('click', () => fileInput.click());
  }

  // 图片选择器（手机相册）保留但隐藏，供将来使用
  const imageInput = $('imageInput');
  if (imageInput) {
    imageInput.addEventListener('change', () => {
      uploadFiles(imageInput.files);
      imageInput.value = '';
    });
  }

  /* ---------------- 粘贴 ---------------- */
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });

  /* ---------------- 拖拽 ---------------- */
  let dragDepth = 0;

  function hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) {
      for (const t of dt.types) {
        if (t === 'Files') return true;
      }
    }
    return false;
  }

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.dropzone.classList.add('active');
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropzone.classList.remove('active');
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.classList.remove('active');
    const files = e.dataTransfer?.files;
    if (files && files.length) uploadFiles(files);
  });

  /* ---------------- 底部菜单 ---------------- */
  el.btnMore.addEventListener('click', () => { el.sheetBackdrop.hidden = false; });
  el.btnSheetCancel.addEventListener('click', () => { el.sheetBackdrop.hidden = true; });
  el.sheetBackdrop.addEventListener('click', (e) => {
    if (e.target === el.sheetBackdrop) el.sheetBackdrop.hidden = true;
  });

  el.btnReload.addEventListener('click', async () => {
    el.sheetBackdrop.hidden = true;
    await loadHistory();
    toast('已刷新');
  });

  el.btnClear.addEventListener('click', async () => {
    el.sheetBackdrop.hidden = true;
    if (!confirm('清空所有消息和已上传的文件？此操作不可撤销。')) return;

    try {
      // 必须带身份头，否则服务端无法判断权限
      const res = await fetch('/api/clear?scope=all', {
        method: 'POST',
        headers: { 'X-Chat-Sender': senderHeader() },
      });

      if (!res.ok) {
        let reason = '清空失败';
        try {
          const j = await res.json();
          if (j && j.error) reason = j.error;
        } catch { /* ignore */ }
        toast(reason, 3000);
        return;
      }

      // 立即清空界面，不等 SSE
      el.messages.querySelectorAll('.msg, .day-sep').forEach((n) => n.remove());
      seen.clear();
      lastDay = null;
      lastSender = null;
      showEmpty();

      toast('已清空');
    } catch (e) {
      toast('清空失败：' + (e.message || '网络错误'));
    }
  });

  el.btnInfo.addEventListener('click', async () => {
    el.sheetBackdrop.hidden = true;
    try {
      const r = await fetch('/api/info');
      const j = await r.json();
      const lines = [
        `服务端口：${j.port}`,
        ...j.addresses.map((a) => `${a.iface}：http://${a.address}:${j.port}`),
        `消息条数：${j.count}`,
      ];
      alert('ChatDrop 连接信息\n\n' + lines.join('\n'));
    } catch {
      toast('获取信息失败');
    }
  });

  /* ---------------- 昵称 ---------------- */
  el.btnMe.addEventListener('click', () => {
    el.meNameInput.value = myName;
    el.meBackdrop.hidden = false;
    setTimeout(() => el.meNameInput.select(), 60);
  });

  /* ---------------- 收件人选择器 ---------------- */
  if (el.recipientBtn) {
    el.recipientBtn.addEventListener('click', () => {
      renderDeviceList();
      el.recipientBackdrop.hidden = false;
    });
  }
  if (el.btnRecipientCancel) {
    el.btnRecipientCancel.addEventListener('click', () => {
      el.recipientBackdrop.hidden = true;
    });
  }
  if (el.recipientBackdrop) {
    el.recipientBackdrop.addEventListener('click', (e) => {
      if (e.target === el.recipientBackdrop) el.recipientBackdrop.hidden = true;
    });
  }
  if (el.status) {
    el.status.addEventListener('click', () => {
      renderDeviceList();
      el.recipientBackdrop.hidden = false;
    });
  }
  el.meCancel.addEventListener('click', () => { el.meBackdrop.hidden = true; });
  el.meBackdrop.addEventListener('click', (e) => {
    if (e.target === el.meBackdrop) el.meBackdrop.hidden = true;
  });
  el.meSave.addEventListener('click', () => {
    const v = el.meNameInput.value.trim().slice(0, 20);
    if (!v) { toast('昵称不能为空'); return; }
    myName = v;
    localStorage.setItem(NAME_KEY, v);
    localStorage.setItem(COLOR_KEY, myColor);
    syncMeUI();
    el.meBackdrop.hidden = true;
    toast('昵称已更新');
  });
  el.meNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.meSave.click();
  });

  /* ---------------- 历史 + 实时 ---------------- */
  async function loadHistory() {
    try {
      const qs = new URLSearchParams({ sid, name: myName, color: myColor });
      const r = await fetch(`/api/messages?${qs}`, {
        headers: { 'X-Chat-Sender': senderHeader() },
      });
      const j = await r.json();

      if (j.devices) setDevices(j.devices);

      el.messages.querySelectorAll('.msg, .day-sep').forEach((n) => n.remove());
      seen.clear();
      lastDay = null;
      lastSender = null;
      const list = j.messages || [];
      if (!list.length) {
        showEmpty();
        return;
      }
      if (el.emptyState.parentNode) el.emptyState.remove();
      for (const m of list) renderMessage(m, { scroll: false });
      scrollToBottom();
    } catch {
      toast('加载消息失败');
    }
  }

  function setStatus(state, text) {
    el.statusDot.className = 'dot ' + state;
    el.statusText.textContent = text;
  }

  let es = null;
  let retry = 0;

  function connect() {
    if (es) {
      try { es.close(); } catch { /* ignore */ }
      es = null;
    }
    setStatus('', '连接中…');

    // EventSource 不能自定义请求头，身份必须放查询参数
    const qs = new URLSearchParams({
      sid,
      name: myName,
      color: myColor,
    });
    es = new EventSource(`/api/events?${qs}`);

    es.addEventListener('open', () => {
      retry = 0;
      setStatus('online', '已连接');
    });

    es.addEventListener('message', (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }

      // 转发给扩展功能（五子棋等）
      emitFeatureEvent(payload.type, payload.data !== undefined ? payload.data : payload);

      if (payload.type === 'hello') {
        setStatus('online', '已连接');
        if (payload.devices) setDevices(payload.devices);
        return;
      }
      if (payload.type === 'presence') {
        setDevices(payload.data?.devices || []);
        return;
      }
      if (payload.type === 'message') {
        const stick = nearBottom();
        renderMessage(payload.data, { scroll: stick });
        return;
      }
      if (payload.type === 'delete') {
        removeMessage(payload.data.id);
        return;
      }
      if (payload.type === 'clear') {
        el.messages.querySelectorAll('.msg, .day-sep').forEach((n) => n.remove());
        seen.clear();
        lastDay = null;
        lastSender = null;
        showEmpty();
      }
    });

    es.addEventListener('error', () => {
      setStatus('offline', '重连中…');
      try { es.close(); } catch { /* ignore */ }
      es = null;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 800 * retry);
    });
  }

  /* ---------------- 侧边栏 / 视图切换 ---------------- */

  const sidebarEl = $('sidebar');
  const sidebarBackdropEl = $('sidebarBackdrop');
  const btnSidebarEl = $('btnSidebar');
  const btnSidebarCloseEl = $('btnSidebarClose');

  function openSidebar() {
    if (!sidebarEl) return;
    sidebarEl.classList.add('open');
    if (sidebarBackdropEl) sidebarBackdropEl.hidden = false;
  }

  function closeSidebar() {
    if (!sidebarEl) return;
    sidebarEl.classList.remove('open');
    if (sidebarBackdropEl) sidebarBackdropEl.hidden = true;
  }

  function setActiveNav(name) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
  }

  /**
   * 聊天永远在右侧；「五子棋」「技术问答」「共享表格」只是展开 / 收起左侧面板，
   * 三个面板互斥，不整页切换视图。
   */
  function switchView(name) {
    closeSidebar();
    const gm = window.ChatDropGomoku;
    const qa = window.ChatDropQA;
    const ss = window.ChatDropSharedSheet;

    if (name === 'gomoku') {
      if (qa) qa.collapsePane();
      if (ss) ss.collapsePane();
      if (gm) gm.openPane();
      else setActiveNav('gomoku');
      return;
    }

    if (name === 'qa') {
      if (gm) gm.collapsePane();
      if (ss) ss.collapsePane();
      if (qa) qa.openPane();
      else setActiveNav('qa');
      return;
    }

    if (name === 'sharedsheet') {
      if (gm) gm.collapsePane();
      if (qa) qa.collapsePane();
      if (ss) ss.openPane();
      else setActiveNav('sharedsheet');
      return;
    }

    if (gm) gm.collapsePane();
    if (qa) qa.collapsePane();
    if (ss) ss.collapsePane();
    if (!gm && !qa && !ss) setActiveNav('chat');
    if (nearBottom()) scrollToBottom();
  }

  if (btnSidebarEl) btnSidebarEl.addEventListener('click', openSidebar);
  if (btnSidebarCloseEl) btnSidebarCloseEl.addEventListener('click', closeSidebar);
  if (sidebarBackdropEl) sidebarBackdropEl.addEventListener('click', closeSidebar);
  document.querySelectorAll('.sidebar-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) closeSidebar();
  });

  /* ---------------- 启动 ---------------- */
  syncMeUI();
  syncRecipientUI();
  updateSendState();
  if (window.ChatDropGomoku) window.ChatDropGomoku.init(window.ChatDrop);
  if (window.ChatDropQA) window.ChatDropQA.init(window.ChatDrop);
  if (window.ChatDropSharedSheet) window.ChatDropSharedSheet.init(window.ChatDrop);
  loadHistory().then(connect);

  /* ---------------- 扫码配对 ---------------- */
  if (window.ChatDropPair) {
    window.ChatDropPair.init({
      getSid: () => sid,
      onPick: (targetSid, name) => {
        recipient = targetSid;
        syncRecipientUI();
        const others = otherDevices();
        const d = others.find((x) => x.sid === targetSid);
        toast(d ? `已选择：${d.name}` : '已配对，对方上线后即可收到');
      },
    });

    // URL 里带 ?pair=xxx 时自动选中对方
    window.ChatDropPair.consumePairParam((targetSid) => {
      recipient = targetSid;
      syncRecipientUI();
    });
  }

  // 页面重新可见时刷新一次，防止后台期间漏消息
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!es || es.readyState === EventSource.CLOSED)) {
      loadHistory();
      connect();
    }
  });

  /* ---------------- 移动端视口适配 ---------------- */

  /**
   * 软键盘适配
   *
   * 只在「键盘确实弹出」时才干预高度：
   *   visualViewport.height 明显小于 window.innerHeight 时，
   *   说明键盘占了空间，这时把 #app 压到可视高度。
   *
   * 其他情况一律清空内联 height，交还给 CSS 的 100dvh。
   * 否则一旦把旧高度写死，切换屏幕尺寸/旋转后就会溢出。
   */
  const appEl = document.getElementById('app');
  const vv = window.visualViewport;

  let lastAppliedHeight = 0;

  function syncViewport() {
    if (!appEl) return;

    if (!vv) return;  // 无 visualViewport 时完全交给 CSS

    const vvH = Math.round(vv.height);
    const winH = Math.round(window.innerHeight);

    // 键盘弹出判定：可视高度明显小于布局高度
    const keyboardOpen = vvH > 0 && (winH - vvH) > 120;

    if (keyboardOpen) {
      if (lastAppliedHeight !== vvH) {
        appEl.style.height = vvH + 'px';
        lastAppliedHeight = vvH;
      }
    } else {
      // 无键盘：清掉内联样式，用 CSS 的 100dvh
      if (appEl.style.height) {
        appEl.style.height = '';
        lastAppliedHeight = 0;
      }
    }

    // 同步位移（部分安卓浏览器需要）
    if (vv.offsetTop > 0) {
      appEl.style.transform = `translateY(${Math.round(vv.offsetTop)}px)`;
    } else if (appEl.style.transform) {
      appEl.style.transform = '';
    }
  }

  if (vv) {
    vv.addEventListener('resize', () => {
      syncViewport();
      setTimeout(() => {
        if (nearBottom()) scrollToBottom();
      }, 60);
    });
    vv.addEventListener('scroll', syncViewport);
  }

  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', () => {
    // 旋转后先清空，让 CSS 重新算
    if (appEl) { appEl.style.height = ''; appEl.style.transform = ''; }
    lastAppliedHeight = 0;
    setTimeout(syncViewport, 300);
  });

  // 输入框获得焦点时校正（此时键盘可能刚弹出）
  el.input.addEventListener('focus', () => {
    setTimeout(() => {
      syncViewport();
      scrollToBottom();
    }, 300);
  });

  // 失焦后键盘收起，恢复 CSS 高度
  el.input.addEventListener('blur', () => {
    setTimeout(() => {
      if (appEl) { appEl.style.height = ''; appEl.style.transform = ''; }
      lastAppliedHeight = 0;
      syncViewport();
    }, 250);
  });

  // 初始化不要写死高度
  lastAppliedHeight = 0;

  /* ---------------- Service Worker ---------------- */
  /**
   * 默认不注册 SW。
   *
   * SW 的缓存优先策略在开发/内网场景是灾难：
   * 改了代码手机永远加载旧版，而旧 SW 又会把 sw.js 一起缓存，
   * 导致检测不到更新，形成死锁。
   *
   * 这里主动注销已有的 SW 并清空缓存，让页面回到纯网络模式。
   * 需要离线能力时再用 ENABLE_SW=1 启动服务端。
   */
  if ('serviceWorker' in navigator) {
    (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.length) {
          await Promise.all(regs.map((r) => r.unregister()));
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
          // 如果当前页由 SW 控制，注销后重载一次拿到干净状态
          if (navigator.serviceWorker.controller) {
            location.reload();
            return;
          }
        }
      } catch { /* 忽略 */ }
    })();
  }

  /* ---------------- 版本自检 ---------------- */
  /**
   * 服务端每次启动会生成新的资源版本号。
   * 页面定期对比，发现不一致就提示刷新或自动重载，
   * 避免用户一直停留在旧代码上。
   */
  (function watchVersion() {
    const APP_VERSION = window.__APP_VERSION__ || null;

    async function check() {
      try {
        const r = await fetch('/api/info', { cache: 'no-store' });
        const j = await r.json();
        if (!j.assetVersion) return;
        if (APP_VERSION && j.assetVersion !== APP_VERSION) {
          // 服务端已更新，提示用户
          toast('检测到新版本，正在刷新…', 1600);
          setTimeout(() => location.reload(true), 1200);
        }
      } catch { /* 忽略 */ }
    }

    // 页面重新可见时检查一次
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });

    // 每 60 秒检查一次
    setInterval(check, 60000);
  })();
})();
