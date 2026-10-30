/* VELO FIX — генератор синтетических FIT для автотестов (общий для тестов ядра и интерфейса). */
// ---------- генератор FIT ----------
const CT = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
function crc16(b, s, e) { let c = 0; for (let i = s; i < e; i++) { let t = CT[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ CT[b[i] & 0xF]; t = CT[c & 0xF]; c = (c >> 4) & 0x0FFF; c = c ^ t ^ CT[(b[i] >> 4) & 0xF]; } return c; }
const T0 = 1100000000; // время FIT (сек от 1989-12-31)
const LAT0 = 55.75, LON0 = 37.62, SC = 180 / 2 ** 31;

/**
 * recs: [{t, lat, lon, dist(м), spd(м/с), hr, cad}] — null = поле не записано (invalid).
 * opt.compressed: записи без поля 253 со сжатым заголовком времени.
 * opt.extra: функция(body helpers) для добавления своих сообщений.
 */
function mkFit(recs, opt = {}) {
  const body = [];
  const u8 = v => body.push(v & 255), u16 = v => { u8(v); u8(v >> 8); }, u32 = v => { u16(v & 0xFFFF); u16(Math.floor(v / 65536) & 0xFFFF); };
  const i32 = v => u32(v < 0 ? v + 4294967296 : v);
  const def = (local, g, fields) => { u8(0x40 | local); u8(0); u8(0); u16(g); u8(fields.length); for (const f of fields) { u8(f[0]); u8(f[1]); u8(f[2]); } };
  def(0, 0, [[0, 1, 0x00], [4, 4, 0x86]]); u8(0); u8(4); u32(recs[0].t);
  def(2, 21, [[253, 4, 0x86], [0, 1, 0x00], [1, 1, 0x00]]); u8(2); u32(recs[0].t); u8(0); u8(0);
  const recFields = [[0, 4, 0x85], [1, 4, 0x85], [5, 4, 0x86], [6, 2, 0x84], [3, 1, 0x02], [4, 1, 0x02]];
  def(1, 20, opt.compressed ? recFields : [[253, 4, 0x86], ...recFields]);
  for (const r of recs) {
    if (opt.compressed) u8(0x80 | (1 << 5) | (r.t & 0x1F)); else { u8(1); u32(r.t); }
    if (r.lat == null) { u32(0x7FFFFFFF); u32(0x7FFFFFFF); } else { i32(Math.round(r.lat / SC)); i32(Math.round(r.lon / SC)); }
    u32(r.dist == null ? 0xFFFFFFFF : Math.round(r.dist * 100));
    u16(r.spd == null ? 0xFFFF : Math.round(r.spd * 1000));
    u8(r.hr == null ? 0xFF : r.hr); u8(r.cad == null ? 0xFF : r.cad);
  }
  if (opt.extra) opt.extra({ u8, u16, u32, def });
  const last = recs[recs.length - 1], dist = recs.reduce((m, r) => r.dist != null ? r.dist : m, 0);
  u8(2); u32(last.t); u8(0); u8(4);
  def(3, 18, [[253, 4, 0x86], [2, 4, 0x86], [7, 4, 0x86], [8, 4, 0x86], [9, 4, 0x86], [14, 2, 0x84], [15, 2, 0x84]]);
  const el = last.t - recs[0].t, mx = recs.reduce((m, r) => Math.max(m, r.spd ?? 0), 0);
  u8(3); u32(last.t); u32(recs[0].t); u32(el * 1000); u32(el * 1000); u32(Math.round(dist * 100)); u16(Math.round(dist / Math.max(1, el) * 1000)); u16(Math.min(65534, Math.round(mx * 1000)));
  const out = new Uint8Array(14 + body.length + 2), dv = new DataView(out.buffer);
  out[0] = 14; out[1] = 0x20; dv.setUint16(2, 2132, true); dv.setUint32(4, body.length, true); out.set([46, 70, 73, 84], 8);
  dv.setUint16(12, crc16(out, 0, 12), true); out.set(body, 14); dv.setUint16(14 + body.length, crc16(out, 0, 14 + body.length), true);
  return out;
}

// ровная езда на север 7 м/с, запись раз в секунду
function ride(n, f) {
  const recs = []; let dist = 0;
  for (let i = 0; i < n; i++) {
    const r = { t: T0 + i, lat: LAT0 + dist / 111195, lon: LON0, dist, spd: 7, hr: 140, cad: 85 };
    if (f) f(r, i);
    recs.push(r); dist += 7;
  }
  return recs;
}
