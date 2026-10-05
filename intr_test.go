package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type fakeDev struct{ events chan byte }

func (d *fakeDev) Control(rt, req uint8, val, idx uint16, data []byte, _ time.Duration) (int, error) {
	if len(data) > 0 {
		data[0] = 1
	}
	return len(data), nil
}
func (d *fakeDev) Bulk(ep uint8, data []byte, _ time.Duration) (int, error) { return len(data), nil }
func (d *fakeDev) Close() error                                             { return nil }

type fakeIntrDev struct{ fakeDev }

func (d *fakeIntrDev) Interrupt(ep uint8, data []byte, timeout time.Duration) (int, error) {
	select {
	case v := <-d.events:
		data[0] = v
		return 1, nil
	case <-time.After(timeout):
		return 0, ErrTimeout
	}
}

func call(s *server, url string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, url, nil)
	req.Host = "127.0.0.1:1"
	req.Header.Set("X-Token", s.token)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

func TestInterruptEndpoint(t *testing.T) {
	dev := &fakeIntrDev{fakeDev{events: make(chan byte, 4)}}
	s := &server{token: "t", dev: dev}
	dev.events <- 0x08
	if w := call(s, "/api/intr?ep=0x83&len=1&timeout=500"); w.Code != 200 || w.Body.Len() != 1 || w.Body.Bytes()[0] != 0x08 {
		t.Fatalf("event: %d %x", w.Code, w.Body.Bytes())
	}
	if w := call(s, "/api/intr?ep=0x83&len=1&timeout=50"); w.Code != http.StatusNoContent {
		t.Fatalf("timeout should be 204, got %d", w.Code)
	}
	// a pending interrupt read must not hold the USB lock: control transfers keep flowing
	done := make(chan int)
	go func() { done <- call(s, "/api/intr?ep=0x83&len=1&timeout=800").Code }()
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	if w := call(s, "/api/ctl?rt=0xc0&req=12&val=0x8e&idx=0x20&len=1"); w.Code != 200 {
		t.Fatalf("control during interrupt wait: %d %s", w.Code, w.Body.String())
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatalf("control transfer waited for the interrupt read")
	}
	// a second concurrent interrupt read is refused rather than queued
	if w := call(s, "/api/intr?ep=0x83&len=1&timeout=100"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("second reader: %d", w.Code)
	}
	dev.events <- 0x11
	if c := <-done; c != 200 {
		t.Fatalf("pending read: %d", c)
	}
	// backends without interrupt support say so
	s2 := &server{token: "t", dev: &fakeDev{}}
	if w := call(s2, "/api/intr?ep=0x83&len=1&timeout=50"); w.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported backend: %d", w.Code)
	}
	if w := call(s2, "/api/intr?ep=0x03&len=1&timeout=50"); w.Code != http.StatusBadRequest {
		t.Fatalf("OUT endpoint accepted: %d", w.Code)
	}
}
