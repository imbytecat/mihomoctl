package host

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/procfs"
)

type Record struct {
	PID   int
	Start string
}

func Start(pid int) string {
	process, err := procfs.NewProc(pid)
	if err != nil {
		return ""
	}
	stat, err := process.Stat()
	if err != nil || stat.State == "Z" {
		return ""
	}
	return strconv.FormatUint(stat.Starttime, 10)
}

func Owned(record Record) (*os.Process, error) {
	if record.PID < 2 || record.Start == "" {
		return nil, errors.New("invalid process identity")
	}
	proc, err := procfs.NewProc(record.PID)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	stat, err := proc.Stat()
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if stat.State == "Z" || strconv.FormatUint(stat.Starttime, 10) != record.Start {
		return nil, nil
	}
	p, err := os.FindProcess(record.PID)
	if err != nil {
		return nil, err
	}
	if err := p.Signal(syscall.Signal(0)); err != nil {
		p.Release()
		if errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH) {
			return nil, nil
		}
		return nil, err
	}
	return p, nil
}

func Command(ctx context.Context, files []*os.File, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.ExtraFiles = files
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	return cmd.CombinedOutput()
}
