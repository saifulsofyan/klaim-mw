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
  const cacheSet = async (k, v) => { const c = (await kv('get', 'cache')) || {}; c[k] = v; c['@t:' + k] = Date.now(); await kv('set', 'cache', c); };
  const cacheSetMany = async pairs => { const c = (await kv('get', 'cache')) || {}, t = Date.now(); pairs.forEach(([k, v]) => { c[k] = v; c['@t:' + k] = t; }); await kv('set', 'cache', c); };
  const cacheDel = async k => { const c = (await kv('get', 'cache')) || {}; delete c[k]; delete c['@t:' + k]; await kv('set', 'cache', c); };

  // Data awal form yang sudah dibawa panggilan sebelumnya (sekali pakai, berlaku 20 detik) -> form terbuka tanpa menunggu server lagi
  let HOT = {};
  const HOT_MS = 20000;
  const hotPut = (k, p) => { HOT[k] = {t: Date.now(), p: p}; };
  const hotTake = k => { const e = HOT[k]; if (!e) return null; delete HOT[k]; return Date.now() - e.t < HOT_MS ? e.p : null; };

  // Data ringkasan (dashboard, laporan, frekuensi) boleh diambil dari salinan di HP saat mode Offline.
  // Salinan dianggap basi setelah 10 menit atau setelah ada input baru, lalu diambil ulang dari server.
  const SUMMARY = ['dashboard', 'lcSummary', 'frekuensi', 'report', 'ttdSummary'], TTL = 600000;
  const cacheFresh = async k => { const c = (await kv('get', 'cache')) || {}; return c[k] !== undefined && Date.now() - (c['@t:' + k] || 0) < TTL ? c[k] : undefined; };
  async function stale() {
    const c = (await kv('get', 'cache')) || {};
    Object.keys(c).forEach(k => { if (k.indexOf('@t:') == 0 && SUMMARY.indexOf(k.slice(3).split(':')[0]) >= 0) delete c[k]; });
    HOT = {};
    await kv('set', 'cache', c);
    if (!isOff()) setTimeout(refreshDash, 300);  // ambil angka dashboard terbaru di belakang layar, supaya saat kembali ke dashboard sudah siap
  }

  // ---------- saklar Online / Offline (dipilih petugas di header) ----------
  const isOff = () => { try { return localStorage.getItem('mode') == 'off'; } catch (e) { return false; } };
  window.MODE = {
    off: isOff,
    stale: stale,
    set(v) {  // v = true -> offline
      try { localStorage.setItem('mode', v ? 'off' : 'on'); } catch (e) {}
      badge();
      flush().then(warm);
    }
  };

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
  // Buka form = SATU panggilan: daftar nomor + data awal yang pasti diminta form itu (nomor baru / data nomor pertama / point)
  async function regsBundle(args) {
    const form = typeof P != 'undefined' && P == 'form' && typeof X != 'undefined' ? X : '';
    if (['Klaim', 'Bengkel', 'PU', 'Operasi'].indexOf(form) < 0) return undefined;
    const a = args[2] || [];
    let r;
    try { r = await rpc('api', [args[0], 'regsPlus', [a[0], form]]); }
    catch (e) { if (e instanceof NetErr) throw e; return undefined; }  // Code.gs lama / galat lain: pakai cara biasa
    if (!r || !Array.isArray(r.list)) return undefined;
    const pairs = [['regs:' + JSON.stringify(a), r.list]];
    const seed = (f, aa, v) => { const k = f + ':' + JSON.stringify(aa); pairs.push([k, v]); hotPut(k, Promise.resolve(v)); };
    if (r.next !== undefined) seed('nextReg', [], r.next);
    if (r.list.length) {
      const v0 = r.list[0].v;
      if (r.rec !== undefined) seed('getRecord', [form, v0], r.rec);
      if (r.poin !== undefined) seed('poinAktif', [v0], r.poin);
    }
    cacheSetMany(pairs);
    return r.list;
  }
  // Dashboard: tampilkan angka yang tersimpan di HP SEKETIKA, ambil yang terbaru di belakang layar, lalu segarkan layar bila berubah
  const SWR = ['dashboard', 'lcSummary', 'ttdSummary'], BG = {};
  function repaint(f) {
    try {
      if (SWR.indexOf(f) < 0 || typeof P == 'undefined' || P != 'dash') return;
      const fn = window.vDash;
      if (typeof fn == 'function') Promise.resolve(fn()).catch(() => {}); else if (typeof render == 'function') render();
    } catch (e) {}
  }
  async function bgRefresh(args, key, old) {
    if (BG[key]) return;
    BG[key] = 1;
    try {
      const r = await rpc('api', args);
      await cacheSet(key, r);
      if (JSON.stringify(r) !== JSON.stringify(old)) repaint(args[1]);
    } catch (e) {} finally { delete BG[key]; }
  }
  async function refreshDash() {
    if (!navigator.onLine) return;
    let tk = ''; try { tk = localStorage.getItem('tk') || ''; } catch (e) {}
    if (!tk) return;
    const c = (await kv('get', 'cache')) || {};
    Object.keys(c).forEach(k => {
      if (k.indexOf('@t:') == 0) return;
      const f = k.split(':')[0];
      if (SWR.indexOf(f) < 0) return;
      let a; try { a = JSON.parse(k.slice(f.length + 1)); } catch (e) { return; }
      bgRefresh([tk, f, a], k, c[k]);
    });
  }
  // Pengaturan jarang berubah: tampilkan salinan di HP seketika, perbarui di belakang layar
  let setAt = 0;
  async function refreshSettings(args, key) {
    if (Date.now() - setAt < 30000) return;
    setAt = Date.now();
    try {
      const r = await rpc('api', args);
      await cacheSet(key, r);
      try { if (typeof S != 'undefined' && JSON.stringify(S) != JSON.stringify(r)) S = r; } catch (e) {}
    } catch (e) {}
  }
  async function read(args, nobundle) {
    const f = args[1], a = args[2], key = f + ':' + JSON.stringify(a);
    const hot = hotTake(key);
    if (hot) { try { return await hot; } catch (e) {} }
    if (f == 'getSettings') { const hit = await cacheGet(key); if (hit !== undefined) { refreshSettings(args, key); return hit; } }
    if (SWR.indexOf(f) >= 0) {
      const c = (await kv('get', 'cache')) || {}, t = c['@t:' + key];
      if (c[key] !== undefined) {
        if (isOff() && t && Date.now() - t < TTL) return c[key];  // mode Offline: salinan < 10 menit dipakai apa adanya
        if (!t || Date.now() - t >= 15000) bgRefresh(args, key, c[key]);
        return c[key];
      }
    }
    if (isOff() && SUMMARY.indexOf(f) >= 0) {  // mode Offline: ringkasan dari salinan di HP, tanpa membebani server
      const c = await cacheFresh(key);
      if (c !== undefined) return c;
    }
    try {
      if (f == 'regs' && !nobundle) { const b = await regsBundle(args); if (b !== undefined) return b; }
      const r = await rpc('api', args);
      if (f == 'saveSettings') await cacheDel('getSettings:[]');  // setelah pengaturan diubah, ambil yang baru dari server
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

  // ---------- foto: diunggah di latar begitu dipilih, jadi saat Simpan tinggal menunggu data ----------
  const UP = new WeakMap();
  const upOne = (tk, it) => rpc('api', [tk, 'uploadFoto', [[{data: it.data, name: it.name}]]]).then(r => r[0]);
  function preUp(it) {
    if (!it || typeof it != 'object' || !it.data || UP.has(it) || isOff() || !navigator.onLine) return;
    let tk = ''; try { tk = localStorage.getItem('tk') || ''; } catch (e) {}
    if (!tk) return;
    const p = (async () => { if (((await kv('get', 'queue')) || []).length) throw new Error('antrean'); return upOne(tk, it); })();
    UP.set(it, p);
    p.catch(() => { if (UP.get(it) === p) UP.delete(it); });
  }
  const uploadAll = args => Promise.all((args[2][0] || []).map(it => { const p = UP.get(it), again = () => upOne(args[0], it); return p ? p.catch(again) : again(); }));
  function hookPh() {
    try {
      const f = window.drawPh;
      if (typeof f != 'function' || f.__pre) return;
      const g = function (k) { const r = f.apply(this, arguments); try { (PH[k] || []).forEach(preUp); } catch (e) {} return r; };
      g.__pre = 1; window.drawPh = g;
    } catch (e) {}
  }

  // ---------- simpan data: online -> langsung, offline -> antrean ----------
  async function write(args) {
    await flush();
    const q0 = (await kv('get', 'queue')) || [];
    if (!q0.length) {
      try {  // langsung ke Google Sheet (juga saat mode Offline)
        const r = args[1] == 'uploadFoto' ? await uploadAll(args) : await rpc('api', args);
        if (args[1] == 'save') await stale();  // dashboard & laporan diambil ulang agar angkanya berubah
        return r;
      } catch (e) { if (!(e instanceof NetErr)) throw e; }
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
    if (synced) {
      await stale();
      if (typeof render == 'function' && typeof P != 'undefined' && P == 'dash') render();
    }
  }

  // ---------- siapkan data untuk offline (dimuat saat online) ----------
  let lastWarm = 0;
  async function warm() {
    const tk = localStorage.getItem('tk');
    if (!tk || !navigator.onLine || isOff() || Date.now() - lastWarm < 300000) return;
    lastWarm = Date.now();
    const d = new Date(), m = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const list = [['getSettings', []], ['regs', ['Klaim']], ['regs', ['Bengkel']], ['regs', ['PU']], ['regs', ['Operasi']], ['dashboard', [m]], ['lcSummary', [m]], ['frekuensi', [m]], ['ttdSummary', [m]]];
    for (const [f, a] of list) await read([tk, f, a], true).catch(() => {});
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
    if (fn == 'api') {
      if (/^ttd(Link|Status)$/.test(a[1])) return rpc(fn, a);  // TTD pengemudi (barcode & status): selalu ke server, tidak disimpan di HP
      return WRITE.indexOf(a[1]) >= 0 ? write(a) : read(a);
    }
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
  document.addEventListener('DOMContentLoaded', () => { hookPh(); badge(); flush().then(warm); });
  setInterval(flush, 30000);
})();
