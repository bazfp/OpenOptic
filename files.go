package main

// Roll output: the page streams finished files here so they land directly in the roll folder
// (no browser download prompts) and the browser can release each frame once it is on disk.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// File names: letters, digits, space . _ - + ( ), a known extension, nothing path-like.
var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._\-+() ]{0,150}\.(tif|tiff|json|jpg|png)$`)

const maxSaveBytes = 2 << 30 // 2 GiB, well above a full raw frame (217 MB)

func defaultOutputDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, "Pictures", "OpenOptic")
	}
	return "OpenOptic"
}

func checkDir(dir string) (string, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return "", errors.New("folder must be an absolute path")
	}
	return filepath.Clean(dir), nil
}

func checkName(name string) error {
	if !safeName.MatchString(name) || strings.Contains(name, "..") {
		return fmt.Errorf("unsafe file name %q", name)
	}
	return nil
}

// POST /api/files/check  {"dir": "...", "names": ["a.tif", ...]}  ->  {"dir": "...", "existing": [...]}
func handleFilesCheck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir   string   `json:"dir"`
		Names []string `json:"names"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	dir, err := checkDir(req.Dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	existing := []string{}
	for _, n := range req.Names {
		if err := checkName(n); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, err := os.Stat(filepath.Join(dir, n)); err == nil {
			existing = append(existing, n)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"dir": dir, "existing": existing})
}

// POST /api/files/save?dir=...&name=...&overwrite=0|1   body = file bytes
// Writes to a temporary file in the same folder, syncs, then renames into place, so a crash
// never leaves a half-written TIFF under the final name. Returns path, size and SHA-256.
func handleFilesSave(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dir, err := checkDir(q.Get("dir"))
	if err == nil {
		err = checkName(q.Get("name"))
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	final := filepath.Join(dir, q.Get("name"))
	overwrite := q.Get("overwrite") == "1"
	if _, err := os.Stat(final); err == nil && !overwrite {
		http.Error(w, "file already exists: "+final, http.StatusConflict)
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, "cannot create folder: "+err.Error(), http.StatusInternalServerError)
		return
	}
	giveBackToUser(dir)
	rnd := make([]byte, 6)
	rand.Read(rnd)
	tmp := filepath.Join(dir, "."+q.Get("name")+".partial-"+hex.EncodeToString(rnd))
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		http.Error(w, "cannot write in folder: "+err.Error(), http.StatusInternalServerError)
		return
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r.Body, maxSaveBytes+1))
	if err == nil && n > maxSaveBytes {
		err = errors.New("file too large")
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && !overwrite {
		if _, serr := os.Stat(final); serr == nil {
			err = errors.New("file appeared while saving: " + final)
		}
	}
	if err == nil {
		err = os.Rename(tmp, final)
	}
	if err == nil {
		giveBackToUser(final)
	}
	if err != nil {
		os.Remove(tmp)
		http.Error(w, "save failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"path": final, "bytes": n, "sha256": hex.EncodeToString(h.Sum(nil))})
}

// ---------------------------------------------------------------- folder chooser

type dirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func roots() []dirEntry {
	var r []dirEntry
	if h, err := os.UserHomeDir(); err == nil {
		r = append(r, dirEntry{"Home", h})
		for _, sub := range []string{"Pictures", "Desktop", "Documents"} {
			if st, err := os.Stat(filepath.Join(h, sub)); err == nil && st.IsDir() {
				r = append(r, dirEntry{sub, filepath.Join(h, sub)})
			}
		}
	}
	if filepath.Separator == '\\' {
		for c := 'A'; c <= 'Z'; c++ {
			d := string(c) + `:\`
			if _, err := os.Stat(d); err == nil {
				r = append(r, dirEntry{d, d})
			}
		}
	} else {
		r = append(r, dirEntry{"/", "/"})
		for _, m := range []string{"/Volumes", "/media", "/mnt", "/run/media"} {
			if st, err := os.Stat(m); err == nil && st.IsDir() {
				r = append(r, dirEntry{m, m})
			}
		}
	}
	return r
}

// POST /api/files/list {"dir": "..."} -> sub-folders (no hidden ones), roots, and how many TIFFs
// the folder already holds, for the page's folder chooser. A missing folder lists its nearest
// existing parent so a typed-but-not-yet-created roll folder can still be browsed.
func handleFilesList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir string `json:"dir"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
	dir := req.Dir
	if dir == "" || !filepath.IsAbs(dir) {
		dir = defaultOutputDir()
	}
	dir = filepath.Clean(dir)
	for {
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			break
		}
		p := filepath.Dir(dir)
		if p == dir {
			break
		}
		dir = p
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, "cannot read folder: "+err.Error(), http.StatusForbidden)
		return
	}
	dirs, tifs := []dirEntry{}, 0
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, ".") || strings.HasPrefix(n, "$") {
			continue
		}
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			if st, err := os.Stat(filepath.Join(dir, n)); err == nil {
				isDir = st.IsDir()
			}
		}
		if isDir {
			dirs = append(dirs, dirEntry{n, filepath.Join(dir, n)})
		} else if l := strings.ToLower(n); strings.HasSuffix(l, ".tif") || strings.HasSuffix(l, ".tiff") {
			tifs++
		}
	}
	parent := filepath.Dir(dir)
	if parent == dir {
		parent = ""
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"dir": dir, "requested": filepath.Clean(req.Dir), "parent": parent,
		"dirs": dirs, "tiffs": tifs, "roots": roots(), "sep": string(filepath.Separator), "native": nativePickerAvailable()})
}

var safeFolder = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._\-+() ]{0,100}$`)

// POST /api/files/mkdir {"dir": parent, "name": new folder name}
func handleFilesMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir, Name string }
	json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
	dir, err := checkDir(req.Dir)
	if err == nil && (!safeFolder.MatchString(req.Name) || strings.Contains(req.Name, "..")) {
		err = fmt.Errorf("unsafe folder name %q", req.Name)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	p := filepath.Join(dir, req.Name)
	if err := os.MkdirAll(p, 0o755); err != nil {
		http.Error(w, "cannot create folder: "+err.Error(), http.StatusInternalServerError)
		return
	}
	giveBackToUser(p)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"dir": p})
}

// POST /api/files/pickdir {"dir": start} -> {"dir": chosen} | {"cancelled": true}
// Opens the operating system's own folder dialog on this computer.
func handleFilesPickDir(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir string }
	json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req)
	start := req.Dir
	if start == "" || !filepath.IsAbs(start) {
		start = defaultOutputDir()
	}
	for { // the dialogs need an existing start folder
		if st, err := os.Stat(start); err == nil && st.IsDir() {
			break
		}
		p := filepath.Dir(start)
		if p == start {
			break
		}
		start = p
	}
	dir, ok, err := nativePickDir(start)
	w.Header().Set("Content-Type", "application/json")
	switch {
	case err != nil:
		http.Error(w, err.Error(), http.StatusNotImplemented)
	case !ok:
		json.NewEncoder(w).Encode(map[string]any{"cancelled": true})
	default:
		json.NewEncoder(w).Encode(map[string]any{"dir": dir})
	}
}
