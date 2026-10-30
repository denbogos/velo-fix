"""Запуск автотестов VELO FIX в Chrome без окна (Node.js не нужен).

    python tests/run.py

Реальные заезды для проверки положите в tests/fixtures/*.fit — в git они не попадают (.gitignore).
"""
import base64, html, json, os, pathlib, re, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME = [
    os.environ.get('CHROME', ''),
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    shutil.which('chrome') or '', shutil.which('google-chrome') or '', shutil.which('chromium') or '',
]


# IndexedDB в headless Chrome с --virtual-time-budget не открывается вовсе, поэтому в тестах интерфейса —
# хранилище в памяти с тем же интерфейсом, которым пользуется программа (open / transaction / get / put / delete / getAllKeys)
IDB_MEMORY = r'''(() => { const dbs = new Map(), clone = v => v === undefined ? undefined : structuredClone(v);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open(name) { const r = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => { const fresh = !dbs.has(name); if (fresh) dbs.set(name, new Map()); const data = dbs.get(name);
        r.result = { close() {}, createObjectStore(k) { data.set(k, new Map()); },
          transaction(k) { if (!data.has(k)) data.set(k, new Map()); const m = data.get(k), tx = { oncomplete: null, onerror: null, onabort: null };
            const op = f => ({ result: f() });
            tx.objectStore = () => ({ get: key => op(() => clone(m.get(key))), put: (v, key) => op(() => { m.set(key, clone(v)); return key; }),
              delete: key => op(() => { m.delete(key); }), getAllKeys: () => op(() => [...m.keys()]) });
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); return tx; } };
        if (fresh && r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); }, 0);
      return r; },
    deleteDatabase(name) { dbs.delete(name); const r = {}; setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; } } }); })();'''

try:
    import http.server as _hs
    class Quiet(_hs.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
except ImportError:
    Quiet = None


def render(chrome, page, pre_id, budget=600000, http=False):
    """Открывает страницу в Chrome без окна и возвращает текст <pre id=pre_id> после выполнения.
    http=True — через локальный веб-сервер: у страницы из файла (file://) не работает IndexedDB."""
    with tempfile.TemporaryDirectory() as tmp:
        f = pathlib.Path(tmp) / 'run.html'
        f.write_text(page, encoding='utf-8')
        url, srv = f.as_uri(), None
        if http:
            import functools, http.server, threading
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=tmp))
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            url = f'http://127.0.0.1:{srv.server_address[1]}/run.html'
        try:
            r = subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1280,900',
                                f'--user-data-dir={tmp}\\profile', f'--virtual-time-budget={budget}',
                                '--dump-dom', url], capture_output=True, timeout=900)
        finally:
            if srv: srv.shutdown()
    dom = r.stdout.decode('utf-8', 'replace')
    m = re.search(rf'<pre id="{pre_id}"[^>]*>(.*?)</pre>', dom, re.S)
    return html.unescape(m.group(1)) if m else 'Не удалось получить результат:\n' + dom[-2000:]


def main():
    chrome = next((c for c in CHROME if c and os.path.exists(c)), None)
    if not chrome:
        sys.exit('Не найден Chrome/Edge. Укажите путь в переменной CHROME.')
    src = lambda *p: (ROOT.joinpath(*p)).read_text(encoding='utf-8')
    core, fitgen = src('src', 'core.js'), src('tests', 'fitgen.js')
    fixtures = {p.name: base64.b64encode(p.read_bytes()).decode()
                for p in sorted((ROOT / 'tests' / 'fixtures').glob('*.fit'))}
    sys.stdout.reconfigure(encoding='utf-8')
    # 1) ядро: исправление FIT, проверка для Strava, реальные заезды из tests/fixtures
    page = ('<!doctype html><meta charset="utf-8"><pre id="out">НЕ ЗАВЕРШЕНО</pre>'
            f'<script>window.FIXTURES={json.dumps(fixtures)};</script>'
            f'<script>{core}\n</script><script>{fitgen}\n</script><script>{src("tests", "tests.js")}\n</script>')
    text = render(chrome, page, 'out')
    print(text)
    # 2) интерфейс: вся программа как у пользователя + сценарии редактора трека
    app = (src('src', 'ui.html').replace('/*VERSION*/', 'test').replace('<!--FAVICON-->', '')
           .replace('/*CORE*/', core).replace('/*I18N*/', src('src', 'i18n.js')))
    inject = ('<pre id="uiout" style="display:none">НЕ ЗАВЕРШЕНО</pre>'
              f'<script>{fitgen}\n</script><script>{src("tests", "ui_tests.js")}\n</script>')
    # без интернета: headless Chrome «замораживает» таймеры страницы, пока висят сетевые запросы (тайлы, схема улиц)
    offline = ('<script>localStorage.setItem("velofix.tiles", JSON.stringify("none"));'
               'const __f = window.fetch; window.fetch = (u, o) => /^https?:/i.test(String(u && u.url || u)) ? Promise.reject(new Error("offline (tests)")) : __f(u, o);'
               + IDB_MEMORY + '</script>')
    app = app.replace('<head>', '<head>' + offline, 1)
    head, tail = app.rsplit('</body>', 1)   # the last one: «</body>» also occurs inside a JS template (the report)
    ui = render(chrome, head + inject + '</body>' + tail, 'uiout', http=True)
    print(ui)
    ok = all((m := re.search(r'(\d+) провалено', t)) and m.group(1) == '0' for t in (text, ui))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
