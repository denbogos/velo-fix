# Сборка релиза VELO FIX одной командой:
#   .\build.ps1 2.8.0
# Делает: тесты → версия во всех файлах → VELO_FIX.html → ресурсы exe → VELO_FIX.exe → dist\VELO_FIX_<версия>_Windows.zip + .sha256
# Нужно: Python 3, Chrome или Edge (для тестов), Go 1.21+. Ресурсы (иконка, манифест, версия) собираются через go-winres.
param([Parameter(Mandatory)][string]$Version, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Версия должна быть вида 2.8.0" }
$v4 = ($Version -replace '\.', ',') + ',0'

if (-not $SkipTests) {
    python tests/run.py
    if ($LASTEXITCODE) { throw 'Тесты не прошли — сборка остановлена' }
}

# версия во всех местах
$utf8 = New-Object Text.UTF8Encoding $false
$go = [IO.File]::ReadAllText("$PWD\windows\main.go") -replace 'const appVersion = "[^"]*"', "const appVersion = `"$Version`""
[IO.File]::WriteAllText("$PWD\windows\main.go", $go, $utf8)
$rc = [IO.File]::ReadAllText("$PWD\windows\app.rc")
$rc = $rc -replace '(FILEVERSION|PRODUCTVERSION) [\d,]+', "`$1 $v4" -replace '("(?:File|Product)Version", )"[^"]*"', "`$1`"$Version`""
[IO.File]::WriteAllText("$PWD\windows\app.rc", $rc, $utf8)
$md = [IO.File]::ReadAllText("$PWD\README.md") -replace 'build\.ps1 \d+\.\d+\.\d+', "build.ps1 $Version"
[IO.File]::WriteAllText("$PWD\README.md", $md, $utf8)

python build.py $Version
if ($LASTEXITCODE) { throw 'build.py' }

Push-Location windows
try {
    if (-not (Test-Path go.mod)) { go mod init velofix | Out-Null }
    # ресурсы exe: иконка, манифест, сведения о версии
    $winres = @{ 'RT_GROUP_ICON' = @{ 'APP' = @{ '0000' = 'velofix.ico' } }; 'RT_MANIFEST' = @{ '#1' = @{ '0409' = 'app.manifest' } };
        'RT_VERSION' = @{ '#1' = @{ '0000' = @{ fixed = @{ file_version = "$Version.0"; product_version = "$Version.0" };
            info = @{ '0419' = @{ FileDescription = 'VELO FIX — восстановление трека велотренировки'; FileVersion = $Version; ProductName = 'VELO FIX';
                ProductVersion = $Version; OriginalFilename = 'VELO_FIX.exe'; InternalName = 'VELO_FIX'; LegalCopyright = 'MIT' } } } } } }
    New-Item -ItemType Directory -Force winres | Out-Null
    Copy-Item velofix.ico, app.manifest winres\ -Force
    [IO.File]::WriteAllText("$PWD\winres\winres.json", ($winres | ConvertTo-Json -Depth 10), $utf8)
    go run github.com/tc-hib/go-winres@v0.3.3 make --in winres\winres.json --arch amd64
    if ($LASTEXITCODE) { throw 'go-winres' }
    $env:CGO_ENABLED = '0'; $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
    go build -trimpath -ldflags '-H windowsgui -s -w' -o VELO_FIX.exe .
    if ($LASTEXITCODE) { throw 'go build' }
} finally { Pop-Location }

# архив релиза + контрольная сумма (её проверяет автообновление)
$exeHash = (Get-FileHash windows\VELO_FIX.exe -Algorithm SHA256).Hash.ToLower()
$txt = [IO.File]::ReadAllText("$PWD\README.txt") -replace '^VELO FIX \d+\.\d+\.\d+', "VELO FIX $Version" -replace '(SHA-256 файла VELO_FIX\.exe:\r?\n)[0-9a-f]{64}', "`${1}$exeHash"
[IO.File]::WriteAllText("$PWD\README.txt", $txt, $utf8)
$dist = "$PWD\dist"; $stage = "$dist\VELO_FIX"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\source" | Out-Null
Copy-Item windows\VELO_FIX.exe, windows\VELO_FIX.html $stage
Copy-Item LICENSE "$stage\LICENSE.txt"
if (Test-Path README.txt) { Copy-Item README.txt $stage }
Copy-Item src\core.js, src\i18n.js, src\ui.html, build.py, windows\main.go, windows\app.rc, windows\app.manifest, windows\velofix.ico "$stage\source"
$zip = "$dist\VELO_FIX_${Version}_Windows.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive $stage $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText("$zip.sha256", "$hash  VELO_FIX_${Version}_Windows.zip`n", $utf8)
Remove-Item $stage -Recurse -Force
"Готово: $zip"
"SHA-256: $hash  (загрузите .zip и .zip.sha256 в релиз GitHub)"
