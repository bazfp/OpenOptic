package main

// Reading a roll back from its folder: the page rebuilds its roll list from the frame sidecars
// (<base>.json) on disk, and gets sharp previews of frames it has no preview for by asking the
// helper to downsample the saved TIFF.

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	maxSidecarBytes = 8 << 20 // a frame sidecar is ~50-200 kB
	maxRollFrames   = 5000
)

// Only what the roll list needs; registers, tables and lamp statistics stay on disk.
type sidecarSummary struct {
	Name        string `json:"name"`
	Format      string `json:"format"`
	Frame       string `json:"frame"`
	Number      *int   `json:"number"`
	Scanned     string `json:"scanned"`
	Film        string `json:"film"`
	Orientation struct {
		TiffTag int `json:"tiffTag"`
	} `json:"orientation"`
	Files       json.RawMessage `json:"files"`
	Acquisition struct {
		Profile           string `json:"profile"`
		IlluminationCheck *struct {
			Warning *string `json:"warning"`
		} `json:"illuminationCheck"`
	} `json:"acquisition"`
	Processing struct {
		ChannelShiftLines      json.RawMessage `json:"channelShiftLines"`
		ChannelShiftConfidence json.RawMessage `json:"channelShiftConfidence"`
		MultiExposure          *struct {
			Mode   string          `json:"mode"`
			Fusion json.RawMessage `json:"fusion"`
		} `json:"multiExposure"`
		Infrared *struct {
			Mode    string          `json:"mode"`
			Overlay json.RawMessage `json:"overlay,omitempty"`
		} `json:"infrared"`
		HorizontalMirror *struct {
			Applied bool `json:"applied"`
		} `json:"horizontalMirror"`
	} `json:"processing"`
}

// POST /api/files/roll {"dir": "..."} -> {"dir", "exists", "frames": [sidecar summaries], "skipped": n}
// Frame sidecars are the JSON files with a frame name, a number and a file list; the roll record
// (<roll>_roll.json), USB traces and anything unreadable are skipped.
func handleFilesRoll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	dir, err := checkDir(req.Dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	frames, skipped := []sidecarSummary{}, 0
	entries, err := os.ReadDir(dir)
	exists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		http.Error(w, "cannot read folder: "+err.Error(), http.StatusForbidden)
		return
	}
	for _, e := range entries {
		n := e.Name()
		l := strings.ToLower(n)
		if e.IsDir() || !strings.HasSuffix(l, ".json") || strings.HasSuffix(l, "_roll.json") || strings.HasSuffix(l, "_usbtrace.json") || checkName(n) != nil {
			continue
		}
		if len(frames) >= maxRollFrames {
			skipped++
			continue
		}
		s, ok := readSidecar(filepath.Join(dir, n))
		if !ok {
			skipped++
			continue
		}
		s.Name = n
		frames = append(frames, s)
	}
	sort.Slice(frames, func(i, j int) bool { return *frames[i].Number < *frames[j].Number })
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"dir": dir, "exists": exists, "frames": frames, "skipped": skipped})
}

func readSidecar(path string) (sidecarSummary, bool) {
	var s sidecarSummary
	f, err := os.Open(path)
	if err != nil {
		return s, false
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || st.Size() > maxSidecarBytes {
		return s, false
	}
	if json.NewDecoder(f).Decode(&s) != nil || s.Frame == "" || s.Number == nil || len(s.Files) < 2 || s.Files[0] != '[' {
		return s, false
	}
	return s, true
}

// POST /api/files/preview?dir=...&name=...&max=2400 -> a box-averaged downsample of a saved
// aligned TIFF: "OFPV", uint32 width, uint32 height, then the R, G and B planes as little-endian
// uint16 (an infrared 4th channel is dropped). Only this app's uncompressed 16-bit RGB(I) TIFFs.
func handleFilesPreview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dir, err := checkDir(q.Get("dir"))
	name := q.Get("name")
	if err != nil || checkName(name) != nil || !(strings.HasSuffix(strings.ToLower(name), ".tif") || strings.HasSuffix(strings.ToLower(name), ".tiff")) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	maxDim, _ := strconv.Atoi(q.Get("max"))
	if maxDim < 64 || maxDim > 8192 {
		maxDim = 2400
	}
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		http.Error(w, "cannot open "+name+": "+err.Error(), http.StatusNotFound)
		return
	}
	defer f.Close()
	out, ow, oh, err := tiffPreview(f, maxDim)
	if err != nil {
		http.Error(w, name+": "+err.Error(), http.StatusUnsupportedMediaType)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	hdr := make([]byte, 12)
	copy(hdr, "OFPV")
	binary.LittleEndian.PutUint32(hdr[4:], uint32(ow))
	binary.LittleEndian.PutUint32(hdr[8:], uint32(oh))
	w.Write(hdr)
	w.Write(out)
}

type tiffInfo struct {
	width, height, spp, rowsPerStrip int
	offsets, counts                  []int64
}

func readTiffInfo(f io.ReaderAt) (tiffInfo, error) {
	var t tiffInfo
	h := make([]byte, 8)
	if _, err := f.ReadAt(h, 0); err != nil {
		return t, err
	}
	if string(h[:4]) != "II*\x00" {
		return t, errors.New("not a little-endian TIFF")
	}
	le := binary.LittleEndian
	ifd := int64(le.Uint32(h[4:]))
	nb := make([]byte, 2)
	if _, err := f.ReadAt(nb, ifd); err != nil {
		return t, err
	}
	n := int(le.Uint16(nb))
	if n == 0 || n > 200 {
		return t, errors.New("bad IFD")
	}
	ent := make([]byte, n*12)
	if _, err := f.ReadAt(ent, ifd+2); err != nil {
		return t, err
	}
	// values: SHORT or LONG, inline when they fit in 4 bytes
	values := func(e []byte) ([]int64, error) {
		typ, count := le.Uint16(e[2:]), int(le.Uint32(e[4:]))
		size := map[uint16]int{3: 2, 4: 4}[typ]
		if size == 0 || count < 1 || count > 1<<20 {
			return nil, fmt.Errorf("unsupported tag type %d", typ)
		}
		raw := e[8:12]
		if size*count > 4 {
			raw = make([]byte, size*count)
			if _, err := f.ReadAt(raw, int64(le.Uint32(e[8:]))); err != nil {
				return nil, err
			}
		}
		v := make([]int64, count)
		for i := range v {
			if size == 2 {
				v[i] = int64(le.Uint16(raw[i*2:]))
			} else {
				v[i] = int64(le.Uint32(raw[i*4:]))
			}
		}
		return v, nil
	}
	t.spp, t.rowsPerStrip = 1, -1
	for i := 0; i < n; i++ {
		e := ent[i*12 : i*12+12]
		tag := le.Uint16(e)
		switch tag {
		case 256, 257, 258, 259, 273, 277, 278, 279, 284:
		default:
			continue
		}
		v, err := values(e)
		if err != nil {
			return t, err
		}
		switch tag {
		case 256:
			t.width = int(v[0])
		case 257:
			t.height = int(v[0])
		case 258:
			for _, b := range v {
				if b != 16 {
					return t, errors.New("not 16 bits per sample")
				}
			}
		case 259:
			if v[0] != 1 {
				return t, errors.New("compressed TIFF")
			}
		case 273:
			t.offsets = v
		case 277:
			t.spp = int(v[0])
		case 278:
			t.rowsPerStrip = int(v[0])
		case 279:
			t.counts = v
		case 284:
			if v[0] != 1 {
				return t, errors.New("planar TIFF")
			}
		}
	}
	if t.width < 1 || t.height < 1 || t.width > 1<<16 || t.height > 1<<16 || (t.spp != 3 && t.spp != 4) {
		return t, errors.New("not an RGB/RGBI image")
	}
	if len(t.offsets) == 0 || len(t.offsets) != len(t.counts) {
		return t, errors.New("missing strips")
	}
	var total int64
	for _, c := range t.counts {
		total += c
	}
	if total < int64(t.width)*int64(t.height)*int64(t.spp)*2 {
		return t, errors.New("image data shorter than its size")
	}
	return t, nil
}

// tiffPreview box-averages the image to fit maxDim, reading it once, row by row.
func tiffPreview(f *os.File, maxDim int) ([]byte, int, int, error) {
	t, err := readTiffInfo(f)
	if err != nil {
		return nil, 0, 0, err
	}
	k := (max(t.width, t.height) + maxDim - 1) / maxDim
	if k < 1 {
		k = 1
	}
	ow, oh := (t.width+k-1)/k, (t.height+k-1)/k
	// strips in order make one continuous sample stream
	readers := make([]io.Reader, len(t.offsets))
	for i := range t.offsets {
		readers[i] = io.NewSectionReader(f, t.offsets[i], t.counts[i])
	}
	src := bufio.NewReaderSize(io.MultiReader(readers...), 1<<20)
	row := make([]byte, t.width*t.spp*2)
	sums := make([]uint64, ow*3)
	planes := make([]byte, ow*oh*3*2)
	le := binary.LittleEndian
	for oy := 0; oy < oh; oy++ {
		clear(sums)
		rows := min(k, t.height-oy*k)
		for j := 0; j < rows; j++ {
			if _, err := io.ReadFull(src, row); err != nil {
				return nil, 0, 0, fmt.Errorf("reading row %d: %w", oy*k+j, err)
			}
			for x := 0; x < t.width; x++ {
				o, p := (x/k)*3, x*t.spp*2
				sums[o] += uint64(le.Uint16(row[p:]))
				sums[o+1] += uint64(le.Uint16(row[p+2:]))
				sums[o+2] += uint64(le.Uint16(row[p+4:]))
			}
		}
		for ox := 0; ox < ow; ox++ {
			cols := min(k, t.width-ox*k)
			n := uint64(rows * cols)
			for c := 0; c < 3; c++ {
				le.PutUint16(planes[(c*ow*oh+oy*ow+ox)*2:], uint16((sums[ox*3+c]+n/2)/n))
			}
		}
	}
	return planes, ow, oh, nil
}
