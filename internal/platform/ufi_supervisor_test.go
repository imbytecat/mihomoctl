package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
)

func TestUFISupervisorRetriesAndStopsOwnedChild(t *testing.T) {
	for _, mode := range []string{"prepare-and-crash", "sync-failure"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			runtime := filepath.Join(root, "runtime")
			// The fixture only writes a marker and sleeps; it opens no listeners.
			script := "#!/bin/sh\ncd '" + runtime + "' || exit 1\necho started >> starts\n"
			if mode == "prepare-and-crash" {
				script += "if [ ! -f crashed ]; then touch crashed; exit 1; fi\n"
			}
			script += "exec sleep 30\n"
			if err := fsutil.AtomicWrite(filepath.Join(runtime, "mihomo"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			if err := fsutil.WriteJSON(filepath.Join(runtime, "firewall.json"), firewall{IPv4: "/fixture/iptables", IPv6: "/fixture/ip6tables", Backend: "legacy"}); err != nil {
				t.Fatal(err)
			}
			var prepares, syncs, stops atomic.Int32
			var pidAtCleanup atomic.Int32
			p := testUFI(Environment{Root: root, Run: func(_ context.Context, _ []*os.File, _ string, args ...string) ([]byte, error) {
				if args[len(args)-1] == "--version" {
					return []byte("iptables v1.8.7 (legacy)"), nil
				}
				switch args[4] {
				case "prepare":
					if prepares.Add(1) == 1 && mode == "prepare-and-crash" {
						return []byte("temporary prepare failure"), errors.New("exit status 1")
					}
				case "sync":
					if syncs.Add(1) == 1 && mode == "sync-failure" {
						return []byte("guard state unavailable"), errors.New("exit status 1")
					}
				case "stop":
					stops.Add(1)
					if data, err := os.ReadFile(filepath.Join(runtime, "core.pid")); err == nil {
						pid, _ := strconv.Atoi(string(data))
						if pid > 1 && syscall.Kill(pid, 0) == nil {
							pidAtCleanup.Store(int32(pid))
						}
					}
				}
				return nil, nil
			}})
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			finished := make(chan error, 1)
			ended := make(chan struct{})
			go func() { defer close(ended); finished <- p.supervise(ctx) }()
			t.Cleanup(func() {
				cancel()
				select {
				case <-ended:
				case <-time.After(7 * time.Second):
					t.Error("supervisor fixture did not exit")
				}
			})
			var pid int
			for ctx.Err() == nil {
				starts, _ := os.ReadFile(filepath.Join(runtime, "starts"))
				data, _ := os.ReadFile(filepath.Join(runtime, "core.pid"))
				pid, _ = strconv.Atoi(string(data))
				if strings.Count(string(starts), "started") >= 2 && pid > 1 && syscall.Kill(pid, 0) == nil {
					break
				}
				select {
				case err := <-finished:
					t.Fatal("supervisor exited instead of recovering", err)
				case <-time.After(20 * time.Millisecond):
				}
			}
			if ctx.Err() != nil {
				t.Fatal("runtime was not restarted")
			}
			cancel()
			select {
			case err := <-finished:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(7 * time.Second):
				t.Fatal("supervisor did not stop its child")
			}
			if syscall.Kill(pid, 0) == nil || pidAtCleanup.Load() != 0 {
				t.Fatal("removed protection before the owned core exited", pid, pidAtCleanup.Load())
			}
			if stops.Load() < 2 {
				t.Fatal("missing cleanup between restart and stop")
			}
		})
	}
}
