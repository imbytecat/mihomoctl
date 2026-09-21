package manager

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/host"
)

func TestLogTailsDoNotExposeTruncatedSecretLines(t *testing.T) {
	a := testAgent(t)
	id := randomID()
	for _, path := range []string{a.taskPath(id, "log.txt"), a.runtime("core.log"), a.runtime("supervisor.log")} {
		if err := fsutil.AtomicWrite(path, []byte("password: "+strings.Repeat("s", 32*1024)+"\nsafe final line\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	logs, err := a.Logs()
	if err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{a.readJobLog(id), logs} {
		if strings.Contains(output, "ssss") || !strings.Contains(output, "safe final line") {
			t.Fatal("log tail leaked a partial secret line or lost the final line")
		}
	}
}

func TestAtomicWritesReplaceWithoutFollowingLinks(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "target"), filepath.Join(dir, "link")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	old, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if err := fsutil.AtomicWrite(target, []byte("new"), 0700); err != nil {
		t.Fatal(err)
	}
	if data, _ := io.ReadAll(old); string(data) != "original" {
		t.Fatal("modified the old inode")
	}
	if info, _ := os.Stat(target); info.Mode().Perm() != 0700 {
		t.Fatal("lost executable mode")
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(link, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(target); string(data) != "new" {
		t.Fatal("followed the destination symlink")
	}
	if info, _ := os.Lstat(link); !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		t.Fatal("unsafe secret permissions")
	}
	if err := fsutil.AtomicWrite(dir, []byte("failure"), 0600); err == nil {
		t.Fatal("replaced a directory")
	}
	entries, _ := os.ReadDir(filepath.Dir(dir))
	for _, entry := range entries {
		if entry.Name() != filepath.Base(dir) {
			t.Fatal("temporary file survived failure", entry.Name())
		}
	}
}

func TestProcessIdentityRejectsStalePID(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Linux procfs")
	}
	a := testAgent(t)
	start := host.Start(os.Getpid())
	if start == "" {
		t.Fatal("cannot identify running process")
	}
	for _, recorded := range []string{start, "stale"} {
		if err := fsutil.WriteJSON(a.runtime("core.json"), host.Record{PID: os.Getpid(), Start: recorded}); err != nil {
			t.Fatal(err)
		}
		process, err := host.Owned(host.Record{PID: os.Getpid(), Start: recorded})
		if err != nil {
			t.Fatal(err)
		}
		if process != nil {
			process.Release()
		}
		if (process != nil) != (recorded == start) {
			t.Fatal("PID ownership check failed")
		}
	}
}
