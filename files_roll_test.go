package main

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// a TIFF laid out as the page writes it (header + IFD, data in one strip), via a tiny writer
func writeTestTiff(t *testing.T, path string, w, h, spp int, px func(x, y, c int) uint16) {
	le := binary.LittleEndian
	type ent struct{ tag, typ, count, val uint32 }
	dataOff := uint32(512)
	bpsOff := uint32(400)
	es := []ent{{256, 4, 1, uint32(w)}, {257, 4, 1, uint32(h)}, {258, 3, uint32(spp), bpsOff}, {259, 3, 1, 1}, {262, 3, 1, 2},
		{273, 4, 1, dataOff}, {277, 3, 1, uint32(spp)}, {278, 4, 1, uint32(h)}, {279, 4, 1, uint32(w * h * spp * 2)}, {284, 3, 1, 1}}
	b := make([]byte, int(dataOff)+w*h*spp*2)
	copy(b, "II*\x00")
	le.PutUint32(b[4:], 8)
	le.PutUint16(b[8:], uint16(len(es)))
	for i, e := range es {
		o := 10 + i*12
		le.PutUint16(b[o:], uint16(e.tag))
		le.PutUint16(b[o+2:], uint16(e.typ))
		le.PutUint32(b[o+4:], e.count)
		if e.typ == 3 && e.count == 1 {
			le.PutUint16(b[o+8:], uint16(e.val))
		} else {
			le.PutUint32(b[o+8:], e.val)
		}
	}
	for i := 0; i < spp; i++ {
		le.PutUint16(b[int(bpsOff)+i*2:], 16)
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			for c := 0; c < spp; c++ {
				le.PutUint16(b[int(dataOff)+((y*w+x)*spp+c)*2:], px(x, y, c))
			}
		}
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRollFromFolder(t *testing.T) {
	dir := t.TempDir()
	side := func(n int, base string) string {
		return `{"format":"x","frame":"` + base + `","number":` + string(rune('0'+n)) + `,"scanned":"2026-10-06T10:00:0` + string(rune('0'+n)) + `Z","film":"neg",
			"orientation":{"tiffTag":6},"files":[{"kind":"tiff","name":"` + base + `.tif","bytes":10}],"acquisition":{"profile":"Captured full frame 3600","registers":{"1":2}},
			"processing":{"channelShiftLines":[0,24.2,48.2],"channelShiftConfidence":[1,0.9,0.8],"multiExposure":{"mode":"range"},"infrared":null,"horizontalMirror":{"applied":true}}}`
	}
	os.WriteFile(filepath.Join(dir, "R_02.json"), []byte(side(2, "R_02")), 0o644)
	os.WriteFile(filepath.Join(dir, "R_01.json"), []byte(side(1, "R_01")), 0o644)
	os.WriteFile(filepath.Join(dir, "R_roll.json"), []byte(`{"roll":"R_","frames":[]}`), 0o644)
	os.WriteFile(filepath.Join(dir, "R_01_usbtrace.json"), []byte(`{"trace":[]}`), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.json"), []byte(`{"hello":1}`), 0o644)
	os.WriteFile(filepath.Join(dir, "broken.json"), []byte(`{`), 0o644)
	w := httptest.NewRecorder()
	handleFilesRoll(w, httptest.NewRequest(http.MethodPost, "/api/files/roll", strings.NewReader(`{"dir":`+strconvQuote(dir)+`}`)))
	if w.Code != 200 {
		t.Fatalf("roll: %d %s", w.Code, w.Body)
	}
	var res struct {
		Exists  bool             `json:"exists"`
		Frames  []map[string]any `json:"frames"`
		Skipped int              `json:"skipped"`
	}
	json.Unmarshal(w.Body.Bytes(), &res)
	if !res.Exists || len(res.Frames) != 2 || res.Frames[0]["frame"] != "R_01" || res.Frames[1]["frame"] != "R_02" || res.Skipped != 2 {
		t.Fatalf("frames: %s", w.Body)
	}
	if _, ok := res.Frames[0]["acquisition"].(map[string]any)["registers"]; ok {
		t.Fatal("register dumps must not be sent")
	}
	// missing folder: empty, not an error
	w = httptest.NewRecorder()
	handleFilesRoll(w, httptest.NewRequest(http.MethodPost, "/api/files/roll", strings.NewReader(`{"dir":`+strconvQuote(filepath.Join(dir, "nope"))+`}`)))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"exists":false`) {
		t.Fatalf("missing folder: %d %s", w.Code, w.Body)
	}
}

func TestPreviewFromTiff(t *testing.T) {
	dir := t.TempDir()
	// 10x7 RGBI: R = x*1000, G = y*1000, B = 500, I = 60000
	writeTestTiff(t, filepath.Join(dir, "R_01.tif"), 10, 7, 4, func(x, y, c int) uint16 {
		return [4]uint16{uint16(x * 1000), uint16(y * 1000), 500, 60000}[c]
	})
	call := func(name string, maxDim int) *httptest.ResponseRecorder {
		q := url.Values{"dir": {dir}, "name": {name}, "max": {strconvItoa(maxDim)}}
		w := httptest.NewRecorder()
		handleFilesPreview(w, httptest.NewRequest(http.MethodPost, "/api/files/preview?"+q.Encode(), nil))
		return w
	}
	w := call("R_01.tif", 64)
	b := w.Body.Bytes()
	if w.Code != 200 || string(b[:4]) != "OFPV" || binary.LittleEndian.Uint32(b[4:]) != 10 || binary.LittleEndian.Uint32(b[8:]) != 7 {
		t.Fatalf("full size: %d %q", w.Code, b[:12])
	}
	px := func(b []byte, w, h, c, x, y int) int { return int(binary.LittleEndian.Uint16(b[12+(c*w*h+y*w+x)*2:])) }
	if px(b, 10, 7, 0, 3, 2) != 3000 || px(b, 10, 7, 1, 3, 2) != 2000 || px(b, 10, 7, 2, 3, 2) != 500 {
		t.Fatal("RGB planes, infrared dropped")
	}
	// 10x7 into max 64 is 1:1; force 4:1 with a wider image
	writeTestTiff(t, filepath.Join(dir, "R_02.tif"), 300, 130, 3, func(x, y, c int) uint16 { return [3]uint16{uint16(x * 100), uint16(y * 100), 7}[c] })
	w = call("R_02.tif", 100)
	b = w.Body.Bytes()
	ow, oh := int(binary.LittleEndian.Uint32(b[4:])), int(binary.LittleEndian.Uint32(b[8:]))
	if w.Code != 200 || ow != 100 || oh != 44 {
		t.Fatalf("downsampled size %dx%d", ow, oh)
	}
	if px(b, ow, oh, 0, 0, 0) != 100 || px(b, ow, oh, 1, 0, 0) != 100 || px(b, ow, oh, 0, 99, 43) != 29800 || px(b, ow, oh, 1, 99, 43) != 12900 {
		t.Fatalf("box average: %d %d %d %d", px(b, ow, oh, 0, 0, 0), px(b, ow, oh, 1, 0, 0), px(b, ow, oh, 0, 99, 43), px(b, ow, oh, 1, 99, 43))
	}
	if call("../R_01.tif", 64).Code != 400 || call("R_01.json", 64).Code != 400 || call("nope.tif", 64).Code != 404 {
		t.Fatal("unsafe or missing names must be refused")
	}
	os.WriteFile(filepath.Join(dir, "x.tif"), []byte("MM\x00*junk"), 0o644)
	if call("x.tif", 64).Code != http.StatusUnsupportedMediaType {
		t.Fatal("foreign TIFF must be refused")
	}
}

func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }
func strconvItoa(i int) string     { b, _ := json.Marshal(i); return string(b) }
