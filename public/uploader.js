'use strict';

/**
 * ChatDrop 多任务上传器（前端）
 *
 * 取 LocalSend 之精华：
 *   - 多文件并发上传，互不阻塞
 *   - 分片 + 偏移上传，支持断点续传
 *   - sha256 校验
 *
 * 弃其糟粕：
 *   - 不需要「先被接受」的握手
 *   - 不做单会话阻塞
 *
 * 关键能力：**上一个没传完不影响下一个**
 *   - 每个文件是独立任务，独立 XHR
 *   - 某个任务失败/中断，其他任务照常进行
 *   - 中断的任务保留 .part，下次选同一文件自动从断点续传
 */

(() => {
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const MAX_PARALLEL = 3;

  /** @type {Map<string, Task>} 任务表 */
  const tasks = new Map();
  let seq = 0;

  /* ---------------- 工具 ---------------- */

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
  }

  /** 文件指纹：名称+大小+最后修改时间，足够区分同一文件 */
  function fingerprintOf(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  /** 计算文件 sha256（分块读，避免大文件爆内存） */
  async function sha256Of(file, onProgress) {
    if (!crypto?.subtle) return null;
    try {
      const chunkSize = 8 * 1024 * 1024;
      if (file.size <= chunkSize) {
        const buf = await file.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', buf);
        return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
      }
      // 大文件：用增量哈希（借助流式 API 不可用时退化为跳过校验）
      // 浏览器没有流式 sha256，这里对超大文件跳过以保证体验
      return null;
    } catch {
      return null;
    }
  }

  /* ---------------- 任务状态 ---------------- */

  function newTask(file) {
    return {
      key: 't' + (++seq),
      file,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      fingerprint: fingerprintOf(file),
      sessionId: null,
      token: null,
      offset: 0,
      status: 'queued',   // queued | hashing | uploading | done | failed | canceled | paused
      error: null,
      xhr: null,
      speed: 0,
      startedAt: 0,
      lastTick: 0,
      lastLoaded: 0,
    };
  }

  /* ---------------- 渲染 ---------------- */

  const panel = document.getElementById('uploadPanel');
  const listEl = document.getElementById('uploadList');
  const headEl = document.getElementById('uploadHead');
  const countEl = document.getElementById('uploadCount');
  const btnToggle = document.getElementById('btnUploadToggle');
  const btnClearDone = document.getElementById('btnClearDone');
  let collapsed = false;

  function ensurePanel() {
    if (!panel) return;
    const any = tasks.size > 0;
    panel.hidden = !any;
  }

  function render() {
    if (!listEl) return;
    ensurePanel();

    const arr = [...tasks.values()];
    const running = arr.filter((t) => t.status === 'uploading' || t.status === 'hashing').length;
    const waiting = arr.filter((t) => t.status === 'queued').length;
    const done = arr.filter((t) => t.status === 'done').length;
    const failed = arr.filter((t) => t.status === 'failed' || t.status === 'paused').length;

    if (countEl) {
      const parts = [];
      if (running) parts.push(`${running} 个传输中`);
      if (waiting) parts.push(`${waiting} 个等待`);
      if (done) parts.push(`${done} 个完成`);
      if (failed) parts.push(`${failed} 个中断`);
      countEl.textContent = parts.join(' · ') || '空闲';
    }

    listEl.innerHTML = '';
    for (const t of arr) {
      const row = document.createElement('div');
      row.className = 'up-item ' + t.status;

      const pct = t.size > 0 ? Math.min(100, (t.offset / t.size) * 100) : 0;

      const top = document.createElement('div');
      top.className = 'up-item-top';

      const nameEl = document.createElement('span');
      nameEl.className = 'up-name';
      nameEl.textContent = t.name;
      nameEl.title = t.name;

      const metaEl = document.createElement('span');
      metaEl.className = 'up-meta';

      let metaText = '';
      if (t.status === 'queued') metaText = '等待中';
      else if (t.status === 'hashing') metaText = '校验中…';
      else if (t.status === 'uploading') {
        metaText = `${pct.toFixed(0)}% · ${fmtSize(t.offset)}/${fmtSize(t.size)}`;
        if (t.speed > 0) metaText += ` · ${fmtSize(t.speed)}/s`;
      } else if (t.status === 'done') metaText = '已完成';
      else if (t.status === 'canceled') metaText = '已取消';
      else if (t.status === 'paused') metaText = `已中断 · 已传 ${fmtSize(t.offset)}`;
      else if (t.status === 'failed') metaText = t.error || '失败';
      metaEl.textContent = metaText;

      const actions = document.createElement('span');
      actions.className = 'up-actions';

      if (t.status === 'uploading' || t.status === 'queued' || t.status === 'hashing') {
        if (t.status === 'uploading' && t.sessionId) {
          const p = document.createElement('button');
          p.className = 'up-btn';
          p.textContent = '暂停';
          p.onclick = () => pauseTask(t.key);
          actions.appendChild(p);
        }
        const b = document.createElement('button');
        b.className = 'up-btn';
        b.textContent = '取消';
        b.onclick = () => cancelTask(t.key);
        actions.appendChild(b);
      } else if (t.status === 'paused') {
        const b = document.createElement('button');
        b.className = 'up-btn primary';
        b.textContent = '继续';
        b.onclick = () => resumeTask(t.key);
        actions.appendChild(b);
        const d = document.createElement('button');
        d.className = 'up-btn';
        d.textContent = '取消';
        d.onclick = () => cancelTask(t.key);
        actions.appendChild(d);
      } else if (t.status === 'failed') {
        const b = document.createElement('button');
        b.className = 'up-btn primary';
        b.textContent = '重试';
        b.onclick = () => retryTask(t.key);
        actions.appendChild(b);
        const d = document.createElement('button');
        d.className = 'up-btn';
        d.textContent = '移除';
        d.onclick = () => removeTask(t.key);
        actions.appendChild(d);
      } else {
        const d = document.createElement('button');
        d.className = 'up-btn';
        d.textContent = '移除';
        d.onclick = () => removeTask(t.key);
        actions.appendChild(d);
      }

      top.append(nameEl, metaEl, actions);

      const track = document.createElement('div');
      track.className = 'up-track';
      const fill = document.createElement('div');
      fill.className = 'up-fill';
      fill.style.width = pct + '%';
      track.appendChild(fill);

      row.append(top, track);
      listEl.appendChild(row);
    }

    if (btnClearDone) {
      btnClearDone.hidden = !arr.some((t) => t.status === 'done' || t.status === 'canceled');
    }
  }

  /* ---------------- 上传流程 ---------------- */

  const senderHeader = () => window.__chatdropSenderHeader?.() || '';

  async function initSession(task) {
    const r = await fetch('/api/upload/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Sender': senderHeader(),
      },
      body: JSON.stringify({
        name: task.name,
        size: task.size,
        mime: task.mime,
        fingerprint: task.fingerprint,
        to: task.to || undefined,
      }),
    });

    const j = await r.json().catch(() => ({}));

    if (r.status === 429) {
      // 并发已满：留在队列里，稍后重试
      task.status = 'queued';
      task.error = j.error || '队列已满';
      render();
      return { retry: true };
    }
    if (!r.ok) {
      throw new Error(j.error || '初始化失败');
    }

    // 秒传
    if (j.instant) {
      task.status = 'done';
      task.offset = task.size;
      render();
      return { instant: true, message: j.message };
    }

    // 断点续传命中：同样要保存 token
    if (j.resumed && j.token) task.token = j.token;

    task.sessionId = j.sessionId;
    task.token = j.token || null;
    task.offset = j.offset || 0;
    task.status = 'uploading';
    render();
    return { sessionId: j.sessionId, offset: j.offset || 0 };
  }

  /** 上传单个分片 */
  function uploadChunk(task, blob, offset) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      task.xhr = xhr;

      const qs = new URLSearchParams({
        sessionId: task.sessionId,
        token: task.token || '',
        offset: String(offset),
      });

      xhr.open('POST', `/api/upload/chunk?${qs}`, true);
      xhr.setRequestHeader('X-Chat-Sender', senderHeader());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      let base = offset;

      xhr.upload.addEventListener('progress', (e) => {
        const loaded = base + e.loaded;
        task.offset = loaded;

        const now = Date.now();
        if (task.lastTick && now - task.lastTick > 400) {
          const dt = (now - task.lastTick) / 1000;
          const db = loaded - task.lastLoaded;
          task.speed = dt > 0 ? db / dt : 0;
          task.lastTick = now;
          task.lastLoaded = loaded;
        } else if (!task.lastTick) {
          task.lastTick = now;
          task.lastLoaded = loaded;
        }

        render();
      });

      xhr.addEventListener('load', () => {
        task.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const j = JSON.parse(xhr.responseText);
            task.offset = j.offset ?? j.received ?? offset + blob.size;
          } catch {
            task.offset = offset + blob.size;
          }
          resolve();
        } else if (xhr.status === 409) {
          // 偏移不匹配：服务端告知正确位置，可直接续传
          let expected = offset;
          try { expected = JSON.parse(xhr.responseText).expectedOffset ?? offset; } catch { /* ignore */ }
          reject(Object.assign(new Error('offset mismatch'), { code: 409, expected }));
        } else if (xhr.status === 408) {
          reject(Object.assign(new Error('分片超时'), { code: 408 }));
        } else {
          let msg = '分片上传失败';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
          reject(new Error(msg));
        }
      });

      xhr.addEventListener('error', () => {
        task.xhr = null;
        reject(new Error('网络错误'));
      });

      xhr.addEventListener('abort', () => {
        task.xhr = null;
        reject(Object.assign(new Error('已取消'), { code: 'ABORT' }));
      });

      xhr.send(blob);
    });
  }

  /** 分片发送循环（可被初次上传和「继续」复用） */
  async function pumpChunks(task) {
    let guard = 0;
    while (task.offset < task.size) {
      if (guard++ > 100000) throw new Error('分片数量异常');

      // 暂停 / 取消 立即退出循环
      if (task.status === 'paused' || task.status === 'canceled') return false;

      const start = task.offset;
      const end = Math.min(start + CHUNK_SIZE, task.size);
      const blob = task.file.slice(start, end);

      try {
        await uploadChunk(task, blob, start);
      } catch (e) {
        if (e.code === 'ABORT') {
          // abort 可能是「暂停」或「取消」，由外部状态决定
          return false;
        }
        if (e.code === 409 && typeof e.expected === 'number') {
          task.offset = e.expected;
          render();
          continue;
        }
        throw e;
      }
    }
    return true;
  }

  /** 校验并提交完成 */
  async function finishTask(task) {
    task.status = 'hashing';
    render();

    const sha = await sha256Of(task.file);

    const r = await fetch('/api/upload/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Sender': senderHeader(),
      },
      body: JSON.stringify({
        sessionId: task.sessionId,
        token: task.token || '',
        sha256: sha,
      }),
    });

    const j = await r.json().catch(() => ({}));

    if (r.status === 422) throw new Error('校验失败，文件可能损坏');

    if (r.status === 409) {
      // 大小不符：从服务端给的偏移继续
      task.offset = j.offset ?? task.offset;
      task.status = 'uploading';
      render();
      const ok = await pumpChunks(task);
      if (!ok) return;
      return finishTask(task);
    }

    if (!r.ok) throw new Error(j.error || '完成失败');

    task.status = 'done';
    task.offset = task.size;
    task.speed = 0;
    render();
    window.__chatdropOnUploaded?.(j.message);
  }

  /** 已有会话时直接续跑（「继续」按钮用） */
  async function runTaskFromSession(task) {
    try {
      task.lastTick = 0;
      task.lastLoaded = task.offset;
      render();

      const ok = await pumpChunks(task);
      if (!ok) {
        // 暂停或取消，状态已由对应操作设置
        if (task.status === 'uploading') task.status = 'paused';
        render();
        return;
      }

      await finishTask(task);
    } catch (e) {
      if (task.status === 'paused' || task.status === 'canceled') return;
      task.status = 'failed';
      task.error = e.message || '上传失败';
      task.speed = 0;
      render();
    }
  }

  /** 跑完一个任务的完整流程（新建会话） */
  async function runTask(task) {
    try {
      task.status = 'uploading';
      task.startedAt = Date.now();
      task.lastTick = 0;
      render();

      // 1. 初始化/续传握手
      const init = await initSession(task);
      if (init.retry) return;
      if (init.instant) {
        if (init.message) window.__chatdropOnInstant?.(init.message);
        return;
      }

      // 2. 分片循环
      const ok = await pumpChunks(task);
      if (!ok) {
        if (task.status === 'uploading') task.status = 'paused';
        render();
        return;
      }

      // 3. 校验并完成
      await finishTask(task);
    } catch (e) {
      if (task.status === 'paused' || task.status === 'canceled') return;
      task.status = 'failed';
      task.error = e.message || '上传失败';
      task.speed = 0;
      render();
    }
  }

  /* ---------------- 调度 ---------------- */

  const queue = [];

  function pump() {
    const running = [...tasks.values()].filter(
      (t) => t.status === 'uploading' || t.status === 'hashing'
    ).length;

    let slots = MAX_PARALLEL - running;
    while (slots > 0) {
      const idx = queue.findIndex((k) => {
        const t = tasks.get(k);
        return t && t.status === 'queued';
      });
      if (idx < 0) break;
      const key = queue.splice(idx, 1)[0];
      const task = tasks.get(key);
      if (!task) continue;
      slots--;
      runTask(task);
    }
  }

  /* ---------------- 对外操作 ---------------- */

  function addFiles(fileList, opts = {}) {
    const files = Array.from(fileList || []).filter((f) => f && f.size > 0);
    if (!files.length) return;

    const to = opts.to || (window.__chatdropRecipient?.() ?? undefined);

    for (const f of files) {
      const t = newTask(f);
      t.to = to;
      tasks.set(t.key, t);
      queue.push(t.key);
    }
    render();
    pump();
  }

  function cancelTask(key) {
    const t = tasks.get(key);
    if (!t) return;
    t.status = 'canceled';
    if (t.xhr) {
      try { t.xhr.abort(); } catch { /* ignore */ }
      t.xhr = null;
    }
    if (t.sessionId) {
      fetch(`/api/upload/cancel?sessionId=${encodeURIComponent(t.sessionId)}&token=${encodeURIComponent(t.token || '')}`, {
        method: 'POST',
      }).catch(() => {});
    }
    const qi = queue.indexOf(key);
    if (qi >= 0) queue.splice(qi, 1);
    render();
    pump();
  }

  /** 暂停：中断传输但保留已传数据，之后可继续 */
  async function pauseTask(key) {
    const t = tasks.get(key);
    if (!t || t.status !== 'uploading') return;

    // 先标记，避免 abort 后的 catch 把状态改成 canceled/failed
    t.status = 'paused';
    t.speed = 0;

    if (t.xhr) {
      try { t.xhr.abort(); } catch { /* ignore */ }
      t.xhr = null;
    }

    if (t.sessionId) {
      try {
        const r = await fetch(`/api/upload/pause?sessionId=${encodeURIComponent(t.sessionId)}&token=${encodeURIComponent(t.token || '')}`, {
          method: 'POST',
        });
        const j = await r.json().catch(() => ({}));
        if (typeof j.offset === 'number') t.offset = j.offset;
      } catch { /* 服务端不可达也保留本地进度 */ }
    }

    render();
    pump();
  }

  /** 继续：从服务端返回的断点续传 */
  async function resumeTask(key) {
    const t = tasks.get(key);
    if (!t || t.status !== 'paused') return;

    if (!t.sessionId) {
      // 没有会话，从头开始
      t.offset = 0;
      t.status = 'queued';
      if (!queue.includes(key)) queue.push(key);
      render();
      pump();
      return;
    }

    try {
      const r = await fetch(`/api/upload/resume?sessionId=${encodeURIComponent(t.sessionId)}&token=${encodeURIComponent(t.token || '')}`, {
        method: 'POST',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || '会话已失效');

      t.offset = typeof j.offset === 'number' ? j.offset : t.offset;
      t.status = 'uploading';
      t.error = null;
      render();

      // 直接续跑，不重新 init（会话已存在）
      runTaskFromSession(t);
    } catch (e) {
      // 会话过期：从头再来
      t.sessionId = null;
      t.offset = 0;
      t.status = 'queued';
      t.error = null;
      if (!queue.includes(key)) queue.push(key);
      render();
      pump();
    }
  }

  function retryTask(key) {
    const t = tasks.get(key);
    if (!t) return;
    if (t.status === 'failed' && !t.sessionId) {
      t.offset = 0;
    }
    t.status = 'queued';
    t.error = null;
    if (!queue.includes(key)) queue.push(key);
    render();
    pump();
  }

  function removeTask(key) {
    const t = tasks.get(key);
    if (!t) return;
    if (t.xhr) { try { t.xhr.abort(); } catch { /* ignore */ } }
    const qi = queue.indexOf(key);
    if (qi >= 0) queue.splice(qi, 1);
    tasks.delete(key);
    render();
    pump();
  }

  function clearDone() {
    for (const [k, t] of [...tasks]) {
      if (t.status === 'done' || t.status === 'canceled') tasks.delete(k);
    }
    render();
  }

  /* ---------------- 事件绑定 ---------------- */

  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      collapsed = !collapsed;
      listEl.hidden = collapsed;
      btnToggle.textContent = collapsed ? '展开' : '收起';
    });
  }
  if (btnClearDone) btnClearDone.addEventListener('click', clearDone);

  /* ---------------- 导出 ---------------- */

  window.ChatDropUploader = {
    addFiles,
    cancelTask,
    retryTask,
    removeTask,
    clearDone,
    list: () => [...tasks.values()],
    activeCount: () => [...tasks.values()].filter(
      (t) => t.status === 'uploading' || t.status === 'hashing' || t.status === 'queued'
    ).length,
  };
})();
