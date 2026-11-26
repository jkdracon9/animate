// 오프라인 실행용 서비스 워커: 온라인이면 최신 파일을 받고, 오프라인이거나 네트워크가 느리면 저장된 파일을 쓴다.
const CACHE = 'animate-v3';
const ASSETS = [
  './', './index.html', './css/style.css', './manifest.webmanifest',
  './js/app.js', './js/store.js', './js/mp4.js', './js/gif.js', './js/zip.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];
const NETWORK_WAIT_MS = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const net = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    });
    // 네트워크가 3초 안에 답하지 않으면 저장된 파일을 먼저 쓴다
    const quick = await Promise.race([
      net.catch(() => null),
      new Promise((r) => setTimeout(() => r(null), NETWORK_WAIT_MS)),
    ]);
    if (quick) return quick;
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try { return await net; } catch {
      return (await caches.match('./index.html')) || Response.error();
    }
  })());
});
