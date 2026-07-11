const CACHE_NAME = 'ycyk-v3';
const ASSETS = [
    'index.html',
    'css/app.css',
    'js/config.js',
    'js/db.js',
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

    // Never cache API calls
    if (url.pathname.startsWith('/api/')) return;

    // Never cache POST requests
    if (e.request.method !== 'GET') return;

    // For same-origin GET requests: network first, fallback to cache
    if (url.origin === self.location.origin) {
        e.respondWith(
            fetch(e.request).then(function(res) {
                // Update cache with fresh response
                var clone = res.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(e.request, clone);
                });
                return res;
            }).catch(function() {
                return caches.match(e.request);
            })
        );
    }
});
