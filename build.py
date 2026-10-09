import sys
v = sys.argv[1] if len(sys.argv) > 1 else 'dev'
s = open('src/ui.html', encoding='utf-8').read().replace('/*VERSION*/', v)
s = s.replace('<!--FAVICON-->', open('src/favicon.txt', encoding='utf-8').read().strip())
core = open('src/core.js', encoding='utf-8').read()
i18n = open('src/i18n.js', encoding='utf-8').read()
open('windows/VELO_FIX.html', 'w', encoding='utf-8').write(s.replace('/*CORE*/', core).replace('/*I18N*/', i18n))
print('windows/VELO_FIX.html built, version', v)
