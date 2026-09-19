// Development-only persistent task mock; never included in the plugin.
import sodium from 'libsodium-wrappers';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parse } from 'shell-quote';
const version = 'v1.0.0';
import {
  emptyState,
  type DeviceState,
  type DeviceJob,
  type TaskAction,
  type TaskParams,
  updatesSchema,
} from '../src/state';

const ready = {
  ...emptyState,
  agent: true,
  version,
  service: true,
  core: true,
  coreVersion: 'v1.19.30',
  config: true,
  subscription: true,
  controller: { enabled: true, port: 9090, applied: true },
};
const scenarios: Record<string, DeviceState> = {
  'missing-service': emptyState,
  'missing-core': {
    ...ready,
    core: false,
    coreVersion: '',
    config: false,
    subscription: false,
  },
  'missing-config': { ...ready, config: false, subscription: false },
  ready,
  'unreadable-state': { ...ready },
  'managed-linux': {
    ...ready,
    platform: 'linux',
    capabilities: {
      interfaces: false,
      capture: false,
    },
    running: true,
    supervisor: true,
    listeners: true,
  },
  running: {
    ...ready,
    running: true,
    supervisor: true,
    listeners: true,
    network: true,
    capture: true,
    dashboard: { installed: true, ready: true, version: 'v3.26.0' },
  },
};
const scenario =
  new URL(location.href).searchParams.get('state') || 'missing-service';
const storageKey = 'ufi-mock-' + scenario;
type Intent = {
  id: string;
  action: TaskAction | 'bootstrap';
  params: TaskParams;
};
type Pending = { intent: Intent; end: number; failure: string };
const persisted = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
const state: DeviceState =
  persisted?.state || structuredClone(scenarios[scenario] || emptyState);
let controllerSecret =
  persisted?.controllerSecret || 'mock-controller-key-not-a-real-secret';
let pending: Pending | null = persisted?.pending || null;
const jobs: Record<string, DeviceJob> = persisted?.jobs || {};
const commands: string[] = [],
  intents: Intent[] = [],
  requests: string[] = [];
const uploads: { name: string; bytes: Uint8Array }[] = [];
const keys = sodium.ready.then(() => sodium.crypto_box_keypair());
const flags = globalThis as typeof globalThis & {
  mockProbeError?: boolean;
  mockRuntimeLog?: string;
  mockUpdateFailure?: boolean;
  mockUploadFailure?: boolean;
  mockUploadDelayMs?: number;
  mockTaskDelayMs?: number;
  mockTaskFailure?: string;
};
const save = () =>
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ state, pending, jobs, controllerSecret }),
  );
function statusSnapshot() {
  const snapshot = structuredClone(state);
  if (snapshot.updates) {
    for (const [key, installed, current] of [
      ['self', state.agent, state.version],
      ['core', state.core, state.coreVersion],
      ['dashboard', state.dashboard.installed, state.dashboard.version],
    ] as const) {
      const update = snapshot.updates[key];
      update.current = installed ? current : '';
      if (update.state === 'error') continue;
      // Fixture tags are numeric stable versions; production comparison is Go semver.
      update.state = !installed ? 'not-installed' : !current ? 'unknown'
        : update.latest.replace(/^v/, '').localeCompare(current.replace(/^v/, ''), 'en', { numeric: true }) > 0 ? 'available' : 'up-to-date';
    }
  }
  return snapshot;
}
function advance() {
  if (!pending || Date.now() < pending.end) return;
  const { intent, failure } = pending;
  const job = jobs[intent.id]!;
  if (job.cancelRequested) {
    job.state = 'cancelled'; job.phase = 'cancelled'; job.cancellable = false;
    job.result = '任务已取消'; state.locked = false; state.task = job; pending = null; save(); return;
  }
  job.cancellable = false;
  job.state = failure ? 'failed' : 'succeeded';
  job.error = failure;
  job.phase = failure ? 'download' : 'done';
  job.updated = new Date().toISOString();
  state.locked = false;
  if (!failure) {
    switch (intent.action) {
      case 'bootstrap':
      case 'install':
        state.agent = state.service = true;
        if (intent.action === 'bootstrap') state.settings.releaseProxy = intent.params.releaseProxy || '';
        state.version = 'v9.8.7';
        state.controller = { enabled: true, port: 9090, applied: false };
        job.result = 'Mihomo 服务已安装';
        break;
      case 'self-update':
        state.version = 'v9.8.7';
        job.result = 'mihomoctl 已是最新版本';
        break;
      case 'save-release-proxy':
        state.settings.releaseProxy = intent.params.releaseProxy || '';
        job.result = '发行转发设置已保存';
        break;
      case 'save-interfaces':
        state.settings.interfaces =
          !intent.params.interfaces || intent.params.interfaces === 'auto'
            ? []
            : intent.params.interfaces.split(' ');
        job.result = '接口已保存';
        break;
      case 'download':
        state.core = true;
        state.coreVersion = 'v9.8.7';
        job.result = '内核 v9.8.7 已安装，校验通过';
        break;
      case 'update':
        state.config = state.subscription = true;
        state.controller!.applied = true;
        state.dashboard.ready =
          state.dashboard.installed && state.controller!.enabled;
        job.result = '配置已更新';
        break;
      case 'save-controller': {
        const value = intent.params.controller!;
        state.controller = {
          enabled: value.enabled,
          port: value.port,
          applied: state.config,
        };
        if (value.reset) controllerSecret = 'mock-regenerated-controller-key';
        else if (value.secret) controllerSecret = value.secret;
        state.dashboard.ready =
          state.dashboard.installed && state.config && value.enabled;
        job.result = '面板设置已应用';
        break;
      }
      case 'download-dashboard':
        state.dashboard = {
          installed: true,
          ready: state.config && !!state.controller?.enabled,
          version: 'v3.26.0',
        };
        job.result = 'Zashboard v3.26.0 已安装';
        break;
      case 'boot-on':
        state.boot = true;
        job.result = '开机启动已开启';
        break;
      case 'boot-off':
        state.boot = false;
        job.result = '开机启动已关闭';
        break;
      case 'start':
      case 'restart':
        Object.assign(state, {
          running: true,
          supervisor: true,
          listeners: true,
          network: true,
          capture: true,
        });
        job.result = '代理已启动';
        break;
      case 'stop':
        Object.assign(state, {
          running: false,
          supervisor: false,
          listeners: false,
          network: false,
          capture: false,
        });
        job.result = '代理已停止';
        break;
      case 'uninstall':
        Object.assign(state, structuredClone(emptyState));
        for (const id of Object.keys(jobs)) delete jobs[id];
        controllerSecret = '';
        pending = null;
        sessionStorage.removeItem(storageKey);
        return;
    }
  }
  state.task = job;
  pending = null;
  save();
}
function cancelJob(id: string) {
  const job = jobs[id]!;
  if (!job?.cancellable) throw new Error('任务已进入不可取消阶段');
  job.cancelRequested = true;
  if (pending) pending.end = Date.now() + 300;
  save();
  return job;
}
function submit(intent: Intent, hash = '') {
  if (state.locked) throw new Error('设备任务进行中');
  intents.push(intent);
  const job: DeviceJob = {
    id: intent.id,
    action: intent.action,
    state: 'running',
    phase: ['start', 'restart'].includes(intent.action) ? 'starting' : 'download',
    hash,
    started: new Date().toISOString(),
    downloaded: 0, total: 0, speed: 0,
    cancellable: ['bootstrap', 'download', 'self-update', 'download-dashboard', 'update'].includes(intent.action), cancelRequested: false,
    result: '',
    error: '',
    updated: new Date().toISOString(),
  };
  jobs[job.id] = job;
  state.task = job;
  state.locked = true;
  pending = {
    intent,
    end: Date.now() + (flags.mockTaskDelayMs ?? 300),
    failure: flags.mockTaskFailure || '',
  };
  save();
  return job;
}
Object.assign(globalThis, {
  KANO_baseURL: '/api',
  common_headers: { authorization: 'a'.repeat(64) },
  mockDeviceState: state,
  mockCommands: commands,
  mockUploads: uploads,
  mockIntents: intents,
  mockRequests: requests,
  runShellWithRoot: async (command: string) => {
    commands.push(command);
    const marker = command.match(/UFI_EXIT_[a-zA-Z0-9_]+/)![0];
    if (flags.mockProbeError)
      return { success: false, content: '模拟连接失败' };
    advance();
    state.publicKey = sodium.to_base64(
      (await keys).publicKey,
      sodium.base64_variants.ORIGINAL,
    );
    let result: unknown = null;
    try {
      const inner = parse(command)[2] as string;
      const args = parse(inner).filter(
        (x): x is string => typeof x === 'string',
      );
      if (inner.includes('ufi-uninstall-status'))
        result = state.agent && state.task ? { id: state.task.id, action: state.task.action, state: state.task.state, phase: state.task.phase, updated: state.task.updated, error: state.task.error } : null;
      else if (inner.includes('/data/mihomoctl/mihomoctl uninstall')) {
        const job = submit({ id: args[args.indexOf('--id') + 1]!, action: 'uninstall', params: {} });
        result = { id: job.id, action: job.action, state: job.state, phase: job.phase, updated: job.updated };
      }
      else if (inner.includes('/data/mihomoctl/mihomoctl status')) result = !state.agent ? null : scenario === 'unreadable-state'
        ? { broken: true } : statusSnapshot();
      else if (args[0] === '/data/mihomoctl/mihomoctl') {
        switch (args[1]) {
          case 'submit': {
            const uploaded = uploads.find((x) => x.name === args[2]);
            if (!uploaded) throw new Error('上传不存在');
            if (bytesToHex(sha256(uploaded.bytes)) !== args[3])
              throw new Error('校验失败');
            const key = await keys;
            const intent = JSON.parse(
              sodium.to_string(
                sodium.crypto_box_seal_open(
                  uploaded.bytes,
                  key.publicKey,
                  key.privateKey,
                ),
              ),
            );
            result = submit(intent, args[3]);
            break;
          }
          case 'cancel':
            result = cancelJob(args[2]!);
            break;
          case 'job':
            result = jobs[args[2]!];
            break;
          case 'stop':
            result = submit({
              id: crypto.randomUUID().replaceAll('-', ''),
              action: 'stop',
              params: {},
            });
            break;
          case 'check-updates':
            state.updates = updatesSchema.parse({
              checkedAt: new Date().toISOString(),
              self: {
                current: state.version,
                latest: 'v9.8.7',
                state: flags.mockUpdateFailure
                  ? 'error'
                  : state.version === 'v9.8.7'
                    ? 'up-to-date'
                    : 'available',
                error: flags.mockUpdateFailure ? '模拟查询失败' : '',
              },
              core: {
                current: state.coreVersion,
                latest: state.coreVersion || 'v9.8.7',
                state: state.core ? 'up-to-date' : 'not-installed',
              },
              dashboard: {
                current: state.dashboard.version,
                latest: 'v3.26.0',
                state: state.dashboard.installed
                  ? 'up-to-date'
                  : 'not-installed',
              },
            });
            result = state.updates;
            save();
            break;
          case 'controller-secret':
            result = sodium.to_base64(
              sodium.crypto_box_seal(
                sodium.from_string(controllerSecret),
                sodium.from_base64(args[2]!, sodium.base64_variants.ORIGINAL),
              ),
              sodium.base64_variants.ORIGINAL,
            );
            break;
          case 'job-log':
            result = '设备任务日志';
            break;
          case 'logs':
            result = flags.mockRuntimeLog ?? 'core.log\n代理运行正常';
            break;
          case 'diagnose':
            result = 'wlan0 192.168.0.1/24';
            break;
          default:
            throw new Error('未知命令');
        }
      } else if (args.includes('cancel')) {
        result = cancelJob(args[args.indexOf('cancel') + 1]!);
      } else if (args.includes('submit')) {
        const at = args.indexOf('submit');
        result = submit({
          id: args[at + 1]!,
          action: 'bootstrap',
          params: { releaseProxy: args[at + 7] || '' },
        });
      } else if (inner.includes('bootstrap.sh'))
        result = state.task?.action === 'bootstrap' ? state.task : null;
      return {
        success: true,
        content: JSON.stringify(result) + '\n' + marker + '0',
      };
    } catch (error) {
      return {
        success: true,
        content: JSON.stringify({ error: String(error) }) + '\n' + marker + '1',
      };
    }
  },
});
const nativeFetch = globalThis.fetch.bind(globalThis);
const mockFetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  let url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  requests.push(url);
  if (new URL(url, location.href).hostname === 'mirror.example.com')
    url = decodeURIComponent(new URL(url).pathname.slice(1));
  if (url === 'https://api.github.com/repos/imbytecat/mihomoctl/releases/latest') {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (['authorization', 'kano-t', 'kano-sign'].some((name) => headers.has(name)))
      throw new Error('发行查询不得携带 UFI 请求头');
    // Credential behavior is tested in Chromium; Bun does not model browser cookies.
    if ((input instanceof Request ? input.credentials : init?.credentials) !== 'omit')
      throw new Error('发行查询不得携带浏览器凭据');
    return Response.json({
      tag_name: 'v9.8.7',
      draft: false,
      prerelease: false,
      assets: ['arm64', 'armv7'].map((arch) => ({
        name: `mihomoctl-linux-${arch}`,
        size: 1048576,
        browser_download_url: `https://github.com/imbytecat/mihomoctl/releases/download/v9.8.7/mihomoctl-linux-${arch}`,
        digest: 'sha256:' + 'a'.repeat(64),
      })),
    });
  }
  if (new URL(url, location.href).origin !== location.origin)
    throw new Error('浏览器不应请求外网：' + url);
  const path = new URL(url, location.href).pathname;
  if (path === '/api/upload_img' || path === '/api/root_shell') {
    const request = new Request(input, init);
    if (request.headers.get('authorization') !== 'a'.repeat(64) ||
        !request.headers.has('kano-t') || !/^[a-f0-9]{64}$/.test(request.headers.get('kano-sign') || ''))
      return new Response(null, { status: 401 });
    if (path === '/api/root_shell') {
      const body = await request.json() as { command: string };
      const result = await (globalThis as typeof globalThis & { runShellWithRoot(command: string): Promise<{ success: boolean; content: string }> }).runShellWithRoot(body.command);
      return result.success ? Response.json({ result: result.content }) : Response.json({ error: result.content }, { status: 500 });
    }
    if (flags.mockUploadFailure)
      return Response.json({ error: '模拟上传失败' }, { status: 500 });
    const body = await request.formData();
    const file = body.get('file') as File;
    const name = crypto.randomUUID() + '.bin';
    uploads.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (flags.mockUploadDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, flags.mockUploadDelayMs),
      );
    return Response.json({ url: '/uploads/' + name });
  }
  return nativeFetch(input, init);
};
// Match the host contract: requests.js saves originFetch, then wraps fetch and
// calls input.startsWith before adding UFI signing headers to every request.
Object.assign(globalThis, { originFetch: mockFetch });
globalThis.fetch = async (input, init = {}) => {
  (input as string).startsWith('/api/');
  const headers = new Headers(init.headers);
  headers.set('kano-t', String(Date.now()));
  headers.set('kano-sign', 'fixture-signature');
  return mockFetch(input, { ...init, headers });
};
