package manager

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/platform"
)

// A real persistent child stands in for a supervisor; no host network is changed.
type lockTestRuntime struct {
	platform.Adapter
	root string
}

func (p lockTestRuntime) Inspect(context.Context) (platform.State, error) {
	_, err := os.Stat(filepath.Join(p.root, "fixture.pid"))
	return platform.State{Running: err == nil}, nil
}

func (p lockTestRuntime) Start(context.Context, platform.StartOptions) error {
	child := exec.Command("sleep", "30")
	if err := child.Start(); err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(filepath.Join(p.root, "fixture.pid"), []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		return err
	}
	return child.Process.Release()
}

func (p lockTestRuntime) Stop(context.Context) error {
	data, err := os.ReadFile(filepath.Join(p.root, "fixture.pid"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		return err
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	defer process.Release()
	if err := process.Kill(); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Remove(filepath.Join(p.root, "fixture.pid"))
}

func TestSuccessfulStartReleasesControlLockWhileRuntimeLives(t *testing.T) {
	a := testAgent(t)
	if err := fsutil.AtomicWrite(a.corePath(), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	control, _ := a.controller()
	if err := a.applyConfig(context.Background(), randomID(), []byte("proxies: []\n"), "https://fixture.invalid", control, func(string) {}); err != nil {
		t.Fatal(err)
	}
	runtime := lockTestRuntime{Adapter: a.Platform, root: a.Root}
	a.Platform = runtime
	t.Cleanup(func() { _ = runtime.Stop(context.Background()) })
	t.Setenv("UFI_TEST_RUNTIME_CHILD", "1")
	job, err := a.Submit(Request{ID: randomID(), Action: "start"})
	if err != nil {
		t.Fatal(err)
	}
	if finished := waitJob(t, a, job.ID); finished.State != "succeeded" {
		t.Fatalf("start failed: %+v", finished)
	}
	data, err := os.ReadFile(filepath.Join(a.Root, "fixture.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || syscall.Kill(pid, 0) != nil {
		t.Fatal("runtime exited instead of persisting", err)
	}
	// Completion is persisted just before worker exit; allow its final deferred closes.
	deadline := time.Now().Add(time.Second)
	for {
		status, err := a.Inspect()
		if err != nil {
			t.Fatal(err)
		}
		if !status.Locked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completed worker left control.lock held by its persistent child")
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop, err := a.Submit(Request{ID: randomID(), Action: "stop"})
	if err != nil {
		t.Fatal("cannot stop a running runtime after start completed", err)
	}
	if finished := waitJob(t, a, stop.ID); finished.State != "succeeded" {
		t.Fatalf("stop failed: %+v", finished)
	}
	if state, err := runtime.Inspect(context.Background()); err != nil || state.Running {
		t.Fatal("runtime still running after stop", err)
	}
}
