// VELO FIX — Windows launcher.
// Serves the embedded offline app on http://127.0.0.1 (so map tiles get a proper page origin)
// and opens it in its own window (Microsoft Edge / Google Chrome "app" mode).
// Falls back to a local file in the default browser. No installation, no admin rights.
package main

import (
	_ "embed"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

//go:embed VELO_FIX.html
var page []byte

const appVersion = "2.1.0"
const port = "47815"

func messageBox(text, title string, flags uintptr) {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	proc.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}

func exists(p string) bool { st, err := os.Stat(p); return err == nil && !st.IsDir() }

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

func main() {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "VeloFix")
	os.MkdirAll(dir, 0o755)
	profile := filepath.Join(dir, "window-profile")

	appURL := ""
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
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
		go http.Serve(ln, mux)
		appURL = "http://127.0.0.1:" + port + "/"
	} else if ours("http://127.0.0.1:" + port + "/") {
		appURL = "http://127.0.0.1:" + port + "/" // reuse running instance's server
	}

	if appURL == "" { // port taken by something else: fall back to a local file
		htmlPath := filepath.Join(dir, "VELO_FIX-"+appVersion+".html")
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
				cmd.Wait()
				// keep serving while any window of our profile is still open (Wait may return early
				// if the browser hands off to an existing process)
				time.Sleep(3 * time.Second)
				for alive(profile) {
					time.Sleep(5 * time.Second)
				}
			}
			return
		}
	}
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", appURL).Start(); err != nil {
		messageBox("Не найден браузер для запуска.", "VELO FIX", 0x30)
		return
	}
	if ln != nil {
		time.Sleep(12 * time.Hour)
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
