// Injected at build time by build.js — do not hand-edit these two lines.
const CACHE_VERSION = '__CACHE_VERSION__';
const PRECACHE_URLS = __PRECACHE_URLS__;

const CACHE_NAME = 'app-visitas-' + CACHE_VERSION;

self.addEventListener('install', (event) => {
    // Sem skipWaiting automático — o novo SW fica "esperando" até o usuário
    // confirmar a atualização (banner "Nova versão disponível"), pra não
    // recarregar a página sozinho no meio de um formulário.
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Push de verdade (VAPID, via lib/handlers/push.js) — chega mesmo com o
// app fechado. O payload é o mesmo JSON montado no backend (title/body/
// tag/data), não precisa buscar nada — só exibir.
self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { body: event.data ? event.data.text() : '' }; }
    const title = payload.title || 'Hygicare Visitas';
    event.waitUntil(
        self.registration.showNotification(title, {
            body: payload.body || '',
            tag: payload.tag || undefined,
            icon: './icons/apple-touch-icon.png',
            badge: './icons/apple-touch-icon.png',
            data: payload.data || {}
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const page = (event.notification.data && event.notification.data.page) || 'dashboard';
    const params = (event.notification.data && event.notification.data.params) || undefined;
    // "Cold start" (app fechado, nenhum client aberto pro postMessage pegar)
    // caía sempre em openWindow('./') puro — perdia completamente qual
    // campanha era, e o app abria na Dashboard normal (ou em qualquer outra
    // página que tivesse restaurado). campanha-preencher é a única página
    // com forma de URL própria (?c=<id>, ver peekCampanhaId em app.js), então
    // é a única que dá pra recuperar aqui sem o postMessage.
    const coldStartUrl = (page === 'campanha-preencher' && params && params.id)
        ? './?c=' + encodeURIComponent(params.id)
        : './';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            const client = clientList.find((c) => 'focus' in c);
            if (client) {
                client.focus();
                client.postMessage({ type: 'NAVIGATE', page, params });
                return null;
            }
            return self.clients.openWindow ? self.clients.openWindow(coldStartUrl) : null;
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

function isHashedAsset(url) {
    // esbuild emits content-hashed filenames like app-A1B2C3D4.js / base-A1B2C3D4.css
    return /-[A-Z0-9]{8}\.(js|css)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Skip cross-origin requests (GAS API, CDNs, etc.) — never cache API responses here;
    // the app already does its own stale-while-revalidate caching for business data.
    if (url.origin !== self.location.origin) return;

    // Navigation requests (the HTML shell): network-first so a new deploy is picked up
    // immediately, falling back to the cached shell (and then to a 503) when offline.
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                    return response;
                })
                .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
        );
        return;
    }

    // Hashed JS/CSS chunks and static assets (icons, manifest): cache-first — safe because
    // a content change always produces a new hashed filename.
    if (isHashedAsset(url) || url.pathname.includes('/icons/') || url.pathname.endsWith('manifest.webmanifest')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // Everything else same-origin: stale-while-revalidate.
    event.respondWith(
        caches.match(event.request).then((cached) => {
            const fetchPromise = fetch(event.request).then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return response;
            }).catch(() => cached);
            return cached || fetchPromise;
        })
    );
});

