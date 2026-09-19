package manager

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/imbytecat/mihomoctl/internal/fsutil"
	"github.com/imbytecat/mihomoctl/internal/redact"
	"github.com/imbytecat/mihomoctl/internal/storage"
	"golang.org/x/crypto/nacl/box"
)

type Job = storage.Task

func (a *Manager) taskPath(id string, file string) string { return a.path("tasks", id, file) }
func (a *Manager) writeJob(job *Job) error {
	if err := a.openStore(); err != nil {
		return err
	}
	job.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	return a.store.UpdateTask(*job)
}

// Submit is the same durable acceptance path for local CLI and decrypted UFI intents.
func (a *Manager) Submit(request Request) (*Job, error) {
	if request.ID == "" {
		request.ID = randomID()
	}
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	if err := a.authorize(request); err != nil {
		return nil, err
	}
	key, err := a.identity()
	if err != nil {
		return nil, err
	}
	plain, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	sealed, err := box.SealAnonymous(nil, plain, &key.Public, rand.Reader)
	if err != nil {
		return nil, err
	}
	return a.accept(request, sealed)
}
func (a *Manager) SubmitSealed(sealed []byte) (*Job, error) {
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	request, err := a.decrypt(sealed)
	if err != nil {
		return nil, err
	}
	if err := a.authorize(request); err != nil {
		return nil, err
	}
	return a.accept(request, sealed)
}
func (a *Manager) accept(request Request, sealed []byte) (_ *Job, err error) {
	key, err := a.identity()
	if err != nil {
		return nil, err
	}
	plain, _ := json.Marshal(request)
	mac := hmac.New(sha256.New, key.Private[:])
	mac.Write(plain)
	fingerprint := hex.EncodeToString(mac.Sum(nil))
	sum := sha256.Sum256(sealed)
	digest := hex.EncodeToString(sum[:])
	lock, err := a.lock()
	if err != nil {
		return nil, err
	}
	defer lock.Close()

	existing, e := a.store.Task(request.ID)
	if e == nil {
		previous, e := a.store.Fingerprint(request.ID)
		if e != nil || previous != fingerprint {
			return nil, errors.New("任务 ID 冲突")
		}
		return &existing, nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	job := &Job{ID: request.ID, Action: request.Action, State: "queued", Phase: "accepted", Hash: digest, Cancellable: cancellableAction(request.Action), Started: time.Now().UTC().Format(time.RFC3339Nano), Updated: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := a.store.CreateTask(*job, fingerprint, sealed); err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			job.State = "failed"
			job.Error = redact.String(err.Error())
			err = errors.Join(err, a.writeJob(job))
		}
	}()
	if err := os.MkdirAll(a.taskPath(job.ID, ""), 0700); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(a.taskPath(job.ID, "log.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	defer log.Close()
	cmd := exec.Command(a.Executable, "worker", "--root", a.Root, job.ID)
	gate, release, e := os.Pipe()
	if e != nil {
		return nil, e
	}
	defer gate.Close()
	defer release.Close()
	cmd.ExtraFiles = []*os.File{lock, gate}
	cmd.Stdin = nil
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return nil, fmt.Errorf("无法启动设备任务：%w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = a.Platform.AttachTask(ctx, cmd.Process.Pid, job.ID); err == nil {
		_, err = release.Write([]byte{1})
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("无法托管设备任务：%w", err)
	}
	_ = cmd.Process.Release()
	return job, nil // The worker inherited the locked descriptor; browser lifetime is irrelevant.
}

func (a *Manager) Job(id string) (*Job, error) {
	if !validID(id) {
		return nil, errors.New("invalid task id")
	}
	if err := a.requireIdentity(); err != nil {
		return nil, err
	}
	job, err := a.store.Task(id)
	if err != nil {
		return nil, errors.New("任务不存在")
	}
	if job.State == "running" || job.State == "queued" {
		if lock, err := a.lock(); err == nil {
			defer lock.Close()
			// Re-read after acquiring the lock: the worker may just have finished.
			if job, err = a.store.Task(id); err != nil {
				return nil, err
			}
			if job.State == "running" || job.State == "queued" {
				job.State = "interrupted"
				job.Error = "设备任务已中断，请检查当前状态后重试"
				if err = a.writeJob(&job); err != nil {
					return nil, err
				}
			}
		}
	}
	return &job, nil
}

func (a *Manager) Worker(id string) (err error) {
	if !validID(id) {
		return errors.New("invalid task id")
	}
	gate := os.NewFile(4, "task-start-gate")
	if gate == nil {
		return errors.New("missing task gate")
	}
	info, e := gate.Stat()
	if e != nil || info.Mode()&os.ModeNamedPipe == 0 {
		return errors.New("invalid task gate")
	}
	var signal [1]byte
	n, e := gate.Read(signal[:])
	gate.Close()
	if e != nil || n != 1 || signal[0] != 1 {
		return errors.New("task launcher did not release worker")
	}
	lock := os.NewFile(3, "inherited-control-lock")
	if lock == nil {
		return errors.New("missing task lock")
	}
	defer lock.Close()
	actual, err := lock.Stat()
	expected, e := os.Stat(a.path("control.lock"))
	if err != nil || e != nil || !os.SameFile(actual, expected) {
		return errors.New("invalid task lock")
	}
	// ExtraFiles clears CLOEXEC for the handoff. The worker owns the lock;
	// supervisors, cores and other exec descendants must not retain it.
	syscall.CloseOnExec(int(lock.Fd()))
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err
	}
	job, err := a.store.Task(id)
	if err != nil {
		return err
	}
	if job.State != "queued" {
		return errors.New("任务不能重复执行")
	}
	started := time.Now()
	var log *os.File
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil)).With("task", id, "action", job.Action)
	defer func() {
		if err != nil {
			job.State = "failed"
			job.Error = taskError(err)
			// Full diagnostics already live in the task record; do not embed entire runtime logs again.
			logger.Error("任务失败", "phase", job.Phase, "error", strings.SplitN(job.Error, "\n", 2)[0], "duration", time.Since(started))
			_ = a.writeJob(&job)
		}
		if log != nil {
			_ = log.Close()
		}
	}()
	log, err = os.OpenFile(a.runtime("tasks.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	logger = slog.New(slog.NewTextHandler(io.MultiWriter(os.Stdout, log), nil)).With("task", id, "action", job.Action)
	sealed, err := a.store.Request(id)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(sealed)
	if hex.EncodeToString(sum[:]) != job.Hash {
		return errors.New("任务文件校验失败")
	}
	request, err := a.decrypt(sealed)
	if err != nil || request.ID != id || request.Action != job.Action {
		return errors.New("任务内容不匹配")
	}
	job.State = "running"
	job.Phase = "preparing"
	if err = a.writeJob(&job); err != nil {
		return err
	}
	ctx, timeout := context.WithTimeout(context.Background(), 12*time.Minute)
	defer timeout()
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	if job.CancelRequested {
		cancel(context.Canceled)
	}
	if job.Cancellable {
		done := make(chan struct{})
		go func(watchCtx context.Context) { defer close(done); a.watchCancellation(watchCtx, id, cancel) }(ctx)
		defer func() { cancel(nil); <-done }()
	}
	ctx = context.WithValue(ctx, taskContextKey{}, taskControl{
		progress: func(downloaded, total int64, speed float64) error {
			job.Downloaded, job.Total, job.Speed = int(downloaded), int(total), speed
			return a.writeJob(&job)
		},
		commit: func() error { return a.store.CommitTask(id) },
	})
	phase := func(value string) {
		job.Phase = value
		_ = a.writeJob(&job)
		logger.Info("任务阶段变化", "phase", value)
	}
	result, runErr := a.execute(ctx, request, phase)
	if job.Cancellable {
		// Close acceptance even on failure so a late cancel cannot be acknowledged
		// after the terminal outcome has already been chosen.
		if sealErr := a.store.CommitTask(id); sealErr != nil && runErr == nil {
			runErr = sealErr
		}
	}
	if request.Action == "uninstall" && runErr == nil {
		return nil // Never recreate a deleted installation to write a completion record.
	}
	if runErr != nil {
		job.State = "failed"
		current, readErr := a.store.Task(id)
		if readErr == nil && current.CancelRequested {
			job.State, job.Phase, job.Result = "cancelled", "cancelled", "任务已取消"
			runErr = nil
		}
		if runErr != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) && errors.Is(runErr, context.DeadlineExceeded) {
				runErr = fmt.Errorf("任务执行超过 12 分钟，已停止：%w", runErr)
			}
			job.Error = taskError(runErr)
		}
		if runErr != nil {
			logger.Error("任务失败", "phase", job.Phase, "error", strings.SplitN(job.Error, "\n", 2)[0], "duration", time.Since(started))
		} else {
			logger.Info("任务已取消", "phase", job.Phase, "duration", time.Since(started))
		}
	} else {
		job.State = "succeeded"
		job.Result = result
		job.Phase = "done"
		logger.Info("任务已完成", "duration", time.Since(started))
	}
	job.Speed = 0
	if err := a.writeJob(&job); err != nil {
		return err
	}
	a.pruneTaskFiles()
	return nil
}

func (a *Manager) latestJob() *Job {
	id, err := a.store.LatestTask()
	if err != nil {
		return nil
	}
	job, _ := a.Job(id)
	return job
}

func (a *Manager) readJobLog(id string) string {
	if !validID(id) {
		return ""
	}
	data, _ := fsutil.ReadTail(a.taskPath(id, "log.txt"), 24*1024)
	return redact.String(string(data))
}

func (a *Manager) JobLog(id string) (string, error) {
	if _, err := a.Job(id); err != nil {
		return "", err
	}
	return a.readJobLog(id), nil
}
