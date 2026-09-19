package manager

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"github.com/imbytecat/mihomoctl/internal/download"
	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/platform"
	"github.com/imbytecat/mihomoctl/internal/storage"
)

func (a *Manager) Install(releaseProxy string) error {
	releaseProxy, err := download.ForwardOrigin(releaseProxy)
	if err != nil {
		return err
	}
	if err := a.initIdentity(); err != nil {
		return err
	}
	lock, err := a.lock()
	if err != nil {
		return err
	}
	defer lock.Close()
	if a.running() {
		return errors.New("请先停止代理")
	}
	settings, err := a.settings()
	if err != nil {
		return err
	}
	settings.ReleaseProxy = releaseProxy
	if err := a.store.SaveSettings(settings); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(a.Executable, data, 0700); err != nil {
		return err
	}
	if err := a.installRuntime(); err != nil {
		return err
	}
	return a.store.ClearLatest()
}

func (a *Manager) installRuntime() error {
	if err := os.MkdirAll(a.runtime(), 0700); err != nil {
		return err
	}
	if err := a.Platform.Prepare(); err != nil {
		return err
	}
	if data, err := a.overrides(); err != nil {
		return err
	} else if len(data) == 0 {
		control, err := a.controller()
		if err != nil {
			return err
		}
		defaults, err := a.defaultOverrides(control)
		if err != nil {
			return err
		}
		if err := fsutil.AtomicWrite(a.runtime("overrides.yaml"), defaults, 0600); err != nil {
			return err
		}
	}
	return a.store.SetInstalled()
}

func (a *Manager) execute(ctx context.Context, request Request, phase func(string)) (string, error) {
	if err := context.Cause(ctx); err != nil {
		return "", err
	}
	if err := a.authorize(request); err != nil {
		return "", err
	}
	params := request.Params
	if request.Action == "uninstall" {
		return "Mihomo 服务已卸载", a.uninstall(phase)
	}
	if request.Action == "install" {
		if a.running() || a.installed() {
			return "", errors.New("Mihomo 服务已安装，请刷新状态")
		}
		return "Mihomo 服务已安装", a.installRuntime()
	}
	if !a.installed() {
		return "", errors.New("Mihomo 服务未安装")
	}
	resume, err := a.recoverConfiguration()
	if err != nil {
		return "", err
	}
	if resume && request.Action != "stop" {
		if err = a.startRuntime(ctx); err != nil {
			return "", err
		}
	}
	work := a.taskPath(request.ID, "work")
	if err = os.MkdirAll(work, 0700); err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	switch request.Action {
	case "save-release-proxy":
		phase("saving")
		proxy, err := download.ForwardOrigin(*params.ReleaseProxy)
		if err != nil {
			return "", err
		}
		settings, err := a.settings()
		if err != nil {
			return "", err
		}
		settings.ReleaseProxy = proxy
		return "发行转发设置已保存", a.store.SaveSettings(settings)
	case "save-interfaces":
		phase("saving")
		if a.running() {
			return "", errors.New("请先停止代理")
		}
		value, err := parseInterfaces(*params.Interfaces)
		if err != nil {
			return "", err
		}
		settings, err := a.settings()
		if err != nil {
			return "", err
		}
		settings.Interfaces = value
		return "接口已保存", a.store.SaveSettings(settings)
	case "download":
		if a.running() {
			return "", errors.New("请先停止代理")
		}
		return a.downloadCore(ctx, work, phase)
	case "update":
		return a.updateConfig(ctx, request, work, phase)
	case "save-controller":
		return a.saveController(ctx, request, phase)
	case "self-update":
		return a.updateAgent(ctx, work, phase)
	case "download-dashboard":
		return a.downloadDashboard(ctx, request, work, phase)
	case "start":
		if a.running() {
			return "", errors.New("代理已运行")
		}
		if params.Interfaces != nil {
			value, err := parseInterfaces(*params.Interfaces)
			if err != nil {
				return "", err
			}
			settings, err := a.settings()
			if err != nil {
				return "", err
			}
			settings.Interfaces = value
			if err = a.store.SaveSettings(settings); err != nil {
				return "", err
			}
		}
		phase("starting")
		return "代理已启动", a.startRuntime(ctx)
	case "stop":
		phase("stopping")
		return "代理已停止", a.stopRuntime()
	case "restart":
		phase("stopping")
		if err := a.stopRuntime(); err != nil {
			return "", err
		}
		phase("starting")
		return "代理已重启", a.startRuntime(ctx)
	case "boot-on":
		return "开机启动已开启", a.setBoot(true)
	case "boot-off":
		return "开机启动已关闭", a.setBoot(false)
	}
	return "", errors.New("未知任务")
}

// Use the baseline AMD64 build so downloads also work on older x86 CPUs.
func coreTarget(kind, arch string) (string, string, error) {
	switch kind {
	case platform.UFI:
		switch arch {
		case "arm64":
			return "android", "arm64-v8", nil
		case "arm":
			return "android", "armv7", nil
		}
	case platform.Linux:
		switch arch {
		case "amd64":
			return "linux", "amd64-compatible", nil
		case "arm64":
			return "linux", "arm64", nil
		case "arm":
			return "linux", "armv7", nil
		}
	}
	return "", "", errors.New("不支持此平台或内核架构")
}

func (a *Manager) downloadCore(ctx context.Context, work string, phase func(string)) (string, error) {
	if a.running() {
		return "", errors.New("请先停止代理")
	}
	assetPlatform, arch, err := coreTarget(a.Platform.Config().Kind, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	phase("release")
	r, err := a.latestRelease(ctx, "MetaCubeX", "mihomo")
	if err != nil {
		return "", err
	}
	version, address, digest, err := r.asset("MetaCubeX/mihomo", "mihomo-"+assetPlatform+"-"+arch+"-"+r.TagName+".gz")
	if err != nil {
		return "", err
	}
	phase("download")
	archive := filepath.Join(work, "core.gz")
	if err := a.fetchRelease(ctx, address, archive, 64<<20); err != nil {
		return "", err
	}
	phase("verify")
	if err = a.installCore(ctx, archive, work, digest, phase); err != nil {
		return "", err
	}
	return "内核 " + version + " 已安装，校验通过", nil
}

func (a *Manager) installCore(ctx context.Context, archive, work, digest string, phase func(string)) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := download.VerifySHA256(f, digest); err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	candidate := filepath.Join(work, "mihomo")
	out, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(gz, (128<<20)+1))
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || n > 128<<20 || n < 4 {
		return errors.New("内核解压失败或大小无效")
	}
	if _, err = a.run(ctx, candidate, "-v"); err != nil {
		return errors.New("内核不能在本设备运行")
	}
	if id, _ := a.activeGeneration(); id != "" {
		if err = a.testCore(ctx, candidate, a.runtime("current", "config.yaml")); err != nil {
			return err
		}
	}
	if err := commitTask(ctx); err != nil {
		return err
	}
	phase("installing")
	return os.Rename(candidate, a.corePath())
}

func (a *Manager) updateConfig(ctx context.Context, request Request, work string, phase func(string)) (string, error) {
	if !a.coreInstalled() {
		return "", errors.New("请先安装 Mihomo 内核")
	}
	current, err := a.configuration()
	if err != nil {
		return "", err
	}
	address := current.URL
	if request.Params.URL != "" {
		address = request.Params.URL
	}
	address, err = validateURL(address)
	if err != nil {
		return "", err
	}
	phase("subscription")
	sourcePath := filepath.Join(work, "source.yaml")
	if err = a.fetch(ctx, address, sourcePath, 4<<20); err != nil {
		return "", err
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		return "", err
	}
	control, err := a.controller()
	if err != nil {
		return "", err
	}
	if err := commitTask(ctx); err != nil {
		return "", err
	}
	if err = a.applyConfig(ctx, request.ID, source, address, control, phase); err != nil {
		return "", err
	}
	return "配置已更新", nil
}

func (a *Manager) applyConfig(ctx context.Context, id string, source []byte, address string, control Controller, phase func(string)) error {
	overrides, err := a.overrides()
	if err != nil {
		return err
	}
	return a.applyConfigWithOverrides(ctx, id, source, address, control, overrides, phase)
}

func (a *Manager) applyConfigWithOverrides(ctx context.Context, id string, source []byte, address string, control Controller, overrides []byte, phase func(string)) error {
	phase("adapt")
	overlay, err := overrideMapping(overrides)
	if err != nil {
		return err
	}
	if err := a.validateManagedOverrides(overlay); err != nil {
		return err
	}
	merged, err := mergeOverrides(source, overlay)
	if err != nil {
		return err
	}
	dashboard := a.dashboard().Installed
	config, ports, err := adaptConfig(merged, control, dashboard, a.Platform.Policy())
	if err != nil {
		return err
	}
	phase("validate")
	generation := a.runtime("configurations", id)
	if err = fsutil.AtomicWrite(filepath.Join(generation, "config.yaml"), config, 0600); err != nil {
		return err
	}
	if err = fsutil.AtomicWrite(filepath.Join(generation, "source.yaml"), source, 0600); err != nil {
		return err
	}
	if err = fsutil.AtomicWrite(filepath.Join(generation, "overrides.yaml"), overrides, 0600); err != nil {
		return err
	}
	if err = fsutil.AtomicWrite(filepath.Join(generation, "ports"), []byte(ports), 0600); err != nil {
		return err
	}
	apiPort := 0
	if control.Enabled {
		apiPort = control.Port
	}
	if err = fsutil.AtomicWrite(filepath.Join(generation, "api-port"), []byte(strconv.Itoa(apiPort)), 0600); err != nil {
		return err
	}
	if err = a.store.SaveConfiguration(storage.Configuration{ID: id, URL: address, Controller: new(storage.Controller(control)), Dashboard: dashboard && control.Enabled}); err != nil {
		return err
	}
	if err = a.testCore(ctx, a.corePath(), filepath.Join(generation, "config.yaml")); err != nil {
		return err
	}
	previous, err := a.activeGeneration()
	if err != nil {
		return err
	}
	wasRunning := a.running()
	if err = a.store.SavePending(storage.Pending{Previous: previous, Next: id, WasRunning: wasRunning}); err != nil {
		return err
	}
	phase("applying")
	if err = a.stopRuntime(); err == nil {
		err = a.activate(id)
	}
	if err == nil && wasRunning {
		err = a.startRuntime(ctx)
	}
	if err != nil {
		phase("rollback")
		resume, rollbackErr := a.recoverConfiguration()
		if rollbackErr == nil && resume {
			recovery, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			rollbackErr = a.startRuntime(recovery)
		}
		if rollbackErr != nil {
			return fmt.Errorf("配置应用失败，恢复也失败：%v", rollbackErr)
		}
		return errors.New("配置应用失败，已恢复上一版本")
	}
	if err = a.store.ClearPending(); err != nil {
		return err
	}
	return nil
}
