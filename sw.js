/* Our Spending — service worker
   Caches the app shell so the app opens instantly and works offline.
   Bump CACHE when you change files to force an update. */
var CACHE = 'our-spending-v1';
var SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return c.add(u).catch(function () { /* ignore individual misses */ });
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      if (k !== CACHE) return caches.delete(k);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  // Never cache Supabase API / realtime or Google Fonts requests — always go to network.
  if (url.indexOf('supabase.co') !== -1 || url.indexOf('supabase.in') !== -1 ||
      url.indexOf('fonts.googleapis') !== -1 || url.indexOf('fonts.gstatic') !== -1) {
    return; // default browser handling
  }
  if (e.request.method !== 'GET') return;
  // Cache-first for the app shell, fall back to network, then cache.
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) {
          c.put(e.request, copy).catch(function () {});
        });
        return resp;
      }).catch(function () {
        return caches.match('./index.html');
      });
    })
  );
});
