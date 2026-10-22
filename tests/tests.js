/* VELO FIX — автотесты ядра. Запуск: python tests/run.py (Chrome без окна, Node не нужен). */
'use strict';
const T = { pass: 0, fail: 0, lines: [] };
function ok(name, cond, detail = '') {
  if (cond) T.pass++; else T.fail++;
  T.lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function test(name, fn) {
  try { fn(); } catch (e) { T.fail++; T.lines.push(`FAIL  ${name}  — исключение: ${e && e.message}`); }
}

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
const failed = res => res.checks.list.filter(c => !c.pass && !c.info).map(c => c.name);

// ---------- тесты ----------
test('Чистый заезд: без изменений и все проверки проходят', () => {
  const res = VF.run(mkFit(ride(600)), []);
  ok('Чистый заезд: CRC результата верна', res.fit2.crcOk);
  ok('Чистый заезд: все самопроверки пройдены', failed(res).length === 0, failed(res).join('; '));
  ok('Чистый заезд: фантомов и скачков нет', res.phantomBlocks.length === 0 && res.jumps.length === 0);
});

test('Фантомное движение 120 км/ч без педалей обнуляется', () => {
  const recs = ride(600, (r, i) => { if (i >= 300 && i < 330) { r.spd = 33.4; r.cad = 0; } });
  let d = 0; for (let i = 0; i < recs.length; i++) { recs[i].dist = d; d += (i >= 300 && i < 330) ? 33.4 : 7; }
  const res = VF.run(mkFit(recs), []);
  ok('Фантом найден', res.phantomBlocks.length === 1, `блоков: ${res.phantomBlocks.length}`);
  ok('Фантом: макс. скорость после исправления ≤ 100 км/ч', (res.after.max ?? 0) <= 100, `${(res.after.max ?? 0).toFixed(1)} км/ч`);
  ok('Фантом: самопроверки пройдены', failed(res).length === 0, failed(res).join('; '));
});

test('Скачок одометра +12 км заменяется показанием датчика', () => {
  const recs = ride(600); for (let i = 400; i < 600; i++) recs[i].dist += 12000;
  const res = VF.run(mkFit(recs), []);
  ok('Скачок найден', res.jumps.length === 1, `скачков: ${res.jumps.length}`);
  ok('Итоговая дистанция ≈ 4,2 км', Math.abs(res.after.dist - 599 * 7) < 50, `${res.after.dist} м`);
});

test('Одиночные записи без дистанции не отключают исправление одометра (п.2)', () => {
  const recs = ride(600); for (let i = 400; i < 600; i++) recs[i].dist += 12000;
  recs[100].dist = null; recs[250].dist = null;
  const res = VF.run(mkFit(recs), []);
  ok('hasDist остаётся включённым', res.hasDist === true);
  ok('Скачок всё равно исправлен', res.jumps.length === 1 && Math.abs(res.after.dist - 599 * 7) < 50, `${res.after.dist} м`);
  ok('Пустые записи не получили выдуманную дистанцию', res.R2[100].dist == null && res.R2[250].dist == null);
});

test('Сжатые заголовки времени до первой полной метки (п.3)', () => {
  const recs = ride(200);
  const res = VF.run(mkFit(recs, { compressed: true }), []);
  const dt = res.R[0].t - T0;
  ok('Время первой записи берётся из file_id', Math.abs(dt) < 32, `смещение ${dt} с`);
  ok('Время монотонно растёт', res.R.every((r, i) => !i || r.t > res.R[i - 1].t));
});

test('64-битные поля читаются (п.7)', () => {
  const fit = mkFit(ride(50), { extra: ({ u8, u32, def }) => {
    def(4, 65280, [[0, 8, 0x8F], [1, 8, 0x8E], [2, 8, 0x8F]]); u8(4);
    u32(123456789); u32(0);                 // u64 = 123456789
    u32(0xFFFFFFF6); u32(0xFFFFFFFF);       // i64 = -10
    u32(0xFFFFFFFF); u32(0xFFFFFFFF);       // u64 invalid
  } });
  const p = VF.parseFit(fit), m = p.msgs.find(x => !x.isDef && x.g === 65280);
  ok('uint64', m && m.v(0) === 123456789, String(m && m.v(0)));
  ok('sint64 отрицательное', m && m.v(1) === -10, String(m && m.v(1)));
  ok('uint64 invalid → null', m && m.v(2) === null, String(m && m.v(2)));
});

test('Длинный трек 160 000 точек не падает (п.1)', () => {
  const res = VF.run(mkFit(ride(160000)), []);
  ok('Длинный трек обработан, CRC верна', res.fit2.crcOk && res.R2.length === 160000);
  ok('Минимум и максимум без переполнения стека', VF.amax(res.R.map(r => r.lat)) > LAT0 && Math.abs(VF.amin(res.R.map(r => r.lat)) - LAT0) < 1e-6);
});

test('Склейка двух файлов', () => {
  const a = mkFit(ride(300)), b = mkFit(ride(300, (r, i) => { r.t += 400; r.dist += 2100; }));
  const res = VF.run(VF.merge([a, b]), []);
  ok('Склейка: записей 600, CRC верна', res.R.length === 600 && res.fit2.crcOk, `${res.R.length}`);
});

// реальные файлы (tests/fixtures/*.fit, в репозиторий не попадают): только «не падает и самопроверки»
for (const [name, b64] of Object.entries(window.FIXTURES || {})) {
  test('Реальный файл ' + name, () => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const res = VF.run(bytes, []);
    ok(`${name}: обработан, CRC верна`, res.fit2.crcOk, `${res.N} записей`);
    ok(`${name}: самопроверки`, failed(res).length === 0, failed(res).join('; '));
  });
}

document.getElementById('out').textContent = T.lines.join('\n') + `\n\nИТОГО: ${T.pass} пройдено, ${T.fail} провалено\n`;
