import { z } from 'zod';

export const protocol = 9;
const capabilitiesSchema = z.object({
  interfaces: z.boolean(),
  capture: z.boolean(),
});
export type TaskParams = {
  releaseProxy?: string;
  url?: string;
  interfaces?: string;
  controller?: { yaml: string } | {
    enabled: boolean;
    port: number;
    secret?: string;
    reset?: boolean;
  };
};

export const jobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  action: z.enum([
    'bootstrap',
    'install',
    'self-update',
    'download',
    'update',
    'start',
    'stop',
    'restart',
    'boot-on',
    'boot-off',
    'uninstall',
    'save-release-proxy',
    'save-interfaces',
    'save-controller',
    'download-dashboard',
  ]),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled']),
  phase: z.string(),
  updated: z.string(),
  started: z.string(),
  result: z.string().default(''),
  error: z.string().default(''),
  hash: z.string(),
  downloaded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  speed: z.number().nonnegative(),
  cancellable: z.boolean(),
  cancelRequested: z.boolean(),
});
export type DeviceJob = z.infer<typeof jobSchema>;
export type TaskAction = Exclude<DeviceJob['action'], 'bootstrap'>;
const componentUpdateSchema = z.object({
  current: z.string(),
  latest: z.string(),
  state: z.enum([
    'not-installed',
    'up-to-date',
    'available',
    'unknown',
    'error',
  ]),
  error: z.string().default(''),
});
export const updatesSchema = z.object({
  checkedAt: z.string(),
  self: componentUpdateSchema,
  core: componentUpdateSchema,
  dashboard: componentUpdateSchema,
});

const stateSchema = z.object({
  protocol: z.literal(protocol),
  platform: z.enum(['ufi', 'linux']),
  capabilities: capabilitiesSchema,
  version: z.string(),
  publicKey: z.string(),
  service: z.boolean(),
  core: z.boolean(),
  config: z.boolean(),
  subscription: z.boolean(),
  running: z.boolean(),
  supervisor: z.boolean(),
  listeners: z.boolean(),
  network: z.boolean(),
  boot: z.boolean(),
  locked: z.boolean(),
  capture: z.boolean(),
  coreVersion: z.string(),
  settings: z.object({
    releaseProxy: z.string(),
    interfaces: z.array(z.string()),
  }),
  task: jobSchema.nullable(),
  updates: updatesSchema.nullable(),
  controller: z
    .object({
      enabled: z.boolean(),
      port: z.number().int().min(1024).max(65535),
      applied: z.boolean(),
      overrides: z.boolean().default(false),
    })
    .nullable(),
  dashboard: z.object({
    installed: z.boolean(),
    ready: z.boolean(),
    version: z.string(),
  }),
}).refine((state) => !state.service || state.controller !== null);

export type DeviceState = z.infer<typeof stateSchema> & { agent: boolean };
export const emptyState: DeviceState = {
  service: false,
  core: false,
  coreVersion: '',
  config: false,
  subscription: false,
  running: false,
  supervisor: false,
  listeners: false,
  network: false,
  boot: false,
  locked: false,
  capture: false,
  agent: false,
  protocol,
  platform: 'ufi',
  capabilities: {
    interfaces: true,
    capture: true,
  },
  version: '',
  publicKey: '',
  settings: { interfaces: [], releaseProxy: '' },
  task: null,
  updates: null,
  controller: null,
  dashboard: { installed: false, ready: false, version: '' },
};
export type Action =
  | TaskAction
  | 'check-updates'
  | 'logs'
  | 'refresh'
  | 'diagnose'
  | 'view-secret'
  | 'open-dashboard';

export function parseState(text: string): DeviceState {
  const result = stateSchema.safeParse(JSON.parse(text));
  if (!result.success)
    throw new Error('设备状态不完整或协议不匹配');
  return { ...result.data, agent: true };
}
export function parseJob(value: unknown): DeviceJob {
  const result = jobSchema.safeParse(value);
  if (!result.success) throw new Error('设备任务响应无效');
  return result.data;
}

export function lifecycleAction(
  state: DeviceState | null,
): 'install' | 'uninstall' {
  return state
    ? state.agent || state.service
      ? 'uninstall'
      : 'install'
    : 'uninstall';
}

export function componentVersion(
  installed: boolean | undefined,
  version?: string,
): string {
  if (installed === undefined) return '状态未知';
  return installed ? version?.trim() || '版本未知' : '未安装';
}

export function installationTask(action: string): boolean {
  return [
    'bootstrap',
    'install',
    'self-update',
    'download',
    'download-dashboard',
    'uninstall',
  ].includes(action);
}

export function topTask(job: DeviceJob | null | undefined): boolean {
  return (
    !!job &&
    (['failed', 'interrupted'].includes(job.state) ||
      ['queued', 'running'].includes(job.state))
  );
}

export function disabledReason(
  action: Action,
  state: DeviceState | null,
  busy = false,
  draftUrl = '',
): string {
  if (busy) return '正在执行操作，请稍候';
  if (action === 'refresh') return '';
  if (!state) return action === 'stop' || action === 'uninstall' ? '' : '尚未确认设备状态，请刷新状态';
  if (action === 'check-updates')
    return state.agent ? '' : '请先安装 mihomoctl';
  if (action === 'logs' || action === 'diagnose')
    return state.agent ? '' : '请先安装 mihomoctl';
  if (state.locked && action !== 'open-dashboard')
    return state.task && ['queued', 'running'].includes(state.task.state)
      ? '设备正在执行任务，请查看任务进度'
      : '控制锁尚未释放，请查看最近任务和运行日志';
  if (action === 'save-interfaces' && !state.capabilities.interfaces)
    return '由系统网络配置管理';
  if (action === 'uninstall') return state.agent ? '' : 'Mihomo 服务未安装';
  if (action === 'install')
    return state.service
      ? 'Mihomo 服务已安装，请刷新状态'
      : state.running
        ? '请先停止代理'
        : '';
  if (!state.service) return '请先安装 Mihomo 服务';
  if (action === 'self-update' && state.capture) return '请先停止代理并完成网络规则清理';
  if (
    action === 'save-release-proxy' ||
    action === 'save-controller' ||
    action === 'download-dashboard' ||
    action === 'view-secret'
  )
    return '';
  if (action === 'open-dashboard') {
    if (!state.controller?.enabled) return '请先启用控制面板';
    if (!state.dashboard.installed) return '请先安装面板';
    if (!state.controller.applied || !state.dashboard.ready)
      return '请先应用面板设置或更新订阅';
    return state.running && state.listeners ? '' : '请先启动代理';
  }
  if (action === 'stop')
    return state.running || state.capture ? '' : '代理已停止';
  if (action === 'boot-off') return state.boot ? '' : '开机启动已关闭';
  if (
    action === 'save-interfaces' ||
    action === 'download' ||
    action === 'self-update'
  ) {
    if (state.running) return '请先停止代理';
    return '';
  }
  if (!state.core) return '请先安装内核';
  if (action === 'update') {
    return state.subscription || draftUrl.trim() ? '' : '请输入订阅链接';
  }
  if (!state.config) return '请先更新订阅，生成可用配置';
  if (action === 'start') return state.running ? '代理已运行，请使用重启' : '';
  if (action === 'restart')
    return state.running ? '' : '代理未运行，请使用启动';
  if (action === 'boot-on') return state.boot ? '开机启动已开启' : '';
  return '';
}
