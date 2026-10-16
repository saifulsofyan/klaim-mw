// Service worker: menyimpan tampilan aplikasi di HP supaya bisa dibuka tanpa internet
const C = 'klaim-mw-v7';
const SHELL = ['./', 'index.html', 'manifest.json', 'shim.js', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.origin !== location.origin && !/(googleapis|gstatic)\.com$/.test(u.hostname)) return;
  e.respondWith((async () => {
    const c = await caches.open(C), hit = await c.match(r, {ignoreSearch: true});
    const key = u.searchParams.has('ttd') ? u.origin + u.pathname : r;  // barcode TTD: jangan simpan token di cache
    const net = fetch(r).then(res => { if (res.ok || res.type === 'opaque') c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (r.mode === 'navigate' ? await c.match('./') : Response.error());
  })());
});
