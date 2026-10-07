// OpenOptic: a single-file helper that serves the OpticFilm 7600i roll-scanner page on 127.0.0.1 and
// performs its USB traffic natively (usbfs on Linux, WinUSB on Windows, IOKit on macOS),
// so any browser works and no WebUSB support is needed.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"sync"
	"time"

	_ "embed"
)

//go:embed ui.html
var uiHTML []byte

//go:embed capture_profiles.js
var captureProfiles []byte

//go:embed capture_runtime.js
var captureRuntime []byte

//go:embed roll.js
var rollJS []byte

//go:embed capture_sim.js
var captureSim []byte

//go:embed motion.js
var motionJS []byte

//go:embed enhance.js
var enhanceJS []byte

const (
	scannerVID  = 0x07B3
	scannerPID  = 0x0C3B
	ctlTimeout  = 5 * time.Second
	bulkTimeout = 60 * time.Second
	maxTransfer = 1 << 20
)

// Device is the small USB surface the scanner page needs. Each OS provides openDevice.
type Device interface {
	// Control performs a control transfer. Direction comes from bit 7 of rt; for IN
	// transfers data is filled, for OUT transfers data is sent. Returns bytes moved.
	Control(rt, req uint8, val, idx uint16, data []byte, timeout time.Duration) (int, error)
	// Bulk performs a bulk transfer on endpoint address ep (bit 7 set = IN).
	Bulk(ep uint8, data []byte, timeout time.Duration) (int, error)
	Close() error
}

// ErrStall is returned when the device stalls an endpoint (WebUSB status "stall").
var ErrStall = errors.New("endpoint stalled")

// ErrTimeout is returned when a transfer times out. For interrupt reads it only means the
// scanner had nothing to report.
var ErrTimeout = errors.New("USB transfer timed out")

// interruptReader is implemented by backends that can read the scanner's interrupt endpoint
// with a timeout (Linux usbfs, Windows WinUSB). The scanner reports events there: a one-byte
// 0x08 when the first positioning move reaches its stop point, and presumably the front buttons.
type interruptReader interface {
	Interrupt(ep uint8, data []byte, timeout time.Duration) (int, error)
}

type Endpoint struct {
	EndpointNumber int    `json:"endpointNumber"`
	Direction      string `json:"direction"`
	Type           string `json:"type"`
	PacketSize     int    `json:"packetSize"`
}

type OpenInfo struct {
	Backend     string     `json:"backend"`
	ProductName string     `json:"productName"`
	BcdDevice   uint16     `json:"bcdDevice"`
	Endpoints   []Endpoint `json:"endpoints"`
}

// describe reads the device, string and configuration descriptors with standard requests,
// which works identically on every backend.
func describe(d Device) (*OpenInfo, error) {
	dd := make([]byte, 18)
	n, err := d.Control(0x80, 6, 0x0100, 0, dd, ctlTimeout)
	if err != nil || n < 18 {
		return nil, fmt.Errorf("reading device descriptor: %v", orShort(err))
	}
	info := &OpenInfo{Backend: backendName, BcdDevice: binary.LittleEndian.Uint16(dd[12:])}
	if b, ok := d.(interface{ Backend() string }); ok {
		info.Backend = b.Backend()
	}
	if iProduct := dd[15]; iProduct != 0 {
		sd := make([]byte, 255)
		if n, err := d.Control(0x80, 6, 0x0300|uint16(iProduct), 0x0409, sd, ctlTimeout); err == nil && n > 2 {
			u := make([]rune, 0, (n-2)/2)
			for i := 2; i+1 < n; i += 2 {
				u = append(u, rune(binary.LittleEndian.Uint16(sd[i:])))
			}
			info.ProductName = string(u)
		}
	}
	hdr := make([]byte, 9)
	if n, err := d.Control(0x80, 6, 0x0200, 0, hdr, ctlTimeout); err != nil || n < 9 {
		return nil, fmt.Errorf("reading configuration descriptor: %v", orShort(err))
	}
	cfg := make([]byte, binary.LittleEndian.Uint16(hdr[2:]))
	n, err = d.Control(0x80, 6, 0x0200, 0, cfg, ctlTimeout)
	if err != nil {
		return nil, fmt.Errorf("reading configuration descriptor: %v", err)
	}
	info.Endpoints = parseEndpoints(cfg[:n])
	return info, nil
}

func orShort(err error) error {
	if err == nil {
		return errors.New("short read")
	}
	return err
}

// parseEndpoints returns the endpoints of interface 0, alternate setting 0.
func parseEndpoints(cfg []byte) []Endpoint {
	eps := []Endpoint{}
	inTarget := false
	for i := 0; i+2 <= len(cfg); {
		l := int(cfg[i])
		if l < 2 || i+l > len(cfg) {
			break
		}
		switch cfg[i+1] {
		case 4: // interface
			inTarget = l >= 4 && cfg[i+2] == 0 && cfg[i+3] == 0
		case 5: // endpoint
			if inTarget && l >= 7 {
				addr := cfg[i+2]
				e := Endpoint{
					EndpointNumber: int(addr & 0x0F),
					Direction:      "out",
					Type:           [...]string{"control", "isochronous", "bulk", "interrupt"}[cfg[i+3]&3],
					PacketSize:     int(binary.LittleEndian.Uint16(cfg[i+4:]) & 0x7FF),
				}
				if addr&0x80 != 0 {
					e.Direction = "in"
				}
				eps = append(eps, e)
			}
		}
		i += l
	}
	return eps
}

type server struct {
	mu     sync.Mutex
	intrMu sync.Mutex // held during an interrupt read; closeDev waits for it
	dev    Device
	token  string
	port   int
	outDir string
}

func (s *server) closeDev() {
	if s.dev != nil {
		// let a pending interrupt read (at most intrMaxWait) finish before the device goes away
		s.intrMu.Lock()
		defer s.intrMu.Unlock()
		s.dev.Close()
		s.dev = nil
	}
}

func (s *server) handleOpen(w http.ResponseWriter, r *http.Request) {
	s.closeDev()
	d, err := openDevice(scannerVID, scannerPID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	info, err := describe(d)
	if err != nil {
		d.Close()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.dev = d
	log.Printf("opened %s (bcdDevice %x) via %s, %d endpoints", info.ProductName, info.BcdDevice, info.Backend, len(info.Endpoints))
	json.NewEncoder(w).Encode(info)
}

func qint(r *http.Request, name string, bits int) (uint64, error) {
	v, err := strconv.ParseUint(r.URL.Query().Get(name), 0, bits)
	if err != nil {
		return 0, fmt.Errorf("bad parameter %s", name)
	}
	return v, nil
}

func (s *server) transferResult(w http.ResponseWriter, data []byte, n int, err error) {
	switch {
	case errors.Is(err, ErrStall):
		http.Error(w, "stall", http.StatusConflict)
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data[:n])
	}
}

func readBody(r *http.Request) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, maxTransfer+1))
	if len(b) > maxTransfer {
		return nil, errors.New("transfer too large")
	}
	return b, err
}

func (s *server) handleCtl(w http.ResponseWriter, r *http.Request) {
	rt, e1 := qint(r, "rt", 8)
	req, e2 := qint(r, "req", 8)
	val, e3 := qint(r, "val", 16)
	idx, e4 := qint(r, "idx", 16)
	if err := errors.Join(e1, e2, e3, e4); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var data []byte
	if rt&0x80 != 0 {
		l, err := qint(r, "len", 16)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		data = make([]byte, l)
	} else {
		var err error
		if data, err = readBody(r); err != nil || len(data) > 0xFFFF {
			http.Error(w, "bad control payload", http.StatusBadRequest)
			return
		}
	}
	n, err := s.dev.Control(uint8(rt), uint8(req), uint16(val), uint16(idx), data, ctlTimeout)
	if rt&0x80 == 0 {
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
		data, n = nil, 0 // OUT transfers answer with an empty body
	}
	s.transferResult(w, data, n, err)
}

func (s *server) handleBulk(w http.ResponseWriter, r *http.Request) {
	ep, err := qint(r, "ep", 8)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var data []byte
	if ep&0x80 != 0 {
		l, err := qint(r, "len", 32)
		if err != nil || l > maxTransfer {
			http.Error(w, "bad len", http.StatusBadRequest)
			return
		}
		data = make([]byte, l)
	} else if data, err = readBody(r); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	n, err := s.dev.Bulk(uint8(ep), data, bulkTimeout)
	if ep&0x80 == 0 {
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
		data, n = nil, 0
	}
	s.transferResult(w, data, n, err)
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only answer requests addressed to this machine by name (blocks DNS-rebinding attacks).
	host, _, _ := net.SplitHostPort(r.Host)
	if host != "127.0.0.1" && host != "localhost" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/" && r.Method == http.MethodGet {
		inject := fmt.Sprintf("<script>window.NATIVE_USB={token:%q,defaultDir:%q,files:true};</script>\n</head>", s.token, s.outDir)
		page := bytes.Replace(uiHTML, []byte("</head>"), []byte(inject), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(page)
		return
	}
	if r.Method == http.MethodGet {
		scripts := map[string][]byte{"/capture_profiles.js": captureProfiles, "/capture_runtime.js": captureRuntime,
			"/roll.js": rollJS, "/capture_sim.js": captureSim, "/motion.js": motionJS, "/enhance.js": enhanceJS}
		if b, ok := scripts[r.URL.Path]; ok {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Write(b)
			return
		}
	}
	// API calls must carry the per-run token; a custom header also forces a CORS preflight,
	// which this server never approves, so other web pages cannot drive the scanner.
	if r.Method != http.MethodPost || r.Header.Get("X-Token") != s.token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// File output never touches USB, so it does not wait for (or block) scanner transfers.
	switch r.URL.Path {
	case "/api/files/check":
		handleFilesCheck(w, r)
		return
	case "/api/files/save":
		handleFilesSave(w, r)
		return
	case "/api/files/list":
		handleFilesList(w, r)
		return
	case "/api/files/roll":
		handleFilesRoll(w, r)
		return
	case "/api/files/preview":
		handleFilesPreview(w, r)
		return
	case "/api/files/trash":
		handleFilesTrash(w, r)
		return
	case "/api/files/mkdir":
		handleFilesMkdir(w, r)
		return
	case "/api/files/pickdir":
		handleFilesPickDir(w, r) // blocks until the dialog closes; outside the USB lock
		return
	case "/api/intr":
		s.handleIntr(w, r) // waits for a scanner event; outside the USB lock
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch r.URL.Path {
	case "/api/open":
		s.handleOpen(w, r)
	case "/api/close":
		s.closeDev()
	case "/api/ctl", "/api/bulk":
		if s.dev == nil {
			http.Error(w, "scanner not connected", http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path == "/api/ctl" {
			s.handleCtl(w, r)
		} else {
			s.handleBulk(w, r)
		}
	default:
		http.NotFound(w, r)
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

// version is set at build time: -ldflags "-X main.version=v1.2.3" (see Makefile and build.sh).
var version = "dev"

func main() {
	port := flag.Int("port", 47600, "port on 127.0.0.1 (a fixed port keeps saved calibration between runs)")
	noBrowser := flag.Bool("no-browser", false, "don't open a browser window")
	installUdev := flag.Bool("install-udev", false, "Linux: install the udev rule that lets you open the scanner without sudo, then exit")
	outDir := flag.String("out", defaultOutputDir(), "default folder for roll scans (can be changed on the page)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("openoptic", version)
		return
	}
	log.SetFlags(log.Ltime)

	tok := make([]byte, 16)
	rand.Read(tok)
	if *installUdev {
		fmt.Print(installUdevRule())
		return
	}
	s := &server{token: hex.EncodeToString(tok), outDir: *outDir}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Printf("port %d is busy (%v); using a random port - saved calibration will not carry over", *port, err)
		if ln, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			log.Fatal(err)
		}
	}
	s.port = ln.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://127.0.0.1:%d/", s.port)

	fmt.Printf("OpenOptic, roll scanner for the Plustek OpticFilm 7600i (%s backend)\n", backendName)
	fmt.Printf("Open %s in any browser. Leave this window open while scanning; press Ctrl+C to quit.\n", url)
	if !*noBrowser {
		if err := openBrowser(url); err != nil {
			log.Printf("could not open a browser automatically: %v", err)
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		<-sig
		s.mu.Lock()
		s.closeDev()
		os.Exit(0)
	}()
	log.Fatal((&http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}).Serve(ln))
}

const intrMaxWait = 2 * time.Second

// POST /api/intr?ep=0x83&len=1&timeout=1000 -> the event bytes, 204 if nothing arrived in time,
// 501 if this backend cannot read interrupt endpoints. It does not take the USB lock: an
// interrupt endpoint is polled by the host controller, so a pending read neither delays the
// page's control and bulk traffic nor loses an event (the scanner holds it until the next read).
func (s *server) handleIntr(w http.ResponseWriter, r *http.Request) {
	ep, e1 := qint(r, "ep", 8)
	l, e2 := qint(r, "len", 16)
	ms, e3 := qint(r, "timeout", 16)
	if err := errors.Join(e1, e2, e3); err != nil || ep&0x80 == 0 || l == 0 || l > 64 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	timeout := time.Duration(ms) * time.Millisecond
	if timeout <= 0 || timeout > intrMaxWait {
		timeout = intrMaxWait
	}
	if !s.intrMu.TryLock() {
		http.Error(w, "another interrupt read is pending", http.StatusTooManyRequests)
		return
	}
	defer s.intrMu.Unlock()
	s.mu.Lock()
	d := s.dev
	s.mu.Unlock()
	if d == nil {
		http.Error(w, "scanner not connected", http.StatusServiceUnavailable)
		return
	}
	ir, ok := d.(interruptReader)
	if !ok {
		http.Error(w, "the "+backendName+" backend cannot read the interrupt endpoint", http.StatusNotImplemented)
		return
	}
	data := make([]byte, l)
	n, err := ir.Interrupt(uint8(ep), data, timeout)
	if errors.Is(err, ErrTimeout) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.transferResult(w, data, n, err)
}
