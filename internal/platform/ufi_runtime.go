package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/redact"
)

func readBootID() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", fmt.Errorf("无法读取本次开机标识：%w", err)
	}
	id, err := uuid.Parse(strings.TrimSpace(string(data)))
	if err != nil {
		return "", errors.New("无效开机标识")
	}
	return id.String(), nil
}

func (a *UFIAdapter) previousBoot() (bool, error) {
	data, err := os.ReadFile(a.runtime("boot_id"))
	if os.IsNotExist(err) {
		return false, nil
	} // No boot proof: verify kernel resources directly.
	if err != nil {
		return false, err
	}
	previous, err := uuid.Parse(strings.TrimSpace(string(data)))
	if err != nil {
		return false, errors.New("开机标识记录损坏，保留运行记录")
	}
	id, err := a.bootID()
	if err != nil {
		return false, err
	}
	return previous.String() != id, nil
}

func (a *UFIAdapter) hasNetworkState() bool {
	for _, name := range []string{"firewall.json", "network.owned", "network.active", "network.pending"} {
		if fsutil.RegularFile(a.runtime(name)) {
			return true
		}
	}
	return false
}

// Always execute this binary's adapter. An Agent update must not run stale script bytes.
func (a *UFIAdapter) runNetwork(ctx context.Context, files []*os.File, action string, fw firewall) ([]byte, error) {
	return a.command(ctx, files, "/system/bin/sh", "-c", string(networkScript), "mihomoctl-network", a.runtime(), action, fw.IPv4, fw.IPv6, a.Executable)
}

func (a *UFIAdapter) inspectNetwork(ctx context.Context) (State, error) {
	var state State
	fw, err := a.firewall(ctx, false)
	if err != nil {
		return state, err
	}
	output, err := a.runNetwork(ctx, nil, "inspect", fw)
	if err != nil {
		return state, fmt.Errorf("无法核验实际网络规则：%w\n%s", err, redact.String(string(output)))
	}
	var result struct{ Listeners, Network, Capture *bool }
	if err := json.Unmarshal(output, &result); err != nil || result.Listeners == nil || result.Network == nil || result.Capture == nil {
		return state, errors.New("网络状态响应不完整")
	}
	state.Listeners, state.Network, state.Capture = *result.Listeners, *result.Network, *result.Capture
	return state, nil
}

func (a *UFIAdapter) removeRuntimeFiles(names ...string) error {
	for _, name := range names {
		if err := os.Remove(a.runtime(name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
