//go:build linux && !sim

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const backendName = "usbfs"

// usbfs structures from <linux/usbdevice_fs.h>; Go's natural alignment matches the C layout.
type usbCtrlTransfer struct {
	RequestType uint8
	Request     uint8
	Value       uint16
	Index       uint16
	Length      uint16
	Timeout     uint32
	Data        unsafe.Pointer
}

type usbBulkTransfer struct {
	Ep      uint32
	Len     uint32
	Timeout uint32
	Data    unsafe.Pointer
}

type usbIoctl struct {
	Ifno int32
	Code int32
	Data unsafe.Pointer
}

func ioc(dir, nr, size uintptr) uintptr { return dir<<30 | size<<16 | 'U'<<8 | nr }

var (
	ioControl    = ioc(3, 0, unsafe.Sizeof(usbCtrlTransfer{}))
	ioBulk       = ioc(3, 2, unsafe.Sizeof(usbBulkTransfer{}))
	ioClaim      = ioc(2, 15, 4)
	ioRelease    = ioc(2, 16, 4)
	ioIoctl      = ioc(3, 18, unsafe.Sizeof(usbIoctl{}))
	ioDisconnect = ioc(0, 22, 0)
)

type linuxDev struct{ fd int }

func ioctl(fd int, req uintptr, arg unsafe.Pointer) (int, error) {
	r, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), req, uintptr(arg))
	if e != 0 {
		return 0, e
	}
	return int(r), nil
}

func readSys(dir, name string) string {
	b, _ := os.ReadFile(filepath.Join(dir, name))
	return strings.TrimSpace(string(b))
}

func findDevNode(vid, pid uint16) (string, error) {
	matches, _ := filepath.Glob("/sys/bus/usb/devices/*/idVendor")
	for _, m := range matches {
		dir := filepath.Dir(m)
		v, _ := strconv.ParseUint(readSys(dir, "idVendor"), 16, 16)
		p, _ := strconv.ParseUint(readSys(dir, "idProduct"), 16, 16)
		if uint16(v) != vid || uint16(p) != pid {
			continue
		}
		bus, _ := strconv.Atoi(readSys(dir, "busnum"))
		dev, _ := strconv.Atoi(readSys(dir, "devnum"))
		return fmt.Sprintf("/dev/bus/usb/%03d/%03d", bus, dev), nil
	}
	return "", fmt.Errorf("scanner %04x:%04x not found - is it plugged in and switched on?", vid, pid)
}

func openDevice(vid, pid uint16) (Device, error) {
	path, err := findDevNode(vid, pid)
	if err != nil {
		return nil, err
	}
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
			return nil, fmt.Errorf("no permission to open %s.%s", path, accessHint())
		}
		return nil, fmt.Errorf("opening %s: %v", path, err)
	}
	d := &linuxDev{fd: fd}
	ifno := uint32(0)
	if _, err := ioctl(fd, ioClaim, unsafe.Pointer(&ifno)); err != nil {
		if errors.Is(err, syscall.EBUSY) {
			// A kernel driver owns the interface; detach it and try again.
			io := usbIoctl{Ifno: 0, Code: int32(ioDisconnect)}
			ioctl(fd, ioIoctl, unsafe.Pointer(&io))
			_, err = ioctl(fd, ioClaim, unsafe.Pointer(&ifno))
		}
		if err != nil {
			syscall.Close(fd)
			return nil, fmt.Errorf("claiming interface 0: %v (is another program such as SANE using the scanner?)", err)
		}
	}
	return d, nil
}

func mapErr(err error) error {
	switch {
	case errors.Is(err, syscall.EPIPE):
		return ErrStall
	case errors.Is(err, syscall.ETIMEDOUT):
		return errors.New("USB transfer timed out")
	case errors.Is(err, syscall.ENODEV):
		return errors.New("scanner disconnected")
	case errors.Is(err, syscall.EOVERFLOW):
		return errors.New("USB overflow: the scanner sent more data than this read asked for")
	}
	return err
}

func bufPtr(b []byte) unsafe.Pointer {
	if len(b) == 0 {
		return nil
	}
	return unsafe.Pointer(&b[0])
}

func (d *linuxDev) Control(rt, req uint8, val, idx uint16, data []byte, timeout time.Duration) (int, error) {
	ct := usbCtrlTransfer{rt, req, val, idx, uint16(len(data)), uint32(timeout.Milliseconds()), bufPtr(data)}
	n, err := ioctl(d.fd, ioControl, unsafe.Pointer(&ct))
	runtime.KeepAlive(data)
	return n, mapErr(err)
}

func (d *linuxDev) Bulk(ep uint8, data []byte, timeout time.Duration) (int, error) {
	bt := usbBulkTransfer{uint32(ep), uint32(len(data)), uint32(timeout.Milliseconds()), bufPtr(data)}
	n, err := ioctl(d.fd, ioBulk, unsafe.Pointer(&bt))
	runtime.KeepAlive(data)
	if err != nil {
		return n, fmt.Errorf("bulk %s endpoint 0x%02x, %d bytes: %w", map[bool]string{true: "read", false: "write"}[ep&0x80 != 0], ep, len(data), mapErr(err))
	}
	return n, nil
}

func (d *linuxDev) Close() error {
	ifno := uint32(0)
	ioctl(d.fd, ioRelease, unsafe.Pointer(&ifno))
	return syscall.Close(d.fd)
}
