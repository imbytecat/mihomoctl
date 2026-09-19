import sodium from 'libsodium-wrappers';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { rootShell, uploadFile } from '@imbytecat/ufi-sdk';
import { createUfiHostClient, hostFetch } from '@imbytecat/ufi-sdk/host';
import bootstrapScript from './ufi-bootstrap.sh?raw';
import { releaseProxy, releaseURL } from '../config';
import {
  emptyState,
  protocol,
  updatesSchema,
  parseState,
  parseJob,
  type DeviceJob,
  type TaskAction,
  type TaskParams,
} from '../state';
import { requestJSON, requestFailure, requestError } from '../request';

declare const KANO_baseURL: string;
export const DIR = '/data/mihomoctl';
const AGENT = DIR + '/mihomoctl';
const BOOT = '/data/mihomoctl-bootstrap';
// POSIX sh preserves \! inside double quotes; shell-quote corrupts scripts
// containing negated patterns. Single-quote arguments without changing bytes.
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const uploadResponse = z.object({
  url: z
    .string()
    .transform((value) => value.replace(/^\/?uploads\//, ''))
    .refine(
      (name) =>
        name.endsWith('.bin') && z.guid().safeParse(name.slice(0, -4)).success,
    ),
});

export function shellCommand(command: string, marker: string) {
  return `sh -c ${quote(command)}; printf '\\n${marker}%s\\n' "$?"`;
}
export function shellResult(content: string, marker: string) {
  const match = content.match(new RegExp(`\\n${marker}(\\d+)\\s*$`));
  if (!match) throw new Error('设备未返回完整响应');
  const output = content.slice(0, match.index).trim();
  if (match[1] !== '0') {
    try {
      const value = JSON.parse(output);
      if (typeof value.error === 'string') throw new Error(value.error);
    } catch (error) {
      if (error instanceof Error && !(error instanceof SyntaxError))
        throw error;
    }
    throw new Error(output || `命令失败 (${match[1]})`);
  }
  return output;
}
export async function shell(command: string, timeout = 30_000) {
  const marker = `UFI_EXIT_${Date.now()}_${Math.random().toString(36).slice(2)}_`;
  const context = {
    step: '连接设备',
    target: 'UFI 设备 /api/root_shell',
    hint: '检查 UFI 设备 连接、UFI 登录和高级功能。任务可能仍在设备上运行，恢复连接后刷新状态。',
  };
  let result;
  try {
    result = await createUfiHostClient().request(
      rootShell,
      { command: shellCommand(command, marker), timeout },
      { timeout: timeout + 1000 },
    );
  } catch (error) {
    throw requestError(context, error);
  }
  return shellResult(result.result, marker);
}
async function agent(args: string[], timeout = 30_000) {
  const result = await shell(
    [quote(AGENT), ...args.map(quote)].join(' '),
    timeout,
  );
  return JSON.parse(result) as unknown;
}
export async function checkUpdates() {
  return updatesSchema.parse(await agent(['check-updates'], 45_000));
}
export async function stopAgent() {
  return parseJob(await agent(['stop', '--no-wait']));
}
export async function readDeviceState() {
  const output = await shell(`
    [ "$(id -u)" = 0 ] || { echo '请开启 UFI 高级功能'; exit 1; }
    [ ! -L ${DIR} ] || { echo '设备目录异常'; exit 1; }
    if [ -x ${AGENT} ]; then exec ${AGENT} status; fi
    [ ! -e ${DIR} ] || { echo '安装目录仍存在，但 mihomoctl 不可读；请等待安装或卸载完成后刷新'; exit 1; }
    printf null
  `);
  const task = await readBootstrap();
  if (output !== 'null') {
    const state = parseState(output);
    if (
      task &&
      (!state.task ||
        ['queued', 'running'].includes(task.state) ||
        Date.parse(task.updated) > Date.parse(state.task.updated))
    ) {
      state.task = task;
      state.locked ||= ['queued', 'running'].includes(task.state);
    }
    return state;
  }
  return {
    ...emptyState,
    task,
    locked: !!task && ['queued', 'running'].includes(task.state),
  };
}
async function uploadBytes(bytes: Uint8Array) {
  const context = {
    step: '上传设备请求',
    target: 'UFI 设备 /api/upload_img',
    hint: '检查设备连接和 UFI 登录状态。',
  };
  try {
    const result = await createUfiHostClient().request(uploadFile, {
      file: new File([new Uint8Array(bytes)], 'request.bin', { type: 'application/octet-stream' }),
    });
    return uploadResponse.parse(result).url;
  } catch (error) {
    throw requestError(context, error);
  }
}
export async function sealRequest(publicKey: string, value: object) {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  if (key.length !== 32) throw new Error('设备公钥无效');
  const bytes = sodium.crypto_box_seal(
    sodium.from_string(JSON.stringify(value)),
    key,
  );
  return { bytes, hash: bytesToHex(sha256(bytes)) };
}
export function taskID() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function submitTask(action: TaskAction, params: TaskParams = {}) {
  const state = await readDeviceState();
  if (!state.agent || !state.publicKey)
    throw new Error('请先安装 mihomoctl');
  const id = taskID();
  const sealed = await sealRequest(state.publicKey, { id, action, params });
  const name = await uploadBytes(sealed.bytes);
  try {
    return parseJob(await agent(['submit', name, sealed.hash]));
  } catch (error) {
    if (action === 'uninstall') {
      const completed = await readUninstallJob({
        id,
        action,
        state: 'running',
        phase: 'removing',
        updated: '', started: new Date().toISOString(),
        hash: sealed.hash,
        downloaded: 0, total: 0, speed: 0, cancellable: false, cancelRequested: false,
        error: '',
        result: '',
      }).catch(() => null);
      if (completed?.state === 'succeeded') return completed;
    }
    try {
      return parseJob(await agent(['job', id]));
    } catch {}
    throw new Error(
      `任务提交结果未确认\n任务 ID：${id}\n${error instanceof Error ? error.message : String(error)}\n恢复连接后刷新状态，勿连续重复提交。`,
    );
  }
}
export async function readJob(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('无效任务 ID');
  return parseJob(await agent(['job', id]));
}

// Uninstall is a native control command and does not need a readable UI state.
export async function uninstallAgent(): Promise<DeviceJob> {
  const id = taskID();
  const now = new Date().toISOString();
  const initial: DeviceJob = {
    id, action: 'uninstall', state: 'queued', phase: 'stopping',
    started: now, updated: now, hash: '', result: '', error: '',
    downloaded: 0, total: 0, speed: 0, cancellable: false, cancelRequested: false,
  };
  try {
    await shell(`
      [ "$(id -u)" = 0 ] || { echo '请开启 UFI 高级功能'; exit 1; }
      [ ! -L ${DIR} ] && [ ! -L ${BOOT} ] && [ ! -L ${AGENT} ] || { echo '卸载路径异常'; exit 1; }
      if [ ! -e ${DIR} ] && [ ! -e ${BOOT} ]; then exit 0; fi
      [ -x ${AGENT} ] || { echo '设备上的卸载程序不可用，无法完成服务清理'; exit 1; }
      exec ${AGENT} uninstall --id ${id} --no-wait
    `);
  } catch (error) {
    // A missing submit response is never a reason to submit a second uninstall.
    const recovered = await readUninstallJob(initial).catch(() => null);
    if (recovered) return recovered;
    throw new Error(`卸载未完成\n任务 ID：${id}\n${error instanceof Error ? error.message : String(error)}`);
  }
  return initial;
}

// Completion is the absence of both owned directories, not a surviving receipt.
export async function readUninstallJob(
  initial: DeviceJob,
): Promise<DeviceJob | null> {
  if (!/^[a-f0-9]{32}$/.test(initial.id)) throw new Error('无效任务 ID');
  const state = await shell(`
    # ufi-uninstall-status
    [ "$(id -u)" = 0 ] || { echo '请开启 UFI 高级功能'; exit 1; }
    [ ! -L ${DIR} ] && [ ! -L ${BOOT} ] || { echo '卸载目录异常'; exit 1; }
    if [ ! -e ${DIR} ] && [ ! -L ${DIR} ] && [ ! -e ${BOOT} ] && [ ! -L ${BOOT} ]; then printf null
    elif [ -x ${AGENT} ] && record=$(${AGENT} job ${initial.id} 2>/dev/null); then printf '%s' "$record"
    else printf '{"removing":true}'; fi
  `);
  const value = JSON.parse(state);
  if (value === null)
    return {
      ...initial,
      state: 'succeeded',
      phase: 'done',
      result: 'Mihomo 服务已卸载',
    };
  if (value?.removing === true) return null;
  // Observe only the command receipt. Runtime settings and task progress are
  // irrelevant to removal and must not gate this independent control path.
  const receipt = z.object({
    id: z.literal(initial.id),
    action: z.literal('uninstall'),
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled']),
    phase: z.string(),
    updated: z.string(),
    error: z.string().default(''),
    result: z.string().default(''),
  }).parse(value);
  const job = { ...initial, ...receipt };
  if (job.state === 'succeeded')
    return { ...job, state: 'failed', error: '卸载未完成，设备文件仍存在' };
  return job;
}
export async function jobLog(job: DeviceJob) {
  if (job.action === 'bootstrap')
    return shell(`tail -n 35 ${BOOT}/jobs/${job.id}/log.txt`);
  const result = await agent(['job-log', job.id]);
  return typeof result === 'string' ? result : '';
}
export async function deviceLogs(diagnose = false) {
  const result = await agent([diagnose ? 'diagnose' : 'logs']);
  return typeof result === 'string' ? result : '';
}

export async function readControllerSecret(overrides = false) {
  await sodium.ready;
  const key = sodium.crypto_box_keypair();
  try {
    const sealed = await agent([
      'controller-secret',
      sodium.to_base64(key.publicKey, sodium.base64_variants.ORIGINAL),
      ...(overrides ? ['--config'] : []),
    ]);
    if (typeof sealed !== 'string') throw new Error('密钥响应无效');
    const value = sodium.to_string(
      sodium.crypto_box_seal_open(
        sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
        key.publicKey,
        key.privateKey,
      ),
    );
    if (!value) throw new Error('密钥响应无效');
    return value;
  } finally {
    sodium.memzero(key.privateKey);
  }
}

export async function readBootstrap(id?: string): Promise<DeviceJob | null> {
  if (id && !/^[a-f0-9]{32}$/.test(id)) throw new Error('无效任务 ID');
  const output = await shell(`
    [ ! -L ${BOOT} ] || exit 1
    if [ ! -d ${BOOT} ]; then printf null; exit 0; fi
    id=${id ? quote(id) : `"$(cat ${BOOT}/latest 2>/dev/null)"`}
    case "$id" in ''|*[!a-f0-9]*) printf null; exit 0;; esac
    [ "\${#id}" = 32 ] || exit 1
    sh "${BOOT}/jobs/$id/bootstrap.sh" status "$id"
  `);
  return output === 'null' ? null : parseJob(JSON.parse(output));
}
const agentReleaseSchema = z.object({
  tag_name: z.string().min(1),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number().int().positive(),
      browser_download_url: z.string(),
      digest: z.string().nullable().optional(),
    }),
  ),
});
export async function latestAgentAssets(proxy = '') {
  const address =
    'https://api.github.com/repos/imbytecat/mihomoctl/releases/latest';
  const target = releaseURL(proxy, address);
  const context = {
    step: '检查 mihomoctl 最新版本',
    target,
    hint: '检查浏览器能否访问 GitHub API，以及网络和跨域请求是否可用。',
  };
  const release = await requestJSON(
    target,
    { credentials: 'omit', redirect: proxy ? 'error' : 'follow', signal: AbortSignal.timeout(30_000) },
    context,
    agentReleaseSchema,
    hostFetch,
  );
  const asset = (arch: string) => {
    const name = `mihomoctl-linux-${arch}`;
    const value = release.assets.find((entry) => entry.name === name);
    const url = `https://github.com/imbytecat/mihomoctl/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
    if (
      value?.browser_download_url !== url ||
      !/^sha256:[a-f0-9]{64}$/i.test(value.digest || '')
    )
      throw requestFailure(context, `官方版本缺少 ${arch} 文件或有效 SHA-256`);
    return { url: releaseURL(proxy, url), sha256: value.digest!.slice(7).toLowerCase(), size: value.size };
  };
  return { arm64: asset('arm64'), armv7: asset('armv7') };
}

export async function bootstrapAgent(value = '') {
  const proxy = releaseProxy(value);
  const assets = await latestAgentAssets(proxy);
  await sodium.ready;
  const id = taskID();
  const data = sodium.from_string(bootstrapScript);
  const hash = bytesToHex(sha256(data));
  const name = await uploadBytes(data);
  const source = '/data/data/com.minikano.f50_sms/files/uploads/' + name;
  const folder = BOOT + '/jobs/' + id;
  const asset64 = assets.arm64,
    asset7 = assets.armv7;
  const result = await shell(`
    set -e
    umask 077
    [ ! -L ${BOOT} ]
    mkdir -p ${folder}
    chmod 700 ${BOOT} ${BOOT}/jobs ${folder}
    cp ${quote(source)} ${folder}/bootstrap.sh
    chmod 600 ${folder}/bootstrap.sh
    hash=$(sha256sum ${folder}/bootstrap.sh)
    [ "\${hash%% *}" = ${quote(hash)} ] || { echo '安装脚本校验失败'; exit 1; }
    rm -f ${quote(source)}
    sh ${folder}/bootstrap.sh submit ${quote(id)} ${quote(asset64.url)} ${quote(asset64.sha256)} ${quote(asset7.url)} ${quote(asset7.sha256)} ${protocol} ${quote(proxy)} ${asset64.size} ${asset7.size}
  `);
  return parseJob(JSON.parse(result));
}

export function baseURL() {
  return new URL(KANO_baseURL, location.href).href;
}

export async function cancelDeviceTask(job: DeviceJob) {
  if (!/^[a-f0-9]{32}$/.test(job.id)) throw new Error('无效任务 ID');
  if (job.action === 'bootstrap')
    return parseJob(JSON.parse(await shell(`sh ${BOOT}/jobs/${job.id}/bootstrap.sh cancel ${job.id}`)));
  return parseJob(await agent(['cancel', job.id, '--no-wait']));
}
