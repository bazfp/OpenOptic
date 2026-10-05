//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const backendName = "windows"

var (
	setupapi                         = syscall.NewLazyDLL("setupapi.dll")
	procSetupDiGetClassDevsW         = setupapi.NewProc("SetupDiGetClassDevsW")
	procSetupDiEnumDeviceInterfaces  = setupapi.NewProc("SetupDiEnumDeviceInterfaces")
	procSetupDiGetDeviceInterfaceDtl = setupapi.NewProc("SetupDiGetDeviceInterfaceDetailW")
	procSetupDiDestroyDeviceInfoList = setupapi.NewProc("SetupDiDestroyDeviceInfoList")
	procSetupDiGetDeviceRegistryProp = setupapi.NewProc("SetupDiGetDeviceRegistryPropertyW")

	winusb                  = syscall.NewLazyDLL("winusb.dll")
	procWinUsbInitialize    = winusb.NewProc("WinUsb_Initialize")
	procWinUsbFree          = winusb.NewProc("WinUsb_Free")
	procWinUsbControl       = winusb.NewProc("WinUsb_ControlTransfer")
	procWinUsbReadPipe      = winusb.NewProc("WinUsb_ReadPipe")
	procWinUsbWritePipe     = winusb.NewProc("WinUsb_WritePipe")
	procWinUsbSetPipePolicy = winusb.NewProc("WinUsb_SetPipePolicy")
	procWinUsbResetPipe     = winusb.NewProc("WinUsb_ResetPipe")
)

type winGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// GUID_DEVINTERFACE_USB_DEVICE: registered by the USB hub driver for every attached device.
var guidUSBDevice = winGUID{0xA5DCBF10, 0x6530, 0x11D2, [8]byte{0x90, 0x1F, 0x00, 0xC0, 0x4F, 0xB9, 0x51, 0xED}}

type spDeviceInterfaceData struct {
	CbSize   uint32
	Class    winGUID
	Flags    uint32
	Reserved uintptr
}

type spDevinfoData struct {
	CbSize   uint32
	Class    winGUID
	DevInst  uint32
	Reserved uintptr
}

const spdrpService = 0x04

const (
	digcfPresent         = 0x02
	digcfDeviceInterface = 0x10
	errNoMoreItems       = 259
	errGenFailure        = 31  // WinUSB reports a STALL this way
	errSemTimeout        = 121 // transfer timeout
	pipeTransferTimeout  = 0x03
)

type winDev struct {
	file     syscall.Handle
	iface    uintptr
	tmu      sync.Mutex // the interrupt read runs alongside control/bulk transfers
	timeouts map[uint8]uint32
}

// findDevicePath returns the device path and the name of the driver service Windows has bound
// to the scanner (for example "WinUSB", or the Plustek driver's service name).
func findDevicePath(g *winGUID, vid, pid uint16) (string, string, error) {
	h, _, e := procSetupDiGetClassDevsW.Call(uintptr(unsafe.Pointer(g)), 0, 0, digcfPresent|digcfDeviceInterface)
	if h == uintptr(syscall.InvalidHandle) {
		return "", "", fmt.Errorf("SetupDiGetClassDevs: %v", e)
	}
	defer procSetupDiDestroyDeviceInfoList.Call(h)
	want := fmt.Sprintf("vid_%04x&pid_%04x", vid, pid)
	for i := 0; ; i++ {
		ifd := spDeviceInterfaceData{}
		ifd.CbSize = uint32(unsafe.Sizeof(ifd))
		r, _, e := procSetupDiEnumDeviceInterfaces.Call(h, 0, uintptr(unsafe.Pointer(g)), uintptr(i), uintptr(unsafe.Pointer(&ifd)))
		if r == 0 {
			if en, ok := e.(syscall.Errno); ok && en == errNoMoreItems {
				break
			}
			return "", "", fmt.Errorf("SetupDiEnumDeviceInterfaces: %v", e)
		}
		var need uint32
		procSetupDiGetDeviceInterfaceDtl.Call(h, uintptr(unsafe.Pointer(&ifd)), 0, 0, uintptr(unsafe.Pointer(&need)), 0)
		if need < 8 {
			continue
		}
		buf := make([]uint16, (need+1)/2)
		// SP_DEVICE_INTERFACE_DETAIL_DATA_W.cbSize is 8 on 64-bit Windows.
		*(*uint32)(unsafe.Pointer(&buf[0])) = 8
		dev := spDevinfoData{}
		dev.CbSize = uint32(unsafe.Sizeof(dev))
		r, _, _ = procSetupDiGetDeviceInterfaceDtl.Call(h, uintptr(unsafe.Pointer(&ifd)), uintptr(unsafe.Pointer(&buf[0])), uintptr(need), 0, uintptr(unsafe.Pointer(&dev)))
		if r == 0 {
			continue
		}
		path := syscall.UTF16ToString(buf[2:])
		if !strings.Contains(strings.ToLower(path), want) {
			continue
		}
		svc := make([]uint16, 256)
		var typ uint32
		r, _, e = procSetupDiGetDeviceRegistryProp.Call(h, uintptr(unsafe.Pointer(&dev)), spdrpService,
			uintptr(unsafe.Pointer(&typ)), uintptr(unsafe.Pointer(&svc[0])), uintptr(len(svc)*2), 0)
		service := "?" // lookup failed: unknown, don't block on it
		if r != 0 {
			service = syscall.UTF16ToString(svc)
		} else if en, ok := e.(syscall.Errno); ok && en == 13 /* ERROR_INVALID_DATA: property absent */ {
			service = ""
		}
		return path, service, nil
	}
	return "", "", fmt.Errorf("scanner %04x:%04x not found - is it plugged in and switched on?", vid, pid)
}

func openDevice(vid, pid uint16) (Device, error) {
	path, service, err := findDevicePath(&guidUSBDevice, vid, pid)
	if err != nil {
		return nil, err
	}
	log.Printf("scanner found; Windows driver service: %q", service)
	switch strings.ToLower(service) {
	case "winusb":
		return openWinUSB(path)
	case "usbscan":
		// Microsoft's still-image USB driver, used by many scanner driver packages. It has a
		// documented user-mode interface, so no driver change is needed.
		return openUsbscan(vid, pid)
	case "":
		return nil, errors.New("Windows has no driver installed for the scanner. Install the Plustek driver package, then replug the scanner")
	}
	return nil, fmt.Errorf("the scanner is bound to the %q driver, which has no documented interface this program can use "+
		"(it supports Microsoft's usbscan and WinUSB drivers). Please report this driver name", service)
}

func openWinUSB(path string) (Device, error) {
	p, _ := syscall.UTF16PtrFromString(path)
	f, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL|syscall.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, fmt.Errorf("opening the scanner failed (%v); close any other program using it", err)
	}
	var iface uintptr
	r, _, e := procWinUsbInitialize.Call(uintptr(f), uintptr(unsafe.Pointer(&iface)))
	if r == 0 {
		syscall.CloseHandle(f)
		return nil, fmt.Errorf("WinUsb_Initialize failed (%v). Unplug and replug the scanner, and close any other program using it", e)
	}
	return &winDev{file: f, iface: iface, timeouts: map[uint8]uint32{}}, nil
}

func (d *winDev) Backend() string { return "winusb" }

func (d *winDev) setTimeout(pipe uint8, t time.Duration) {
	d.tmu.Lock()
	defer d.tmu.Unlock()
	ms := uint32(t.Milliseconds())
	if d.timeouts[pipe] == ms {
		return
	}
	procWinUsbSetPipePolicy.Call(d.iface, uintptr(pipe), pipeTransferTimeout, 4, uintptr(unsafe.Pointer(&ms)))
	d.timeouts[pipe] = ms
}

func bufPtr(b []byte) uintptr {
	if len(b) == 0 {
		return 0
	}
	return uintptr(unsafe.Pointer(&b[0]))
}

func mapErr(e error) error {
	if en, ok := e.(syscall.Errno); ok {
		switch en {
		case errGenFailure:
			return ErrStall
		case errSemTimeout:
			return ErrTimeout
		}
	}
	return e
}

func (d *winDev) Control(rt, req uint8, val, idx uint16, data []byte, timeout time.Duration) (int, error) {
	d.setTimeout(0, timeout)
	// WINUSB_SETUP_PACKET is an 8-byte struct passed by value, i.e. in one 64-bit register.
	setup := uint64(rt) | uint64(req)<<8 | uint64(val)<<16 | uint64(idx)<<32 | uint64(len(data))<<48
	var n uint32
	r, _, e := procWinUsbControl.Call(d.iface, uintptr(setup), bufPtr(data), uintptr(len(data)), uintptr(unsafe.Pointer(&n)), 0)
	runtime.KeepAlive(data)
	if r == 0 {
		return 0, mapErr(e)
	}
	return int(n), nil
}

func (d *winDev) Bulk(ep uint8, data []byte, timeout time.Duration) (int, error) {
	d.setTimeout(ep, timeout)
	proc := procWinUsbWritePipe
	if ep&0x80 != 0 {
		proc = procWinUsbReadPipe
	}
	var n uint32
	r, _, e := proc.Call(d.iface, uintptr(ep), bufPtr(data), uintptr(len(data)), uintptr(unsafe.Pointer(&n)), 0)
	runtime.KeepAlive(data)
	if r == 0 {
		err := mapErr(e)
		if err == ErrStall {
			procWinUsbResetPipe.Call(d.iface, uintptr(ep))
		}
		return 0, err
	}
	return int(n), nil
}

// Interrupt reads an interrupt endpoint; WinUsb_ReadPipe serves interrupt pipes too, and each
// pipe keeps its own timeout policy.
func (d *winDev) Interrupt(ep uint8, data []byte, timeout time.Duration) (int, error) {
	return d.Bulk(ep, data, timeout)
}

func (d *winDev) Close() error {
	procWinUsbFree.Call(d.iface)
	return syscall.CloseHandle(d.file)
}
