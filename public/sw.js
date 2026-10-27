'use strict';

/* ChatDrop Service Worker
 *
 * 策略：网络优先（Network First）
 *
 * 之前用「缓存优先」导致改了代码看不到效果：
 * 只要缓存里存过，就永远返回旧的，开发时非常痛苦。
 *
 * 现在：
 *   - 所有资源先请求网络，拿到就用并顺便更新缓存
 *   - 网络失败（离线）才回退到缓存
 *   - /api/* 完全不碰，直接走网络
 */

const CACHE = 'chatdrop-shell-v3';   // 版本号变更会触发旧缓存清理
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/pair.js',
  '/uploader.js',
  '/vendor/qrcode-svg.min.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // API 一律走网络，绝不缓存
  if (url.pathname.startsWith('/api/')) return;

  // 网络优先：先拿新的，失败再回退缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        // 成功则顺手更新缓存
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || Response.error())
      )
  );
});
