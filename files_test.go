package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func save(t *testing.T, dir, name, body string, overwrite bool) *httptest.ResponseRecorder {
	q := url.Values{"dir": {dir}, "name": {name}}
	if overwrite {
		q.Set("overwrite", "1")
	}
	w := httptest.NewRecorder()
	handleFilesSave(w, httptest.NewRequest(http.MethodPost, "/api/files/save?"+q.Encode(), strings.NewReader(body)))
	return w
}

func TestSaveCheckAndNoClobber(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Roll 12") // created on first save
	w := save(t, dir, "Roll12_01.tif", "frame-one", false)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	var res struct {
		Path   string
		Bytes  int64
		Sha256 string
	}
	json.Unmarshal(w.Body.Bytes(), &res)
	sum := sha256.Sum256([]byte("frame-one"))
	if res.Bytes != 9 || res.Sha256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("bad result %+v", res)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "Roll12_01.tif")); string(b) != "frame-one" {
		t.Fatal("content")
	}
	if w := save(t, dir, "Roll12_01.tif", "other", false); w.Code != http.StatusConflict {
		t.Fatalf("expected 409 without overwrite, got %d", w.Code)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "Roll12_01.tif")); string(b) != "frame-one" {
		t.Fatal("refused save must not change the file")
	}
	if w := save(t, dir, "Roll12_01.tif", "rescan", true); w.Code != 200 {
		t.Fatal("overwrite")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "Roll12_01.tif")); string(b) != "rescan" {
		t.Fatal("overwrite content")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".partial-") {
			t.Fatal("temporary file left behind: " + e.Name())
		}
	}
	body, _ := json.Marshal(map[string]any{"dir": dir, "names": []string{"Roll12_01.tif", "Roll12_02.tif"}})
	cw := httptest.NewRecorder()
	handleFilesCheck(cw, httptest.NewRequest(http.MethodPost, "/api/files/check", strings.NewReader(string(body))))
	var chk struct{ Existing []string }
	json.Unmarshal(cw.Body.Bytes(), &chk)
	if len(chk.Existing) != 1 || chk.Existing[0] != "Roll12_01.tif" {
		t.Fatalf("check: %s", cw.Body)
	}
}

func TestRejectsUnsafePaths(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"../evil.tif", "a/b.tif", `a\b.tif`, ".hidden.tif", "x.exe", "..tif", "ok..tif", ""} {
		if w := save(t, dir, n, "x", false); w.Code != http.StatusBadRequest {
			t.Errorf("name %q accepted (%d)", n, w.Code)
		}
	}
	if w := save(t, "relative/dir", "a.tif", "x", false); w.Code != http.StatusBadRequest {
		t.Error("relative folder accepted")
	}
}

func post(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
	return w
}

func TestListAndMkdir(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "Roll041"), 0o755)
	os.MkdirAll(filepath.Join(root, ".hidden"), 0o755)
	os.WriteFile(filepath.Join(root, "a.tif"), []byte("x"), 0o644)
	js, _ := json.Marshal(map[string]string{"dir": root})
	var res struct {
		Dir, Parent string
		Dirs        []dirEntry
		Tiffs       int
		Roots       []dirEntry
	}
	json.Unmarshal(post(handleFilesList, string(js)).Body.Bytes(), &res)
	if res.Dir != root || len(res.Dirs) != 1 || res.Dirs[0].Name != "Roll041" || res.Tiffs != 1 || len(res.Roots) == 0 {
		t.Fatalf("list: %+v", res)
	}
	// a not-yet-created roll folder lists its nearest existing parent
	js, _ = json.Marshal(map[string]string{"dir": filepath.Join(root, "Roll042", "sub")})
	json.Unmarshal(post(handleFilesList, string(js)).Body.Bytes(), &res)
	if res.Dir != root {
		t.Fatalf("missing folder should list parent, got %s", res.Dir)
	}
	js, _ = json.Marshal(map[string]string{"dir": root, "name": "Roll 042"})
	if w := post(handleFilesMkdir, string(js)); w.Code != 200 {
		t.Fatalf("mkdir: %d %s", w.Code, w.Body)
	}
	if st, err := os.Stat(filepath.Join(root, "Roll 042")); err != nil || !st.IsDir() {
		t.Fatal("folder not created")
	}
	for _, bad := range []string{"../x", "a/b", `a\b`, ".x", ""} {
		js, _ = json.Marshal(map[string]string{"dir": root, "name": bad})
		if w := post(handleFilesMkdir, string(js)); w.Code != http.StatusBadRequest {
			t.Errorf("mkdir %q accepted", bad)
		}
	}
}

func TestSavedFilesKeepOwnershipHelper(t *testing.T) {
	// giveBackToUser must do nothing unless we are root via sudo; here it must not fail or change
	// ownership of a normal file.
	dir := t.TempDir()
	f := filepath.Join(dir, "a.tif")
	os.WriteFile(f, []byte("x"), 0o644)
	before, _ := os.Stat(f)
	giveBackToUser(f)
	after, _ := os.Stat(f)
	if before.Mode() != after.Mode() {
		t.Fatal("mode changed")
	}
	if _, _, ok := invokingUser(); ok && os.Getuid() != 0 {
		t.Fatal("invokingUser must report false when not root")
	}
}
