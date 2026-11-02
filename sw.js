/* Service worker - Bengkel & Armada Monitoring (build 6d9961c228).
   - File aplikasi disimpan di perangkat: aplikasi tetap terbuka walau sinyal jelek / tanpa internet.
   - index.html, config.js, pwa.js: ambil dari jaringan dulu (selalu versi terbaru), cadangan dari simpanan.
   - app.js?v=...: berversi, jadi cukup diambil dari simpanan (hemat kuota).
   - Panggilan ke server Apps Script (alamat lain) TIDAK disentuh. */
var CACHE = 'bka-6d9961c228';
var SHELL = ['./', 'index.html', 'config.js', 'pwa.js', 'app.js?v=6d9961c228', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
var FRESH = /\/(index\.html|config\.js|pwa\.js)$/;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('bka-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function shellKey() { return new URL('index.html', self.registration.scope).href; }

function networkFirst(req, key) {
  return new Promise(function (resolve) {
    var done = false;
    function fromCache(then) {
      caches.open(CACHE).then(function (c) { return c.match(key || req, { ignoreSearch: !!key }); }).then(function (m) {
        if (m && !done) { done = true; resolve(m); } else if (then) then();
      });
    }
    var t = setTimeout(function () { fromCache(); }, 4000);                       // jaringan lambat: pakai simpanan dulu
    fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' }).then(function (r) {      // no-cache = selalu tanya server (304 bila tidak berubah), jangan pakai simpanan HTTP 10 menit milik GitHub Pages
      clearTimeout(t);
      if (r && r.ok) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(key || req, cp); }); if (!done) { done = true; resolve(r); } }
      else fromCache(function () { if (!done) { done = true; resolve(r); } });
    }, function () {
      clearTimeout(t);
      fromCache(function () { if (!done) { done = true; resolve(Response.error()); } });
    });
  });
}

function cacheFirst(req) {
  return caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (m) {
      if (m) return m;
      return fetch(req).then(function (r) { if (r && r.ok) c.put(req, r.clone()); return r; });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (r.mode === 'navigate') { e.respondWith(networkFirst(r, shellKey())); return; }
  if (FRESH.test(u.pathname)) { e.respondWith(networkFirst(r)); return; }
  e.respondWith(cacheFirst(r));
});
