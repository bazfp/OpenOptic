package main

import (
	"bytes"
	"errors"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Native folder dialogs without cgo: PowerShell (Windows), AppleScript (macOS), zenity or
// kdialog (Linux desktops). The dialog is shown on the computer running the helper.

func linuxPicker() string {
	for _, p := range []string{"zenity", "kdialog", "qarma"} {
		if _, err := exec.LookPath(p); err == nil {
			return p
		}
	}
	return ""
}

func nativePickerAvailable() bool {
	switch runtime.GOOS {
	case "windows", "darwin":
		return true
	case "linux", "freebsd":
		return linuxPicker() != ""
	}
	return false
}

// psQuote makes a PowerShell single-quoted string literal.
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// asQuote makes an AppleScript string literal.
func asQuote(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

func nativePickDir(start string) (string, bool, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		script := `[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false;WindowState='Minimized'}
$d=New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description='Folder for this roll of scans'
$d.ShowNewFolderButton=$true
$d.SelectedPath=` + psQuote(start) + `
if($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}`
		cmd = exec.Command("powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
	case "darwin":
		script := `try
POSIX path of (choose folder with prompt "Folder for this roll of scans" default location (POSIX file ` + asQuote(start) + `))
on error number -128
return ""
end try`
		cmd = exec.Command("osascript", "-e", script)
	default:
		switch linuxPicker() {
		case "zenity", "qarma":
			cmd = exec.Command(linuxPicker(), "--file-selection", "--directory", "--title=Folder for this roll of scans", "--filename="+strings.TrimRight(start, "/")+"/")
		case "kdialog":
			cmd = exec.Command("kdialog", "--getexistingdirectory", start, "--title", "Folder for this roll of scans")
		default:
			return "", false, errors.New("no system folder dialog found (install zenity or kdialog); use the folder browser on the page instead")
		}
	}
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	err := cmd.Run()
	dir := strings.TrimSpace(out.String())
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && dir == "" && runtime.GOOS != "windows" {
			return "", false, nil // zenity/kdialog exit 1 on cancel
		}
		if _, lookErr := exec.LookPath(cmd.Path); lookErr != nil {
			return "", false, errors.New("system folder dialog unavailable: " + lookErr.Error())
		}
		if dir == "" {
			return "", false, errors.New("folder dialog failed: " + strings.TrimSpace(stderr.String()+" "+err.Error()))
		}
	}
	if dir == "" {
		return "", false, nil
	}
	if runtime.GOOS == "darwin" && len(dir) > 1 {
		dir = strings.TrimRight(dir, "/")
	}
	if !filepath.IsAbs(dir) {
		return "", false, errors.New("dialog returned an unexpected path: " + dir)
	}
	return filepath.Clean(dir), true, nil
}
