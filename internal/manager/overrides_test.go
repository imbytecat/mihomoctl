package manager

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"go.yaml.in/yaml/v3"
	"golang.org/x/crypto/nacl/box"
)

func TestOverrideMergePreservesUnspecifiedFieldsAndReplacesArrays(t *testing.T) {
	source := []byte("proxies: []\ndns: {nameserver: [one, two], enhanced-mode: fake-ip, fallback: [old]}\nfeature: true\nrules: [old]\nremove: old\n")
	overlay, err := overrideMapping([]byte("dns: {nameserver: [], fallback: [new]}\nfeature: false\nrules: [new]\nremove: null\nfuture-option: {enabled: true}\n"))
	if err != nil {
		t.Fatal(err)
	}
	merged, err := mergeOverrides(source, overlay)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := yaml.Unmarshal(merged, &config); err != nil {
		t.Fatal(err)
	}
	dns := config["dns"].(map[string]any)
	if config["proxies"] == nil || config["feature"] != false || config["remove"] != nil || dns["enhanced-mode"] != "fake-ip" || len(dns["nameserver"].([]any)) != 0 || !reflect.DeepEqual(dns["fallback"], []any{"new"}) || !reflect.DeepEqual(config["rules"], []any{"new"}) || config["future-option"] == nil {
		t.Fatalf("incorrect merge: %s", merged)
	}
	for _, invalid := range []string{"key: 1\nkey: 2", "key: 1\n---\nkey: 2", "[one, two]", "secret: [", strings.Repeat("x", overridesLimit+1)} {
		if _, err := overrideMapping([]byte(invalid)); err == nil {
			t.Fatalf("accepted invalid overlay %q", invalid[:min(len(invalid), 30)])
		}
	}
}

func TestOverridesPersistEncryptAndRollbackWithConfiguration(t *testing.T) {
	a := testAgent(t)
	text := "external-controller: :9191\nsecret: overlay-private-key\nmode: global\nfuture-option: {enabled: true}\ndns: {enhanced-mode: redir-host}\n"
	job, err := a.Submit(Request{ID: randomID(), Action: "save-controller", Params: Params{Controller: &ControllerInput{YAML: &text}}})
	if err != nil {
		t.Fatal(err)
	}
	if result := waitJob(t, a, job.ID); result.State != "succeeded" {
		t.Fatalf("YAML worker request failed: %+v", result)
	}
	save := func(value string) error {
		_, err := a.saveController(context.Background(), Request{ID: randomID(), Params: Params{Controller: &ControllerInput{YAML: &value}}}, func(string) {})
		return err
	}
	if err := save(text); err != nil {
		t.Fatal(err)
	}
	if err := save("# keep this note\nmode: global\n"); err != nil {
		t.Fatal(err)
	}
	if saved, _ := a.overrides(); !strings.Contains(string(saved), "# keep this note") {
		t.Fatal("lost user comments while filling omitted management settings")
	}
	control, err := a.controller()
	if err != nil || control.Port != 9191 || control.Secret != "overlay-private-key" {
		t.Fatal("unapplied override settings lost", control, err)
	}
	if err := save(text); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.AtomicWrite(a.corePath(), []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	source := []byte("proxies: []\nrules: [MATCH,DIRECT]\ndns: {nameserver: [https://resolver.invalid/dns-query], enhanced-mode: fake-ip}\n")
	if err := a.applyConfig(context.Background(), randomID(), source, "https://fixture.invalid", control, func(string) {}); err != nil {
		t.Fatal(err)
	}
	active, _ := a.activeGeneration()
	raw, err := a.overrides()
	if err != nil || string(raw) != text {
		t.Fatal("generation lost overlay", err)
	}
	original, _ := os.ReadFile(a.runtime("current", "source.yaml"))
	if string(original) != string(source) {
		t.Fatal("overwrote subscription source")
	}
	data, _ := os.ReadFile(a.runtime("current", "config.yaml"))
	if !strings.Contains(string(data), "redir-host") || !strings.Contains(string(data), "resolver.invalid") || !strings.Contains(string(data), "future-option") {
		t.Fatal("overlay not applied", string(data))
	}
	public, private, _ := box.GenerateKey(rand.Reader)
	sealed, err := a.ControllerOverrides(base64.StdEncoding.EncodeToString(public[:]))
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := base64.StdEncoding.DecodeString(sealed)
	plain, ok := box.OpenAnonymous(nil, encoded, public, private)
	if !ok || string(plain) != text {
		t.Fatal("encrypted editor response lost data")
	}
	status, err := a.Inspect()
	if err != nil {
		t.Fatal(err)
	}
	statusJSON, _ := json.Marshal(status)
	if strings.Contains(string(statusJSON), "overlay-private-key") || !status.Controller.Overrides {
		t.Fatal("public status leaked secret or omitted capability")
	}
	if info, err := os.Stat(filepath.Join(a.runtime("current"), "overrides.yaml")); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("unsafe overlay file", err)
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return nil, errors.New("core rejected configuration")
	}
	if err := save("external-controller: :9292\nsecret: rejected-private-key\n"); err == nil {
		t.Fatal("accepted invalid core configuration")
	}
	if current, _ := a.activeGeneration(); current != active {
		t.Fatal("switched before validation")
	}
	if raw, _ := a.overrides(); string(raw) != text {
		t.Fatal("failed save changed active overlay")
	}
	a.runCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := &canceledStart{Adapter: a.Platform, cancel: cancel, running: true}
	a.Platform = runtime
	replacement := "external-controller: :9292\nsecret: rolled-back-key\nfuture-option: false\n"
	if _, err := a.saveController(ctx, Request{ID: randomID(), Params: Params{Controller: &ControllerInput{YAML: &replacement}}}, func(string) {}); err == nil {
		t.Fatal("accepted failed runtime restart")
	}
	if raw, _ := a.overrides(); string(raw) != text || !runtime.running || runtime.starts != 2 {
		t.Fatal("runtime rollback failed to restore overlay and running state")
	}
	for _, invalid := range []string{"tproxy-port: 1234", "dns: {listen: '0.0.0.0:9999'}", "tun: {enable: true}"} {
		if err := save(invalid); err == nil {
			t.Fatal("changed managed listener policy")
		}
	}
	if err := save(""); err != nil {
		t.Fatal(err)
	}
	control, err = a.controller()
	if err != nil || control.Secret != "overlay-private-key" || control.Port != 9191 {
		t.Fatal("empty overlay reset credentials or control port", err)
	}
	if raw, _ := a.overrides(); strings.Contains(string(raw), "future-option") || !strings.Contains(string(raw), "external-controller") {
		t.Fatal("empty overlay did not restore base settings")
	}
}
