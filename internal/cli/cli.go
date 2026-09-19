// Package cli composes the shared manager with a platform and a calling transport.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/imbytecat/mihomoctl/internal/manager"
	"github.com/imbytecat/mihomoctl/internal/platform"
	ufitransport "github.com/imbytecat/mihomoctl/internal/transport/ufi"
	"github.com/spf13/cobra"
)

func New(version string) *cobra.Command {
	var root string
	var config platform.Config
	var uploads, input, id, releaseProxy string
	var noWait, controllerConfig bool
	command := &cobra.Command{Use: "mihomoctl", Short: "Manage Mihomo independently of its user interface", Version: version, SilenceUsage: true, SilenceErrors: true}
	command.PersistentFlags().StringVar(&root, "root", "", "State directory (platform default when omitted)")
	command.PersistentFlags().StringVar(&config.Kind, "platform", "", "Platform: ufi or linux (saved deployment when installed)")
	open := func() (*manager.Manager, error) {
		directory := root
		if directory == "" {
			kind := config.Kind
			if kind == "" {
				kind = platform.DefaultKind()
			}
			directory = platform.DefaultRoot(kind)
		}
		directory, err := filepath.Abs(directory)
		if err != nil {
			return nil, err
		}
		deployment, err := platform.Load(directory, config)
		if err != nil {
			return nil, err
		}
		executable := filepath.Join(directory, "mihomoctl")
		adapter, err := platform.New(deployment, platform.Environment{Root: directory, Executable: executable})
		if err != nil {
			return nil, err
		}
		return manager.New(directory, version, adapter)
	}
	command.AddCommand(&cobra.Command{Use: "version", Short: "Print version and protocol as JSON", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]any{"version": version, "protocol": manager.Protocol})
	}})
	command.AddCommand(&cobra.Command{Use: "network-state FIELD TABLE PRIORITY MARK", Hidden: true, Args: cobra.ExactArgs(4), RunE: func(cmd *cobra.Command, args []string) error {
		var numbers [3]uint64
		for i, value := range args[1:] {
			bits := 31
			if i == 2 {
				bits = 32
			}
			number, err := strconv.ParseUint(value, 0, bits)
			if err != nil || number == 0 {
				return fmt.Errorf("无效网络检查参数：%s", value)
			}
			numbers[i] = number
		}
		result, err := platform.NetworkState(args[0], int(numbers[0]), int(numbers[1]), uint32(numbers[2]))
		if err != nil {
			return err
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
	}})
	type commandEntry struct {
		use, short string
		args       cobra.PositionalArgs
		hidden     bool
		run        func(*cobra.Command, *manager.Manager, []string) (any, error)
	}
	entries := []commandEntry{
		{"install", "Initialize this platform deployment", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) {
			return map[string]any{"ok": true, "executable": m.Executable}, m.Install(releaseProxy)
		}},
		{"status", "Print platform, capabilities and runtime state", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return m.Inspect() }},
		{"check-updates", "Check official component releases and cache the comparison", cobra.NoArgs, false, func(cmd *cobra.Command, m *manager.Manager, _ []string) (any, error) {
			return m.CheckUpdates(cmd.Context())
		}},
		{"submit UPLOAD SHA256", "Accept an encrypted UFI upload", cobra.ExactArgs(2), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) {
			if m.Platform.Config().Kind != platform.UFI {
				return nil, errors.New("该命令仅用于 UFI 上传；本地调用请直接使用操作命令")
			}
			file, err := ufitransport.ReadUpload(uploads, args[0], args[1])
			if err != nil {
				return nil, err
			}
			job, err := m.SubmitSealed(file.Bytes)
			if err != nil {
				return nil, err
			}
			return job, file.Consume()
		}},
		{"cancel ID", "Cancel a task before installation or configuration commit", cobra.ExactArgs(1), false, func(cmd *cobra.Command, m *manager.Manager, args []string) (any, error) {
			job, err := m.Cancel(args[0])
			if err != nil || noWait {
				return job, err
			}
			return awaitTask(cmd.Context(), m, job)
		}},
		{"job ID", "Print task state", cobra.ExactArgs(1), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) { return m.Job(args[0]) }},
		{"job-log ID", "Print sanitized task logs", cobra.ExactArgs(1), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) { return m.JobLog(args[0]) }},
		{"controller-secret PUBLIC_KEY", "Encrypt the API key for the supplied public key", cobra.ExactArgs(1), false, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) {
			if controllerConfig {
				return m.ControllerOverrides(args[0])
			}
			return m.ControllerSecret(args[0])
		}},
		{"logs", "Print sanitized runtime logs", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return m.Logs() }},
		{"diagnose", "Print network diagnostics", cobra.NoArgs, false, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return m.Diagnose() }},
		{"worker ID", "Execute an accepted task with inherited descriptors", cobra.ExactArgs(1), true, func(_ *cobra.Command, m *manager.Manager, args []string) (any, error) { return nil, m.Worker(args[0]) }},
		{"supervise", "Run the UFI runtime supervisor", cobra.NoArgs, true, func(_ *cobra.Command, m *manager.Manager, _ []string) (any, error) { return nil, m.Supervise() }},
	}
	operations := map[string]string{
		"save-release-proxy": "Save the public release forwarding origin",
		"download":           "Install or update the Mihomo core",
		"download-dashboard": "Install or update Zashboard",
		"update":             "Fetch and apply the subscription configuration",
		"save-controller":    "Save and apply local YAML overrides or controller settings",
		"save-interfaces":    "Save UFI shared network interfaces",
		"start":              "Start Mihomo",
		"stop":               "Stop Mihomo",
		"restart":            "Restart Mihomo",
		"boot-on":            "Enable startup at boot",
		"boot-off":           "Disable startup at boot",
		"uninstall":          "Remove this installation and its data",
		"self-update":        "Update mihomoctl",
	}
	runOperation := func(cmd *cobra.Command, m *manager.Manager, _ []string) (any, error) {
		params := manager.Params{}
		if input != "" {
			var reader io.Reader = cmd.InOrStdin()
			if input != "-" {
				file, err := os.Open(input)
				if err != nil {
					return nil, err
				}
				defer file.Close()
				reader = file
			}
			data, err := io.ReadAll(io.LimitReader(reader, 48*1024+1))
			if err != nil || len(data) > 48*1024 {
				return nil, errors.New("输入过大或不可读")
			}
			raw, _ := json.Marshal(map[string]any{"id": "00000000000000000000000000000000", "action": cmd.Name(), "params": json.RawMessage(data)})
			parsed, err := manager.DecodeRequest(raw)
			if err != nil {
				return nil, err
			}
			params = parsed.Params
		}
		job, err := m.Submit(manager.Request{ID: id, Action: cmd.Name(), Params: params})
		if err != nil {
			return nil, err
		}
		if !noWait {
			return awaitTask(cmd.Context(), m, job)
		}
		return job, nil
	}
	for name, short := range operations {
		entries = append(entries, commandEntry{name, short, cobra.NoArgs, false, runOperation})
	}
	for _, entry := range entries {
		child := &cobra.Command{Use: entry.use, Short: entry.short, Args: entry.args, Hidden: entry.hidden, RunE: func(cmd *cobra.Command, args []string) error {
			m, err := open()
			if err != nil {
				return err
			}
			defer m.Close()
			result, err := entry.run(cmd, m, args)
			if err != nil || result == nil {
				return err
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
		}}
		switch child.Name() {
		case "install":
			child.Flags().StringVar(&releaseProxy, "release-proxy", "", "Public HTTPS origin hosting netnr/workers cors.js (empty: direct)")
			child.Flags().StringVar(&config.Unit, "unit", "", "Service name (Linux)")
			child.Flags().StringVar(&config.ListenAddress, "listen-address", "", "Local IPv4 listen address (Linux; loopback by default)")
		case "controller-secret":
			child.Flags().BoolVar(&controllerConfig, "config", false, "Encrypt the local YAML overrides instead of only the API key")
		case "cancel":
			child.Flags().BoolVar(&noWait, "no-wait", false, "Return the cancellation request immediately")
		case "submit":
			child.Flags().StringVar(&uploads, "uploads", platform.UFIUploads, "UFI public upload directory")
		}
		if _, ok := operations[child.Name()]; ok {
			child.Flags().StringVar(&input, "input", "", "Params JSON file, or - for stdin")
			child.Flags().StringVar(&id, "id", "", "Stable task ID for retry/reconnection")
			child.Flags().BoolVar(&noWait, "no-wait", false, "Return the accepted task immediately; it continues after this command exits")
		}
		command.AddCommand(child)
	}
	return command
}
func awaitTask(ctx context.Context, m *manager.Manager, initial *manager.Job) (*manager.Job, error) {
	task := initial
	missing := 0
	if task.Action == "uninstall" {
		_ = m.Close()
	}
	for task.State == "queued" || task.State == "running" {
		select {
		case <-ctx.Done():
			return task, ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
		if task.Action == "uninstall" {
			removed := true
			for _, path := range append([]string{m.Root}, m.Platform.ExtraPaths()...) {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					removed = false
				}
			}
			if removed {
				task.State = "succeeded"
				task.Phase = "done"
				task.Result = "mihomoctl 数据已卸载"
				return task, nil
			}
		}
		next, err := m.Job(task.ID)
		if task.Action == "uninstall" {
			_ = m.Close()
		}
		if err != nil {
			if task.Action == "uninstall" {
				missing++
				if missing < 200 {
					continue
				}
			}
			return task, err
		}
		task = next
	}
	if task.State != "succeeded" && task.State != "cancelled" {
		return task, fmt.Errorf("任务 %s 失败：%s", task.ID, task.Error)
	}
	return task, nil
}
