const CACHE_NAME = 'ycyk-v2';
const ASSETS = [
    'index.html',
    'css/app.css',
    'js/db.js',
    'js/config.js',
    'js/ocr.js',
    'js/app.js',
    'manifest.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    var url = new URL(e.request.url);
    if (url.pathname.startsWith('/api/')) return;
    if (url.origin === self.location.origin && e.request.method === 'GET') {
        e.respondWith(
            caches.match(e.request).then(function(res) { return res || fetch(e.request); })
        );
    }
});
