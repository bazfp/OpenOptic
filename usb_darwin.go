//go:build darwin

package main

// IOKit USB access without cgo. IOUSBLib's device and interface objects are COM-style
// "Interface**" pointers whose vtables are called through purego. The vtable indices below
// follow IOUSBDeviceStruct100 / IOUSBInterfaceStruct100 in <IOKit/usb/IOUSBLib.h>; after
// opening, the code checks GetDeviceVendor/GetDeviceProduct through the vtable against the
// known IDs, so a layout mistake is reported instead of calling the wrong function.

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const backendName = "iokit"

var (
	loadOnce sync.Once
	loadErr  error

	fIOServiceMatching, fIOServiceGetMatchingServices, fIOIteratorNext, fIOObjectRelease uintptr
	fIOCreatePlugInInterfaceForService                                                   uintptr
	fCFNumberCreate, fCFDictionarySetValue, fCFStringCreateWithCString                   uintptr
	fCFUUIDCreateFromString, fCFRelease                                                  uintptr
)

const (
	uuidDeviceUserClient    = "9dc7b780-9ec0-11d4-a54f-000a27052861"
	uuidInterfaceUserClient = "2d9786c6-9ef3-11d4-ad51-000a27052861"
	uuidCFPlugIn            = "c244e858-109c-11d4-91d4-0050e4c6426f"
	uuidDeviceInterface     = "5c8187d0-9ef3-11d4-8b45-000a27052861"
	uuidInterfaceInterface  = "73c97ae8-9ef3-11d4-b1d0-000a27052861"

	// IUnknown
	vQueryInterface = 1
	vRelease        = 3
	// IOUSBDeviceInterface
	dUSBDeviceOpen           = 8
	dUSBDeviceClose          = 9
	dGetDeviceVendor         = 13
	dGetDeviceProduct        = 14
	dGetConfiguration        = 22
	dSetConfiguration        = 23
	dDeviceRequest           = 26
	dCreateInterfaceIterator = 28
	// IOUSBInterfaceInterface
	iUSBInterfaceOpen   = 8
	iUSBInterfaceClose  = 9
	iGetDeviceVendor    = 13
	iGetInterfaceNumber = 17
	iGetNumEndpoints    = 19
	iGetPipeProperties  = 26
	iClearPipeStall     = 30
	iReadPipe           = 31
	iWritePipe          = 32

	kIOReturnExclusiveAccess = 0xE00002C5
	kIOReturnNotResponding   = 0xE00002ED
	kIOReturnNoDevice        = 0xE00002C0
	kIOReturnTimeout         = 0xE00002D6
	kIOUSBPipeStalled        = 0xE000404F
	kIOUSBTransactionTimeout = 0xE0004051
)

func load() error {
	loadOnce.Do(func() {
		iokit, err := purego.Dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			loadErr = err
			return
		}
		cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			loadErr = err
			return
		}
		sym := func(lib uintptr, name string, dst *uintptr) {
			if loadErr != nil {
				return
			}
			*dst, loadErr = purego.Dlsym(lib, name)
		}
		sym(iokit, "IOServiceMatching", &fIOServiceMatching)
		sym(iokit, "IOServiceGetMatchingServices", &fIOServiceGetMatchingServices)
		sym(iokit, "IOIteratorNext", &fIOIteratorNext)
		sym(iokit, "IOObjectRelease", &fIOObjectRelease)
		sym(iokit, "IOCreatePlugInInterfaceForService", &fIOCreatePlugInInterfaceForService)
		sym(cf, "CFNumberCreate", &fCFNumberCreate)
		sym(cf, "CFDictionarySetValue", &fCFDictionarySetValue)
		sym(cf, "CFStringCreateWithCString", &fCFStringCreateWithCString)
		sym(cf, "CFUUIDCreateFromString", &fCFUUIDCreateFromString)
		sym(cf, "CFRelease", &fCFRelease)
	})
	return loadErr
}

func call(fn uintptr, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(fn, args...)
	return r
}

// vcall invokes method idx of a COM-style object (obj is an Interface**).
func vcall(obj uintptr, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	return call(fn, append([]uintptr{obj}, args...)...)
}

func kret(r uintptr) uint32 { return uint32(r) }

func cfString(s string) uintptr {
	b := append([]byte(s), 0)
	r := call(fCFStringCreateWithCString, 0, uintptr(unsafe.Pointer(&b[0])), 0x08000100)
	runtime.KeepAlive(b)
	return r
}

func cfUUID(s string) uintptr {
	str := cfString(s)
	defer call(fCFRelease, str)
	return call(fCFUUIDCreateFromString, 0, str)
}

func uuidBytes(s string) (lo, hi uintptr) {
	b, _ := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	return uintptr(binary.LittleEndian.Uint64(b[0:8])), uintptr(binary.LittleEndian.Uint64(b[8:16]))
}

// plugin creates the CFPlugIn for service and queries it for the given interface.
func plugin(service uintptr, userClient, iface string) (uintptr, error) {
	typ, pl := cfUUID(userClient), cfUUID(uuidCFPlugIn)
	defer call(fCFRelease, typ)
	defer call(fCFRelease, pl)
	pp := new(uintptr)
	score := new(int32)
	if r := kret(call(fIOCreatePlugInInterfaceForService, service, typ, pl, uintptr(unsafe.Pointer(pp)), uintptr(unsafe.Pointer(score)))); r != 0 || *pp == 0 {
		return 0, fmt.Errorf("IOCreatePlugInInterfaceForService: 0x%08x", r)
	}
	defer vcall(*pp, vRelease)
	out := new(uintptr)
	// REFIID (a 16-byte CFUUIDBytes) is passed by value: two integer registers on arm64 and x86-64.
	lo, hi := uuidBytes(iface)
	if r := kret(vcall(*pp, vQueryInterface, lo, hi, uintptr(unsafe.Pointer(out)))); r != 0 || *out == 0 {
		return 0, fmt.Errorf("QueryInterface: 0x%08x", r)
	}
	return *out, nil
}

func findService(vid, pid uint16) (uintptr, error) {
	for _, class := range []string{"IOUSBHostDevice", "IOUSBDevice"} {
		name := append([]byte(class), 0)
		dict := call(fIOServiceMatching, uintptr(unsafe.Pointer(&name[0])))
		runtime.KeepAlive(name)
		if dict == 0 {
			continue
		}
		for _, kv := range []struct {
			key string
			val int32
		}{{"idVendor", int32(vid)}, {"idProduct", int32(pid)}} {
			k := cfString(kv.key)
			v := new(int32)
			*v = kv.val
			n := call(fCFNumberCreate, 0, 3 /* kCFNumberSInt32Type */, uintptr(unsafe.Pointer(v)))
			call(fCFDictionarySetValue, dict, k, n)
			call(fCFRelease, k)
			call(fCFRelease, n)
		}
		iter := new(uint32)
		if kret(call(fIOServiceGetMatchingServices, 0, dict, uintptr(unsafe.Pointer(iter)))) != 0 { // consumes dict
			continue
		}
		svc := call(fIOIteratorNext, uintptr(*iter))
		call(fIOObjectRelease, uintptr(*iter))
		if svc != 0 {
			return svc, nil
		}
	}
	return 0, fmt.Errorf("scanner %04x:%04x not found - is it plugged in and switched on?", vid, pid)
}

type macDev struct {
	dev, intf uintptr
	pipes     map[uint8]uint8 // endpoint address -> pipeRef
}

func openDevice(vid, pid uint16) (Device, error) {
	if err := load(); err != nil {
		return nil, fmt.Errorf("loading IOKit: %v", err)
	}
	svc, err := findService(vid, pid)
	if err != nil {
		return nil, err
	}
	dev, err := plugin(svc, uuidDeviceUserClient, uuidDeviceInterface)
	call(fIOObjectRelease, svc)
	if err != nil {
		return nil, fmt.Errorf("attaching to the scanner: %v", err)
	}
	fail := func(e error) (Device, error) { vcall(dev, vRelease); return nil, e }

	v, p := new(uint16), new(uint16)
	vcall(dev, dGetDeviceVendor, uintptr(unsafe.Pointer(v)))
	vcall(dev, dGetDeviceProduct, uintptr(unsafe.Pointer(p)))
	if *v != vid || *p != pid {
		return fail(fmt.Errorf("IOKit self-check failed (read %04x:%04x); the USB vtable layout on this macOS version is not what this build expects", *v, *p))
	}
	switch r := kret(vcall(dev, dUSBDeviceOpen)); r {
	case 0:
	case kIOReturnExclusiveAccess:
		return fail(errors.New("the scanner is in use by another program (quit SilverFast/Plustek software and try again)"))
	default:
		return fail(fmt.Errorf("USBDeviceOpen: 0x%08x", r))
	}
	cfg := new(uint8)
	if kret(vcall(dev, dGetConfiguration, uintptr(unsafe.Pointer(cfg)))) == 0 && *cfg == 0 {
		vcall(dev, dSetConfiguration, 1)
	}
	d := &macDev{dev: dev, pipes: map[uint8]uint8{}}
	if err := d.openInterface(); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
}

func (d *macDev) openInterface() error {
	req := new([4]uint16)
	*req = [4]uint16{0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF} // kIOUSBFindInterfaceDontCare
	iter := new(uint32)
	if r := kret(vcall(d.dev, dCreateInterfaceIterator, uintptr(unsafe.Pointer(req)), uintptr(unsafe.Pointer(iter)))); r != 0 {
		return fmt.Errorf("CreateInterfaceIterator: 0x%08x", r)
	}
	defer call(fIOObjectRelease, uintptr(*iter))
	for {
		svc := call(fIOIteratorNext, uintptr(*iter))
		if svc == 0 {
			return errors.New("scanner interface 0 not found")
		}
		intf, err := plugin(svc, uuidInterfaceUserClient, uuidInterfaceInterface)
		call(fIOObjectRelease, svc)
		if err != nil {
			return fmt.Errorf("attaching to the scanner interface: %v", err)
		}
		num, vid := new(uint8), new(uint16)
		vcall(intf, iGetInterfaceNumber, uintptr(unsafe.Pointer(num)))
		vcall(intf, iGetDeviceVendor, uintptr(unsafe.Pointer(vid)))
		if *num != 0 || *vid != scannerVID {
			vcall(intf, vRelease)
			continue
		}
		if r := kret(vcall(intf, iUSBInterfaceOpen)); r != 0 {
			vcall(intf, vRelease)
			if r == kIOReturnExclusiveAccess {
				return errors.New("the scanner interface is in use by another program")
			}
			return fmt.Errorf("USBInterfaceOpen: 0x%08x", r)
		}
		d.intf = intf
		n := new(uint8)
		vcall(intf, iGetNumEndpoints, uintptr(unsafe.Pointer(n)))
		for ref := uint8(1); ref <= *n; ref++ {
			dir, num, typ, interval := new(uint8), new(uint8), new(uint8), new(uint8)
			mps := new(uint16)
			if kret(vcall(intf, iGetPipeProperties, uintptr(ref), uintptr(unsafe.Pointer(dir)), uintptr(unsafe.Pointer(num)),
				uintptr(unsafe.Pointer(typ)), uintptr(unsafe.Pointer(mps)), uintptr(unsafe.Pointer(interval)))) == 0 {
				addr := *num & 0x0F
				if *dir == 1 { // kUSBIn
					addr |= 0x80
				}
				d.pipes[addr] = ref
			}
		}
		return nil
	}
}

func ioErr(r uint32) error {
	switch r {
	case 0:
		return nil
	case kIOUSBPipeStalled:
		return ErrStall
	case kIOReturnNoDevice, kIOReturnNotResponding:
		return errors.New("scanner disconnected or not responding")
	case kIOReturnTimeout, kIOUSBTransactionTimeout:
		return errors.New("USB transfer timed out")
	}
	return fmt.Errorf("IOKit error 0x%08x", r)
}

// IOUSBDevRequest
type devRequest struct {
	RequestType uint8
	Request     uint8
	Value       uint16
	Index       uint16
	Length      uint16
	Data        unsafe.Pointer
	LenDone     uint32
}

func (d *macDev) Control(rt, req uint8, val, idx uint16, data []byte, _ time.Duration) (int, error) {
	r := &devRequest{RequestType: rt, Request: req, Value: val, Index: idx, Length: uint16(len(data))}
	if len(data) > 0 {
		r.Data = unsafe.Pointer(&data[0])
	}
	err := ioErr(kret(vcall(d.dev, dDeviceRequest, uintptr(unsafe.Pointer(r)))))
	runtime.KeepAlive(data)
	return int(r.LenDone), err
}

func (d *macDev) Bulk(ep uint8, data []byte, _ time.Duration) (int, error) {
	ref, ok := d.pipes[ep]
	if !ok {
		return 0, fmt.Errorf("no pipe for endpoint 0x%02x", ep)
	}
	var p uintptr
	if len(data) > 0 {
		p = uintptr(unsafe.Pointer(&data[0]))
	}
	var err error
	n := len(data)
	if ep&0x80 != 0 {
		size := new(uint32)
		*size = uint32(len(data))
		err = ioErr(kret(vcall(d.intf, iReadPipe, uintptr(ref), p, uintptr(unsafe.Pointer(size)))))
		n = int(*size)
	} else {
		err = ioErr(kret(vcall(d.intf, iWritePipe, uintptr(ref), p, uintptr(len(data)))))
	}
	runtime.KeepAlive(data)
	if err == ErrStall {
		vcall(d.intf, iClearPipeStall, uintptr(ref))
	}
	if err != nil {
		return 0, err
	}
	return n, nil
}

func (d *macDev) Close() error {
	if d.intf != 0 {
		vcall(d.intf, iUSBInterfaceClose)
		vcall(d.intf, vRelease)
		d.intf = 0
	}
	if d.dev != 0 {
		vcall(d.dev, dUSBDeviceClose)
		vcall(d.dev, vRelease)
		d.dev = 0
	}
	return nil
}
