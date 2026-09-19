package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
)

func TestUFIStartupReturnsReadinessLogsAndCleanupFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	executable := filepath.Join(root, "mihomoctl")
	if err := fsutil.AtomicWrite(executable, []byte("#!/bin/sh\necho 'supervisor failed: TPROXY unavailable'\necho 'token=private-value'\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(filepath.Join(root, "runtime", "core.log"), []byte("stale unrelated failure\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(filepath.Join(root, "runtime", "network.owned"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	stops := 0
	if err := fsutil.WriteJSON(filepath.Join(root, "runtime", "firewall.json"), firewall{IPv4: "/system/bin/iptables", IPv6: "/system/bin/ip6tables", Backend: "legacy"}); err != nil {
		t.Fatal(err)
	}
	a := NewUFI(Environment{Root: root, Executable: executable, Run: func(_ context.Context, _ []*os.File, _ string, args ...string) ([]byte, error) {
		if args[len(args)-1] == "--version" {
			return []byte("iptables v1.8.7 (legacy)"), nil
		}
		if args[2] == "check" {
			return nil, nil
		}
		if args[2] == "stop" {
			stops++
			if stops > 1 {
				return []byte("cleanup route failed"), errors.New("exit status 1")
			}
			return nil, nil
		}
		return []byte("required listeners missing"), errors.New("exit status 1")
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	err := a.Start(ctx, StartOptions{})
	if err == nil {
		t.Fatal("failed startup reported success")
	}
	for _, reason := range []string{"required listeners missing", "TPROXY unavailable", "cleanup route failed", "清理结果：未完成", "清理前"} {
		if !strings.Contains(err.Error(), reason) {
			t.Errorf("lost startup evidence %q: %v", reason, err)
		}
	}
	for _, hidden := range []string{"private-value", "stale unrelated failure"} {
		if strings.Contains(err.Error(), hidden) {
			t.Errorf("leaked secret or stale evidence: %v", err)
		}
	}
}

func TestUFIStartupRecognizesOnlyNewListenConflicts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.log")
	old := "time=old level=error msg=\"External controller listen error: listen tcp 0.0.0.0:9090: bind: address already in use\"\n"
	other := "time=new level=error msg=\"[GEO] Failed to update GEO database: EOF\"\n"
	if err := os.WriteFile(path, []byte(old+other), 0600); err != nil {
		t.Fatal(err)
	}
	if err := startupListenError(path, int64(len(old))); err != nil {
		t.Fatal("old conflicts or GEO errors must not abort a new start", err)
	}
	if err := os.WriteFile(path, []byte(old+other+strings.ReplaceAll(old, "9090", "9191")), 0600); err != nil {
		t.Fatal(err)
	}
	if err := startupListenError(path, int64(len(old))); err == nil || !strings.Contains(err.Error(), "9191") {
		t.Fatal("missing current listen conflict", err)
	}
}

func TestUFIStartupListenConflictFailsBeforeReadinessTimeout(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	executable := filepath.Join(root, "mihomoctl")
	script := "#!/bin/sh\necho 'level=error msg=\"External controller listen error: listen tcp 0.0.0.0:9090: bind: address already in use\"' >> '" + filepath.Join(root, "runtime", "core.log") + "'\nexec sleep 20\n"
	if err := fsutil.AtomicWrite(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSON(filepath.Join(root, "runtime", "firewall.json"), firewall{IPv4: "/fixture/iptables", IPv6: "/fixture/ip6tables", Backend: "legacy"}); err != nil {
		t.Fatal(err)
	}
	a := NewUFI(Environment{Root: root, Executable: executable, Run: func(_ context.Context, _ []*os.File, _ string, args ...string) ([]byte, error) {
		if args[len(args)-1] == "--version" {
			return []byte("iptables v1.8.7 (legacy)"), nil
		}
		if args[2] == "ready" {
			return []byte("controller listener missing"), errors.New("exit status 1")
		}
		return nil, nil
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	err := a.Start(ctx, StartOptions{})
	if err == nil || errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "监听端口 9090 已被占用") || !strings.Contains(err.Error(), "清理结果：本次进程已停止") {
		t.Fatal("listen conflict did not fail promptly with cleanup result", err)
	}
}

func TestUFIStartCancellationReapsItsChildWithoutAProcessRecord(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	executable := filepath.Join(root, "mihomoctl")
	pidFile := filepath.Join(root, "child.pid")
	if err := fsutil.AtomicWrite(executable, []byte("#!/bin/sh\necho $$ > '"+pidFile+"'\nexec sleep 3\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSON(filepath.Join(root, "runtime", "firewall.json"), firewall{IPv4: "/fixture/iptables", IPv6: "/fixture/ip6tables", Backend: "legacy"}); err != nil {
		t.Fatal(err)
	}
	a := NewUFI(Environment{Root: root, Executable: executable, Run: func(_ context.Context, _ []*os.File, _ string, args ...string) ([]byte, error) {
		if args[len(args)-1] == "--version" {
			return []byte("iptables v1.8.7 (legacy)"), nil
		}
		return nil, nil
	}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- a.Start(ctx, StartOptions{}) }()
	deadline := time.Now().Add(2 * time.Second)
	var pid int
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		}
		if pid > 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("startup cancellation did not finish")
	}
	if pid <= 1 {
		t.Fatal("supervisor fixture did not report its PID")
	}
	child, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	defer child.Release()
	if err := child.Signal(syscall.Signal(0)); err == nil {
		t.Fatal("startup failure left its unregistered supervisor alive")
	}
}

func TestUFIBootUsesTaskCLIWithQuotedPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "device 'quoted'", "mihomoctl")
	adapter := NewUFI(Environment{Root: root})
	if err := fsutil.AtomicWrite(filepath.Join(root, "mihomoctl"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("sh", "-c", adapter.BootLine()).CombinedOutput()
	want := strings.Join([]string{"start", "--no-wait", "--root", root, ""}, "\n")
	if err != nil || string(output) != want {
		t.Fatalf("boot command: %q, %v", output, err)
	}
}
