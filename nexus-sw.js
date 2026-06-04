/* ERP Nexus — Service Worker (offline-first PWA) */
const CACHE = 'nexus-v2';
const SHELL = [
  'login.html', 'offer-submit.html', 'nexus-core.js',
  'dashboard.html', 'materials.html', 'suppliers.html', 'offers.html',
  'purchaserequests.html', 'analytics.html', 'notifications.html', 'settings.html',
  'nexus-manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  // Network-first for Firestore API calls
  if (url.includes('firestore.googleapis.com') || url.includes('firebaseio.com')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Cache-first for everything else (shell, fonts, images, libs)
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        return resp;
      }).catch(() => caches.match('login.html'));
    })
  );
});
