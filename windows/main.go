// VELO FIX — Windows launcher.
// Serves the embedded offline app on http://127.0.0.1 (so map tiles get a proper page origin)
// and opens it in its own window (Microsoft Edge / Google Chrome "app" mode).
// Also: desktop shortcut on first run, one-click self-update from GitHub releases,
// reading rides from a connected Garmin / Wahoo (USB drive or MTP).
// Falls back to a local file in the default browser. No installation, no admin rights.
package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

//go:embed VELO_FIX.html
var page []byte

const appVersion = "2.6.0"
const port = "47815"
const repo = "denbogos/velo-fix"

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
)

func messageBox(text, title string, flags uintptr) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}

func exists(p string) bool { st, err := os.Stat(p); return err == nil && !st.IsDir() }
func isDir(p string) bool  { st, err := os.Stat(p); return err == nil && st.IsDir() }

func browsers() []string {
	var out []string
	roots := []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("ProgramW6432"), os.Getenv("LOCALAPPDATA")}
	for _, r := range []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`} {
		for _, root := range roots {
			if root != "" && exists(filepath.Join(root, r)) {
				out = append(out, filepath.Join(root, r))
			}
		}
	}
	return out
}

// another VELO FIX already serving on our port?
func ours(base string) bool {
	c := http.Client{Timeout: 800 * time.Millisecond}
	r, err := c.Get(base + "velofix-id")
	if err != nil {
		return false
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return strings.HasPrefix(string(b), "velofix")
}

var dataDir string

func exePath() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	if q, err := filepath.EvalSymlinks(p); err == nil {
		p = q
	}
	return p
}

// running straight from inside a ZIP (Explorer extracts to %TEMP%)?
func runningFromTemp(p string) bool {
	t := strings.ToLower(os.TempDir())
	return t != "" && strings.HasPrefix(strings.ToLower(p), t)
}

// ---------- PowerShell helper (hidden window, UTF-8 output) ----------
func powershell(script string, env map[string]string, timeout time.Duration) ([]byte, error) {
	full := "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + script
	u := utf16.Encode([]rune(full))
	b := make([]byte, len(u)*2)
	for i, v := range u {
		b[2*i] = byte(v)
		b[2*i+1] = byte(v >> 8)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return out.Bytes(), fmt.Errorf("%v: %s", err, strings.TrimSpace(errb.String()))
		}
		return out.Bytes(), nil
	case <-time.After(timeout):
		cmd.Process.Kill()
		return nil, errors.New("timeout")
	}
}

// ---------- desktop shortcut ----------
func makeShortcut() error {
	exe := exePath()
	if exe == "" {
		return errors.New("exe path unknown")
	}
	if runningFromTemp(exe) {
		return errors.New("temp")
	}
	_, err := powershell(`$d=[Environment]::GetFolderPath('Desktop');$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'VELO FIX.lnk'));`+
		`$s.TargetPath=$env:VF_EXE;$s.WorkingDirectory=(Split-Path $env:VF_EXE);$s.IconLocation=$env:VF_EXE+',0';$s.Description='VELO FIX';$s.Save()`,
		map[string]string{"VF_EXE": exe}, 20*time.Second)
	return err
}

func firstRunShortcut() {
	marker := filepath.Join(dataDir, "shortcut.done")
	if exists(marker) {
		return
	}
	exe := exePath()
	if exe == "" || runningFromTemp(exe) {
		return // will try next time, once unpacked
	}
	if err := makeShortcut(); err == nil {
		os.WriteFile(marker, []byte(exe), 0o644)
	}
}

// ---------- self-update ----------
type release struct {
	Tag    string `json:"tag_name"`
	URL    string `json:"html_url"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

var updMu sync.Mutex
var updReady string // version installed, waiting for restart

func newer(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			fmt.Sscan(pa[i], &x)
		}
		if i < len(pb) {
			fmt.Sscan(pb[i], &y)
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func doUpdate() (string, error) {
	updMu.Lock()
	defer updMu.Unlock()
	if updReady != "" {
		return updReady, nil
	}
	exe := exePath()
	if exe == "" || runningFromTemp(exe) {
		return "", errors.New("Программа запущена прямо из архива — распакуйте её в папку и запустите оттуда")
	}
	dir := filepath.Dir(exe)
	probe := filepath.Join(dir, ".velofix-write-test")
	if err := os.WriteFile(probe, []byte("x"), 0o644); err != nil {
		return "", errors.New("Нет прав на запись в папку программы: " + dir)
	}
	os.Remove(probe)

	cl := &http.Client{Timeout: 2 * time.Minute}
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+repo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "VELO-FIX/"+appVersion)
	resp, err := cl.Do(req)
	if err != nil {
		return "", errors.New("Нет связи с GitHub: " + err.Error())
	}
	var rel release
	err = json.NewDecoder(resp.Body).Decode(&rel)
	resp.Body.Close()
	if err != nil || rel.Tag == "" {
		return "", errors.New("Не удалось прочитать данные релиза")
	}
	ver := strings.TrimPrefix(strings.TrimPrefix(rel.Tag, "v"), "V")
	if !newer(ver, appVersion) {
		return "", errors.New("Уже установлена последняя версия")
	}
	assetURL := ""
	for _, a := range rel.Assets {
		if strings.HasSuffix(strings.ToLower(a.Name), "_windows.zip") {
			assetURL = a.URL
		}
	}
	if !strings.HasPrefix(assetURL, "https://github.com/"+repo+"/releases/download/") {
		return "", errors.New("В релизе нет архива для Windows")
	}
	req, _ = http.NewRequest("GET", assetURL, nil)
	req.Header.Set("User-Agent", "VELO-FIX/"+appVersion)
	resp, err = cl.Do(req)
	if err != nil {
		return "", errors.New("Не удалось скачать: " + err.Error())
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 200<<20))
	resp.Body.Close()
	if err != nil || resp.StatusCode != 200 {
		return "", errors.New("Не удалось скачать архив")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", errors.New("Архив повреждён")
	}
	// common top folder (VELO_FIX/...) is stripped
	prefix := ""
	for _, f := range zr.File {
		if strings.EqualFold(filepath.Base(f.Name), "VELO_FIX.exe") {
			prefix = strings.TrimSuffix(f.Name, filepath.Base(f.Name))
		}
	}
	var newExe []byte
	others := map[string][]byte{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !strings.HasPrefix(f.Name, prefix) {
			continue
		}
		rel := strings.TrimPrefix(f.Name, prefix)
		if rel == "" || strings.Contains(rel, "..") || strings.HasPrefix(rel, "/") || strings.Contains(rel, ":") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(rc, 100<<20))
		rc.Close()
		if err != nil {
			return "", errors.New("Архив повреждён")
		}
		if strings.EqualFold(rel, "VELO_FIX.exe") {
			newExe = b
		} else {
			others[rel] = b
		}
	}
	if len(newExe) < 100000 || newExe[0] != 'M' || newExe[1] != 'Z' {
		return "", errors.New("В архиве нет VELO_FIX.exe")
	}
	tmp := exe + ".new"
	if err := os.WriteFile(tmp, newExe, 0o755); err != nil {
		return "", errors.New("Не удалось записать файл: " + err.Error())
	}
	old := strings.TrimSuffix(exe, filepath.Ext(exe)) + ".old.exe"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil { // a running exe can be renamed, not overwritten
		os.Remove(tmp)
		return "", errors.New("Не удалось заменить программу: " + err.Error())
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(old, exe)
		return "", errors.New("Не удалось заменить программу: " + err.Error())
	}
	for rel, b := range others {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, b, 0o644)
	}
	updReady = ver
	return ver, nil
}

// ---------- Garmin / Wahoo ----------
type devFile struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"` // unix ms
}
type device struct {
	Name  string    `json:"name"`
	Kind  string    `json:"kind"` // drive | mtp
	Files []devFile `json:"files"`
}

var activityDirs = []string{`Garmin\Activity`, `Garmin\Activities`, `Garmin\Activity\Bike`, `exports`, `ELEMNT\exports`, `Activities`}

func scanDrives() []device {
	var out []device
	mask, _, _ := kernel32.NewProc("GetLogicalDrives").Call()
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		if root == `C:\` {
			continue
		}
		dt, _, _ := kernel32.NewProc("GetDriveTypeW").Call(uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(root))))
		if dt != 2 && dt != 3 { // removable or fixed (some devices mount as fixed)
			continue
		}
		var files []devFile
		for _, sub := range activityDirs {
			d := filepath.Join(root, sub)
			if !isDir(d) {
				continue
			}
			ents, _ := os.ReadDir(d)
			for _, e := range ents {
				if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".fit") {
					continue
				}
				info, err := e.Info()
				if err != nil {
					continue
				}
				files = append(files, devFile{ID: filepath.Join(d, e.Name()), Name: e.Name(), Size: info.Size(), MTime: info.ModTime().UnixMilli()})
			}
		}
		if len(files) == 0 {
			continue
		}
		sort.Slice(files, func(a, b int) bool { return files[a].MTime > files[b].MTime })
		if len(files) > 60 {
			files = files[:60]
		}
		name := "Garmin"
		var vol [261]uint16
		if r, _, _ := kernel32.NewProc("GetVolumeInformationW").Call(uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(root))), uintptr(unsafe.Pointer(&vol[0])), 261, 0, 0, 0, 0, 0); r != 0 {
			if v := syscall.UTF16ToString(vol[:]); v != "" {
				name = v
			}
		}
		out = append(out, device{Name: name + " (" + root[:2] + ")", Kind: "drive", Files: files})
	}
	return out
}

func validDrivePath(p string) bool {
	if !strings.EqualFold(filepath.Ext(p), ".fit") || len(p) < 4 || p[1] != ':' {
		return false
	}
	dir := filepath.Dir(p)
	for _, sub := range activityDirs {
		if strings.EqualFold(dir, filepath.Join(p[:3], sub)) {
			return true
		}
	}
	return false
}

// MTP devices (most current Garmin Edge, Wahoo, Hammerhead) are reachable only through the Windows Shell.
const psFind = `
function Sub($f,$path){ foreach($p in $path.Split('\')){ if(-not $f){return $null}; $n=$null; foreach($it in $f.Items()){ if($it.IsFolder -and $it.Name -ieq $p){$n=$it.GetFolder;break} }; $f=$n }; return $f }
$sh=New-Object -ComObject Shell.Application
$res=@()
foreach($dev in $sh.NameSpace(17).Items()){
  if($dev.Path -match '^[A-Za-z]:\\'){continue}
  $df=$null; try{$df=$dev.GetFolder}catch{}; if(-not $df){continue}
  foreach($st in $df.Items()){
    if(-not $st.IsFolder){continue}
    $sf=$null; try{$sf=$st.GetFolder}catch{}; if(-not $sf){continue}
    foreach($rel in @('Garmin\Activity','Garmin\Activities','exports','ELEMNT\exports','Activities')){
      $af=Sub $sf $rel; if(-not $af){continue}
      $files=@()
      foreach($it in $af.Items()){
        if($it.IsFolder){continue}
        $nm=$it.Name; if($nm -notmatch '\.fit$'){ if(($af.GetDetailsOf($it,2)) -match 'FIT'){ $nm=$nm+'.fit' } else { continue } }
        $files+=[pscustomobject]@{name=$nm;raw=$it.Name;size=[int64]$it.Size;mtime=[int64](([DateTimeOffset]$it.ModifyDate).ToUnixTimeMilliseconds())}
      }
      if($files.Count){ $res+=[pscustomobject]@{dev=$dev.Name;storage=$st.Name;rel=$rel;files=@($files|Sort-Object mtime -Descending|Select-Object -First 60)} }
    }
  }
}
ConvertTo-Json -InputObject @($res) -Depth 5 -Compress
`

const psCopy = `
function Sub($f,$path){ foreach($p in $path.Split('\')){ if(-not $f){return $null}; $n=$null; foreach($it in $f.Items()){ if($it.IsFolder -and $it.Name -ieq $p){$n=$it.GetFolder;break} }; $f=$n }; return $f }
$sh=New-Object -ComObject Shell.Application
$dev=$null; foreach($d in $sh.NameSpace(17).Items()){ if($d.Name -eq $env:VF_DEV){$dev=$d} }
if(-not $dev){throw 'device gone'}
$af=Sub $dev.GetFolder ($env:VF_ST+'\'+$env:VF_REL); if(-not $af){throw 'folder gone'}
$item=$null; foreach($it in $af.Items()){ if($it.Name -eq $env:VF_NAME){$item=$it} }; if(-not $item){throw 'file gone'}
$sh.NameSpace($env:VF_OUT).CopyHere($item, 4+16+512+1024)
$t=0; while($t -lt 600){ Start-Sleep -Milliseconds 100; $t++; $f=Get-ChildItem -LiteralPath $env:VF_OUT -File | Select-Object -First 1; if($f -and $f.Length -ge [int64]$env:VF_SIZE){ try{ $s=[IO.File]::Open($f.FullName,'Open','Read','None'); $s.Close(); Write-Output $f.FullName; exit 0 }catch{} } }
throw 'copy timeout'
`

type mtpEntry struct {
	Dev, Storage, Rel string
	Files             []struct {
		Name  string `json:"name"`
		Raw   string `json:"raw"`
		Size  int64  `json:"size"`
		MTime int64  `json:"mtime"`
	}
}

func scanMTP() ([]device, error) {
	out, err := powershell(psFind, nil, 45*time.Second)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Dev     string `json:"dev"`
		Storage string `json:"storage"`
		Rel     string `json:"rel"`
		Files   []struct {
			Name  string `json:"name"`
			Raw   string `json:"raw"`
			Size  int64  `json:"size"`
			MTime int64  `json:"mtime"`
		} `json:"files"`
	}
	s := bytes.TrimSpace(bytes.TrimPrefix(out, []byte("\xef\xbb\xbf")))
	if len(s) == 0 || string(s) == "null" {
		return nil, nil
	}
	if err := json.Unmarshal(s, &raw); err != nil {
		return nil, err
	}
	byDev := map[string]*device{}
	var order []string
	for _, r := range raw {
		d := byDev[r.Dev]
		if d == nil {
			d = &device{Name: r.Dev, Kind: "mtp"}
			byDev[r.Dev] = d
			order = append(order, r.Dev)
		}
		for _, f := range r.Files {
			id := "mtp\x1f" + r.Dev + "\x1f" + r.Storage + "\x1f" + r.Rel + "\x1f" + f.Raw + "\x1f" + fmt.Sprint(f.Size)
			d.Files = append(d.Files, devFile{ID: id, Name: f.Name, Size: f.Size, MTime: f.MTime})
		}
	}
	var res []device
	for _, k := range order {
		d := byDev[k]
		sort.Slice(d.Files, func(a, b int) bool { return d.Files[a].MTime > d.Files[b].MTime })
		res = append(res, *d)
	}
	return res, nil
}

var mtpMu sync.Mutex

func readMTP(id string) ([]byte, error) {
	p := strings.Split(id, "\x1f")
	if len(p) != 6 || p[0] != "mtp" {
		return nil, errors.New("bad id")
	}
	mtpMu.Lock()
	defer mtpMu.Unlock()
	tmp, err := os.MkdirTemp("", "velofix-mtp-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	out, err := powershell(psCopy, map[string]string{"VF_DEV": p[1], "VF_ST": p[2], "VF_REL": p[3], "VF_NAME": p[4], "VF_SIZE": p[5], "VF_OUT": tmp}, 90*time.Second)
	if err != nil {
		return nil, err
	}
	path := strings.TrimSpace(strings.TrimPrefix(string(out), "\ufeff"))
	if !strings.HasPrefix(strings.ToLower(path), strings.ToLower(tmp)) {
		return nil, errors.New("copy failed")
	}
	return os.ReadFile(path)
}

// ---------- HTTP ----------
func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

// API is only for our own page: right Host (no DNS rebinding) and a custom header (forces CORS preflight, which we never answer).
func guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "127.0.0.1:"+port || r.Header.Get("X-VeloFix") != "1" {
			http.Error(w, "forbidden", 403)
			return
		}
		h(w, r)
	}
}

func main() {
	kernel32.NewProc("SetErrorMode").Call(0x0001 | 0x8000) // no "insert disk" popups while scanning drives
	delay := false
	for _, a := range os.Args[1:] {
		if a == "--after-update" {
			delay = true
		}
	}
	if delay {
		time.Sleep(1500 * time.Millisecond) // let the old instance release the port
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	dataDir = filepath.Join(base, "VeloFix")
	os.MkdirAll(dataDir, 0o755)
	profile := filepath.Join(dataDir, "window-profile")
	if exe := exePath(); exe != "" {
		os.Remove(strings.TrimSuffix(exe, filepath.Ext(exe)) + ".old.exe") // leftover from a previous update
	}
	go firstRunShortcut()

	appURL := ""
	var ln net.Listener
	var err error
	for k := 0; k < 10; k++ {
		ln, err = net.Listen("tcp", "127.0.0.1:"+port)
		if err == nil || !delay {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	quit := make(chan struct{})
	var quitOnce sync.Once
	stop := func() { quitOnce.Do(func() { close(quit) }) }
	if err == nil {
		mux := http.NewServeMux()
		mux.HandleFunc("/velofix-id", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "velofix "+appVersion) })
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(page)
		})
		mux.HandleFunc("/api/info", guard(func(w http.ResponseWriter, r *http.Request) {
			exe := exePath()
			jsonOut(w, map[string]any{"version": appVersion, "exe": exe, "fromTemp": runningFromTemp(exe), "updateReady": updReady})
		}))
		mux.HandleFunc("/api/shortcut", guard(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" {
				http.Error(w, "POST", 405)
				return
			}
			if err := makeShortcut(); err != nil {
				jsonOut(w, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			os.WriteFile(filepath.Join(dataDir, "shortcut.done"), []byte(exePath()), 0o644)
			jsonOut(w, map[string]any{"ok": true})
		}))
		mux.HandleFunc("/api/update", guard(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" {
				http.Error(w, "POST", 405)
				return
			}
			v, err := doUpdate()
			if err != nil {
				jsonOut(w, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			jsonOut(w, map[string]any{"ok": true, "version": v})
		}))
		mux.HandleFunc("/api/restart", guard(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" || updReady == "" {
				http.Error(w, "no update", 400)
				return
			}
			cmd := exec.Command(exePath(), "--after-update")
			if err := cmd.Start(); err != nil {
				jsonOut(w, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			jsonOut(w, map[string]any{"ok": true})
			go func() { time.Sleep(300 * time.Millisecond); stop() }()
		}))
		mux.HandleFunc("/api/route", guard(func(w http.ResponseWriter, r *http.Request) {
			u, err := url.Parse(r.URL.Query().Get("u"))
			if err != nil || u.Scheme != "https" || (u.Host != "routing.openstreetmap.de" && u.Host != "brouter.de") {
				http.Error(w, "bad url", 400)
				return
			}
			cl := &http.Client{Timeout: 20 * time.Second}
			req, _ := http.NewRequest("GET", u.String(), nil)
			req.Header.Set("User-Agent", "VELO-FIX/"+appVersion+" (github.com/"+repo+")")
			resp, err := cl.Do(req)
			if err != nil {
				http.Error(w, err.Error(), 502)
				return
			}
			defer resp.Body.Close()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, io.LimitReader(resp.Body, 20<<20))
		}))
		mux.HandleFunc("/api/overpass", guard(func(w http.ResponseWriter, r *http.Request) {
			ep := r.URL.Query().Get("ep")
			if ep != "https://maps.mail.ru/osm/tools/overpass/api/interpreter" && ep != "https://overpass-api.de/api/interpreter" && ep != "https://overpass.kumi.systems/api/interpreter" {
				http.Error(w, "bad endpoint", 400)
				return
			}
			q, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
			cl := &http.Client{Timeout: 60 * time.Second}
			req, _ := http.NewRequest("POST", ep, strings.NewReader("data="+url.QueryEscape(string(q))))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			req.Header.Set("User-Agent", "VELO-FIX/"+appVersion+" (github.com/"+repo+")")
			resp, err := cl.Do(req)
			if err != nil {
				http.Error(w, err.Error(), 502)
				return
			}
			defer resp.Body.Close()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, io.LimitReader(resp.Body, 200<<20))
		}))
		mux.HandleFunc("/api/devices", guard(func(w http.ResponseWriter, r *http.Request) {
			devs := scanDrives()
			res := map[string]any{"devices": devs}
			if r.URL.Query().Get("mtp") == "1" {
				m, err := scanMTP()
				if err != nil {
					res["mtpError"] = err.Error()
				}
				res["devices"] = append(devs, m...)
			}
			jsonOut(w, res)
		}))
		mux.HandleFunc("/api/devfile", guard(func(w http.ResponseWriter, r *http.Request) {
			id := r.URL.Query().Get("id")
			var b []byte
			var err error
			if strings.HasPrefix(id, "mtp\x1f") {
				b, err = readMTP(id)
			} else if validDrivePath(id) {
				b, err = os.ReadFile(id)
			} else {
				err = errors.New("bad id")
			}
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write(b)
		}))
		go http.Serve(ln, mux)
		appURL = "http://127.0.0.1:" + port + "/"
	} else if ours("http://127.0.0.1:" + port + "/") {
		appURL = "http://127.0.0.1:" + port + "/" // reuse running instance's server
	}

	if appURL == "" { // port taken by something else: fall back to a local file
		htmlPath := filepath.Join(dataDir, "VELO_FIX-"+appVersion+".html")
		if err := os.WriteFile(htmlPath, page, 0o644); err != nil {
			messageBox("Не удалось подготовить программу:\n"+err.Error(), "VELO FIX", 0x10)
			return
		}
		appURL = (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(htmlPath)}).String()
	}

	for _, b := range browsers() {
		cmd := exec.Command(b, "--app="+appURL, "--user-data-dir="+profile, "--window-size=1200,900",
			"--no-first-run", "--no-default-browser-check", "--disable-sync")
		if err := cmd.Start(); err == nil {
			if ln != nil {
				go func() {
					cmd.Wait()
					// keep serving while any window of our profile is still open (Wait may return early
					// if the browser hands off to an existing process)
					time.Sleep(3 * time.Second)
					for alive(profile) {
						time.Sleep(5 * time.Second)
					}
					stop()
				}()
				<-quit
			}
			return
		}
	}
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", appURL).Start(); err != nil {
		messageBox("Не найден браузер для запуска.", "VELO FIX", 0x30)
		return
	}
	if ln != nil {
		select {
		case <-quit:
		case <-time.After(12 * time.Hour):
		}
	}
}

// alive reports whether the browser still holds the profile lock file.
func alive(profile string) bool {
	lock := filepath.Join(profile, "lockfile")
	if !exists(lock) {
		return false
	}
	f, err := os.OpenFile(lock, os.O_RDWR, 0)
	if err != nil {
		return true // locked by a running browser
	}
	f.Close()
	return false
}
