package manager

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/host"
	"github.com/imbytecat/mihomoctl/internal/platform"
	"github.com/imbytecat/mihomoctl/internal/redact"
	"github.com/imbytecat/mihomoctl/internal/storage"
	ufitransport "github.com/imbytecat/mihomoctl/internal/transport/ufi"

	"go.yaml.in/yaml/v3"
	"golang.org/x/crypto/nacl/box"
)

type localTransport struct{ address string }

func (client localTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	target, _ := url.Parse(client.address)
	copy := request.Clone(request.Context())
	u := *request.URL
	u.Scheme = target.Scheme
	u.Host = target.Host
	copy.URL = &u
	return http.DefaultTransport.RoundTrip(copy)
}

// A real child process exercises descriptor handoff without running ARM or firewall code.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "worker" {
		flags := flag.NewFlagSet("worker", flag.ExitOnError)
		root := flags.String("root", "", "")
		_ = flags.Parse(os.Args[2:])
		a, err := testManager(*root)
		if err != nil {
			os.Exit(2)
		}
		if address := os.Getenv("UFI_TEST_HTTP"); address != "" {
			a.httpTransport = localTransport{address}
		}
		if os.Getenv("UFI_TEST_RUNTIME_CHILD") == "1" {
			a.Platform = lockTestRuntime{Adapter: a.Platform, root: *root}
		}
		if err = a.Worker(flags.Arg(0)); err != nil {
			os.Exit(1)
		}
		_ = a.Close()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func testAgent(t *testing.T) *Manager {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "mihomoctl")
	uploads := filepath.Join(base, "uploads")
	if err := os.Mkdir(uploads, 0700); err != nil {
		t.Fatal(err)
	}
	a, err := testManager(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	if err = a.Install(""); err != nil {
		t.Fatal(err)
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return []byte(`{"listeners":false,"network":false}`), nil
	}
	return a
}

func sealRequest(t *testing.T, a *Manager, request Request) (string, string, []byte) {
	t.Helper()
	key, err := a.identity()
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := json.Marshal(request)
	data, err := box.SealAnonymous(nil, plain, &key.Public, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := randomID()
	name := id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:] + ".bin"
	if err = fsutil.AtomicWrite(filepath.Join(uploadDir(a), name), data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return name, hex.EncodeToString(digest[:]), data
}

func waitJob(t *testing.T, a *Manager, id string) *Job {
	t.Helper()
	for i := 0; i < 100; i++ {
		job, err := a.Job(id)
		if err != nil {
			t.Fatal(err)
		}
		if job.State != "queued" && job.State != "running" {
			return job
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return nil
}

func TestEncryptedSubmissionAndDurableCompletion(t *testing.T) {
	a := testAgent(t)
	request := Request{ID: randomID(), Action: "save-interfaces", Params: Params{Interfaces: new("wlan0")}}
	name, digest, data := sealRequest(t, a, request)
	if bytes.Contains(data, []byte(*request.Params.Interfaces)) {
		t.Fatal("request is not encrypted")
	}
	job, err := submitUpload(a, name, digest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(uploadDir(a), name)); !os.IsNotExist(err) {
		t.Fatal("staging file not consumed")
	}
	finished := waitJob(t, a, job.ID)
	if finished.State != "succeeded" {
		t.Fatalf("%+v", finished)
	}
	settings, _ := a.settings()
	if strings.Join(settings.Interfaces, " ") != *request.Params.Interfaces {
		t.Fatal(settings)
	}
	if err = fsutil.AtomicWrite(filepath.Join(uploadDir(a), name), data, 0600); err != nil {
		t.Fatal(err)
	}
	repeated, err := submitUpload(a, name, digest)
	if err != nil || repeated.ID != job.ID || repeated.State != "succeeded" {
		t.Fatalf("replay: %+v %v", repeated, err)
	}
}

func TestTaskRetainsLockAfterSubmitterReturns(t *testing.T) {
	a := testAgent(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; _, _ = w.Write([]byte(`{}`)) }))
	defer server.Close()
	t.Setenv("UFI_TEST_HTTP", server.URL)
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("fixture"), 0700)
	name, digest, _ := sealRequest(t, a, Request{ID: randomID(), Action: "update", Params: Params{URL: server.URL}})
	job, err := submitUpload(a, name, digest)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not request metadata")
	}
	if lock, err := a.lock(); err == nil {
		lock.Close()
		t.Fatal("worker lost the inherited lock")
	}
	close(release)
	finished := waitJob(t, a, job.ID)
	if finished.State != "failed" || finished.Phase != "adapt" {
		t.Fatalf("%+v", finished)
	}
}

func TestUnmanagedDataAndInvalidRequestsArePreserved(t *testing.T) {
	root := filepath.Join(t.TempDir(), "mihomoctl")
	_ = os.Mkdir(root, 0700)
	_ = os.WriteFile(filepath.Join(root, "keep"), []byte("data"), 0600)
	a, _ := testManager(root)
	if a.Install("") == nil {
		t.Fatal("overwrote unmanaged directory")
	}
	if data, _ := os.ReadFile(filepath.Join(root, "keep")); string(data) != "data" {
		t.Fatal("data changed")
	}
	a = testAgent(t)
	name, _, _ := sealRequest(t, a, Request{ID: randomID(), Action: "save-interfaces", Params: Params{Interfaces: new("wlan0")}})
	if _, err := submitUpload(a, name, strings.Repeat("0", 64)); err == nil {
		t.Fatal("accepted invalid digest")
	}
	if _, err := submitUpload(a, "../outside.bin", strings.Repeat("0", 64)); err == nil {
		t.Fatal("accepted traversal")
	}
	if _, err := os.Stat(filepath.Join(uploadDir(a), name)); err != nil {
		t.Fatal("deleted unverified staging file")
	}
}

func TestConfigPolicyPreservedAndFailedValidationDoesNotCommit(t *testing.T) {
	source := []byte("proxies: []\nproxy-groups: [{name: choice, type: select, proxies: [DIRECT]}]\nrules: [MATCH,choice]\ndns: {nameserver: [https://223.5.5.5/dns-query], enhanced-mode: fake-ip}\n")
	encoded, ports, err := adaptConfig(source, Controller{Enabled: true, Port: 9090, Secret: strings.Repeat("x", 32)}, false, ufiPolicy)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	_ = yaml.Unmarshal(source, &before)
	_ = yaml.Unmarshal(encoded, &after)
	for _, key := range []string{"proxies", "proxy-groups", "rules"} {
		if !reflect.DeepEqual(before[key], after[key]) {
			t.Fatal("policy changed", key)
		}
	}
	if ports != "7894,1053,9090" || after["dns"].(map[string]any)["enhanced-mode"] != "fake-ip" {
		t.Fatal(ports, after)
	}
	a := testAgent(t)
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("test fixture"), 0700)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(source) }))
	defer server.Close()
	a.httpTransport = server.Client().Transport
	id := randomID()
	work := a.taskPath(id, "")
	_ = os.MkdirAll(work, 0700)
	if _, err = a.updateConfig(context.Background(), Request{ID: id, Params: Params{URL: server.URL}}, work, func(string) {}); err != nil {
		t.Fatal(err)
	}
	first, _ := a.activeGeneration()
	if first != id {
		t.Fatal(first)
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("password: secret"), errors.New("invalid")
	}
	next := randomID()
	nextWork := a.taskPath(next, "")
	_ = os.MkdirAll(nextWork, 0700)
	if _, err = a.updateConfig(context.Background(), Request{ID: next, Params: Params{URL: server.URL}}, nextWork, func(string) {}); err == nil {
		t.Fatal("accepted invalid config")
	}
	if current, _ := a.activeGeneration(); current != first {
		t.Fatal("replaced active configuration")
	}
	config, _ := a.configuration()
	if config.URL != server.URL {
		t.Fatal("subscription changed")
	}
}

func TestIncompleteConfigTransactionRestoresPreviousGeneration(t *testing.T) {
	a := testAgent(t)
	old, next := randomID(), randomID()
	_ = os.MkdirAll(a.runtime("configurations", old), 0700)
	_ = os.MkdirAll(a.runtime("configurations", next), 0700)
	seedConfiguration(t, a, old)
	seedConfiguration(t, a, next)
	if err := a.activate(next); err != nil {
		t.Fatal(err)
	}
	if err := a.store.SavePending(storage.Pending{Previous: old, Next: next}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.recoverConfiguration(); err != nil {
		t.Fatal(err)
	}
	if active, _ := a.activeGeneration(); active != old {
		t.Fatal(active)
	}
}

func TestInterruptedJobAndSecretRedaction(t *testing.T) {
	a := testAgent(t)
	job := Job{ID: randomID(), State: "running", Action: "update", Phase: "subscription"}
	if err := a.store.CreateTask(job, "fixture", nil); err != nil {
		t.Fatal(err)
	}
	result, err := a.Job(job.ID)
	if err != nil || result.State != "interrupted" {
		t.Fatal(result, err)
	}
	text := redact.String("https://host/private?token=secret\npassword: abc\nuuid=abc\nordinary message")
	if strings.Contains(text, "secret") || strings.Contains(text, "abc") || !strings.Contains(text, "ordinary message") {
		t.Fatal(text)
	}
}

func TestOfficialAssetAndCoreIntegrity(t *testing.T) {
	for _, arch := range []string{"arm64-v8", "armv7"} {
		address := "https://github.com/MetaCubeX/mihomo/releases/download/v9.8.7/mihomo-android-" + arch + "-v9.8.7.gz"
		metadata := map[string]any{"tag_name": "v9.8.7", "draft": false, "prerelease": false, "assets": []map[string]any{{
			"name": "mihomo-android-" + arch + "-v9.8.7.gz", "browser_download_url": address, "digest": "sha256:" + strings.Repeat("a", 64),
		}}}
		data, _ := json.Marshal(metadata)
		if version, url, _, err := selectAsset(data, arch); err != nil || version != "v9.8.7" || url != address {
			t.Fatal(version, url, err)
		}
		metadata["prerelease"] = true
		data, _ = json.Marshal(metadata)
		if _, _, _, err := selectAsset(data, arch); err == nil {
			t.Fatal("accepted prerelease")
		}
		metadata["prerelease"] = false
		metadata["assets"].([]map[string]any)[0]["digest"] = ""
		data, _ = json.Marshal(metadata)
		if _, _, _, err := selectAsset(data, arch); err == nil {
			t.Fatal("accepted absent digest")
		}
	}
	a := testAgent(t)
	work := t.TempDir()
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write([]byte("verified fixture binary"))
	_ = gz.Close()
	archive := filepath.Join(work, "core.gz")
	_ = os.WriteFile(archive, compressed.Bytes(), 0600)
	_ = fsutil.AtomicWrite(a.runtime("mihomo"), []byte("previous core"), 0700)
	executed := false
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { executed = true; return nil, nil }
	if err := a.installCore(context.Background(), archive, work, strings.Repeat("0", 64), func(string) {}); err == nil || executed {
		t.Fatal("executed an unverified core")
	}
	if data, _ := os.ReadFile(a.runtime("mihomo")); string(data) != "previous core" {
		t.Fatal("replaced previous core")
	}
	digest := sha256.Sum256(compressed.Bytes())
	if err := a.installCore(context.Background(), archive, work, hex.EncodeToString(digest[:]), func(string) {}); err != nil || !executed {
		t.Fatal(err)
	}
}

func TestUninstallPreservesRuntimeOnCleanupFailure(t *testing.T) {
	a := testAgent(t)
	_ = fsutil.WriteJSON(a.runtime("firewall.json"), map[string]string{"ipv4": "/fixture/iptables", "ipv6": "/fixture/ip6tables", "backend": "legacy"})
	_ = fsutil.AtomicWrite(a.runtime("network.owned"), nil, 0600)
	_ = fsutil.AtomicWrite(a.runtime("private-data"), []byte("keep me"), 0600)
	_ = fsutil.AtomicWrite(a.Platform.(*platform.UFIAdapter).BootPath, []byte("other-plugin start\n"+a.Platform.(*platform.UFIAdapter).BootLine()+"\n"), 0644)
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("network failure") }
	request := Request{ID: randomID(), Action: "uninstall"}
	if _, err := a.execute(context.Background(), request, func(string) {}); err == nil {
		t.Fatal("ignored failed cleanup")
	}
	if !fsutil.RegularFile(a.runtime("private-data")) {
		t.Fatal("removed files before cleanup")
	}
	a.runCommand = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[len(args)-1] == "--version" {
			return []byte("iptables v1.8.7 (legacy)"), nil
		}
		return nil, nil
	}
	if _, err := a.execute(context.Background(), request, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(a.Root); !os.IsNotExist(err) {
		t.Fatal("installation retained after uninstall")
	}
	if data, _ := os.ReadFile(a.Platform.(*platform.UFIAdapter).BootPath); string(data) != "other-plugin start\n" {
		t.Fatal("changed another plugin's boot entry")
	}
	if err := a.Install(""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.execute(context.Background(), Request{ID: randomID(), Action: "install"}, func(string) {}); err == nil {
		t.Fatal("reinstalled an active installation")
	}
}

func TestDetachedUninstallDeletesAllOwnedFiles(t *testing.T) {
	a := testAgent(t)
	_ = fsutil.AtomicWrite(a.path("tasks", randomID(), "work", "config.yaml"), []byte("staged config"), 0600)
	_ = fsutil.AtomicWrite(filepath.Join(a.Root+"-bootstrap", "jobs", "old", "mihomoctl"), []byte("staging"), 0600)
	_ = fsutil.AtomicWrite(a.path("runtime", "core.log"), []byte("core log"), 0600)
	_ = fsutil.AtomicWrite(a.path("extra-file"), []byte("owned data"), 0600)
	_ = fsutil.AtomicWrite(a.Platform.(*platform.UFIAdapter).BootPath, []byte("other-plugin start\n"+a.Platform.(*platform.UFIAdapter).BootLine()+"\n"), 0644)
	other := filepath.Join(filepath.Dir(a.Root), "other-plugin")
	_ = os.WriteFile(other, []byte("untouched"), 0600)
	name, digest, _ := sealRequest(t, a, Request{ID: randomID(), Action: "uninstall"})
	if _, err := submitUpload(a, name, digest); err != nil {
		t.Fatal(err)
	}
	_ = a.Close()
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(a.Root); os.IsNotExist(err) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	// Give the worker time to finalize; writing its old task record must not recreate the root.
	time.Sleep(100 * time.Millisecond)
	for _, path := range []string{a.Root, a.Root + "-bootstrap"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("owned path remains", path)
		}
	}
	if data, _ := os.ReadFile(a.Platform.(*platform.UFIAdapter).BootPath); string(data) != "other-plugin start\n" {
		t.Fatal("modified another boot entry")
	}
	if data, _ := os.ReadFile(other); string(data) != "untouched" {
		t.Fatal("modified another plugin")
	}
}

func TestCleanupPreservesReplayRecordsAndActiveConfig(t *testing.T) {
	a := testAgent(t)
	active := randomID()
	_ = a.activate(active)
	for i := 0; i < 6; i++ {
		id := randomID()
		if i == 0 {
			id = active
		}
		_ = fsutil.AtomicWrite(a.runtime("configurations", id, "source.yaml"), []byte("fixture"), 0600)
		seedConfiguration(t, a, id)
		_ = a.store.CreateTask(Job{ID: id, Action: "update", State: "succeeded"}, "fingerprint", []byte("fixture"))
		_ = fsutil.AtomicWrite(a.taskPath(id, "work/core.gz"), []byte("fixture"), 0600)
	}
	a.pruneTaskFiles()
	entries, _ := os.ReadDir(a.runtime("configurations"))
	if len(entries) != 3 || !fsutil.RegularFile(a.runtime("configurations", active, "source.yaml")) {
		t.Fatal("configuration retention failed")
	}
	entries, _ = os.ReadDir(a.path("tasks"))
	if len(entries) != 6 {
		t.Fatal("removed replay records")
	}
	for _, entry := range entries {
		data, _ := a.store.Request(entry.Name())
		if len(data) != 0 || fsutil.RegularFile(a.taskPath(entry.Name(), "work/core.gz")) {
			t.Fatal("staging files retained")
		}
	}
}

func parseRelease(data []byte) (release, error) {
	var value release
	if err := json.Unmarshal(data, &value); err != nil {
		return value, errors.New("官方版本信息无效")
	}
	return value, value.validate()
}

func selectAsset(data []byte, arch string) (string, string, string, error) {
	value, err := parseRelease(data)
	if err != nil {
		return "", "", "", errors.New("官方版本信息无效")
	}
	return value.asset("MetaCubeX/mihomo", "mihomo-android-"+arch+"-"+value.TagName+".gz")
}

var ufiPolicy = platform.Policy{Bind: "*", DNS: "0.0.0.0", Controller: "0.0.0.0"}

func uploadDir(a *Manager) string { return filepath.Join(filepath.Dir(a.Root), "uploads") }
func testManager(root string) (*Manager, error) {
	p := platform.NewUFI(platform.Environment{Root: root, Executable: filepath.Join(root, "mihomoctl")})
	p.BootPath = filepath.Join(filepath.Dir(root), "boot.sh")
	a, err := New(root, "test", p)
	if err != nil {
		return nil, err
	}
	p.Run = func(ctx context.Context, files []*os.File, name string, args ...string) ([]byte, error) {
		if a.runCommand != nil {
			return a.runCommand(ctx, name, args...)
		}
		return host.Command(ctx, files, name, args...)
	}
	return a, nil
}
func submitUpload(a *Manager, name, digest string) (*Job, error) {
	file, err := ufitransport.ReadUpload(uploadDir(a), name, digest)
	if err != nil {
		return nil, err
	}
	job, err := a.SubmitSealed(file.Bytes)
	if err != nil {
		return nil, err
	}
	return job, file.Consume()
}

func seedConfiguration(t *testing.T, a *Manager, id string) {
	t.Helper()
	controller, err := a.store.Controller()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.store.SaveConfiguration(storage.Configuration{ID: id, URL: "https://fixture.invalid", Controller: &controller}); err != nil {
		t.Fatal(err)
	}
}
