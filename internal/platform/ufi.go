package platform

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/host"
	"github.com/imbytecat/mihomoctl/internal/redact"
)

//go:embed network_ufi.sh
var networkScript []byte

var listenConflict = regexp.MustCompile(`\blevel="?error"? .*\blisten (?:tcp|udp)[46]? [^ ]+:([0-9]+): bind: address already in use`)

func startupListenError(path string, offset int64) error {
	data, err := fsutil.ReadTailSince(path, offset, 8*1024)
	if err != nil {
		return nil // Readiness checks still own missing or unreadable log failures.
	}
	if match := listenConflict.FindSubmatch(data); match != nil {
		return fmt.Errorf("监听端口 %s 已被占用，请更换为空闲端口或停止占用该端口的程序", match[1])
	}
	return nil
}

const UFIUploads = "/data/data/com.minikano.f50_sms/files/uploads"

type UFIAdapter struct {
	Environment
	BootPath string
}

func NewUFI(env Environment) *UFIAdapter {
	return &UFIAdapter{Environment: env, BootPath: "/sdcard/ufi_tools_boot.sh"}
}
func (a *UFIAdapter) Config() Config { return Config{Kind: UFI} }
func (a *UFIAdapter) Capabilities() Capabilities {
	return Capabilities{Interfaces: true, Capture: true}
}
func (a *UFIAdapter) Policy() Policy       { return Policy{"*", "0.0.0.0", "0.0.0.0"} }
func (a *UFIAdapter) ExtraPaths() []string { return []string{a.Root + "-bootstrap"} }
func (a *UFIAdapter) CertDirs() []string {
	return []string{"/system/etc/security/cacerts", "/apex/com.android.conscrypt/cacerts"}
}
func (a *UFIAdapter) Prepare() error {
	return fsutil.AtomicWrite(a.runtime("network.sh"), networkScript, 0700)
}
func (a *UFIAdapter) AttachTask(context.Context, int, string) error { return nil }
func (a *UFIAdapter) Remove(ctx context.Context) error {
	if err := a.Stop(ctx); err != nil {
		return err
	}
	return a.SetBoot(ctx, false)
}
func (a *UFIAdapter) Inspect(ctx context.Context) (State, error) {
	s := State{Running: a.running(), Supervisor: a.alive("supervisor"), Capture: fsutil.RegularFile(a.runtime("network.active")) || fsutil.RegularFile(a.runtime("network.pending"))}
	if data, err := os.ReadFile(a.BootPath); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == a.BootLine() {
				s.Boot = true
			}
		}
	} else if !os.IsNotExist(err) {
		return s, err
	}
	if !s.Running && !s.Capture {
		return s, nil
	}
	fw, err := a.firewall(ctx, false)
	if err != nil {
		return s, nil
	}
	output, err := a.command(ctx, nil, "/system/bin/sh", a.runtime("network.sh"), a.runtime(), "inspect", fw.IPv4, fw.IPv6, a.Executable)
	if err == nil {
		var n struct{ Listeners, Network bool }
		if json.Unmarshal(output, &n) == nil {
			s.Listeners = n.Listeners
			s.Network = n.Network
		}
	}
	return s, nil
}
func (a *UFIAdapter) process(name string) (*os.Process, bool) {
	var record host.Record
	if fsutil.ReadJSON(a.runtime(name+".json"), &record) != nil {
		return nil, false
	}
	return host.Owned(record)
}

func (a *UFIAdapter) alive(name string) bool {
	process, alive := a.process(name)
	if process != nil {
		process.Release()
	}
	return alive
}
func (a *UFIAdapter) running() bool { return a.alive("core") || a.alive("supervisor") }

func (a *UFIAdapter) network(ctx context.Context, action string) error {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	lock, err := os.OpenFile(a.runtime("network.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	for syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	fw, err := a.firewall(ctx, action == "check" || action == "prepare")
	if err != nil {
		return err
	}
	output, err := a.command(ctx, []*os.File{lock}, "/system/bin/sh", a.runtime("network.sh"), a.runtime(), action, fw.IPv4, fw.IPv6, a.Executable)
	if err != nil {
		return fmt.Errorf("网络规则 %s 失败（%s，%s / %s）：%w\n%s", action, fw.Backend, fw.IPv4, fw.IPv6, err, redact.String(string(output)))
	}
	return nil
}

func (a *UFIAdapter) stopProcess(name string) error {
	p, alive := a.process(name)
	if p != nil {
		defer p.Release()
	}
	if !alive {
		return nil
	}
	if err := p.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		q, live := a.process(name)
		if q != nil {
			q.Release()
		}
		if !live {
			return nil
		}
	}
	if err := p.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	for i := 0; i < 50; i++ {
		if !a.alive(name) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("进程未退出，保留网络保护")
}

func (a *UFIAdapter) Stop(_ context.Context) error {
	if err := a.stopProcess("supervisor"); err != nil {
		return err
	}
	if err := a.stopProcess("core"); err != nil {
		return err
	}
	if fsutil.RegularFile(a.runtime("network.owned")) {
		if err := a.network(context.Background(), "stop"); err != nil {
			return err
		}
	}
	return nil
}

func (a *UFIAdapter) Start(ctx context.Context, options StartOptions) error {
	if err := fsutil.AtomicWrite(a.runtime("interfaces"), []byte(strings.Join(options.Interfaces, " ")), 0600); err != nil {
		return err
	}
	if err := a.Stop(context.Background()); err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(a.runtime("network.sh"), networkScript, 0700); err != nil {
		return err
	}
	if err := a.network(ctx, "check"); err != nil {
		return errors.Join(fmt.Errorf("启动前能力检查失败：%w", err), a.Stop(context.Background()))
	}
	offsets := map[string]int64{}
	for _, name := range []string{"supervisor.log", "core.log"} {
		if info, err := os.Stat(a.runtime(name)); err == nil {
			offsets[name] = info.Size()
		}
	}
	log, err := os.OpenFile(a.runtime("supervisor.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(a.Executable, "supervise", "--root", a.Root)
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	var done chan struct{}
	var exitErr error
	var readyErr error
	failure := func(cause error) error {
		state := fmt.Errorf("失败时状态（清理前）：守护进程存活=%t，内核存活=%t", a.alive("supervisor"), a.alive("core"))
		if readyErr == nil {
			probe, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			readyErr = a.network(probe, "ready")
			cancel()
		}
		var childErr error
		if done != nil {
			select {
			case <-done:
			default:
				if err := cmd.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
					childErr = err
				}
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
						childErr = errors.Join(childErr, err)
					}
					select {
					case <-done:
					case <-time.After(2 * time.Second):
						childErr = errors.Join(childErr, errors.New("等待本次守护进程退出超时"))
					}
				}
			}
		}
		cleanup := errors.Join(childErr, a.Stop(context.Background()))
		cleanupResult := errors.New("清理结果：本次进程已停止，本安装网络规则已清理；配置与日志保留")
		if cleanup != nil {
			cleanup = fmt.Errorf("启动失败后的清理也失败：%w", cleanup)
			cleanupResult = errors.New("清理结果：未完成，请查看清理错误并重试停止操作")
		}
		details := []error{fmt.Errorf("代理启动失败：%w", cause), cleanupResult, state, readyErr, cleanup}
		for _, name := range []string{"supervisor.log", "core.log"} {
			data, err := fsutil.ReadTailSince(a.runtime(name), offsets[name], 8*1024)
			if err == nil && len(data) > 0 {
				details = append(details, fmt.Errorf("%s（本次启动）:\n%s", name, redact.String(string(data))))
			}
		}
		return errors.Join(details...)
	}
	if err = cmd.Start(); err != nil {
		return failure(err)
	}
	done = make(chan struct{})
	go func() { exitErr = cmd.Wait(); close(done) }()
	stable := 0
	for i := 0; i < 20; i++ {
		select {
		case <-ctx.Done():
			return failure(ctx.Err())
		case <-done:
			if exitErr == nil {
				exitErr = errors.New("守护进程提前退出")
			}
			return failure(fmt.Errorf("本次守护进程退出：%w", exitErr))
		case <-time.After(time.Second):
		}
		if err := startupListenError(a.runtime("core.log"), offsets["core.log"]); err != nil {
			return failure(err)
		}
		readyErr = a.network(ctx, "ready")
		if readyErr == nil && !a.alive("supervisor") {
			readyErr = errors.New("守护进程记录不可验证")
		}
		if readyErr == nil {
			stable++
		} else {
			stable = 0
		}
		if stable >= 5 {
			select {
			case <-done:
				return failure(errors.New("守护进程在就绪检查期间退出"))
			default:
				return nil
			}
		}
	}
	return failure(errors.New("启动就绪检查未通过（要求连续通过 5 次）"))
}

func (a *UFIAdapter) Supervise() error {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	return a.supervise(ctx)
}

func (a *UFIAdapter) supervise(ctx context.Context) error {
	lock, err := os.OpenFile(a.runtime("supervisor.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("守护进程已运行")
	}
	if err = fsutil.WriteJSON(a.runtime("supervisor.json"), host.Record{PID: os.Getpid(), Start: host.Start(os.Getpid())}); err != nil {
		return err
	}
	defer os.Remove(a.runtime("supervisor.json"))
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	logger.Info("UFI 守护已启动", "pid", os.Getpid())
	delay := time.Second
	retry := func() bool {
		logger.Info("等待重新启动内核", "delay", delay)
		select {
		case <-ctx.Done():
			return false
		case <-time.After(delay):
		}
		delay = min(delay*2, 30*time.Second)
		return true
	}
	cleanup := func() error {
		err := a.network(context.Background(), "stop")
		if err != nil {
			logger.Error("网络规则清理失败，保留清理记录", "error", redact.String(err.Error()))
		}
		return err
	}
	for ctx.Err() == nil {
		if info, err := os.Stat(a.runtime("supervisor.log")); err == nil && info.Size() > 256<<10 {
			_ = os.Truncate(a.runtime("supervisor.log"), 0)
		}
		// Protect listeners even before the hotspot exists; no core starts unguarded.
		if err := a.network(ctx, "prepare"); err != nil {
			logger.Error("网络保护准备失败，内核未启动", "error", redact.String(err.Error()))
			cleanupErr := cleanup()
			if !retry() {
				return cleanupErr
			}
			continue
		}
		log, err := os.OpenFile(a.runtime("core.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		cmd := exec.CommandContext(ctx, a.runtime("mihomo"), "-d", a.runtime(), "-f", a.runtime("current", "config.yaml"))
		cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
		cmd.WaitDelay = 5 * time.Second
		cmd.Stdout = log
		cmd.Stderr = log
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err = cmd.Start(); err != nil {
			log.Close()
			logger.Error("内核进程启动失败", "error", redact.String(err.Error()))
			cleanupErr := cleanup()
			if !retry() {
				return cleanupErr
			}
			continue
		}
		err = fsutil.WriteJSON(a.runtime("core.json"), host.Record{PID: cmd.Process.Pid, Start: host.Start(cmd.Process.Pid)})
		if err == nil {
			err = fsutil.AtomicWrite(a.runtime("core.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0600)
		}
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			log.Close()
			return errors.Join(fmt.Errorf("无法记录内核进程：%w", err), cleanup())
		}
		logger.Info("Mihomo 内核已启动", "pid", cmd.Process.Pid)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		ticker := time.NewTicker(5 * time.Second)
		started := time.Now()
		alive := true
		for alive {
			select {
			case <-ctx.Done():
				logger.Info("收到停止请求，等待本次内核退出")
				<-done // CommandContext sends TERM, then kills only this child after WaitDelay.
				alive = false
			case err := <-done:
				logger.Warn("Mihomo 内核退出", "error", err, "uptime", time.Since(started))
				alive = false
			case <-ticker.C:
				e := a.network(ctx, "sync")
				if e != nil && ctx.Err() == nil {
					logger.Error("网络同步失败，为保护监听端口终止内核", "error", redact.String(e.Error()))
					// Unknown guard state must not leave a public proxy listening.
					if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
						logger.Error("终止本次内核失败", "error", err)
					}
				}
				if info, e := log.Stat(); e == nil && info.Size() > 1<<20 {
					_ = log.Truncate(0)
				}
			}
		}
		ticker.Stop()
		log.Close()
		cleanupErr := cleanup()
		_ = os.Remove(a.runtime("core.json"))
		_ = os.Remove(a.runtime("core.pid"))
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		if ctx.Err() != nil {
			logger.Info("守护已停止，内核进程已退出", "networkClean", cleanupErr == nil)
			return cleanupErr
		}
		if !retry() {
			return cleanupErr
		}
	}
	return nil
}

func (a *UFIAdapter) BootLine() string {
	return "'" + strings.ReplaceAll(a.path("mihomoctl"), "'", "'\\''") + "' start --no-wait --root '" + strings.ReplaceAll(a.Root, "'", "'\\''") + "' # mihomoctl"
}
func (a *UFIAdapter) SetBoot(_ context.Context, enabled bool) error {
	data, err := os.ReadFile(a.BootPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != a.BootLine() {
			lines = append(lines, line)
		}
	}
	if enabled {
		lines = append(lines, a.BootLine())
	}
	return fsutil.AtomicWrite(a.BootPath, []byte(strings.TrimRight(strings.Join(lines, "\n"), "\n")+"\n"), 0644)
}
