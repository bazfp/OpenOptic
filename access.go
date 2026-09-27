package main

// Linux device access without hand-editing udev rules, and file ownership when the helper is
// started with sudo.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const udevRulePath = "/etc/udev/rules.d/70-opticfilm.rules"
const udevRule = `# Plustek OpticFilm 7600i: let the logged-in desktop user open the scanner.
SUBSYSTEM=="usb", ATTR{idVendor}=="07b3", ATTR{idProduct}=="0c3b", MODE="0660", TAG+="uaccess"
`

// invokingUser returns the uid/gid of the user who ran sudo, if any.
func invokingUser() (int, int, bool) {
	if runtime.GOOS == "windows" || os.Getuid() != 0 {
		return 0, 0, false
	}
	uid, err1 := strconv.Atoi(os.Getenv("SUDO_UID"))
	gid, err2 := strconv.Atoi(os.Getenv("SUDO_GID"))
	if err1 != nil || err2 != nil || uid == 0 {
		return 0, 0, false
	}
	return uid, gid, true
}

// giveBackToUser hands a file or folder created while running as root to the user who ran sudo,
// so scans are not left owned by root.
func giveBackToUser(path string) {
	if uid, gid, ok := invokingUser(); ok {
		os.Chown(path, uid, gid)
	}
}

// installUdevRule writes the rule and reloads udev. Run as root; otherwise it prints the one
// command to run. Returns an explanation for the user either way.
func installUdevRule() string {
	if runtime.GOOS != "linux" {
		return "The udev rule is only needed on Linux."
	}
	if os.Getuid() != 0 {
		exe, err := os.Executable()
		if err != nil {
			exe = "./opticfilm-linux-x64"
		}
		return "Installing the rule needs root. Run:\n\n    sudo " + exe + " -install-udev\n\n" +
			"Or start the helper itself with sudo, which needs no rule at all:\n\n    sudo " + exe + "\n"
	}
	if err := os.MkdirAll(filepath.Dir(udevRulePath), 0o755); err != nil {
		return "Could not create " + filepath.Dir(udevRulePath) + ": " + err.Error()
	}
	if err := os.WriteFile(udevRulePath, []byte(udevRule), 0o644); err != nil {
		return "Could not write " + udevRulePath + ": " + err.Error()
	}
	var out strings.Builder
	fmt.Fprintf(&out, "Wrote %s\n", udevRulePath)
	for _, args := range [][]string{{"udevadm", "control", "--reload-rules"}, {"udevadm", "trigger"}} {
		cmd := exec.Command(args[0], args[1:]...)
		if b, err := cmd.CombinedOutput(); err != nil {
			fmt.Fprintf(&out, "%s failed: %v %s\n", strings.Join(args, " "), err, strings.TrimSpace(string(b)))
		}
	}
	fmt.Fprint(&out, "Done. Unplug the scanner and plug it in again, then start the helper normally (no sudo).\n")
	return out.String()
}

// accessHint is shown when the device cannot be opened for lack of permission.
func accessHint() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		exe = "./opticfilm-linux-x64"
	}
	hint := "\nOn Linux the scanner's USB device node is root-owned by default. Any one of these works:\n" +
		"  1. Start the helper with sudo (nothing to install; saved files still belong to you):\n" +
		"         sudo " + exe + "\n" +
		"  2. Let the helper install the udev rule once, then run it normally:\n" +
		"         sudo " + exe + " -install-udev\n" +
		"  3. Install sane-backends (its scanner rules usually cover this scanner) and re-plug it:\n" +
		"         Debian/Ubuntu: sudo apt install sane-utils    Fedora: sudo dnf install sane-backends\n"
	if _, err := os.Stat(udevRulePath); err == nil {
		hint += "\n" + udevRulePath + " exists already: unplug the scanner and plug it in again so it takes effect.\n"
	}
	if p, err := filepath.Glob("/usr/lib/udev/rules.d/*libsane*"); err == nil && len(p) > 0 {
		hint += "\nsane's udev rules are installed (" + p[0] + "); re-plugging the scanner may be enough.\n"
	}
	return hint
}
