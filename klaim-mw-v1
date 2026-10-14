/* Penghubung PWA: menjalankan aplikasi Apps Script di luar Apps Script, dengan dukungan offline.
   - Panggilan google.script.run diubah menjadi fetch ke Apps Script (doPost).
   - Data yang pernah dimuat disimpan di HP, dipakai saat offline.
   - Input (save / upload foto) saat offline masuk antrean di HP, dikirim otomatis saat online. */
(function () {
  const APP_URL = 'https://script.google.com/macros/s/AKfycbwNeFXE_qBv9o8XL7biEgxdDIT-ZAGc9ANEg-3tNd1Vo0z5TOYTnqFpD2EkCmoVKUoc/exec';
  const WRITE = ['save', 'uploadFoto'];
  const FALLBACK = {getRecord: null, poinAktif: 0, regs: [], nextReg: 'Otomatis saat online'};
  const MEM = {};
  let DBP, busy = false, bd, uid = 0;

  // ---------- penyimpanan lokal (IndexedDB, cadangan: memori) ----------
  const db = () => DBP || (DBP = new Promise(ok => {
    if (!window.indexedDB) return ok(null);
    const r = indexedDB.open('klaimmw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ok(null);
  }));
  const kv = async (op, k, v) => {
    const d = await db();
    if (!d) { if (op == 'set') MEM[k] = v; else if (op == 'del') delete MEM[k]; else return MEM[k]; return; }
    return new Promise(ok => {
      const s = d.transaction('kv', op == 'get' ? 'readonly' : 'readwrite').objectStore('kv');
      const q = op == 'get' ? s.get(k) : op == 'set' ? s.put(v, k) : s.delete(k);
      q.onsuccess = () => ok(q.result);
      q.onerror = () => ok();
    });
  };
  const cacheGet = async k => ((await kv('get', 'cache')) || {})[k];
  const cacheSet = async (k, v) => { const c = (await kv('get', 'cache')) || {}; c[k] = v; await kv('set', 'cache', c); };

  // ---------- panggilan ke server ----------
  class NetErr extends Error {}
  async function rpc(fn, args) {
    let res;
    try { res = await fetch(APP_URL, {method: 'POST', body: JSON.stringify({fn: fn, args: args})}); }
    catch (e) { throw new NetErr('Tidak ada koneksi internet'); }
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('Server tidak merespons dengan benar, coba lagi'); }
    if (!j.ok) throw new Error(j.error);
    return j.data;
  }

  // ---------- baca data: online -> simpan salinan, offline -> pakai salinan ----------
  async function read(args) {
    const f = args[1], a = args[2], key = f + ':' + JSON.stringify(a);
    try {
      const r = await rpc('api', args);
      cacheSet(key, r);
      return r;
    } catch (e) {
      if (!(e instanceof NetErr)) throw e;
      if (f == 'nextReg') return FALLBACK.nextReg;
      let hit = await cacheGet(key);
      if (hit !== undefined) {
        if (f == 'regs') {  // sembunyikan nomor yang sudah masuk antrean di HP
          const q = (await kv('get', 'queue')) || [];
          const used = q.filter(i => i.args[1] == 'save' && i.args[2][0] == a[0]).map(i => i.args[2][1].NoReg);
          hit = hit.filter(x => used.indexOf(x.v) < 0);
        }
        return hit;
      }
      if (f in FALLBACK) return FALLBACK[f];
      throw new Error('Offline: data ini belum pernah dimuat saat online');
    }
  }

  // ---------- simpan data: online -> langsung, offline -> antrean ----------
  async function write(args) {
    await flush();
    const q0 = (await kv('get', 'queue')) || [];
    if (!q0.length) {
      try { return await rpc('api', args); } catch (e) { if (!(e instanceof NetErr)) throw e; }
    }
    const f = args[1], a = args[2];
    if (f == 'uploadFoto') {  // foto disimpan di HP dulu, diberi nama sementara
      const ids = [];
      for (const p of a[0]) { const id = 'pending:' + Date.now().toString(36) + (uid++).toString(36); await kv('set', id, p); ids.push(id); }
      return ids;
    }
    const q = (await kv('get', 'queue')) || [];
    q.push({args: args, ts: Date.now()});
    await kv('set', 'queue', q);
    badge();
    return 'Antrean-' + q.length;
  }

  // ---------- kirim antrean ke server ----------
  async function flush() {
    if (busy || !navigator.onLine) return;
    busy = true;
    let synced = false;
    try {
      const q = (await kv('get', 'queue')) || [];
      while (q.length) {
        const tk = localStorage.getItem('tk');
        if (!tk) break;
        const it = q[0], args = JSON.parse(JSON.stringify(it.args)), used = [];
        args[0] = tk;
        try {
          const d = args[1] == 'save' ? args[2][1] : null;
          if (d) for (const k of Object.keys(d)) {  // ganti foto sementara dengan alamat Drive
            if (typeof d[k] != 'string' || d[k].indexOf('pending:') < 0) continue;
            const parts = d[k].split('\n');
            for (let i = 0; i < parts.length; i++) {
              if (parts[i].indexOf('pending:') != 0) continue;
              const id = parts[i], p = await kv('get', id);
              used.push(id);
              parts[i] = p ? (await rpc('api', [tk, 'uploadFoto', [[p]]]))[0] : '';
            }
            d[k] = parts.filter(Boolean).join('\n');
          }
          await rpc('api', args);
          for (const id of used) await kv('del', id);
          q.shift();
          await kv('set', 'queue', q);
          synced = true;
          badge();
        } catch (e) {
          if (e instanceof NetErr) break;
          if (/SESI_HABIS/.test(e.message)) { note('Login ulang untuk mengirim data yang tertunda'); break; }
          const bad = (await kv('get', 'failed')) || [];
          bad.push({args: it.args, error: e.message});
          await kv('set', 'failed', bad);
          q.shift();
          await kv('set', 'queue', q);
          badge();
        }
      }
    } finally { busy = false; }
    if (synced && typeof render == 'function' && typeof P != 'undefined' && P == 'dash') render();
  }

  // ---------- siapkan data untuk offline (dimuat saat online) ----------
  let lastWarm = 0;
  async function warm() {
    const tk = localStorage.getItem('tk');
    if (!tk || !navigator.onLine || Date.now() - lastWarm < 300000) return;
    lastWarm = Date.now();
    const d = new Date(), m = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const list = [['getSettings', []], ['regs', ['Klaim']], ['regs', ['Bengkel']], ['regs', ['PU']], ['regs', ['Operasi']], ['dashboard', [m]], ['lcSummary', [m]], ['frekuensi', [m]]];
    for (const [f, a] of list) await read([tk, f, a]).catch(() => {});
  }

  // ---------- penanda di layar ----------
  async function badge() {
    if (!document.body) return;
    const q = (await kv('get', 'queue')) || [], f = (await kv('get', 'failed')) || [], t = [];
    if (!bd) {
      bd = document.createElement('div');
      bd.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:72px;z-index:99;background:#14206B;color:#fff;font:600 12px/1.3 sans-serif;padding:8px 14px;border-radius:20px;display:none;max-width:90%;text-align:center';
      bd.onclick = () => flush();
      document.body.appendChild(bd);
    }
    if (!navigator.onLine) t.push('Mode offline');
    if (q.length) t.push(q.length + ' data menunggu dikirim (ketuk untuk kirim)');
    if (f.length) t.push(f.length + ' gagal dikirim');
    bd.textContent = t.join(' · ');
    bd.style.display = t.length ? 'block' : 'none';
  }
  async function note(m) { await badge(); if (bd) { bd.textContent = m; bd.style.display = 'block'; } }

  // ---------- pengganti google.script.run ----------
  async function call(fn, a) {
    if (fn == 'api') return WRITE.indexOf(a[1]) >= 0 ? write(a) : read(a);
    if (fn == 'session') {
      try { const r = await rpc(fn, a); kv('set', 'session', r); return r; }
      catch (e) { if (e instanceof NetErr) { const s = await kv('get', 'session'); if (s) return s; } throw e; }
    }
    if (fn == 'login') {
      const r = await rpc(fn, a);
      kv('set', 'session', {username: r.username, nama: r.nama, peran: r.peran});
      setTimeout(() => flush().then(warm), 1500);
      return r;
    }
    if (fn == 'logout') { await kv('set', 'cache', {}); await kv('del', 'session'); return rpc(fn, a).catch(() => true); }
    return rpc(fn, a);
  }
  const mk = (ok, no) => new Proxy({}, {get: (t, p) => {
    if (typeof p != 'string' || p == 'then') return undefined;
    if (p == 'withSuccessHandler') return f => mk(f, no);
    if (p == 'withFailureHandler') return f => mk(ok, f);
    return (...a) => { call(p, a).then(r => ok && ok(r), e => no && no(e)); };
  }});
  window.google = {script: {run: mk(null, null)}};

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  window.addEventListener('online', () => { badge(); flush().then(warm); });
  window.addEventListener('offline', badge);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush().then(warm); });
  document.addEventListener('DOMContentLoaded', () => { badge(); flush().then(warm); });
  setInterval(flush, 30000);
})();
