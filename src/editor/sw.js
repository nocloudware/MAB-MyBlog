const CACHE_NAME = 'mab-myblog-editor-v1';

const FILES_TO_CACHE = [
    '/',
    '/index.html',
    '/src/editor/assets/js/editor.js',
    '/src/editor/assets/js/markdown.js',
    '/src/editor/assets/js/image.js',
    '/src/editor/assets/js/publisher.js',
    '/src/editor/assets/css/editor.css',
    '/src/editor/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(FILES_TO_CACHE);
        })
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.open(CACHE_NAME).then(cache => {
            return cache.match(event.request).then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request).then(response => {
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }
                    const responseToCache = response.clone();
                    cache.put(event.request, responseToCache);
                    return response;
                });
            });
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(cacheName => {
                    return cacheName !== CACHE_NAME;
                }).map(cacheName => {
                    return caches.delete(cacheName);
                })
            );
        })
    );
});
