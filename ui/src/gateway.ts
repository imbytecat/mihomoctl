// Task observation and presentation are independent of the page's lifetime.
import {
  readJob,
  readBootstrap,
  readUninstallJob,
  jobLog,
} from './transport/ufi';
import type { DeviceJob } from './state';

export const phases: Record<string, string> = {
  accepted: '任务已接收',
  preparing: '准备中',
  release: '查询官方版本',
  download: '下载中',
  verify: '校验文件',
  installing: '安装中',
  subscription: '下载订阅',
  validate: '校验配置',
  applying: '应用配置',
  rollback: '恢复上一配置',
  saving: '保存设置',
  starting: '启动代理',
  adapt: '适配配置',
  removing: '删除设备文件',
  stopping: '停止代理',
  done: '已完成',
  interrupted: '任务已中断',
  failed: '任务失败',
  cancelled: '已取消',
};
export class TaskCancelled extends Error {
  constructor() { super('任务已取消'); }
}
export class TaskFailed extends Error {}
export function transferText(job: DeviceJob, now = Date.now()) {
  const size = (bytes: number) => bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
  const idle = Math.max(0, Math.floor((now - Date.parse(job.updated)) / 1000));
  const speed = idle > 3 ? 0 : job.speed;
  return `${size(job.downloaded)}${job.total ? ` / ${size(job.total)} · ${Math.min(100, Math.floor(job.downloaded / job.total * 100))}%` : ' · 总大小未知'} · ${size(speed)}/s${idle >= 10 ? ` · 已 ${idle} 秒无新数据` : ''}`;
}
export async function waitTask(
  initial: DeviceJob,
  progress: (job: DeviceJob) => void,
) {
  let job = initial;
  let deleting = 0;
  while (job.state === 'queued' || job.state === 'running') {
    progress(job);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      if (job.action === 'uninstall') {
        const next = await readUninstallJob(job);
        if (!next) {
          if (++deleting > 40)
            throw new Error('卸载未完成，请检查设备上剩余的文件');
          continue;
        }
        job = next;
      } else
        job =
          job.action === 'bootstrap'
            ? (await readBootstrap(job.id))!
            : await readJob(job.id);
    } catch (error) {
      throw new Error(
        `设备任务状态暂不可读\n任务 ID：${job.id}\n${error instanceof Error ? error.message : String(error)}\n任务不会因页面断开而取消，恢复连接后刷新即可继续查看。`,
      );
    }
    if (!job) throw new Error('任务记录不可读');
  }
  progress(job);
  if (job.state === 'cancelled') throw new TaskCancelled();
  if (job.state !== 'succeeded') {
    throw new TaskFailed('设备任务失败\n' + await formatTaskDetails(job));
  }
  return job.result || '任务已完成';
}
export function describeTask(job: DeviceJob) {
  const names: Record<DeviceJob['action'], string> = {
    'self-update': '更新 mihomoctl',
    bootstrap: '安装 mihomoctl',
    install: '安装 Mihomo 服务',
    download: '安装 / 更新 Mihomo 内核',
    update: '更新订阅',
    start: '启动代理',
    stop: '停止代理',
    restart: '重启代理',
    'boot-on': '启用开机启动',
    'boot-off': '关闭开机启动',
    uninstall: '卸载 Mihomo 服务',
    'save-interfaces': '保存接口',
    'save-release-proxy': '保存发行转发',
    'save-controller': '应用覆写',
    'download-dashboard': '安装 / 更新 Zashboard',
  };
  return [
    names[job.action],
    `执行阶段：${phases[job.phase] || job.phase}`,
    `开始时间：${new Date(job.started).toLocaleString()}`,
    `${['queued', 'running'].includes(job.state) ? '最近更新' : '结束时间'}：${new Date(job.updated).toLocaleString()}`,
    `耗时：${Math.max(0, Math.floor(((['queued', 'running'].includes(job.state) ? Date.now() : Date.parse(job.updated)) - Date.parse(job.started)) / 1000))} 秒`,
    job.downloaded || job.total ? transferText(job) : '',
    job.cancelRequested ? '取消请求已接收，正在清理' : '',
    job.result,
    job.error,
    `任务 ID：${job.id}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function taskDetails(task: DeviceJob) {
  const latest = task.action === 'bootstrap'
    ? await readBootstrap(task.id) || task
    : task.action === 'uninstall' ? await readUninstallJob(task) || task : await readJob(task.id);
  return formatTaskDetails(latest);
}

async function formatTaskDetails(task: DeviceJob) {
  const log = await jobLog(task).catch(() => '暂时无法读取任务日志');
  return [describeTask(task), log && '任务日志\n' + log].filter(Boolean).join('\n\n');
}

export function dashboardURL(base: string, port: number, secret: string) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('无效面板端口');
  const url = new URL(base);
  url.protocol = 'http:';
  url.port = String(port);
  url.pathname = '/ui/';
  url.search = new URLSearchParams({ hostname: url.hostname, port: String(port), secret }).toString();
  // Setup imports changed credentials even when Zashboard already has an active backend,
  // then automatically navigates to /proxies after connecting.
  url.hash = '/setup';
  url.username = '';
  url.password = '';
  return url.href;
}
