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


def main():
    chrome = next((c for c in CHROME if c and os.path.exists(c)), None)
    if not chrome:
        sys.exit('Не найден Chrome/Edge. Укажите путь в переменной CHROME.')
    core = (ROOT / 'src' / 'core.js').read_text(encoding='utf-8')
    tests = (ROOT / 'tests' / 'tests.js').read_text(encoding='utf-8')
    fixtures = {p.name: base64.b64encode(p.read_bytes()).decode()
                for p in sorted((ROOT / 'tests' / 'fixtures').glob('*.fit'))}
    page = ('<!doctype html><meta charset="utf-8"><pre id="out">НЕ ЗАВЕРШЕНО</pre>'
            f'<script>window.FIXTURES={json.dumps(fixtures)};</script>'
            f'<script>{core}\n</script><script>{tests}\n</script>')
    with tempfile.TemporaryDirectory() as tmp:
        f = pathlib.Path(tmp) / 'run.html'
        f.write_text(page, encoding='utf-8')
        r = subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-first-run',
                            f'--user-data-dir={tmp}\\profile', '--virtual-time-budget=600000',
                            '--dump-dom', f.as_uri()], capture_output=True, timeout=900)
    dom = r.stdout.decode('utf-8', 'replace')
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    text = html.unescape(m.group(1)) if m else 'Не удалось получить результат:\n' + dom[-2000:]
    sys.stdout.reconfigure(encoding='utf-8')
    print(text)
    fails = re.search(r'(\d+) провалено', text)
    sys.exit(0 if fails and fails.group(1) == '0' else 1)


if __name__ == '__main__':
    main()
