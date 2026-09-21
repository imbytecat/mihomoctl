package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/host"
)

const fixtureBoot = "11111111-1111-4111-8111-111111111111"

func TestMain(m *testing.M) {
	if os.Getenv("MIHOMOCTL_TEST_UFI_IDENTITY") == "1" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM)
		defer cancel()
		<-ctx.Done() // Inert owned-process fixture: no listeners or network mutations.
		return
	}
	os.Exit(m.Run())
}

func testUFI(env Environment) *UFIAdapter {
	a := NewUFI(env)
	a.bootID = func() (string, error) { return fixtureBoot, nil }
	a.BootPath = filepath.Join(env.Root, "boot.sh")
	return a
}

func TestUFIRebootStateUsesKernelEvidenceAndKeepsBootPreference(t *testing.T) {
	for _, mode := range []string{"empty", "residue", "unreadable", "incomplete"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			mutations := 0
			a := testUFI(Environment{Root: root, Executable: filepath.Join(root, "mihomoctl"), Run: func(_ context.Context, _ []*os.File, _ string, args ...string) ([]byte, error) {
				if args[len(args)-1] == "--version" {
					return []byte("iptables v1.8.7 (legacy)"), nil
				}
				if args[0] != "-c" || args[1] != string(networkScript) {
					t.Fatal("executed persisted or foreign network script")
				}
				if args[4] != "inspect" {
					mutations++
					return nil, nil
				}
				switch mode {
				case "residue":
					return []byte(`{"listeners":false,"network":false,"capture":true}`), nil
				case "unreadable":
					return nil, errors.New("permission denied")
				case "incomplete":
					return []byte(`{"listeners":false,"network":false}`), nil
				default:
					return []byte(`{"listeners":false,"network":false,"capture":false}`), nil
				}
			}})
			files := map[string]string{"boot_id": "22222222-2222-4222-8222-222222222222", "core.json": "interrupted old write", "supervisor.json": "old PID", "core.pid": "123", "network.owned": "", "network.active": "A\nwlan0\n", "network.pending": "B", "network.active.next": "A", "network.sh": "obsolete script", "core.log": "keep evidence", "current/config.yaml": "keep config"}
			for name, data := range files {
				if err := fsutil.AtomicWrite(a.runtime(name), []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := fsutil.WriteJSON(a.runtime("firewall.json"), firewall{IPv4: "/fixture/iptables", IPv6: "/fixture/ip6tables", Backend: "legacy"}); err != nil {
				t.Fatal(err)
			}
			if err := a.SetBoot(context.Background(), true); err != nil {
				t.Fatal(err)
			}
			state, err := a.Inspect(context.Background())
			if mode == "unreadable" || mode == "incomplete" {
				if err == nil {
					t.Fatal("unreadable kernel state reported success")
				}
			} else if err != nil || state.Running || state.Capture != (mode == "residue") || !state.Boot {
				t.Fatal(state, err)
			}
			if mutations != 0 {
				t.Fatal("status mutated the network")
			}
			for name, data := range files {
				if got, _ := os.ReadFile(a.runtime(name)); string(got) != data {
					t.Fatal("status changed", name)
				}
			}
			err = a.Stop(context.Background())
			if mode != "empty" {
				if err == nil || mutations != 0 {
					t.Fatal("cleaned unproven resources", err)
				}
				if !fsutil.RegularFile(a.runtime("network.owned")) {
					t.Fatal("discarded failure evidence")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for name := range files {
				_, err := os.Stat(a.runtime(name))
				if name == "core.log" || name == "current/config.yaml" {
					if err != nil {
						t.Fatal(err)
					}
					continue
				}
				if !os.IsNotExist(err) {
					t.Fatal("left obsolete runtime state", name, err)
				}
			}
			boot, _ := os.ReadFile(a.BootPath)
			if !strings.Contains(string(boot), a.BootLine()) {
				t.Fatal("stop disabled autostart")
			}
		})
	}
}

func TestUFIProcessRequiresManagedCommandAndReadableBootIdentity(t *testing.T) {
	a := testUFI(Environment{Root: t.TempDir()})
	if err := fsutil.AtomicWrite(a.runtime("boot_id"), []byte(fixtureBoot), 0600); err != nil {
		t.Fatal(err)
	}
	a.bootID = func() (string, error) { return "", os.ErrPermission }
	if _, err := a.Inspect(context.Background()); err == nil {
		t.Fatal("unknown boot was treated as stopped")
	}
	if err := a.Stop(context.Background()); err == nil {
		t.Fatal("cleared unknown boot")
	}
	if runtime.GOOS != "linux" {
		return
	}
	a.bootID = func() (string, error) { return fixtureBoot, nil }
	a.Executable, _ = os.Executable()
	if err := fsutil.WriteJSON(a.runtime("supervisor.json"), host.Record{PID: os.Getpid(), Start: host.Start(os.Getpid())}); err != nil {
		t.Fatal(err)
	}
	if p, err := a.process("supervisor"); err != nil || p != nil {
		t.Fatal("trusted PID without matching managed arguments", p, err)
	}
}

func TestUFIStopOwnsLiveCommandAcrossAtomicAgentUpdate(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Linux procfs")
	}
	root := t.TempDir()
	a := testUFI(Environment{Root: root, Executable: filepath.Join(root, "mihomoctl")})
	self, _ := os.Executable()
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(a.Executable, data, 0700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(a.Executable, "supervise", "--root", root)
	cmd.Env = append(os.Environ(), "MIHOMOCTL_TEST_UFI_IDENTITY=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	if err := fsutil.WriteJSON(a.runtime("supervisor.json"), host.Record{PID: cmd.Process.Pid, Start: host.Start(cmd.Process.Pid)}); err != nil {
		t.Fatal(err)
	}
	verify := func() {
		t.Helper()
		p, err := a.process("supervisor")
		if err != nil || p == nil {
			t.Fatal("lost ownership of live managed command", err)
		}
		p.Release()
	}
	verify()
	if err := fsutil.AtomicWrite(a.runtime("boot_id"), []byte(fixtureBoot), 0600); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(a.Executable, data, 0700); err != nil {
		t.Fatal(err)
	}
	verify()
	if err := a.SetBoot(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := a.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	state, err := a.Inspect(context.Background())
	if err != nil || state.Running || !state.Boot {
		t.Fatal("stop changed boot preference or left the process", state, err)
	}
}
