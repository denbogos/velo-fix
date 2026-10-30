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

// генератор FIT (mkFit, ride, T0, LAT0, LON0) — tests/fitgen.js

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

// ---------- «готово для Strava» ----------
test('Проверка для Strava: чистый заезд без замечаний', () => {
  const r = VF.stravaCheck(VF.run(mkFit(ride(600)), []));
  ok('Чистый заезд: замечаний нет', r.length === 0, r.map(x => x.type).join(','));
});
// нарисованная линия, уложенная в слишком мало записей (так сломался реальный файл 29.10)
const squeezed = k => { const recs = ride(600), A = recs[100], B = recs[200], L = 700 * k;
  // «треугольник» A → P → B длиной L: A и B в 700 м друг от друга по меридиану, P сбоку
  const h = Math.sqrt((L / 2) ** 2 - 350 ** 2) / (111320 * Math.cos(A.lat * Math.PI / 180)), P = { lat: (A.lat + B.lat) / 2, lon: A.lon + h };
  const pts = []; for (let s = 0; s <= 40; s++) { const u = s / 40, [p, q, v] = u <= 0.5 ? [A, P, u * 2] : [P, B, u * 2 - 1]; pts.push({ lat: p.lat + v * (q.lat - p.lat), lon: p.lon + v * (q.lon - p.lon) }); }
  return VF.stravaCheck(VF.run(mkFit(recs), [], { edits: [{ type: 'route', t0: A.t, t1: B.t, pts, src: 'нарисовано вручную' }] })); };
test('Проверка для Strava: линия сжата в 4 раза', () => {
  const r = squeezed(4), f = r.find(x => x.type === 'fast');
  ok('Сжатие ×4: найден «трек летит» на участке 100–200', f && f.a >= 95 && f.b <= 205 && f.vmax > 70, JSON.stringify(r.map(x => [x.type, x.a, x.b, x.vmax])));
});
test('Проверка для Strava: линия сжата в 2 раза (50 км/ч — по скорости не видно)', () => {
  const r = squeezed(2), s = r.find(x => x.type === 'squeeze');
  ok('Сжатие ×2: найдено «сжатие»', s && s.a >= 95 && s.b <= 205 && s.ratio > 1.7, JSON.stringify(r.map(x => [x.type, x.a, x.b, x.ratio])));
});
test('Проверка для Strava: пропуск без координат', () => {
  const r = VF.stravaCheck(VF.run(mkFit(ride(600, (x, i) => { if (i >= 300 && i < 340) { x.lat = null; x.lon = null; } })), [], { fillStraight: false }));
  const g = r.find(x => x.type === 'nogps');
  ok('Пропуск 40 записей найден', g && g.n === 40 && g.level === 'warn', JSON.stringify(r));
});

// реальные файлы (tests/fixtures/*.fit, в репозиторий не попадают): только «не падает и самопроверки»
for (const [name, b64] of Object.entries(window.FIXTURES || {})) {
  test('Реальный файл ' + name, () => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const res = VF.run(bytes, []);
    ok(`${name}: обработан, CRC верна`, res.fit2.crcOk, `${res.N} записей`);
    ok(`${name}: самопроверки`, failed(res).length === 0, failed(res).join('; '));
    const bad = VF.stravaCheck(res).filter(x => x.level === 'bad');
    ok(`${name}: проверка для Strava без ложных тревог`, bad.length === 0, bad.map(x => `${x.type} ${x.a}-${x.b} ${x.vmax ?? (x.ratio || 0).toFixed(2)}`).join('; '));
  });
}

document.getElementById('out').textContent = T.lines.join('\n') + `\n\nИТОГО: ${T.pass} пройдено, ${T.fail} провалено\n`;
