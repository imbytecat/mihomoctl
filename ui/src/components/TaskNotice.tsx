import { ChevronRight, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Progress } from '@base-ui/react/progress';
import { clsx } from 'clsx';
import { describeTask, phases, transferText } from '../gateway';
import type { DeviceJob } from '../state';
import type { GatewayModel } from '../use-gateway';
import { Button, focus, muted } from './ui';

const row = `ufi:m-0 ufi:flex ufi:min-h-11 ufi:w-full ufi:min-w-0 ufi:cursor-pointer ufi:items-center ufi:gap-2 ufi:border-0 ufi:bg-transparent ufi:p-0 ufi:text-left ufi:text-sm ufi:text-inherit ${focus}`;

export function TaskNotice({
  model,
  job,
  installation = false,
}: {
  model: GatewayModel;
  job: DeviceJob;
  installation?: boolean;
}) {
  const active = ['queued', 'running'].includes(job.state);
  const failed = ['failed', 'interrupted'].includes(job.state);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const name = describeTask(job).split('\n')[0];
  const show = () => void model.showTask();

  if (installation)
    return (
      <button type="button" data-install-task onClick={show} className={clsx(row, 'ufi:px-4')}>
        <span className={`ufi:min-w-0 ufi:flex-1 ufi:truncate ${muted}`}>
          最近任务：{name}
          {failed ? '失败' : job.state === 'cancelled' ? '已取消' : '已完成'}
        </span>
        <ChevronRight size={16} className={muted} aria-hidden />
      </button>
    );

  if (!active)
    return (
      <Button data-task full variant="danger" className="ufi:mt-3" onClick={show}>
        {name}失败 · 查看详情
      </Button>
    );

  const downloading = ['download', 'subscription'].includes(job.phase);
  const cancellable = ['bootstrap', 'download', 'download-dashboard', 'self-update', 'update'].includes(job.action);
  return (
    <div className="ufi:mt-3 ufi:rounded-xl ufi:bg-[var(--mh-fill)] ufi:px-3 ufi:py-1">
      <div className="ufi:flex ufi:items-center ufi:gap-2">
        <button type="button" data-task onClick={show} className={row}>
          <LoaderCircle
            size={16}
            className="ufi:shrink-0 ufi:text-[#0a84ff] ufi:animate-spin ufi:motion-reduce:animate-none"
            aria-hidden
          />
          <span className="ufi:min-w-0 ufi:truncate">
            {job.cancelRequested ? '正在取消并清理…' : phases[job.phase] || '处理中'}
            <span className={muted}> · {name}</span>
          </span>
        </button>
        {cancellable && (
          <Button
            data-cancel-task
            variant="ghost"
            className="ufi:-mr-2 ufi:text-[#ff6961]"
            disabled={!job.cancellable || job.cancelRequested || model.cancelling}
            title={!job.cancellable ? '正在应用更改，此阶段不可取消' : undefined}
            onClick={() => void model.cancelTask()}
          >
            {job.cancelRequested || model.cancelling ? '正在取消…' : '取消任务'}
          </Button>
        )}
      </div>
      {downloading && (
        <Progress.Root
          value={job.total ? Math.min(100, (job.downloaded / job.total) * 100) : null}
          aria-label="下载进度"
          aria-valuetext={transferText(job, now)}
          className="ufi:pb-2"
        >
          <Progress.Track className="ufi:h-1.5 ufi:overflow-hidden ufi:rounded-full ufi:bg-[var(--mh-fill-strong)]">
            <Progress.Indicator className="ufi:h-full ufi:rounded-full ufi:bg-[var(--mh-accent)] ufi:transition-[width] ufi:duration-500 ufi:data-[indeterminate]:w-1/3 ufi:data-[indeterminate]:animate-pulse" />
          </Progress.Track>
          <p data-transfer className={`ufi:mb-0 ufi:mt-1.5 ufi:break-words ufi:text-xs ufi:tabular-nums ${muted}`}>
            {transferText(job, now)}
          </p>
        </Progress.Root>
      )}
    </div>
  );
}
