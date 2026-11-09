package main

import "testing"

// Both models are opened by the helper, the 7600i first, and the error names every id it tried.
func TestScannerPIDs(t *testing.T) {
	if len(scannerPIDs) != 2 || scannerPIDs[0] != scannerPID || scannerPIDs[1] != 0x130C {
		t.Fatalf("scannerPIDs = %x", scannerPIDs)
	}
	if got, want := pidList(), "07b3:0c3b, 07b3:130c"; got != want {
		t.Fatalf("pidList() = %q, want %q", got, want)
	}
}
