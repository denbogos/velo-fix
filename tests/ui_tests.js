/* VELO FIX — автотесты интерфейса: вся программа (VELO_FIX.html) в Chrome без окна, сценарии редактора трека.
   Каждый сценарий — ошибка, которая уже однажды доходила до пользователя. Запуск: python tests/run.py */
'use strict';
(async () => {
  const U = { pass: 0, fail: 0, lines: [] };
  const ok = (name, cond, detail = '') => { if (cond) U.pass++; else U.fail++; U.lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let stage = '';
  window.__stage = s => { stage = s; };
  async function uiTest(name, fn) {
    stage = 'начало';
    try { await Promise.race([fn(), sleep(60000).then(() => { throw new Error('не уложился в 60 с, этап: ' + stage); })]); }
    catch (e) { U.fail++; U.lines.push(`FAIL  ${name}  — исключение: ${e && e.message}`); }
  }
  for (let k = 0; k < 100 && !window.__velofix; k++) await sleep(50);
  const V = window.__velofix, M = V.M, TE = V.TE;
  const view = () => [M.z, Math.round(M.cx), Math.round(M.cy)].join(',');
  const ptr = (type, x, y, button = 0) => { const b = M.cv.getBoundingClientRect();
    M.cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: b.left + x, clientY: b.top + y, button, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse' })); };
  const clickLL = (lat, lon) => { const [x, y] = M.scr(lat, lon); ptr('pointerdown', x, y); ptr('pointerup', x, y); };
  const fresh = () => { if (TE.on) V.teStop(); V.S.files = []; V.S.cur = null; };
  async function loadRide(recs, name) { fresh(); stage = 'addFiles ' + name; await V.addFiles([new File([mkFit(recs)], name)]); stage = 'после addFiles'; await sleep(300); const t = document.getElementById('toast'); if (t) t.style.display = 'none'; return V.cur(); }
  const gapRide = (n, a, b) => ride(n, (r, i) => { if (i >= a && i <= b) { r.lat = null; r.lon = null; } });
  window.confirm = () => true;
  const idbOk = await Promise.race([new Promise(r => { try { const q = indexedDB.open('probe', 1); q.onsuccess = () => { q.result.close(); r(true); }; q.onerror = () => r(false); } catch (e) { r(false); } }), sleep(4000).then(() => false)]);
  ok('Хранилище (в тестах — в памяти, см. run.py) открывается', idbOk);

  await uiTest('Карта не перескакивает к «подозрительным местам» после правки (2.9.2)', async () => {
    await loadRide(ride(600), 'ui-jump.fit');
    V.teStart(); await sleep(200);
    TE.pos[300] = { lat: TE.pos[300].lat + 0.004, lon: TE.pos[300].lon };   // «выброс»
    M.fitRange(50, 150); const v0 = view();
    V.teFindIssues(); await sleep(700);
    ok('Подозрительное место найдено', TE.issues.length > 0, `${TE.issues.length}`);
    ok('Карта осталась на месте', view() === v0, `${v0} → ${view()}`);
  });

  await uiTest('Щелчок рядом с треком без движения ничего не меняет (2.9.2)', async () => {
    await loadRide(ride(600), 'ui-click.fit');
    V.teStart(); await sleep(200); M.fitRange(150, 250); await sleep(50);
    const i = 200, [x, y] = M.scr(TE.pos[i].lat, TE.pos[i].lon), p0 = JSON.stringify(TE.pos[i]), u0 = TE.undo.length, v0 = view();
    ptr('pointerdown', x, y); ptr('pointermove', x + 2, y); ptr('pointerup', x + 2, y); await sleep(700);
    ok('Точка трека на месте', JSON.stringify(TE.pos[i]) === p0);
    ok('Лишнего шага отмены нет', TE.undo.length === u0, `${u0} → ${TE.undo.length}`);
    ok('Карта на месте', view() === v0);
  });

  await uiTest('Перетаскивание трека работает и отменяется', async () => {
    const i = 200, [x, y] = M.scr(TE.pos[i].lat, TE.pos[i].lon), p0 = JSON.stringify(TE.pos[i]), u0 = TE.undo.length;
    ptr('pointerdown', x, y); ptr('pointermove', x + 10, y); ptr('pointermove', x + 40, y); ptr('pointerup', x + 40, y); await sleep(100);
    ok('Точка сдвинута', JSON.stringify(TE.pos[i]) !== p0);
    ok('Шаг отмены добавлен', TE.undo.length === u0 + 1);
    V.teUndo(); ok('Ctrl+Z вернул точку', JSON.stringify(TE.pos[i]) === p0);
  });

  await uiTest('«Дорисовать» закрывает пропуск целиком (2.9.3: линия не сжимается)', async () => {
    const f = await loadRide(gapRide(800, 300, 420), 'ui-gap.fit');
    V.teStart(); await sleep(200);
    const g = V.teNextGap(0); ok('Пропуск найден: 299 → 421', g && g[0] === 299 && g[1] === 421, JSON.stringify(g));
    V.teDrawStart(g[0], g[1]); await sleep(100); TE.dw.mode = 'line';
    const A = TE.pos[g[0]], B = TE.pos[g[1]];
    for (const u of [0.3, 0.6]) clickLL(A.lat + (B.lat - A.lat) * u, A.lon + (B.lon - A.lon) * u + 0.0003);
    await sleep(100); ok('Поставлены точки, к A ничего не прицеплено', TE.dw && TE.dw.wp.length === 2, TE.dw && `${TE.dw.wp.length}`);
    await V.teDrawDone(); let empty = 0; for (let i = g[0]; i <= g[1]; i++) if (!TE.pos[i]) empty++;
    ok('В пропуске не осталось записей без координат', empty === 0, `${empty}`);
    await V.teSave(false); await sleep(300);
    const r = V.cur().res, e = V.cur().edits.find(x => x.type === 'route');
    ok('Правка покрывает весь пропуск', e && e.t0 === r.R[299].t && e.t1 === r.R[421].t, e && `${r.R.findIndex(x => x.t === e.t0)}–${r.R.findIndex(x => x.t === e.t1)}`);
    ok('Проверка для Strava: проблем нет', V.stravaIssues(V.cur()).filter(x => x.level === 'bad').length === 0);
  });

  await uiTest('Рисую с другого конца (от B к A) — линия разворачивается сама', async () => {
    await loadRide(gapRide(800, 300, 420), 'ui-rev.fit');
    V.teStart(); await sleep(200); const g = V.teNextGap(0);
    V.teDrawStart(g[0], g[1]); await sleep(100); TE.dw.mode = 'line';
    const A = TE.pos[g[0]], B = TE.pos[g[1]];
    for (const u of [0.8, 0.5, 0.2]) clickLL(A.lat + (B.lat - A.lat) * u, A.lon + 0.0004);   // from B towards A, beside the old line
    await V.teDrawDone();
    let back = 0; for (let i = g[0] + 1; i <= g[1]; i++) if (TE.pos[i] && TE.pos[i - 1] && TE.pos[i].lat < TE.pos[i - 1].lat - 1e-7) back++;
    ok('Записи идут от A к B (север), а не назад', back === 0, `шагов назад: ${back}`);
    ok('Линия прошла по нарисованному (сбоку от старой)', Math.abs(TE.pos[g[0] + 60].lon - (A.lon + 0.0004)) < 0.0002);
    TE.on = false;
  });

  await uiTest('Правки файла возвращаются при повторном открытии', async () => {
    await V.addFiles([new File([mkFit(gapRide(800, 300, 420))], 'ui-gap.fit')]); await sleep(300);
    V.cur().edits = V.cur().edits.length ? V.cur().edits : [{ type: 'del', t0: V.cur().res.R[50].t, t1: V.cur().res.R[60].t }]; V.cur().res = null; V.showCurrent();
    await sleep(1200);   // сохранение правок — через 0,8 с
    const n0 = V.cur().edits.length;
    await V.addFiles([new File([mkFit(gapRide(800, 300, 420))], 'ui-gap.fit')]); await sleep(300);
    ok('Правки восстановлены', V.cur().edits.length === n0 && n0 > 0, `${n0} → ${V.cur().edits.length}`);
    ok('Сказано об этом', /восстановлены/.test(document.getElementById('toast').textContent));
  });

  await uiTest('Незаконченная правка трека переживает закрытие редактора', async () => {
    V.teStart(); await sleep(200); M.fitRange(100, 200); await sleep(50);
    const i = 150, [x, y] = M.scr(TE.pos[i].lat, TE.pos[i].lon);
    ptr('pointerdown', x, y); ptr('pointermove', x + 10, y); ptr('pointermove', x + 50, y); ptr('pointerup', x + 50, y);
    const moved = JSON.stringify(TE.pos[i]); await sleep(1400);   // черновик — через 1 с
    TE.on = false;   // «закрыли программу» без «Готово»
    V.teStart(); await sleep(400);
    const btn = [...document.querySelectorAll('#toast [data-ta]')].find(b => /Продолжить|Continue/.test(b.textContent));
    ok('Предложено продолжить', !!btn, document.getElementById('toast').textContent.slice(0, 80));
    if (btn) btn.click();
    ok('Правка вернулась', JSON.stringify(TE.pos[i]) === moved);
    V.teSave(false); await sleep(200);
  });

  await uiTest('Поездка без GPS в начале: первый щелчок — старт (2.9.1)', async () => {
    await loadRide(gapRide(600, 0, 80), 'ui-start.fit');
    V.teStart(); await sleep(200);
    V.teDrawStart(0, 81); await sleep(100); TE.dw.mode = 'line';
    ok('Старта нет — ждём щелчка', TE.dw.noA && TE.dw.wp.length === 0);
    const B = TE.pos[81];
    clickLL(B.lat - 0.004, B.lon); clickLL(B.lat - 0.002, B.lon + 0.0002); await sleep(100);
    ok('Первый щелчок стал стартом', TE.dw.wp.length === 2);
    await V.teDrawDone(); let empty = 0; for (let i = 0; i <= 81; i++) if (!TE.pos[i]) empty++;
    ok('Начало поездки заполнено', empty === 0, `${empty}`);
    ok('Старт там, где щёлкнули', TE.pos[0] && Math.abs(TE.pos[0].lat - (B.lat - 0.004)) < 0.0002);
    TE.on = false;
  });

  await uiTest('Сжатая линия ловится перед сохранением для Strava', async () => {
    const recs = ride(600), A = recs[100], Bp = recs[200], h = Math.sqrt(1400 ** 2 - 350 ** 2) / (111320 * Math.cos(A.lat * Math.PI / 180)), P = { lat: (A.lat + Bp.lat) / 2, lon: A.lon + h };
    const pts = []; for (let s = 0; s <= 40; s++) { const u = s / 40, [p, q, v] = u <= 0.5 ? [A, P, u * 2] : [P, Bp, u * 2 - 1]; pts.push({ lat: p.lat + v * (q.lat - p.lat), lon: p.lon + v * (q.lon - p.lon) }); }
    const f = await loadRide(recs, 'ui-squeeze.fit');
    f.edits = [{ type: 'route', t0: A.t, t1: Bp.t, pts, src: 'нарисовано вручную' }]; f.res = null; V.showCurrent(); await sleep(200);
    const bad = V.stravaIssues(f).filter(x => x.level === 'bad');
    ok('Проблема найдена на 100–200', bad.length === 1 && bad[0].a >= 95 && bad[0].b <= 205, JSON.stringify(bad.map(x => [x.type, x.a, x.b])));
    ok('Справа красный блок', /Strava отклонит/.test(document.getElementById('strava').textContent));
    let asked = ''; window.confirm = m => { asked = m; return false; };
    document.getElementById('saveBtn').click(); await sleep(100); window.confirm = () => true;
    ok('Перед сохранением спрошено', /Strava исключит/.test(asked), asked.slice(0, 60));
  });

  document.getElementById('uiout').textContent = U.lines.join('\n') + `\n\nИНТЕРФЕЙС: ${U.pass} пройдено, ${U.fail} провалено\n`;
})();
