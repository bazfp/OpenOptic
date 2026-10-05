//go:build sim

// Developer self-test backend: a tiny simulated scanner so the HTTP bridge and the page can be
// exercised without hardware. Build with: go build -tags sim
package main

import (
	"encoding/binary"
	"os"
	"time"
)

const backendName = "simulated"

type simDev struct {
	regs   [256]byte
	addr   byte
	events chan byte
	pos    int // carriage position in steps from the home sensor
}

func openDevice(vid, pid uint16) (Device, error) {
	d := &simDev{events: make(chan byte, 8)}
	d.events <- 0x08 // the position sensor's latched change, reported when the endpoint is first read
	if os.Getenv("OPTICFILM_SIM_BUTTON") != "" {
		// developer aid: front buttons A (0x04) and B (0x02) pressed alternately every 1.5 s
		go func() {
			v := byte(0x04)
			for range time.Tick(1500 * time.Millisecond) {
				select {
				case d.events <- v:
				default:
				}
				v ^= 0x06
			}
		}()
	}
	d.regs[0x41] = 0x88
	return d, nil
}

var simDeviceDesc = []byte{18, 1, 0x00, 0x02, 0, 0, 0, 64, 0xB3, 0x07, 0x3B, 0x0C, 0x00, 0x04, 1, 2, 0, 1}
var simConfig = []byte{
	9, 2, 39, 0, 1, 1, 0, 0x80, 250,
	9, 4, 0, 0, 3, 0xFF, 0, 0, 0,
	7, 5, 0x81, 2, 0x00, 0x02, 0,
	7, 5, 0x02, 2, 0x00, 0x02, 0,
	7, 5, 0x83, 3, 0x01, 0x00, 8,
}

func simString(s string) []byte {
	b := []byte{byte(2 + 2*len(s)), 3}
	for _, r := range s {
		b = binary.LittleEndian.AppendUint16(b, uint16(r))
	}
	return b
}

func (d *simDev) Control(rt, req uint8, val, idx uint16, data []byte, _ time.Duration) (int, error) {
	if rt == 0x80 && req == 6 {
		var src []byte
		switch val >> 8 {
		case 1:
			src = simDeviceDesc
		case 2:
			src = simConfig
		case 3:
			src = simString("OpticFilm 7600i (simulated)")
		}
		return copy(data, src), nil
	}
	if rt&0x80 == 0 {
		if val == 0x83 {
			if len(data) == 1 {
				d.addr = data[0]
			} else {
				for i := 0; i+1 < len(data); i += 2 {
					d.regs[data[i]] = data[i+1]
					if data[i] == 0x0F && data[i+1] == 1 { // moves finish at once
						steps := int(d.regs[0x3D]&0x0F)<<16 | int(d.regs[0x3E])<<8 | int(d.regs[0x3F])
						if d.regs[0x02]&0x04 != 0 {
							d.pos = max(0, d.pos-steps)
						} else {
							d.pos += steps
						}
						d.regs[0x41] = 0x80 | 0x20
						if d.pos == 0 {
							d.regs[0x41] |= 0x08
						}
					}
				}
			}
		}
		return len(data), nil
	}
	for i := range data {
		data[i] = 0
	}
	switch {
	case val == 0x84:
		data[0] = d.regs[d.addr]
	case val == 0x8E && idx == 0x20:
		data[0] = 1
	case val == 0x8E && idx == 0x18:
		data[0] = 0
	case val == 0x8E:
		data[0] = 0x08
	}
	return len(data), nil
}

func (d *simDev) Bulk(ep uint8, data []byte, _ time.Duration) (int, error) {
	if ep&0x80 != 0 {
		for i := range data {
			data[i] = byte(i)
		}
	}
	return len(data), nil
}

func (d *simDev) Interrupt(ep uint8, data []byte, timeout time.Duration) (int, error) {
	select {
	case v := <-d.events:
		data[0] = v
		return 1, nil
	case <-time.After(timeout):
		return 0, ErrTimeout
	}
}

func (d *simDev) Close() error { return nil }
