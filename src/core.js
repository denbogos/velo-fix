/* VELO FIX core — FIT/GPX track reconstruction. Pure JS, no dependencies (browser + Node). */
'use strict';
const VF = (() => {
  const FIT_EPOCH = 631065600, SC = 180 / 2 ** 31, RE = 6371008.8;
  const BT = { 0x00: ['u8', 1, 0xFF], 0x01: ['i8', 1, 0x7F], 0x02: ['u8', 1, 0xFF], 0x83: ['i16', 2, 0x7FFF], 0x84: ['u16', 2, 0xFFFF],
    0x85: ['i32', 4, 0x7FFFFFFF], 0x86: ['u32', 4, 0xFFFFFFFF], 0x07: ['str', 1, null], 0x88: ['f32', 4, null], 0x89: ['f64', 8, null],
    0x0A: ['u8', 1, 0x00], 0x8B: ['u16', 2, 0x0000], 0x8C: ['u32', 4, 0x00000000], 0x0D: ['u8', 1, 0xFF] };

  // ---------- CRC ----------
  const CT = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  function crc16(b, s, e) {
    let c = 0;
    for (let i = s; i < e; i++) {
      let t = CT[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ CT[b[i] & 0xF];
      t = CT[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ CT[(b[i] >> 4) & 0xF];
    }
    return c;
  }

  // ---------- FIT parse (keeps byte offsets of every field) ----------
  function parseFit(bytes) {
    const b = bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const hsize = b[0];
    if (b.length < 12 || String.fromCharCode(b[8], b[9], b[10], b[11]) !== '.FIT') throw new Error('Это не FIT-файл');
    const dsize = dv.getUint32(4, true), end = hsize + dsize;
    if (end + 2 > b.length) throw new Error('FIT-файл обрезан');
    const crcOk = crc16(b, 0, end) === dv.getUint16(end, true);
    const defs = {}, msgs = []; let p = hsize, lastTs = null;
    while (p < end) {
      const h = b[p], start = p; p++;
      if (h & 0x80) {
        const local = (h >> 5) & 3, off = h & 0x1F, d = defs[local];
        if (!d) throw new Error('FIT: сжатый заголовок без определения @' + start);
        let ts = (lastTs & ~0x1F) + off; if (off < (lastTs & 0x1F)) ts += 0x20; lastTs = ts;
        const m = readData(d, p, start); m.cts = ts; m.compressed = true; m.end = p + d.size; p = m.end; msgs.push(m); continue;
      }
      const local = h & 0x0F;
      if (h & 0x40) {
        const le = b[p + 1] === 0, g = dv.getUint16(p + 2, le), nf = b[p + 4]; let q = p + 5; const fields = [];
        for (let i = 0; i < nf; i++) { fields.push([b[q], b[q + 1], b[q + 2]]); q += 3; }
        const dev = [];
        if (h & 0x20) { const nd = b[q++]; for (let i = 0; i < nd; i++) { dev.push([b[q], b[q + 1], b[q + 2]]); q += 3; } }
        const fsize = fields.reduce((a, f) => a + f[1], 0), size = fsize + dev.reduce((a, f) => a + f[1], 0);
        const d = { local, g, le, fields, dev, fsize, size, bytes: b.slice(start, q), hasDev: !!(h & 0x20) };
        defs[local] = d; msgs.push({ isDef: true, def: d, start, end: q }); p = q;
      } else {
        const d = defs[local]; if (!d) throw new Error('FIT: данные без определения @' + start);
        const m = readData(d, p, start); m.end = p + d.size; p = m.end;
        const ts = m.v(253); if (ts != null) lastTs = ts;
        msgs.push(m);
      }
    }
    function readData(d, pos, start) {
      const f = {}; let q = pos;
      for (const [num, size, bt] of d.fields) { f[num] = { off: q, size, bt }; q += size; }
      return { def: d, g: d.g, start, dataStart: pos, f, v(num) { return readVal(this.f[num], d.le); } };
    }
    function readVal(fd, le) {
      if (!fd) return null; const t = BT[fd.bt]; if (!t) return null; const [kind, bs, inv] = t;
      if (kind === 'str') { let s = ''; for (let i = 0; i < fd.size && b[fd.off + i]; i++) s += String.fromCharCode(b[fd.off + i]); return s; }
      if (fd.size !== bs) return null; let v;
      switch (kind) { case 'u8': v = b[fd.off]; break; case 'i8': v = dv.getInt8(fd.off); break; case 'u16': v = dv.getUint16(fd.off, le); break;
        case 'i16': v = dv.getInt16(fd.off, le); break; case 'u32': v = dv.getUint32(fd.off, le); break; case 'i32': v = dv.getInt32(fd.off, le); break;
        case 'f32': v = dv.getFloat32(fd.off, le); break; case 'f64': v = dv.getFloat64(fd.off, le); break; }
      return (inv != null && v === inv) ? null : v;
    }
    return { bytes: b, dv, hsize, dsize, end, crcOk, msgs, protocol: b[1], profile: dv.getUint16(2, true) };
  }

  // ---------- geometry ----------
  const rad = x => x * Math.PI / 180;
  function hav(a1, o1, a2, o2) {
    const p1 = rad(a1), p2 = rad(a2), dp = p2 - p1, dl = rad(o2 - o1);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * RE * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  class Poly {
    constructor(pts, name) {
      this.pts = pts; this.name = name; this.c = [0];
      for (let i = 1; i < pts.length; i++) this.c.push(this.c[i - 1] + hav(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
      this.L = this.c[this.c.length - 1]; const k = Math.cos(rad(pts[0].lat)); this.k = k;
      this.xy = pts.map(p => [rad(p.lon) * RE * k, rad(p.lat) * RE]);
    }
    xyOf(lat, lon) { return [rad(lon) * RE * this.k, rad(lat) * RE]; }
    segProj(i, P) {
      const [x1, y1] = this.xy[i], [x2, y2] = this.xy[i + 1], dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((P[0] - x1) * dx + (P[1] - y1) * dy) / L2));
      return [Math.hypot(P[0] - (x1 + u * dx), P[1] - (y1 + u * dy)), this.c[i] + u * (this.c[i + 1] - this.c[i])];
    }
    nearest(lat, lon) { const P = this.xyOf(lat, lon); let best = [1e18, 0]; for (let i = 0; i < this.pts.length - 1; i++) { const r = this.segProj(i, P); if (r[0] < best[0]) best = r; } return best; }
    // all separate passes within tol (local minima), as [dist, s]
    passes(lat, lon, tol) {
      const P = this.xyOf(lat, lon), out = []; let cur = null;
      for (let i = 0; i < this.pts.length - 1; i++) {
        const r = this.segProj(i, P);
        if (r[0] <= tol) { if (!cur || r[0] < cur[0]) cur = r; }
        else if (cur && r[0] > tol * 2.5) { out.push(cur); cur = null; }
      }
      if (cur) out.push(cur);
      return out;
    }
    at(s) {
      s = Math.max(0, Math.min(this.L, s)); let lo = 0, hi = this.c.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.c[m] <= s) lo = m; else hi = m; }
      const seg = this.c[hi] - this.c[lo], u = seg ? (s - this.c[lo]) / seg : 0, a = this.pts[lo], b2 = this.pts[hi];
      return { lat: a.lat + u * (b2.lat - a.lat), lon: a.lon + u * (b2.lon - a.lon) };
    }
    slice(s0, s1) { // points from s0 to s1 (s0<s1)
      const out = [this.at(s0)];
      for (let i = 0; i < this.pts.length; i++) if (this.c[i] > s0 && this.c[i] < s1) out.push(this.pts[i]);
      out.push(this.at(s1)); return out;
    }
  }

  // ---------- GPX ----------
  function parseGpx(text, name) {
    const pts = []; const re = /<trkpt\b([^>]*?)(\/>|>([\s\S]*?)<\/trkpt>)/g; let m, nTime = 0;
    while ((m = re.exec(text))) {
      const a = m[1], lat = /lat\s*=\s*["']([-\d.eE+]+)/.exec(a), lon = /lon\s*=\s*["']([-\d.eE+]+)/.exec(a);
      if (!lat || !lon) continue; const body = m[3] || '';
      const tm = /<time>\s*([^<]+?)\s*<\/time>/.exec(body), el = /<ele>\s*([^<]+?)\s*<\/ele>/.exec(body);
      const t = tm ? Date.parse(tm[1]) / 1000 : null; if (t != null && !isNaN(t)) nTime++;
      pts.push({ lat: +lat[1], lon: +lon[1], ele: el ? +el[1] : null, t: (t != null && !isNaN(t)) ? t : null });
    }
    if (pts.length < 2) {  // also accept routes
      const re2 = /<rtept\b([^>]*?)(\/>|>([\s\S]*?)<\/rtept>)/g;
      while ((m = re2.exec(text))) { const a = m[1], lat = /lat\s*=\s*["']([-\d.eE+]+)/.exec(a), lon = /lon\s*=\s*["']([-\d.eE+]+)/.exec(a); if (lat && lon) pts.push({ lat: +lat[1], lon: +lon[1], ele: null, t: null }); }
    }
    const creator = (/<gpx\b[^>]*creator\s*=\s*["']([^"']*)/.exec(text) || [])[1] || '';
    return { name, pts, nTime, creator };
  }

  // ---------- main analysis ----------
  function run(fitBytes, gpxList, opt = {}) {
    const log = [], warn = [];
    const fit = parseFit(fitBytes);
    const recs = fit.msgs.filter(m => !m.isDef && m.g === 20);
    if (recs.length < 10) throw new Error('В FIT нет записей тренировки');
    const R = recs.map(m => {
      const ts = m.v(253) ?? m.cts, la = m.v(0), lo = m.v(1); let spd = m.v(6); if (spd == null) spd = m.v(73);
      let alt = m.v(78); alt = alt != null ? alt / 5 - 500 : (m.v(2) != null ? m.v(2) / 5 - 500 : null);
      return { m, t: ts, lat: la != null && lo != null ? la * SC : null, lon: la != null && lo != null ? lo * SC : null,
        dist: m.v(5) != null ? m.v(5) / 100 : null, spd: spd != null ? spd / 1000 : null, alt,
        hr: m.v(3), cad: m.v(4), pwr: m.v(7), temp: m.v(13) };
    });
    const N = R.length, U = t => new Date((t + FIT_EPOCH) * 1000);
    const sensorFix = opt.sensorFix === false ? { hr: [], pwr: [] } : cleanSensors(R);
    const ses = fit.msgs.find(m => !m.isDef && m.g === 18), laps = fit.msgs.filter(m => !m.isDef && m.g === 19);
    const act = fit.msgs.find(m => !m.isDef && m.g === 34);
    let tzOff = 0; if (act && act.v(5) != null && act.v(253) != null) tzOff = act.v(5) - act.v(253);
    // ---- events -> pauses
    const ev = fit.msgs.filter(m => !m.isDef && m.g === 21 && m.v(0) === 0).map(m => ({ t: m.v(253), type: m.v(1) }));
    const stops = ev.filter(e => e.type === 1 || e.type === 4).map(e => e.t);
    function pausedBetween(t0, t1) { return stops.some(s => s >= t0 && s < t1); }
    // ---- duplicates
    const dups = new Set();
    for (let i = 1; i < N; i++) {
      if (R[i].t !== R[i - 1].t) continue;
      const a = R[i - 1].m, b = R[i].m; if (a.end - a.start !== b.end - b.start) continue;
      let same = true; for (let k = 0; k < a.end - a.start && same; k++) if (fit.bytes[a.start + k] !== fit.bytes[b.start + k]) same = false;
      if (same) dups.add(i);
    }
    // ---- speed sensor?
    const gpsless = R.filter(r => r.lat == null), withSpd = gpsless.filter(r => r.spd != null && r.spd > 0.5).length;
    const hasDist = R.every(r => r.dist != null);
    const sensor = hasDist && (gpsless.length < 30 || withSpd / gpsless.length > 0.5) && R.some(r => r.spd != null);
    // ---- phantom movement: physically impossible bike speed without pedalling on flat ground
    //      (GPS drift / spoofing while the wheel sensor is asleep: device takes speed and distance from GPS)
    const KMH = i => (R[i].spd ?? 0) * 3.6;
    const pedal = i => (R[i].cad ?? 0) > 0 || (R[i].pwr ?? 0) > 0;
    const altAt = i => R[Math.max(0, Math.min(N - 1, i))].alt;
    const descending = i => { const a = altAt(i - 20), b = altAt(i + 20); return a != null && b != null && a - b > 8; };
    const phantom = new Array(N).fill(false);
    for (let i = 0; i < N; i++) if (KMH(i) > 100 || (KMH(i) > 70 && !descending(i) && !pedal(i))) phantom[i] = true;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < N; i++) {   // grow block over neighbouring non-pedalling fast records
      if (!phantom[i]) continue;
      for (const d of [-1, 1]) { let j = i + d; while (j >= 0 && j < N && !phantom[j] && !pedal(j) && KMH(j) > 30 && Math.abs((R[j].t - R[j - d]?.t) || 1) <= 5) { phantom[j] = true; j += d; } }
    }
    const phantomBlocks = [];
    { let i = 0; while (i < N) { if (phantom[i]) { let j = i; while (j + 1 < N && phantom[j + 1]) j++;
      const alts = []; for (let k = i; k <= j; k++) if (R[k].alt != null) alts.push(R[k].alt);
      const altRange = alts.length ? Math.max(...alts) - Math.min(...alts) : null;
      let maxV = 0; for (let k = i; k <= j; k++) maxV = Math.max(maxV, KMH(k));
      const odo = hasDist ? R[j].dist - (i > 0 ? R[i - 1].dist : R[i].dist) : null;
      phantomBlocks.push({ a: i, b: j, t0: R[i].t, t1: R[j].t, maxV, altRange, odo, n: j - i + 1 }); i = j + 1; } else i++; } }
    const newSpd = R.map((r, i) => phantom[i] ? 0 : r.spd);
    let phantomTimer = 0;
    for (let i = 0; i < N; i++) if (phantom[i] && i > 0 && !pausedBetween(R[i - 1].t, R[i].t)) phantomTimer += Math.min(5, Math.max(1, R[i].t - R[i - 1].t));
    // ---- odometer: rebuild from increments (phantom -> 0, false jumps -> speed sensor value)
    const newDist = R.map(r => r.dist); const jumps = [];
    if (hasDist) {
      for (let i = 1; i < N; i++) {
        let dd = R[i].dist - R[i - 1].dist; const dt = R[i].t - R[i - 1].t, sp = newSpd[i] ?? 0, paused = pausedBetween(R[i - 1].t, R[i].t);
        const exp = sp * (paused ? 1 : Math.max(1, dt));
        if (phantom[i]) dd = 0;
        else if (sensor && !dups.has(i) && dd > exp * 1.5 + 50) {
          const repl = Math.round(exp * 100) / 100;
          jumps.push({ i, t0: R[i - 1].t, t1: R[i].t, orig: dd, repl, paused });
          dd = repl;
        }
        newDist[i] = newDist[i - 1] + Math.max(0, dd);
      }
    }
    // ---- reference tracks
    const refs = [];
    for (const g of gpxList) {
      if (g.pts.length < 2) { warn.push(`${g.name}: нет точек трека — пропущен`); continue; }
      // copy of main track?  timestamps coincide with FIT and positions coincide
      if (g.nTime > g.pts.length * 0.5) {
        const byT = new Map(R.filter(r => r.lat != null).map(r => [r.t + FIT_EPOCH, r]));
        let hit = 0, tot = 0;
        for (const p of g.pts) { if (p.t == null) continue; tot++; const r = byT.get(Math.round(p.t)); if (r && hav(r.lat, r.lon, p.lat, p.lon) < 30) hit++; }
        if (tot && hit / tot > 0.5) { g.role = 'copy'; log.push(`${g.name}: это экспорт основной тренировки (время и координаты совпадают с FIT в ${Math.round(hit / tot * 100)}% точек) — как эталон не используется`); continue; }
        // time check vs FIT range
        const t0 = g.pts.find(p => p.t != null).t, t1 = [...g.pts].reverse().find(p => p.t != null).t, f0 = R[0].t + FIT_EPOCH, f1 = R[N - 1].t + FIT_EPOCH;
        g.timeNote = (t1 < f0 || t0 > f1) ? 'время трека не пересекается с тренировкой — используется только геометрия' : 'используется только геометрия (время не переносится)';
      } else g.timeNote = 'без меток времени — используется только геометрия';
      g.role = 'ref'; const P = new Poly(g.pts, g.name); refs.push(P);
      log.push(`${g.name}: эталон, ${g.pts.length} точек, ${(P.L / 1000).toFixed(2)} км, ${g.timeNote}`);
    }
    // ---- validity of fixes
    const valid = R.map(r => r.lat != null);
    const badReason = {};
    for (const pb of phantomBlocks) for (let k = pb.a; k <= pb.b; k++) if (valid[k]) { valid[k] = false; badReason[k] = `фантомное движение до ${Math.round(pb.maxV)} км/ч без педалирования (GPS-дрейф/подмена)`; }
    // ---- teleport islands: a straight-line GPS displacement can never exceed the distance actually travelled
    const islands = [];
    {
      const fx = []; for (let i = 0; i < N; i++) if (valid[i]) fx.push(i);
      // while the timer is paused the rider may still move slowly (walking, rolling under auto-pause speed): allow 2.5 m/s
      const pausePref = [0]; for (let i = 1; i < N; i++) pausePref.push(pausePref[i - 1] + (pausedBetween(R[i - 1].t, R[i].t) ? R[i].t - R[i - 1].t : 0));
      const bound = (a, b, slack) => {
        const d = hav(R[a].lat, R[a].lon, R[b].lat, R[b].lon);
        const walk = 2.5 * (pausePref[b] - pausePref[a]);
        const lim = (hasDist && sensor) ? 1.3 * (newDist[b] - newDist[a]) + walk + slack : (R[b].t - R[a].t) * 22 + slack; // 22 m/s ~ 80 km/h
        return { d, ok: d <= lim, lim };
      };
      let cur = [];
      for (let k = 0; k < fx.length; k++) {
        if (cur.length && !bound(fx[k - 1], fx[k], 60).ok) { islands.push(cur); cur = []; }
        cur.push(fx[k]);
      }
      if (cur.length) islands.push(cur);
      if (islands.length > 1) {
        const trusted = new Set(); const order = islands.map((s, i) => i).sort((x, y) => islands[y].length - islands[x].length);
        const tIdx = [];   // sorted list of trusted fix indices
        const addT = isl => { for (const i of isl) tIdx.push(i); tIdx.sort((a, b) => a - b); };
        trusted.add(order[0]); addT(islands[order[0]]);
        for (const k of order.slice(1)) {
          const isl = islands[k], first = isl[0], last = isl[isl.length - 1];
          let P = null, Q = null; for (const i of tIdx) { if (i < first) P = i; else if (i > last) { Q = i; break; } }
          const sl = (a, b) => Math.min(150, 60 + 3 * (R[b].t - R[a].t));
          const okP = P == null || bound(P, first, sl(P, first)).ok, okQ = Q == null || bound(last, Q, sl(last, Q)).ok;
          const exc = (a, b) => { const q = bound(a, b, sl(a, b)); return q.d - q.lim; };
          const excess = Math.max(P == null ? -1 : exc(P, first), Q == null ? -1 : exc(last, Q));
          if ((okP && okQ) || (isl.length >= 30 && excess < 300)) { trusted.add(k); addT(isl); }
          else {
            const ref = !okP ? bound(P, first, sl(P, first)) : bound(last, Q, sl(last, Q));
            const [pa, pb] = !okP ? [P, first] : [last, Q];
            const trav = (hasDist && sensor) ? `при ${((newDist[pb] - newDist[pa]) / 1000).toFixed(1)} км по датчику` : `за ${R[pb].t - R[pa].t} с`;
            for (const i of isl) { valid[i] = false; badReason[i] = `GPS-телепортация: смещение ${(ref.d / 1000).toFixed(1)} км ${trav}`; }
          }
        }
      }
    }
    const xt = (i) => refs.length ? Math.min(...refs.map(P => P.nearest(R[i].lat, R[i].lon)[0])) : null;
    // runs
    function runsOf(arr, val) { const out = []; let i = 0; while (i < N) { if (arr[i] === val) { let j = i; while (j + 1 < N && arr[j + 1] === val) j++; out.push([i, j]); i = j + 1; } else i++; } return out; }
    const gapsLong = runsOf(valid, false).filter(([a, b]) => b - a + 1 >= 20);
    const frags = runsOf(valid, true);
    for (const [a, b] of frags) {
      if (b - a + 1 >= 20) continue;
      const nearGap = gapsLong.some(([ga, gb]) => (ga > b && ga - b <= 60) || (gb < a && a - gb <= 60));
      if (!nearGap) continue;
      const devs = []; for (let i = a; i <= b; i++) { const d = xt(i); if (d != null) devs.push(d); }
      devs.sort((x, y) => x - y); const med = devs.length ? devs[devs.length >> 1] : null;
      let gp = 0, sd = 0; const s0 = a > 0 && valid[a - 1] ? a - 1 : a;
      for (let i = s0 + 1; i <= b; i++) { gp += hav(R[i - 1].lat ?? R[i].lat, R[i - 1].lon ?? R[i].lon, R[i].lat, R[i].lon); }
      if (hasDist) sd = newDist[b] - newDist[a];
      let fixG = 0; for (let i = a + 1; i <= b; i++) fixG += hav(R[i - 1].lat, R[i - 1].lon, R[i].lat, R[i].lon);
      const ratio = sd > 30 ? fixG / sd : null;
      let why = null;
      if (med != null && med > 12 && refs.length) why = `нестабильный приём у пропуска: ${Math.round(devs[0])}–${Math.round(devs[devs.length - 1])} м от дороги`;
      if (ratio != null && (ratio < 0.6 || ratio > 1.5)) why = (why ? why + '; ' : '') + `путь GPS ${Math.round(fixG)} м при ${Math.round(sd)} м по датчику`;
      if (why) for (let i = a; i <= b; i++) { valid[i] = false; badReason[i] = why; }
    }
    // jumps at the edge of a GPS gap (last/first fix before/after a gap)
    for (let pass = 0; pass < 3; pass++) for (let i = 1; i < N; i++) {
      if (!valid[i]) continue;
      let p = i - 1; while (p >= 0 && !valid[p]) p--; if (p < 0) continue;
      const nextInvalid = i + 1 < N && !valid[i + 1], prevGap = p < i - 1;
      if (!nextInvalid && !prevGap) continue;
      const d = hav(R[p].lat, R[p].lon, R[i].lat, R[i].lon), trav = hasDist ? newDist[i] - newDist[p] : (R[i].t - R[p].t) * 15;
      if (d > 100 && d > 3 * Math.max(1, trav) + 60) {
        const bad = nextInvalid ? i : p; valid[bad] = false; badReason[bad] = `скачок GPS на краю пропуска ${Math.round(d)} м`;
      }
    }
    // isolated spikes
    for (let i = 1; i < N - 1; i++) {
      if (!valid[i] || !valid[i - 1] || !valid[i + 1]) continue;
      const d1 = hav(R[i - 1].lat, R[i - 1].lon, R[i].lat, R[i].lon), d2 = hav(R[i].lat, R[i].lon, R[i + 1].lat, R[i + 1].lon), d3 = hav(R[i - 1].lat, R[i - 1].lon, R[i + 1].lat, R[i + 1].lon);
      const s1 = (R[i].spd ?? 0) * Math.max(1, R[i].t - R[i - 1].t), s2 = (R[i + 1].spd ?? 0) * Math.max(1, R[i + 1].t - R[i].t);
      if (d1 > 3 * s1 + 30 && d2 > 3 * s2 + 30 && d3 < 0.5 * (d1 + d2)) { valid[i] = false; badReason[i] = `одиночный выброс GPS ${Math.round(Math.min(d1, d2))} м`; }
    }
    // ---- trim range, manual edits, privacy zones
    const pos = R.map(r => ({ lat: r.lat, lon: r.lon }));
    let ka = 0, kb = N - 1;
    if (opt.trim) { while (ka < N - 1 && R[ka].t < opt.trim.t0) ka++; while (kb > ka && R[kb].t > opt.trim.t1) kb--; }
    const trimmed = R.map((r, i) => i < ka || i > kb);
    const routes = [];
    for (const e of (opt.edits || [])) {
      const inR = i => R[i].t >= e.t0 && R[i].t <= e.t1;
      if (e.type === 'keep') { for (let i = 0; i < N; i++) if (inR(i) && R[i].lat != null && !phantom[i]) { valid[i] = true; pos[i] = { lat: R[i].lat, lon: R[i].lon }; delete badReason[i]; } }
      else if (e.type === 'del') { for (let i = 0; i < N; i++) if (inR(i) && valid[i]) { valid[i] = false; badReason[i] = 'удалено вручную'; } }
      else if (e.type === 'route' && e.pts && e.pts.length >= 2) {
        let iA = -1, iB = -1; for (let i = 0; i < N; i++) { if (R[i].t === e.t0) iA = i; if (R[i].t === e.t1) iB = i; }
        if (iA < 0 || iB <= iA + 0) continue;
        for (let i = iA + 1; i < iB; i++) if (valid[i]) { valid[i] = false; badReason[i] = 'заменено маршрутом по дорогам'; }
        valid[iA] = true; valid[iB] = true; delete badReason[iA]; delete badReason[iB];
        pos[iA] = { lat: e.pts[0].lat, lon: e.pts[0].lon }; pos[iB] = { lat: e.pts[e.pts.length - 1].lat, lon: e.pts[e.pts.length - 1].lon };
        routes.push({ iA, iB, pts: e.pts, src: e.src || 'маршрут по дорогам' });
      }
    }
    const privacy = [];
    if (opt.privacy > 0) {
      const firstV = (() => { for (let i = ka; i <= kb; i++) if (valid[i]) return i; return -1; })(), lastV = (() => { for (let i = kb; i >= ka; i--) if (valid[i]) return i; return -1; })();
      for (const [c, dir] of [[firstV, 1], [lastV, -1]]) {
        if (c < 0) continue; const C = pos[c]; let n = 0;
        for (let i = dir > 0 ? ka : kb; dir > 0 ? i <= kb : i >= ka; i += dir) {
          if (!valid[i]) continue;
          if (hav(C.lat, C.lon, pos[i].lat, pos[i].lon) > opt.privacy) break;
          valid[i] = false; badReason[i] = `зона приватности ${opt.privacy} м`; n++;
        }
        privacy.push({ at: dir > 0 ? 'старт' : 'финиш', n });
      }
    }
    // ---- gap filling
    const along = i => hasDist ? newDist[i] : null;
    function chainsFor(A, B) {
      const tol = 40, cands = [];
      const nodes = []; refs.forEach((P, ri) => { nodes.push({ ri, rev: false, P }); nodes.push({ ri, rev: true, P }); });
      const sOf = (n, s) => n.rev ? n.P.L - s : s;
      const startPt = n => n.rev ? n.P.pts[n.P.pts.length - 1] : n.P.pts[0];
      const endPt = n => n.rev ? n.P.pts[0] : n.P.pts[n.P.pts.length - 1];
      const pa = nodes.map(n => n.P.passes(pos[A].lat, pos[A].lon, tol).map(([d, s]) => ({ d, s: sOf(n, s) })));
      const pb = nodes.map(n => n.P.passes(pos[B].lat, pos[B].lon, tol).map(([d, s]) => ({ d, s: sOf(n, s) })));
      const join = (n1, n2) => { const e = endPt(n1), s = startPt(n2); return hav(e.lat, e.lon, s.lat, s.lon); };
      const JOIN = 150;
      for (let x = 0; x < nodes.length; x++) for (const a of pa[x]) {
        // same node
        for (const b of pb[x]) if (b.s > a.s) cands.push({ path: [[x, a.s, b.s]], len: b.s - a.s, dA: a.d, dB: b.d });
        for (let y = 0; y < nodes.length; y++) {
          if (nodes[y].ri === nodes[x].ri) continue;
          const j1 = join(nodes[x], nodes[y]); if (j1 > JOIN) continue;
          for (const b of pb[y]) cands.push({ path: [[x, a.s, nodes[x].P.L], [y, 0, b.s]], len: nodes[x].P.L - a.s + j1 + b.s, dA: a.d, dB: b.d, joins: [j1] });
          for (let z = 0; z < nodes.length; z++) {
            if (nodes[z].ri === nodes[x].ri || nodes[z].ri === nodes[y].ri) continue;
            const j2 = join(nodes[y], nodes[z]); if (j2 > JOIN) continue;
            for (const b of pb[z]) cands.push({ path: [[x, a.s, nodes[x].P.L], [y, 0, nodes[y].P.L], [z, 0, b.s]], len: nodes[x].P.L - a.s + j1 + nodes[y].P.L + j2 + b.s, dA: a.d, dB: b.d, joins: [j1, j2] });
          }
        }
      }
      return { cands, nodes };
    }
    function buildPath(c, nodes) {
      const pts = [], src = [];
      for (const [ni, s0, s1] of c.path) {
        const n = nodes[ni], P = n.P;
        let seg;
        if (!n.rev) seg = P.slice(s0, s1); else seg = P.slice(P.L - s1, P.L - s0).reverse();
        for (const p of seg) { pts.push(p); src.push(P.name); }
      }
      // dedupe consecutive identical
      const out = [], os = []; for (let i = 0; i < pts.length; i++) { if (i && pts[i].lat === pts[i - 1].lat && pts[i].lon === pts[i - 1].lon) continue; out.push(pts[i]); os.push(src[i]); }
      const P = new Poly(out, 'path'); P.src = os; return P;
    }
    const fills = {}, runs = [], unfilled = [];
    const erased = (opt.edits || []).filter(e => e.type === 'del');
    for (let [a, b] of runsOf(valid, false)) {
      a = Math.max(a, ka); b = Math.min(b, kb); if (a > b) continue;
      if (erased.some(e => R[a].t >= e.t0 && R[b].t <= e.t1)) { unfilled.push({ a, b, n: b - a + 1, t0: R[a].t, t1: R[b].t, erased: true, why: 'стёрто вручную' }); continue; }
      const A = a - 1, B = b + 1, n = b - a + 1;
      if (A < ka || B > kb) { unfilled.push({ a, b, n, t0: R[a].t, t1: R[b].t, edge: true, why: A < ka ? 'в начале записи нет опорной точки' : 'в конце записи нет опорной точки' }); continue; }
      const straight = hav(pos[A].lat, pos[A].lon, pos[B].lat, pos[B].lon), dur = R[B].t - R[A].t;
      const sensLen = hasDist && sensor ? newDist[B] - newDist[A] : null;
      let best = null, nodes = null, P = null, ok = false, conf, method;
      const rt = routes.find(r => r.iA === A && r.iB === B);
      if (rt) {
        P = new Poly(rt.pts, rt.src); P.src = rt.pts.map(() => rt.src); ok = true; best = { len: P.L, dA: 0, dB: 0 };
        const ratio = sensLen ? P.L / sensLen : null;
        conf = ratio == null ? 'низкая' : (ratio > 0.85 && ratio < 1.2 ? 'средняя' : 'низкая');
        method = (rt.src === 'нарисовано вручную' ? 'нарисовано вручную' : 'маршрут по дорогам') + (sensLen ? ' + дистанция датчика скорости' : ' + равномерно по времени') + (ratio != null && conf === 'низкая' ? ` (длина маршрута ${Math.round(ratio * 100)}% от пройденного — проверьте)` : '');
      }
      if (!ok && refs.length) {
        const ch = chainsFor(A, B); nodes = ch.nodes;
        for (const c of ch.cands) {
          let score;
          if (sensLen != null && sensLen > 0) score = Math.abs(Math.log(c.len / sensLen));
          else { const v = c.len / Math.max(1, dur) * 3.6; if (v < 3 || v > 70) continue; score = c.len / 1e5; }
          score += (c.dA + c.dB) / 2000;
          if (!best || score < best.score) best = { ...c, score };
        }
      }
      if (!ok && best) {
        const ratio = sensLen ? best.len / sensLen : null;
        const tolOk = sensLen == null ? true : (sensLen > 500 ? (ratio > 0.85 && ratio < 1.18) : Math.abs(best.len - sensLen) <= 120);
        if (tolOk) {
          ok = true; P = buildPath(best, nodes);
          conf = n <= 15 ? 'высокая' : (ratio != null && Math.abs(ratio - 1) > 0.08 ? 'низкая' : 'средняя');
          if (sensLen == null && n > 15) conf = 'низкая';
          method = sensLen != null ? 'эталонная геометрия + дистанция датчика скорости' : 'эталонная геометрия + равномерно по времени (нет датчика скорости)';
        }
      }
      if (!ok && straight <= 200 && dur <= 30) {
        ok = true; P = new Poly([{ lat: pos[A].lat, lon: pos[A].lon }, { lat: pos[B].lat, lon: pos[B].lon }], 'interp'); P.src = ['интерполяция', 'интерполяция'];
        conf = n <= 5 ? 'высокая' : 'средняя'; method = 'линейная интерполяция короткого пропуска';
        best = { len: straight, dA: 0, dB: 0 };
      }
      if (!ok && opt.fillStraight) {
        ok = true; P = new Poly([{ lat: pos[A].lat, lon: pos[A].lon }, { lat: pos[B].lat, lon: pos[B].lon }], 'straight'); P.src = ['прямая (нет эталона)', 'прямая (нет эталона)'];
        conf = 'низкая'; method = 'прямая линия между достоверными точками (эталонного GPX нет)'; best = { len: straight, dA: 0, dB: 0 };
      }
      if (!ok) { unfilled.push({ a, b, n, t0: R[a].t, t1: R[b].t, A, B, tA: R[A].t, tB: R[B].t, from: pos[A], to: pos[B], straight, sensLen, why: refs.length ? 'нет эталонного трека, совпадающего с этим участком по геометрии и длине' : 'нет GPX маршрута — участок оставлен без координат (Strava соединит его прямой)' }); continue; }
      const totalSpan = sensLen != null && sensLen > 0 ? sensLen : dur;
      for (let k = a; k <= b; k++) {
        const u = sensLen != null && sensLen > 0 ? (newDist[k] - newDist[A]) / sensLen : (R[k].t - R[A].t) / Math.max(1, dur);
        const s = Math.max(0, Math.min(1, u)) * P.L, pt = P.at(s);
        let lo = 0, hi = P.c.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.c[m] <= s) lo = m; else hi = m; }
        const srcName = P.src[lo] === P.src[hi] ? P.src[lo] : P.src[lo] + '→' + P.src[hi];
        fills[k] = { lat: pt.lat, lon: pt.lon, src: srcName, conf, method };
      }
      runs.push({ a, b, n, t0: R[a].t, t1: R[b].t, dA: best.dA, dB: best.dB, len: best.len, sensLen, straight, conf, method,
        srcs: [...new Set(P.src.filter(Boolean))], joins: best.joins || [] });
    }
    // ---- output FIT
    const newLL = R.map((r, i) => trimmed[i] ? { lat: null, lon: null } : fills[i] ? { lat: fills[i].lat, lon: fills[i].lon } : (valid[i] ? { lat: pos[i].lat, lon: pos[i].lon } : { lat: null, lon: null }));
    const isTrim = ka > 0 || kb < N - 1;
    const finalDist = !hasDist ? newDist : R.map((r, i) => i < ka ? 0 : i > kb ? newDist[kb] - newDist[ka] : newDist[i] - (isTrim ? newDist[ka] : 0));
    const totalCorr = hasDist ? R[N - 1].dist - finalDist[N - 1] : 0;
    const lastIdxAt = t => { let lo = -1, hi = N - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (R[m].t <= t) lo = m; else hi = m - 1; } return lo; };
    const deltaAt = t => { const i = lastIdxAt(t); return i < 0 || !hasDist ? 0 : R[i].dist - finalDist[i]; };
    const ptAt = []; { let acc = 0; for (let i = 0; i < N; i++) { if ((phantom[i] || trimmed[i]) && i > 0 && !pausedBetween(R[i - 1].t, R[i].t)) acc += Math.min(5, Math.max(1, R[i].t - R[i - 1].t)); ptAt.push(acc); } }
    const ctx = {
      newDist: finalDist, newSpd, phantom, trimmed, isTrim, sensorChanged: (sensorFix.hr.length || sensorFix.pwr.length) ? { hr: sensorFix.hr.length > 0, pwr: sensorFix.pwr.length > 0 } : null, tStart: R[ka].t, tEnd: R[kb].t, anyPhantom: phantomBlocks.length > 0 || isTrim,
      deltaIn: (t0, t1) => deltaAt(t1) - deltaAt(t0),
      phantomTimeIn: (t0, t1) => { const a = lastIdxAt(t0), b = lastIdxAt(t1); return (b < 0 ? 0 : ptAt[b]) - (a < 0 ? 0 : ptAt[a]); },
      maxSpdIn: (t0, t1) => { let mx = 0; for (let i = 0; i < N; i++) if (R[i].t > t0 && R[i].t <= t1 && !trimmed[i] && newSpd[i] != null) mx = Math.max(mx, newSpd[i]); return mx; } };
    const recIndex = new Map(recs.map((m, i) => [m, i]));
    const before = summary(fit, ses);
    const out = writeFit(fit, recIndex, newLL, dups, R, ses, laps, valid, ctx, act);
    const fit2 = parseFit(out);
    const after = summary(fit2, fit2.msgs.find(m => !m.isDef && m.g === 18));
    const R2 = fit2.msgs.filter(m => !m.isDef && m.g === 20).map(m => ({ t: m.v(253) ?? m.cts, lat: m.v(0) != null ? m.v(0) * SC : null, lon: m.v(1) != null ? m.v(1) * SC : null, dist: m.v(5) != null ? m.v(5) / 100 : null, spd: m.v(6) != null ? m.v(6) / 1000 : (m.v(73) != null ? m.v(73) / 1000 : null) }));
    // ---- checks
    const checks = verify(fit, fit2, R, R2, dups, recIndex, phantom, trimmed);
    return { fit, fit2, out, R, R2, N, U, tzOff, refs, gpxList, jumps, dups: [...dups], badReason, fills, runs, unfilled, newLL, newDist,
      before, after, checks, log, warn, sensorFix, sensor, hasDist, totalCorr, phantomBlocks, phantomTimer, newSpd, phantom, trimmed, ka, kb, privacy, pos, valid, finalDist };
  }

  // ---------- heart-rate / power spikes (strap static, power-meter glitches) ----------
  function cleanSensors(R) {
    const N = R.length, out = { hr: [], pwr: [] };
    const median = (key, i, w, skip) => { const v = []; for (let k = Math.max(0, i - w); k <= Math.min(N - 1, i + w); k++) if (k !== i && R[k][key] != null && !skip(R[k][key])) v.push(R[k][key]); if (v.length < 5) return null; v.sort((a, b) => a - b); return v[v.length >> 1]; };
    const series = (key, cand, keepRun) => {
      const c = new Array(N).fill(false), med = new Array(N).fill(null);
      for (let i = 0; i < N; i++) { const x = R[i][key]; if (x == null) continue; med[i] = median(key, i, 30, cand.hard); c[i] = cand.hard(x) || (med[i] != null && cand.soft(x, med[i])); }
      let i = 0;
      while (i < N) {
        if (!c[i]) { i++; continue; } let j = i; while (j + 1 < N && (c[j + 1] || (R[j + 1][key] == null && j + 2 < N && c[j + 2]))) j++;
        let mx = -Infinity, hard = false; for (let k = i; k <= j; k++) if (R[k][key] != null) { mx = Math.max(mx, R[k][key]); hard = hard || cand.hard(R[k][key]); }
        if (hard || keepRun(j - i + 1, R[j].t - R[i].t)) {
          let a = i - 1; while (a >= 0 && (R[a][key] == null || c[a])) a--; let b = j + 1; while (b < N && (R[b][key] == null || c[b])) b++;
          const va = a >= 0 ? R[a][key] : null, vb = b < N ? R[b][key] : null; let n = 0;
          for (let k = i; k <= j; k++) { if (R[k][key] == null) continue; const v = va != null && vb != null ? va + (vb - va) * (R[k].t - R[a].t) / Math.max(1, R[b].t - R[a].t) : (va ?? vb);
            R[k][key + '0'] = R[k][key]; R[k][key] = v == null ? null : Math.round(v); n++; }
          if (n) out[key].push({ a: i, b: j, t0: R[i].t, t1: R[j].t, n, max: mx, to: R[i][key] });
        }
        i = j + 1;
      }
    };
    // HR: > 225 is never real; a ±40 bpm jump that returns within 20 s is strap static / dropout
    series('hr', { hard: x => x > 225 || x < 25, soft: (x, m) => Math.abs(x - m) > 40 }, (n, dt) => dt <= 20);
    // power: > 2500 W is a glitch; a short (≤ 3 s) burst far above the surrounding level is a meter spike, a real sprint lasts longer
    series('pwr', { hard: x => x > 2500, soft: (x, m) => x > 1200 && x > 3 * m + 800 }, (n, dt) => dt <= 3);
    return out;
  }

  function summary(fit, ses) {
    if (!ses) return {};
    const g = n => ses.v(n);
    return { dist: g(9) != null ? g(9) / 100 : null, avg: g(14) != null ? g(14) / 1000 * 3.6 : null, max: g(15) != null ? g(15) / 1000 * 3.6 : null,
      elapsed: g(7) != null ? g(7) / 1000 : null, timer: g(8) != null ? g(8) / 1000 : null, asc: g(22), desc: g(23) };
  }

  // ---------- writer: keeps original bytes, patches values, extends definitions if a record lacks lat/lon ----------
  function writeFit(fit, recIndex, newLL, dups, R, ses, laps, valid, ctx, act) {
    const newDist = ctx.newDist;
    const src = fit.bytes, work = src.slice(); const dv = new DataView(work.buffer);
    const put = (fd, le, kind, val) => {
      if (!fd) return false;
      if (kind === 'u8') dv.setUint8(fd.off, val); else if (kind === 'i32') dv.setInt32(fd.off, val, le); else if (kind === 'u32') dv.setUint32(fd.off, val, le); else if (kind === 'u16') dv.setUint16(fd.off, val, le);
      return true;
    };
    const toSc = d => Math.round(d / SC);
    const ext = new Map(); // record msg -> [latSc, lonSc] needing extended def
    for (const [m, i] of recIndex) {
      const ll = newLL[i]; const le = m.def.le;
      const origHas = m.v(0) != null;
      if (ll.lat != null && (!origHas || R[i].lat !== ll.lat || R[i].lon !== ll.lon)) {
        if (m.f[0] && m.f[1] && m.f[0].size === 4 && m.f[1].size === 4) { put(m.f[0], le, 'i32', toSc(ll.lat)); put(m.f[1], le, 'i32', toSc(ll.lon)); }
        else ext.set(m, [toSc(ll.lat), toSc(ll.lon)]);
      } else if (ll.lat == null && origHas && !valid[i]) { // invalid fix not replaced -> write invalid
        put(m.f[0], le, 'i32', 0x7FFFFFFF); put(m.f[1], le, 'i32', 0x7FFFFFFF);
      }
      if (newDist[i] != null && R[i].dist != null && Math.abs(newDist[i] - R[i].dist) > 0.001 && m.f[5] && m.f[5].size === 4) put(m.f[5], le, 'u32', Math.round(newDist[i] * 100));
      if (R[i].hr0 !== undefined && m.f[3] && m.f[3].size === 1) put(m.f[3], le, 'u8', R[i].hr == null ? 0xFF : R[i].hr);
      if (R[i].pwr0 !== undefined && m.f[7] && m.f[7].size === 2) put(m.f[7], le, 'u16', R[i].pwr == null ? 0xFFFF : R[i].pwr);
      if (ctx.phantom[i]) { if (m.f[6] && m.f[6].size === 2) put(m.f[6], le, 'u16', 0); if (m.f[73] && m.f[73].size === 4) put(m.f[73], le, 'u32', 0); }
    }
    // session / laps
    const allLL = newLL.filter(p => p.lat != null);
    // fs: {dist, timer, moving[], avg[], max[]}
    const fix = (m, fs, t0, t1) => {
      if (!m) return; const le = m.def.le, d0 = m.v(fs.dist);
      let nd = d0;
      if (d0 != null) { nd = Math.round(d0 - ctx.deltaIn(t0, t1) * 100); put(m.f[fs.dist], le, 'u32', nd); }
      let tm = m.v(fs.timer);
      const pt = ctx.phantomTimeIn(t0, t1);
      if (tm && pt > 0) { tm = Math.max(0, tm - Math.round(pt * 1000)); put(m.f[fs.timer], le, 'u32', tm); for (const mf of fs.moving) if (m.v(mf) != null) put(m.f[mf], le, 'u32', Math.max(0, m.v(mf) - Math.round(pt * 1000))); }
      if (tm && nd != null) for (const af of fs.avg) if (m.f[af]) { const kind = m.f[af].size === 4 ? 'u32' : 'u16'; put(m.f[af], le, kind, Math.round(nd / 100 / (tm / 1000) * 1000)); }
      if (ctx.anyPhantom) { const mx = Math.round(ctx.maxSpdIn(t0, t1) * 1000); for (const xf of fs.max) if (m.f[xf] && m.v(xf) != null) put(m.f[xf], le, m.f[xf].size === 4 ? 'u32' : 'u16', mx); }
    };
    const sensorAgg = (m, f, t0, t1) => {
      if (!m || !ctx.sensorChanged) return; const le = m.def.le;
      let hs = 0, hn = 0, hm = 0, ps = 0, pn = 0, pm = 0;
      R.forEach((r, i) => { if (ctx.trimmed[i] || r.t <= t0 || r.t > t1) return; if (r.hr != null) { hs += r.hr; hn++; hm = Math.max(hm, r.hr); } if (r.pwr != null) { ps += r.pwr; pn++; pm = Math.max(pm, r.pwr); } });
      const p8 = (n, v) => { if (m.f[n] && m.f[n].size === 1 && m.v(n) != null) put(m.f[n], le, 'u8', Math.min(254, Math.round(v))); };
      const p16 = (n, v) => { if (m.f[n] && m.f[n].size === 2 && m.v(n) != null) put(m.f[n], le, 'u16', Math.min(65534, Math.round(v))); };
      if (ctx.sensorChanged.hr && hn) { p8(f.hrAvg, hs / hn); p8(f.hrMax, hm); }
      if (ctx.sensorChanged.pwr && pn) { p16(f.pAvg, ps / pn); p16(f.pMax, pm); }
    };
    sensorAgg(ses, { hrAvg: 16, hrMax: 17, pAvg: 20, pMax: 21 }, -Infinity, Infinity);
    for (const lp of laps) sensorAgg(lp, { hrAvg: 15, hrMax: 16, pAvg: 19, pMax: 20 }, (lp.v(2) ?? -Infinity) - 1, lp.v(253) ?? Infinity);
    if (ses) {
      fix(ses, { dist: 9, timer: 8, moving: [59], avg: [14, 124], max: [15, 125] }, -Infinity, Infinity);
      if (allLL.length && ses.f[29] && ses.f[32]) {
        const le = ses.def.le;
        put(ses.f[29], le, 'i32', toSc(Math.max(...allLL.map(p => p.lat)))); put(ses.f[30], le, 'i32', toSc(Math.max(...allLL.map(p => p.lon))));
        put(ses.f[31], le, 'i32', toSc(Math.min(...allLL.map(p => p.lat)))); put(ses.f[32], le, 'i32', toSc(Math.min(...allLL.map(p => p.lon))));
      }
    }
    for (const lp of laps) fix(lp, { dist: 9, timer: 8, moving: [52], avg: [13, 110], max: [14, 111] }, (lp.v(2) ?? -Infinity) - 1, lp.v(253) ?? Infinity);
    if (ctx.isTrim) {
      const firstLL = newLL.find(p => p.lat != null);
      for (const m of [ses, ...laps]) {
        if (!m) continue; const le = m.def.le, st = m.v(2), en = m.v(253);
        const ns = Math.max(st ?? ctx.tStart, ctx.tStart), ne = Math.min(en ?? ctx.tEnd, ctx.tEnd);
        if (m.f[2] && st != null) put(m.f[2], le, 'u32', ns);
        if (m.f[7] && m.v(7) != null) put(m.f[7], le, 'u32', Math.max(0, ne - ns) * 1000);
        if (firstLL && m.f[3] && m.f[4] && m.v(3) != null) { put(m.f[3], le, 'i32', toSc(firstLL.lat)); put(m.f[4], le, 'i32', toSc(firstLL.lon)); }
      }
    }
    if (act && act.v(0) != null) { const pt = ctx.phantomTimeIn(-Infinity, Infinity); if (pt > 0) put(act.f[0], act.def.le, 'u32', Math.max(0, act.v(0) - Math.round(pt * 1000))); }
    // stream rebuild
    const dupMsgs = new Set([...recIndex].filter(([m, k]) => dups.has(k) || ctx.trimmed[k]).map(([m]) => m));
    const parts = [work.slice(0, fit.hsize)]; const active = {};
    const extDefs = new Map();
    function extDefFor(d) {
      if (extDefs.has(d)) return extDefs.get(d);
      const f = d.fields.filter(x => x[0] !== 0 && x[0] !== 1);
      const fields = [...f, [0, 4, 0x85], [1, 4, 0x85]];
      const bytes = [0x40 | d.local | (d.hasDev ? 0x20 : 0), 0, d.le ? 0 : 1];
      bytes.push(...(d.le ? [d.g & 0xFF, d.g >> 8] : [d.g >> 8, d.g & 0xFF]), fields.length);
      for (const x of fields) bytes.push(...x);
      if (d.hasDev) { bytes.push(d.dev.length); for (const x of d.dev) bytes.push(...x); }
      const nd = { ...d, fields, bytes: new Uint8Array(bytes), ext: true, dropped: d.fields.filter(x => x[0] === 0 || x[0] === 1) };
      extDefs.set(d, nd); return nd;
    }
    for (const m of fit.msgs) {
      if (m.isDef) { parts.push(work.slice(m.start, m.end)); active[m.def.local] = m.def; continue; }
      if (dupMsgs.has(m)) continue;
      const d = m.def, local = d.local;
      if (ext.has(m)) {
        const ed = extDefFor(d);
        if (active[local] !== ed) { parts.push(ed.bytes); active[local] = ed; }
        const hdr = m.compressed ? new Uint8Array([work[m.start]]) : new Uint8Array([local]);
        // fields without 0/1, then lat, lon, then dev bytes
        const body = []; let q = m.dataStart;
        for (const [num, size] of d.fields) { if (num !== 0 && num !== 1) for (let k = 0; k < size; k++) body.push(work[q + k]); q += size; }
        const ll = new DataView(new ArrayBuffer(8)); ll.setInt32(0, ext.get(m)[0], d.le); ll.setInt32(4, ext.get(m)[1], d.le);
        for (let k = 0; k < 8; k++) body.push(ll.getUint8(k));
        for (let k = m.dataStart + d.fsize; k < m.end; k++) body.push(work[k]);
        parts.push(hdr, new Uint8Array(body));
      } else {
        if (active[local] !== d) { parts.push(d.bytes); active[local] = d; }
        parts.push(work.slice(m.start, m.end));
      }
    }
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len + 2); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    const odv = new DataView(out.buffer); odv.setUint32(4, len - fit.hsize, true);
    if (fit.hsize >= 14) odv.setUint16(12, crc16(out, 0, 12), true);
    odv.setUint16(len, crc16(out, 0, len), true);
    return out;
  }

  const VFhms = s => s == null ? '—' : `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  // ---------- verification ----------
  function verify(fit, fit2, R, R2, dups, recIndex, phantom, trimmed) {
    const gone = new Set([...dups, ...R.map((r, i) => i).filter(i => trimmed[i])]);
    const res = []; const ok = (name, pass, detail) => res.push({ name, pass, detail });
    ok('Структура FIT: контрольные суммы и разбор до конца файла', fit2.crcOk && fit2.end + 2 === fit2.bytes.length, `CRC ${fit2.crcOk ? 'верна' : 'НЕВЕРНА'}, ${fit2.msgs.filter(m => !m.isDef).length} сообщений`);
    const keepR = R.filter((r, i) => !gone.has(i));
    ok('Количество записей', R2.length === keepR.length, `${R2.length} (исходно ${R.length}; удалено дублей ${dups.size}${gone.size > dups.size ? ', обрезано ' + (gone.size - dups.size) : ''})`);
    const sensorFields = [2, 3, 4, 6, 7, 13, 73, 78, 253];
    const recs1 = fit.msgs.filter(m => !m.isDef && m.g === 20).filter((m, i) => !gone.has(i)), recs2 = fit2.msgs.filter(m => !m.isDef && m.g === 20);
    let mism = 0, devMism = 0; const keptR = R.filter((r, i) => !gone.has(i)); const phantomKept = R.map((r, i) => i).filter(i => !gone.has(i)).map(i => phantom[i]);
    for (let i = 0; i < Math.min(recs1.length, recs2.length); i++) {
      for (const n of sensorFields) { if ((n === 6 || n === 73) && phantomKept[i]) continue; if ((n === 3 && keptR[i].hr0 !== undefined) || (n === 7 && keptR[i].pwr0 !== undefined)) continue; if (recs1[i].v(n) !== recs2[i].v(n)) mism++; }
      const a = recs1[i], b = recs2[i], la = a.end - a.dataStart - a.def.fsize, lb = b.end - b.dataStart - b.def.fsize;
      if (la !== lb) devMism++; else for (let k = 0; k < la; k++) if (fit.bytes[a.dataStart + a.def.fsize + k] !== fit2.bytes[b.dataStart + b.def.fsize + k]) { devMism++; break; }
    }
    const nS = keptR.filter(r => r.hr0 !== undefined || r.pwr0 !== undefined).length;
    ok('Показания датчиков не изменены (пульс, каденс, мощность, скорость, высота, температура, время, dev-поля)' + (nS ? ', кроме исправленных выбросов' : ''), mism === 0 && devMism === 0, `расхождений: ${mism}, в dev-полях: ${devMism}` + (nS ? `; выбросов пульса/мощности исправлено: ${nS}` : ''));
    let mono = true; for (let i = 1; i < R2.length; i++) if (R2[i].t <= R2[i - 1].t) mono = false;
    ok('Время строго возрастает, дублей нет', mono, '');
    let neg = 0; for (let i = 1; i < R2.length; i++) if (R2[i].dist != null && R2[i - 1].dist != null && R2[i].dist < R2[i - 1].dist) neg++;
    ok('Нет отрицательных приращений дистанции', neg === 0, `${neg}`);
    let tele = 0; for (let i = 1; i < R2.length; i++) { const a = R2[i - 1], b = R2[i]; if (a.lat == null || b.lat == null) continue; const g = hav(a.lat, a.lon, b.lat, b.lon); const dd = (b.dist ?? 0) - (a.dist ?? 0); const dt = b.t - a.t; if (g > 100 && g > 3 * Math.max(1, dd) + 2.5 * Math.max(0, dt - 1)) tele++; }
    ok('Нет GPS-телепортаций (шаг > 100 м, больше пройденного по датчику и пешком на паузе)', tele === 0, `${tele}`);
    let glen = 0, olen = 0; for (let i = 1; i < R2.length; i++) if (R2[i].lat != null && R2[i - 1].lat != null && R2[i].t - R2[i - 1].t <= 5) { glen += hav(R2[i - 1].lat, R2[i - 1].lon, R2[i].lat, R2[i].lon); olen += Math.max(0, (R2[i].dist ?? 0) - (R2[i - 1].dist ?? 0)); }
    const last = R2[R2.length - 1].dist;
    if (olen > 1000) ok('Длина GPS-трека согласована с одометром на участках с GPS (0,93–1,05)', glen / olen > 0.93 && glen / olen < 1.05, `${(glen / 1000).toFixed(2)} км по GPS против ${(olen / 1000).toFixed(2)} км по одометру (${(glen / olen).toFixed(3)})`);
    const s1 = fit.msgs.find(m => !m.isDef && m.g === 18), s2 = fit2.msgs.find(m => !m.isDef && m.g === 18);
    if (s1 && s2) {
      const dT = Math.round((s1.v(8) - s2.v(8)) / 1000);
      const trimmedAny = gone.size > dups.size;
      ok(trimmedAny ? 'Время пересчитано по обрезке' : 'Общее время не изменено' + (dT ? '; время движения уменьшено только на фантомное движение' : ''), (trimmedAny || s1.v(7) === s2.v(7)) && dT >= 0, `${VFhms(s2.v(7) / 1000)}; время движения ${VFhms(s1.v(8) / 1000)} → ${VFhms(s2.v(8) / 1000)}`);
      const mx = (s2.v(15) ?? 0) / 1000 * 3.6;
      ok('Максимальная скорость физически возможна для велосипеда (≤ 100 км/ч)', mx <= 100, `${mx.toFixed(1)} км/ч`);
      if (last && s2.v(9) != null) ok('Итог session совпадает с одометром последней записи', Math.abs(s2.v(9) / 100 - last) < 0.05, `${(s2.v(9) / 100000).toFixed(2)} км`);
    }
    const nogps = R2.filter(r => r.lat == null).length;
    res.push({ name: 'Записи без координат', pass: nogps === 0, info: nogps > 0, detail: nogps ? `${nogps} — участки, которые нечем достоверно заполнить (добавьте GPX маршрута, чтобы их восстановить)` : 'нет' });
    return { list: res, glen };
  }

  // ---------- output builders ----------
  const iso = (t) => new Date((t + FIT_EPOCH) * 1000).toISOString().replace('.000Z', 'Z');
  function toGpx(res) {
    const { R, newLL, fills, dups } = res; const D = new Set(dups);
    const L = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="VELO FIX" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd">',
      `<metadata><name>Восстановленная тренировка</name><time>${iso(R[0].t)}</time></metadata>`, '<trk><name>Восстановленная тренировка</name><type>cycling</type><trkseg>'];
    R.forEach((r, i) => {
      if (D.has(i) || newLL[i].lat == null) return;
      let s = `<trkpt lat="${newLL[i].lat.toFixed(7)}" lon="${newLL[i].lon.toFixed(7)}">`;
      if (r.alt != null) s += `<ele>${r.alt.toFixed(1)}</ele>`;
      s += `<time>${iso(r.t)}</time>`;
      if (fills[i]) s += `<src>restored:${fills[i].src.replace(/[<&>]/g, '')}</src>`;
      let tpx = ''; if (r.temp != null) tpx += `<gpxtpx:atemp>${r.temp}</gpxtpx:atemp>`; if (r.hr != null) tpx += `<gpxtpx:hr>${r.hr}</gpxtpx:hr>`; if (r.cad != null) tpx += `<gpxtpx:cad>${r.cad}</gpxtpx:cad>`;
      let ext = r.pwr != null ? `<power>${r.pwr}</power>` : ''; if (tpx) ext += `<gpxtpx:TrackPointExtension>${tpx}</gpxtpx:TrackPointExtension>`;
      if (ext) s += `<extensions>${ext}</extensions>`;
      L.push(s + '</trkpt>');
    });
    L.push('</trkseg></trk></gpx>'); return L.join('\n');
  }
  function toTcx(res) {
    const { R, newLL, dups, trimmed, finalDist, newSpd, after } = res; const D = new Set(dups);
    const keep = R.map((r, i) => !D.has(i) && !(trimmed && trimmed[i]));
    const first = keep.indexOf(true); const t0 = R[first].t;
    const L = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      '<Activities><Activity Sport="Biking">', `<Id>${iso(t0)}</Id>`, `<Lap StartTime="${iso(t0)}">`,
      `<TotalTimeSeconds>${(after.timer ?? 0).toFixed(1)}</TotalTimeSeconds>`, `<DistanceMeters>${(after.dist ?? 0).toFixed(1)}</DistanceMeters>`,
      after.max != null ? `<MaximumSpeed>${(after.max / 3.6).toFixed(3)}</MaximumSpeed>` : '', '<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>'];
    R.forEach((r, i) => {
      if (!keep[i]) return; let s = `<Trackpoint><Time>${iso(r.t)}</Time>`;
      if (newLL[i].lat != null) s += `<Position><LatitudeDegrees>${newLL[i].lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${newLL[i].lon.toFixed(7)}</LongitudeDegrees></Position>`;
      if (r.alt != null) s += `<AltitudeMeters>${r.alt.toFixed(1)}</AltitudeMeters>`;
      if (finalDist[i] != null) s += `<DistanceMeters>${finalDist[i].toFixed(2)}</DistanceMeters>`;
      if (r.hr != null) s += `<HeartRateBpm><Value>${r.hr}</Value></HeartRateBpm>`;
      if (r.cad != null) s += `<Cadence>${Math.min(254, r.cad)}</Cadence>`;
      let x = ''; if (newSpd[i] != null) x += `<ns3:Speed>${newSpd[i].toFixed(3)}</ns3:Speed>`; if (r.pwr != null) x += `<ns3:Watts>${r.pwr}</ns3:Watts>`;
      if (x) s += `<Extensions><ns3:TPX>${x}</ns3:TPX></Extensions>`;
      L.push(s + '</Trackpoint>');
    });
    L.push('</Track></Lap>', '<Creator xsi:type="Device_t"><Name>VELO FIX</Name><UnitId>0</UnitId><ProductID>0</ProductID><Version><VersionMajor>2</VersionMajor><VersionMinor>2</VersionMinor></Version></Creator>', '</Activity></Activities></TrainingCenterDatabase>');
    return L.filter(Boolean).join('\n');
  }
  function toCsv(res) {
    const { R, newLL, fills, badReason, newDist, jumps, dups, tzOff } = res; const D = new Set(dups);
    const jumpAt = new Map(jumps.map(j => [j.i, j])); const firstJ = jumps.length ? jumps[0].i : Infinity;
    const q = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['record_idx', 'time_utc', 'time_local', 'orig_lat', 'orig_lon', 'new_lat', 'new_lon', 'orig_distance_m', 'new_distance_m', 'change', 'reason', 'gps_source', 'confidence'].join(';')];
    const loc = t => new Date((t + FIT_EPOCH + tzOff) * 1000).toISOString().slice(11, 19);
    R.forEach((r, i) => {
      const ch = [], why = [];
      if (D.has(i)) { ch.push('deleted'); why.push('побайтовый дубликат предыдущей записи'); }
      if (fills[i]) { ch.push('coords'); why.push(badReason[i] ? 'недостоверный фикс: ' + badReason[i] : 'нет GPS-фикса'); }
      else if (badReason[i]) { ch.push('coords-removed'); why.push('недостоверный фикс удалён, восстановить нельзя: ' + badReason[i]); }
      if (res.phantom[i]) { ch.push('speed'); why.push(`скорость ${(r.spd * 3.6).toFixed(1)} км/ч → 0: фантомное движение (вы стояли, GPS «ехал»)`); }
      if (r.hr0 !== undefined) { ch.push('hr'); why.push(`выброс пульса ${r.hr0} → ${r.hr ?? 'нет'}`); }
      if (r.pwr0 !== undefined) { ch.push('power'); why.push(`выброс мощности ${r.pwr0} Вт → ${r.pwr ?? 'нет'}`); }
      if (r.dist != null && newDist[i] != null && Math.abs(r.dist - newDist[i]) > 0.001) { ch.push('distance'); const j = jumpAt.get(i); why.push(j ? `ложный скачок одометра +${j.orig.toFixed(0)} м заменён на ${j.repl} м` : 'накопленная дистанция без ложных километров'); }
      if (!ch.length) return;
      const f = fills[i];
      rows.push([i, iso(r.t), loc(r.t), r.lat?.toFixed(7), r.lon?.toFixed(7), newLL[i].lat?.toFixed(7), newLL[i].lon?.toFixed(7), r.dist?.toFixed(2), newDist[i]?.toFixed(2),
        ch.join('+'), why.join('; '), f ? f.src : (ch.includes('distance') || ch.includes('speed') ? 'датчик скорости / анализ' : ''), f ? f.conf : (ch.includes('distance') || ch.includes('speed') ? 'высокая' : '')].map(q).join(';'));
    });
    return '﻿' + rows.join('\r\n');
  }
  const hms = s => s == null ? '—' : `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  function toReport(res, fitName) {
    const { before: b, after: a, runs, unfilled, jumps, dups, badReason, checks, log, warn, tzOff, R, R2 } = res;
    const loc = t => new Date((t + FIT_EPOCH + tzOff) * 1000).toISOString().slice(11, 19);
    const tz = `UTC${tzOff >= 0 ? '+' : '−'}${Math.abs(tzOff / 3600)}`;
    const L = [`# Отчёт о восстановлении тренировки`, '', `Исходный файл: **${fitName}**. Время в отчёте — местное (${tz}, по данным устройства).`, '',
      '## Итог', '', '| Показатель | До | После |', '|---|---|---|',
      `| Дистанция | ${b.dist != null ? (b.dist / 1000).toFixed(2) + ' км' : '—'} | ${a.dist != null ? (a.dist / 1000).toFixed(2) + ' км' : '—'} |`,
      `| Средняя скорость | ${b.avg?.toFixed(2) ?? '—'} км/ч | ${a.avg?.toFixed(2) ?? '—'} км/ч |`,
      `| Макс. скорость | ${b.max?.toFixed(1) ?? '—'} км/ч | ${a.max?.toFixed(1) ?? '—'} км/ч |`,
      `| Общее время | ${hms(b.elapsed)} | ${hms(a.elapsed)} |`, `| Время движения | ${hms(b.timer)} | ${hms(a.timer)} |`,
      `| Набор высоты | ${b.asc ?? '—'} м | ${a.asc ?? '—'} м |`,
      `| Записи без координат | ${R.filter(r => r.lat == null).length} | ${R2.filter(r => r.lat == null).length} |`,
      `| Записи | ${R.length} | ${R2.length} |`, '', '## Найденные проблемы и исправления', ''];
    if (!jumps.length && !runs.length && !dups.length && !Object.keys(badReason).length && !res.phantomBlocks.length && !res.sensorFix.hr.length && !res.sensorFix.pwr.length) L.push('Проблем не найдено.');
    for (const j of jumps) L.push(`- **Ложный скачок одометра** ${loc(j.t0)}–${loc(j.t1)}${j.paused ? ' (во время паузы)' : ''}: +${j.orig.toFixed(0)} м, по датчику скорости ${j.repl} м. Исправлено.`);
    if (dups.length) L.push(`- **Дубликаты записей:** ${dups.length} (побайтово идентичны предыдущей записи) — удалены.`);
    for (const p of res.phantomBlocks) L.push(`- **Фантомное движение** ${loc(p.t0)}–${loc(p.t1)}: GPS показывал до ${Math.round(p.maxV)} км/ч без педалирования, высота менялась всего на ${p.altRange?.toFixed(1)} м — вы стояли, а приёмник «уехал» (дрейф или подмена GPS). Убрано ${(p.odo / 1000).toFixed(2)} км, скорость обнулена, координаты удалены.`);
    for (const s of res.sensorFix.hr) L.push(`- **Выброс пульса** ${loc(s.t0)}${s.t1 > s.t0 ? '–' + loc(s.t1) : ''}: до ${s.max} уд/мин — помеха датчика, заменено плавным переходом (${s.n} зап.).`);
    for (const s of res.sensorFix.pwr) L.push(`- **Выброс мощности** ${loc(s.t0)}${s.t1 > s.t0 ? '–' + loc(s.t1) : ''}: ${s.max} Вт — сбой измерителя, заменено плавным переходом (${s.n} зап.).`);
    if (res.phantomTimer) L.push(`- Время движения уменьшено на ${hms(res.phantomTimer)}: устройство считало фантомный участок ездой.`);
    const nb = Object.keys(badReason).length; if (nb) L.push(`- **Недостоверные GPS-точки:** ${nb} — удалены или заменены (причины по каждой точке — в CSV).`);
    if (runs.length) {
      L.push('', '### Восстановленные участки', '', '| Время | Записей | Источник | Эталон / датчик | Стык | Метод | Уверенность |', '|---|---|---|---|---|---|---|');
      for (const r of runs) L.push(`| ${loc(r.t0)}–${loc(r.t1)} | ${r.n} | ${r.srcs.join(' → ')} | ${Math.round(r.len)} / ${r.sensLen != null ? Math.round(r.sensLen) : '—'} м | ${Math.round(r.dA)} / ${Math.round(r.dB)} м | ${r.method} | ${r.conf} |`);
    }
    if (unfilled.length) { L.push('', '### Не восстановлено', ''); for (const u of unfilled) L.push(`- ${u.t0 != null ? loc(u.t0) + '–' + loc(u.t1) : 'записи ' + u.a + '–' + u.b}, ${u.n} записей: ${u.why}. Координаты оставлены пустыми, данные датчиков сохранены.`); }
    L.push('', '## Проверки', '', '| Проверка | Результат |', '|---|---|');
    for (const c of checks.list) L.push(`| ${c.name} | ${c.pass ? '✅' : (c.info ? 'ℹ️' : '⚠️')} ${c.detail} |`);
    L.push('', '## Входные файлы', ''); for (const l of log) L.push('- ' + l); for (const w of warn) L.push('- ⚠️ ' + w);
    L.push('', '## Ограничения', '', '- Координаты на восстановленных участках вычислены, а не измерены: форма дороги взята из эталонных GPX, положение в каждую секунду — по датчику скорости. Погрешность — десятки метров.',
      '- Время, пульс, каденс, мощность, высота и прочие датчики не изменяются. Исключение — скорость на фантомных участках: там её записывал GPS, а не датчик колеса.', '- Импорт в Garmin Connect/Strava программа проверить не может; структура FIT сохраняется исходной.');
    return L.join('\n');
  }

  // ---------- tiny ZIP (store) ----------
  const CRC32T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC32T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) { // [{name, data:Uint8Array}]
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)), dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate());
    for (const f of files) {
      const nm = enc.encode(f.name), c = crc32(f.data), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, c, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(h.buffer), nm, f.data);
      const cd = new DataView(new ArrayBuffer(46)); cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(12, dt, true); cd.setUint16(14, dd, true);
      cd.setUint32(16, c, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true); cd.setUint16(28, nm.length, true); cd.setUint32(42, off, true);
      central.push(new Uint8Array(cd.buffer), nm); off += 30 + nm.length + f.data.length;
    }
    let csz = 0; for (const c of central) csz += c.length;
    const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csz, true); e.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(e.buffer)]; let n = 0; for (const a of all) n += a.length;
    const out = new Uint8Array(n); let o = 0; for (const a of all) { out.set(a, o); o += a.length; } return out;
  }


  // ---------- merge several FIT files of one ride into one (records/events of later files appended) ----------
  function merge(list) { // list: Uint8Array[]
    const F = list.map(parseFit).map(f => ({ f, recs: f.msgs.filter(m => !m.isDef && m.g === 20) }))
      .filter(x => x.recs.length).sort((a, b) => (a.recs[0].v(253) ?? 0) - (b.recs[0].v(253) ?? 0));
    if (F.length < 2) throw new Error('Для склейки нужно минимум два FIT-файла с записями');
    for (const x of F) if (x.f.msgs.some(m => m.compressed)) throw new Error('Файл со сжатыми метками времени склеивать не умею');
    const A = F[0], bytes = A.f.bytes;
    const tailIdx = A.f.msgs.findIndex(m => !m.isDef && (m.g === 19 || m.g === 18 || m.g === 34));
    const head = tailIdx < 0 ? A.f.msgs : A.f.msgs.slice(0, tailIdx), tail = tailIdx < 0 ? [] : A.f.msgs.slice(tailIdx);
    const parts = [bytes.slice(0, A.f.hsize)]; const active = {};
    const pushMsg = (src, m) => { parts.push(src.slice(m.start, m.end)); };
    for (const m of head) { pushMsg(bytes, m); if (m.isDef) active[m.def.local] = m.def; }
    let distOff = A.recs[A.recs.length - 1].v(5) ?? 0, lastT = A.recs[A.recs.length - 1].v(253);
    const totals = { timer: 0, elapsed: 0, dist: 0, asc: 0, desc: 0, cal: 0, maxSpd: 0, maxHr: 0, hrW: 0, hrT: 0 };
    const addSes = f => { const s = f.msgs.find(m => !m.isDef && m.g === 18); if (!s) return;
      totals.timer += s.v(8) ?? 0; totals.asc += s.v(22) ?? 0; totals.desc += s.v(23) ?? 0; totals.cal += s.v(11) ?? 0;
      totals.maxSpd = Math.max(totals.maxSpd, s.v(15) ?? 0); totals.maxHr = Math.max(totals.maxHr, s.v(17) ?? 0);
      if (s.v(16) != null && s.v(8)) { totals.hrW += s.v(16) * s.v(8); totals.hrT += s.v(8); } };
    addSes(A.f);
    for (const B of F.slice(1)) {
      addSes(B.f); const bb = B.f.bytes; let lastDist = 0;
      for (const m of B.f.msgs) {
        if (m.isDef) { if (m.def.g === 20 || m.def.g === 21) { parts.push(bb.slice(m.start, m.end)); active[m.def.local] = m.def; } continue; }
        if (m.g !== 20 && m.g !== 21) continue;
        const t = m.v(253); if (t != null && t <= lastT) continue;
        if (active[m.def.local] !== m.def) { parts.push(m.def.bytes); active[m.def.local] = m.def; }
        const c = bb.slice(m.start, m.end);
        if (m.g === 20 && m.f[5] && m.v(5) != null && m.f[5].size === 4) { const v = m.v(5) + distOff; new DataView(c.buffer).setUint32(m.f[5].off - m.start, v, m.def.le); lastDist = v; }
        parts.push(c); if (t != null) lastT = t;
      }
      if (lastDist) distOff = lastDist;
    }
    // tail of A (laps, session, activity) with merged totals
    const firstT = A.recs[0].v(253);
    for (const m of tail) {
      if (m.isDef) { parts.push(bytes.slice(m.start, m.end)); active[m.def.local] = m.def; continue; }
      if (active[m.def.local] !== m.def) { parts.push(m.def.bytes); active[m.def.local] = m.def; }
      const c = bytes.slice(m.start, m.end), dv = new DataView(c.buffer), le = m.def.le, off = n => m.f[n] && m.f[n].off - m.start;
      const put32 = (n, v) => { if (m.f[n] && m.f[n].size === 4 && m.v(n) != null) dv.setUint32(off(n), Math.max(0, Math.round(v)), le); };
      const put16 = (n, v) => { if (m.f[n] && m.f[n].size === 2 && m.v(n) != null) dv.setUint16(off(n), Math.max(0, Math.min(65534, Math.round(v))), le); };
      const put8 = (n, v) => { if (m.f[n] && m.f[n].size === 1 && m.v(n) != null) dv.setUint8(off(n), Math.max(0, Math.min(254, Math.round(v)))); };
      if (m.g === 18 || m.g === 19) {
        const df = 9, tf = 8, el = 7; const elapsed = (lastT - firstT + 1) * 1000;
        if (m.f[253]) put32(253, lastT);
        put32(df, distOff); put32(tf, totals.timer); put32(el, elapsed);
        const avg = totals.timer ? distOff / 100 / (totals.timer / 1000) * 1000 : 0;
        if (m.g === 18) { put16(14, avg); put32(124, avg); put16(15, totals.maxSpd); put32(125, totals.maxSpd); put16(22, totals.asc); put16(23, totals.desc); put16(11, totals.cal); put8(17, totals.maxHr); if (totals.hrT) put8(16, totals.hrW / totals.hrT); put32(59, totals.timer); }
        else { put16(13, avg); put32(110, avg); put16(14, totals.maxSpd); put32(111, totals.maxSpd); put16(21, totals.asc); put16(22, totals.desc); put16(11, totals.cal); put8(16, totals.maxHr); if (totals.hrT) put8(15, totals.hrW / totals.hrT); put32(52, totals.timer); }
      }
      if (m.g === 34) { const t0 = m.v(253); if (m.v(5) != null && t0 != null) put32(5, m.v(5) + (lastT - t0)); put32(253, lastT); put32(0, totals.timer); }
      parts.push(c);
    }
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len + 2); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    const odv = new DataView(out.buffer); odv.setUint32(4, len - A.f.hsize, true);
    if (A.f.hsize >= 14) odv.setUint16(12, crc16(out, 0, 12), true);
    odv.setUint16(len, crc16(out, 0, len), true);
    return out;
  }

  return { merge, parseFit, parseGpx, run, toGpx, toTcx, toCsv, toReport, zip, hav, FIT_EPOCH, SC, hms };
})();
if (typeof module !== 'undefined') module.exports = VF;
