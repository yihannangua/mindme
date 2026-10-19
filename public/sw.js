/* 应用壳离线缓存只覆盖静态文件，认证和同步请求始终访问网络。 */
const CACHE = 'mindme-shell-__BUILD_ID__';
const PRECACHE = /*__PRECACHE__*/ [];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('mindme-shell-') && name !== CACHE).map(name => caches.delete(name)))),
    self.clients.claim(),
  ]));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match('/')).then(response => response || Response.error())));
    return;
  }
  if (PRECACHE.includes(url.pathname)) event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
});
