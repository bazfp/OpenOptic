//go:build windows

package main

// Backend for scanners bound to usbscan.sys, the Windows still-image USB driver that scanner
// driver packages install. It is driven through the documented IOCTLs in <usbscan.h>:
// vendor/class control transfers go through IOCTL_SEND_USB_REQUEST, bulk data through
// ReadFile/WriteFile on the device handle.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

// CTL_CODE(FILE_DEVICE_USB_SCAN=0x8000, IOCTL_INDEX=0x800+n, METHOD_BUFFERED, FILE_ANY_ACCESS)
func usbscanIoctl(n uint32) uint32 { return 0x8000<<16 | (0x800+n)<<2 }

var (
	ioctlGetDeviceDescriptor = usbscanIoctl(6)
	ioctlGetUsbDescriptor    = usbscanIoctl(8)
	ioctlSendUsbRequest      = usbscanIoctl(9)
	ioctlSetTimeout          = usbscanIoctl(11)
)

// GUID_DEVINTERFACE_IMAGE, registered by usbscan.sys for each device it drives.
var guidImage = winGUID{0x6BDD1FC6, 0x810F, 0x11D0, [8]byte{0xBE, 0xC7, 0x08, 0x00, 0x2B, 0xE2, 0x09, 0x2F}}

type ioBlockEx struct { // IO_BLOCK_EX
	Offset      uint32 // wValue
	Length      uint32 // wLength
	Data        unsafe.Pointer
	Index       uint32 // wIndex
	Request     uint8
	RequestType uint8
	DirIn       uint8
}

type usbscanDeviceDescriptor struct { // DEVICE_DESCRIPTOR
	VendorID, ProductID, BcdDevice, LanguageID uint16
}

type usbscanDev struct {
	h    syscall.Handle
	desc usbscanDeviceDescriptor
}

func (d *usbscanDev) Backend() string { return "usbscan" }

func openUsbscanPath(path string, vid, pid uint16) (*usbscanDev, error) {
	p, _ := syscall.UTF16PtrFromString(path)
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		0, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	d := &usbscanDev{h: h}
	var n uint32
	if err := syscall.DeviceIoControl(h, ioctlGetDeviceDescriptor, nil, 0,
		(*byte)(unsafe.Pointer(&d.desc)), uint32(unsafe.Sizeof(d.desc)), &n, nil); err != nil {
		syscall.CloseHandle(h)
		return nil, err
	}
	if d.desc.VendorID != vid || d.desc.ProductID != pid {
		syscall.CloseHandle(h)
		return nil, errors.New("different device")
	}
	// Read/write/event timeouts in seconds (USBSCAN_TIMEOUT).
	t := [3]uint32{60, 60, 60}
	syscall.DeviceIoControl(h, ioctlSetTimeout, (*byte)(unsafe.Pointer(&t)), uint32(unsafe.Sizeof(t)), nil, 0, &n, nil)
	return d, nil
}

func openUsbscan(vid, pid uint16) (Device, error) {
	var firstErr error
	note := func(err error) {
		if firstErr == nil && err != nil && err.Error() != "different device" {
			firstErr = err
		}
	}
	if path, _, err := findDevicePath(&guidImage, vid, pid); err == nil {
		d, err := openUsbscanPath(path, vid, pid)
		if err == nil {
			log.Printf("usbscan: opened %s", path)
			return d, nil
		}
		note(err)
	}
	// Older setups only expose the legacy \\.\UsbscanN names.
	for i := 0; i < 32; i++ {
		path := fmt.Sprintf(`\\.\Usbscan%d`, i)
		d, err := openUsbscanPath(path, vid, pid)
		if err == nil {
			log.Printf("usbscan: opened %s", path)
			return d, nil
		}
		if en, ok := err.(syscall.Errno); !ok || en != syscall.ERROR_FILE_NOT_FOUND {
			note(err)
		}
	}
	if firstErr != nil {
		return nil, fmt.Errorf("the scanner's driver would not open it (%v). Close SilverFast and any other scanning "+
			"software, then unplug and replug the scanner", firstErr)
	}
	return nil, errors.New("the scanner is on the usbscan driver, but its device handle could not be found")
}

func (d *usbscanDev) Control(rt, req uint8, val, idx uint16, data []byte, _ time.Duration) (int, error) {
	if rt == 0x80 && req == 6 {
		return d.descriptor(val, idx, data)
	}
	blk := ioBlockEx{Offset: uint32(val), Length: uint32(len(data)), Index: uint32(idx), Request: req, RequestType: rt}
	var out *byte
	var outLen uint32
	if len(data) > 0 {
		blk.Data = unsafe.Pointer(&data[0])
	}
	if rt&0x80 != 0 {
		blk.DirIn = 1
		if len(data) > 0 {
			out, outLen = &data[0], uint32(len(data))
		}
	}
	var n uint32
	err := syscall.DeviceIoControl(d.h, ioctlSendUsbRequest, (*byte)(unsafe.Pointer(&blk)), uint32(unsafe.Sizeof(blk)), out, outLen, &n, nil)
	runtime.KeepAlive(data)
	if err != nil {
		return 0, mapErr(err)
	}
	if rt&0x80 == 0 || n == 0 {
		// OUT transfers move the whole payload; some usbscan versions report 0 for IN.
		return len(data), nil
	}
	return int(n), nil
}

// descriptor serves standard GET_DESCRIPTOR requests, which usbscan only allows through
// IOCTL_GET_USB_DESCRIPTOR. If even that is refused, it falls back to what the driver reports
// about the device plus the scanner's known endpoint layout (bulk IN 1, bulk OUT 2).
func (d *usbscanDev) descriptor(val, idx uint16, data []byte) (int, error) {
	in := [4]byte{byte(val >> 8), byte(val), byte(idx), byte(idx >> 8)} // GET_USB_DESCRIPTOR
	var n uint32
	if len(data) > 0 {
		err := syscall.DeviceIoControl(d.h, ioctlGetUsbDescriptor, &in[0], 4, &data[0], uint32(len(data)), &n, nil)
		if err == nil && n > 0 {
			return int(n), nil
		}
	}
	switch val >> 8 {
	case 1:
		dd := []byte{18, 1, 0x00, 0x02, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}
		binary.LittleEndian.PutUint16(dd[8:], d.desc.VendorID)
		binary.LittleEndian.PutUint16(dd[10:], d.desc.ProductID)
		binary.LittleEndian.PutUint16(dd[12:], d.desc.BcdDevice)
		return copy(data, dd), nil
	case 2:
		cfg := []byte{
			9, 2, 32, 0, 1, 1, 0, 0x80, 250,
			9, 4, 0, 0, 2, 0xFF, 0, 0, 0,
			7, 5, 0x81, 2, 0x00, 0x02, 0,
			7, 5, 0x02, 2, 0x00, 0x02, 0,
		}
		return copy(data, cfg), nil
	}
	return 0, ErrStall
}

func (d *usbscanDev) Bulk(ep uint8, data []byte, _ time.Duration) (int, error) {
	// usbscan routes ReadFile to the bulk IN pipe and WriteFile to the bulk OUT pipe.
	var n uint32
	var err error
	if ep&0x80 != 0 {
		err = syscall.ReadFile(d.h, data, &n, nil)
	} else {
		err = syscall.WriteFile(d.h, data, &n, nil)
	}
	if err != nil {
		return 0, mapErr(err)
	}
	return int(n), nil
}

func (d *usbscanDev) Close() error { return syscall.CloseHandle(d.h) }
