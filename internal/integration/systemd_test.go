package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Enabled only in an isolated Linux CI runner; never mutates the developer's host.
func TestSystemdDeployment(t *testing.T) {
	if os.Getenv("MIHOMOCTL_SYSTEMD_TEST") != "1" {
		t.Skip("requires isolated systemd CI runner")
	}
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Fatal("integration requires root on Linux")
	}
	agent, fixture := os.Getenv("MIHOMOCTL_TEST_EXECUTABLE"), os.Getenv("MIHOMOCTL_TEST_CORE")
	if !filepath.IsAbs(agent) || !filepath.IsAbs(fixture) {
		t.Fatal("explicit fixture paths required")
	}
	base, err := os.MkdirTemp("/var/lib", "mihomoctl-ci-")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "${MIHOMOCTL_UNSET} % path", "mihomoctl")
	core := filepath.Join(base, "core")
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(core, data, 0700); err != nil {
		t.Fatal(err)
	}
	name := filepath.Base(base) + ".service"
	unitPath := filepath.Join("/etc/systemd/system", name)
	var tasks []string
	hold := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() {
		if t.Failed() {
			output, _ := exec.Command("systemctl", "show", name,
				"--property=Id,LoadState,FragmentPath,ExecStart,WorkingDirectory,ActiveState,SubState").CombinedOutput()
			t.Logf("fixture systemd properties:\n%s", output)
		}
		release.Do(func() { close(hold) })
		for _, id := range tasks {
			_ = exec.Command("systemctl", "stop", "mihomoctl-task-"+id+".scope").Run()
		}
		_ = exec.Command("systemctl", "stop", name).Run()
		_ = exec.Command("systemctl", "disable", name).Run()
		_ = os.Remove(unitPath)
		_ = exec.Command("systemctl", "daemon-reload").Run()
		_ = os.RemoveAll(base)
	})
	executable := agent
	run := func(input string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, executable, append([]string{"--root", root}, args...)...)
		cmd.Stdin = strings.NewReader(input)
		return cmd.CombinedOutput()
	}
	output, err := run("", "--platform", "linux", "install", "--unit", name)
	if err != nil {
		t.Fatalf("install: %s %v", output, err)
	}
	executable = filepath.Join(root, "mihomoctl")
	if output, err = run("", "status"); err != nil {
		t.Fatalf("inspect before core download: %s %v", output, err)
	}
	// Stand in for the verified download; the fixture only opens loopback ports.
	if err = os.WriteFile(filepath.Join(root, "runtime", "mihomo"), data, 0700); err != nil {
		t.Fatal(err)
	}
	var source atomic.Value
	source.Store("proxies: []\nrules: [MATCH,DIRECT]\n")
	var first atomic.Bool
	first.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if first.CompareAndSwap(true, false) {
			<-hold
		}
		_, _ = w.Write([]byte(source.Load().(string)))
	}))
	defer func() { release.Do(func() { close(hold) }); server.Close() }()
	payload, _ := json.Marshal(map[string]string{"url": server.URL + "/?token=private-fixture"})
	output, err = run(string(payload), "update", "--input", "-", "--no-wait")
	if err != nil {
		t.Fatalf("submit: %s %v", output, err)
	}
	var task struct{ ID, State string }
	if err = json.Unmarshal(output, &task); err != nil {
		t.Fatal(err)
	}
	tasks = append(tasks, task.ID)
	if output, err = exec.Command("systemctl", "show", "--property=ActiveState", "--value", "mihomoctl-task-"+task.ID+".scope").CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != "active" {
		t.Fatalf("task did not survive its caller: %s %v", output, err)
	}
	release.Do(func() { close(hold) })
	for i := 0; i < 100; i++ {
		output, err = run("", "job", task.ID)
		if err != nil {
			t.Fatalf("job: %s %v", output, err)
		}
		_ = json.Unmarshal(output, &task)
		if task.State == "succeeded" {
			break
		}
		if task.State == "failed" {
			t.Fatalf("job failed: %s", output)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if task.State != "succeeded" {
		t.Fatal("detached task did not finish")
	}
	if output, err = run("", "start"); err != nil {
		t.Fatalf("start: %s %v", output, err)
	}
	output, err = run("", "status")
	if err != nil {
		t.Fatalf("inspect: %s %v", output, err)
	}
	var state struct {
		Running, Listeners, Network, Capture bool
		Platform                             string
	}
	_ = json.Unmarshal(output, &state)
	if !state.Running || !state.Listeners || state.Capture || state.Network || state.Platform != "linux" {
		t.Fatalf("incorrect managed status: %s", output)
	}
	previous, err := os.Readlink(filepath.Join(root, "runtime/current"))
	if err != nil {
		t.Fatal(err)
	}
	source.Store("proxies: []\nfixture-exit: true\n")
	if output, err = run("{}", "update", "--input", "-"); err == nil {
		t.Fatalf("bad runtime config accepted: %s", output)
	}
	if current, _ := os.Readlink(filepath.Join(root, "runtime/current")); current != previous {
		t.Fatal("rollback lost previous config")
	}
	output, err = run("", "status")
	if err != nil {
		t.Fatal(string(output), err)
	}
	_ = json.Unmarshal(output, &state)
	if !state.Running || !state.Listeners {
		t.Fatal("rollback did not restore service")
	}
	for _, action := range []string{"boot-on", "boot-off", "restart"} {
		if output, err = run("", action); err != nil {
			t.Fatalf("%s: %s %v", action, output, err)
		}
		if action == "boot-on" {
			if output, err = exec.Command("systemctl", "is-enabled", name).CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != "enabled" {
				t.Fatalf("autostart was not enabled: %s %v", output, err)
			}
			if output, err = run("", "stop"); err != nil {
				t.Fatalf("stop enabled service: %s %v", output, err)
			}
			time.Sleep(6 * time.Second) // Longer than RestartSec; an explicit stop must stay stopped.
			output, err = run("", "status")
			var stopped struct{ Running, Boot bool }
			if err != nil || json.Unmarshal(output, &stopped) != nil || stopped.Running || !stopped.Boot {
				t.Fatalf("stop changed boot policy or restarted: %s %v", output, err)
			}
			if output, err = run("", "start"); err != nil {
				t.Fatalf("start enabled service: %s %v", output, err)
			}
		}
		if action == "boot-off" {
			output, _ = exec.Command("systemctl", "is-enabled", name).CombinedOutput()
			if strings.TrimSpace(string(output)) != "linked" {
				t.Fatalf("disabled unit lost its managed link: %s", output)
			}
			output, err = run("", "status")
			var disabled struct{ Running, Boot bool }
			if err != nil || json.Unmarshal(output, &disabled) != nil || !disabled.Running || disabled.Boot {
				t.Fatalf("disable stopped active service: %s %v", output, err)
			}
		}
	}
	if output, err = run("", "uninstall"); err != nil {
		t.Fatalf("uninstall: %s %v", output, err)
	}
	if _, err = os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("uninstall left state")
	}
	if _, err = os.Stat(core); err != nil {
		t.Fatal("uninstall touched an unrelated executable")
	}
	if _, err = os.Lstat(unitPath); !os.IsNotExist(err) {
		t.Fatal("uninstall left the systemd link", err)
	}
}
