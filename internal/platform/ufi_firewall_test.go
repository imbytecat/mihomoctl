package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
)

func TestFirewallSelectionRespectsDefaultAndRequiresMatchingPair(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tools map[string]string
		want  string
	}{
		{"default legacy", map[string]string{"iptables": "legacy", "ip6tables": "legacy", "iptables-nft": "nf_tables", "ip6tables-nft": "nf_tables"}, "legacy"},
		{"default nft", map[string]string{"iptables": "nf_tables", "ip6tables": "nf_tables"}, "nf_tables"},
		{"mixed", map[string]string{"iptables": "legacy", "ip6tables": "nf_tables"}, ""},
		{"incomplete default", map[string]string{"iptables": "legacy", "iptables-nft": "nf_tables", "ip6tables-nft": "nf_tables"}, ""},
		{"unique explicit", map[string]string{"iptables-legacy": "legacy", "ip6tables-legacy": "legacy"}, "legacy"},
		{"ambiguous explicit", map[string]string{"iptables-legacy": "legacy", "ip6tables-legacy": "legacy", "iptables-nft": "nf_tables", "ip6tables-nft": "nf_tables"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := testUFI(Environment{Run: func(_ context.Context, _ []*os.File, path string, args ...string) ([]byte, error) {
				if len(args) != 1 || args[0] != "--version" {
					t.Fatal("selection must not inspect other proxies or write rules", args)
				}
				return []byte(filepath.Base(path) + " v1.8.7 (" + tc.tools[filepath.Base(path)] + ")"), nil
			}})
			f, err := a.detectFirewall(context.Background(), func(name string) (string, error) {
				if _, ok := tc.tools[name]; !ok {
					return "", os.ErrNotExist
				}
				return "/system/bin/" + name, nil
			})
			if tc.want == "" {
				if err == nil {
					t.Fatal("accepted ambiguous backend", f)
				}
				return
			}
			if err != nil || f.Backend != tc.want {
				t.Fatal(f, err)
			}
		})
	}
}

func TestFirewallBindingSurvivesPathChangesAndRejectsBackendChanges(t *testing.T) {
	dir := t.TempDir()
	tools := filepath.Join(dir, "tools")
	for _, name := range []string{"iptables", "ip6tables"} {
		if err := fsutil.AtomicWrite(filepath.Join(tools, name), []byte("#!/bin/sh\nprintf 'iptables v1.8.7 (legacy)\\n'\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", tools)
	a := testUFI(Environment{Root: filepath.Join(dir, "mihomoctl")})
	f, err := a.firewall(context.Background(), true)
	if err != nil || f.Backend != "legacy" {
		t.Fatal(f, err)
	}
	info, err := os.Stat(a.runtime("firewall.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal(info, err)
	}
	t.Setenv("PATH", filepath.Join(dir, "missing"))
	if _, err := a.firewall(context.Background(), false); err != nil {
		t.Fatal("binding followed PATH instead of saved programs", err)
	}
	if err := fsutil.AtomicWrite(f.IPv4, []byte("#!/bin/sh\nprintf 'iptables v1.8.7 (nf_tables)\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := a.firewall(context.Background(), false); err == nil {
		t.Fatal("accepted changed backend")
	}
	if err := fsutil.AtomicWrite(f.IPv6, []byte("#!/bin/sh\nprintf 'ip6tables v1.8.7 (nf_tables)\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := a.firewall(context.Background(), false); err == nil || !strings.Contains(err.Error(), "后端已变化") {
		t.Fatal(err)
	}
}

func TestFailedFirewallProbeDoesNotStartSupervisor(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	marker := filepath.Join(root, "launched")
	executable := filepath.Join(root, "mihomoctl")
	if err := fsutil.AtomicWrite(executable, []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSON(filepath.Join(root, "runtime", "firewall.json"), firewall{IPv4: "/fixture/iptables", IPv6: "/fixture/ip6tables", Backend: "legacy"}); err != nil {
		t.Fatal(err)
	}
	a := testUFI(Environment{Root: root, Executable: executable, Run: func(_ context.Context, _ []*os.File, _ string, args ...string) ([]byte, error) {
		if args[len(args)-1] == "--version" {
			return []byte("iptables v1.8.7 (legacy)"), nil
		}
		if args[4] == "check" {
			return []byte("TPROXY target unavailable"), errors.New("exit status 1")
		}
		return nil, nil
	}})
	if err := a.Start(context.Background(), StartOptions{}); err == nil || !strings.Contains(err.Error(), "TPROXY target unavailable") {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("started a supervisor without required capabilities")
	}
}

func TestOwnedRulesWithoutBindingNeverGuessBackend(t *testing.T) {
	for _, marker := range []string{"network.owned", "network.active", "network.pending"} {
		t.Run(marker, func(t *testing.T) {
			a := testUFI(Environment{Root: filepath.Join(t.TempDir(), "mihomoctl"), Run: func(context.Context, []*os.File, string, ...string) ([]byte, error) {
				t.Fatal("queried a guessed backend for existing owned resources")
				return nil, nil
			}})
			if err := fsutil.AtomicWrite(a.runtime(marker), nil, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := a.firewall(context.Background(), true); err == nil || !strings.Contains(err.Error(), "缺少后端记录") {
				t.Fatal(err)
			}
			if fsutil.RegularFile(a.runtime("firewall.json")) {
				t.Fatal("invented a binding")
			}
		})
	}
}
