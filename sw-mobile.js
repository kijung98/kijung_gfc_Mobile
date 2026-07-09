// 방문영업일지 모바일 — 서비스워커 v4
// "홈 화면에 추가" 시 앱처럼 동작하고 오프라인에서도 화면이 열리도록 해줍니다.
// 캐시 이름의 버전 숫자를 바꿔주면 사용자 기기의 오래된 파일이 자동으로 갱신됩니다.
const CACHE_NAME = 'gfc-visit-log-mobile-v11';
const CORE_ASSETS = [
  './index.html',
  './manifest-mobile.json',
  './companies-data.js',
  './icon-120.png',
  './icon-152.png',
  './icon-167.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.map((n) => (n !== CACHE_NAME ? caches.delete(n) : null)))
    )
  );
  self.clients.claim();
});

// index.html은 항상 최신 버전을 우선 시도하고(network-first), 실패 시 캐시로 폴백
// 나머지 정적 파일은 캐시 우선(cache-first)으로 빠르게
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 CDN은 통과

  const isHTML = url.pathname.endsWith('.html') || req.mode === 'navigate';

  if (isHTML) {
    // network-first: 항상 새 버전 시도
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  } else {
    // cache-first: 캐시 있으면 즉시, 없으면 네트워크
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }))
    );
  }
});
