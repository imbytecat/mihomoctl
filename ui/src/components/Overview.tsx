import {
  Check,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCw,
  Square,
} from 'lucide-react';
import { clsx } from 'clsx';
import { disabledReason, topTask } from '../state';
import type { GatewayModel } from '../use-gateway';
import { ActionButton, Button, Hint, card, focus, muted } from './ui';
import { TaskNotice } from './TaskNotice';

export function stageOf(model: GatewayModel) {
  const device = model.device;
  return !device
    ? 'unknown'
    : !device.agent
      ? 'agent'
      : !device.service
        ? 'service'
        : !device.core
          ? 'core'
          : !device.config
            ? 'subscription'
            : 'ready';
}

export function runtimeTitle(model: GatewayModel) {
  const device = model.device;
  if (!device) return model.busy === 'uninstall' ? '正在卸载' : model.busy ? '正在检测' : '状态不可用';
  if (!device.running && device.capture) return '待清理';
  if (!device.running)
    return stageOf(model) === 'ready' ? '已停止' : '尚未就绪';
  return !device.supervisor
    ? '需要恢复'
    : !device.listeners
      ? '正在启动'
      : device.capabilities.capture && !device.network
        ? '等待网络'
        : '运行中';
}

function healthy(model: GatewayModel) {
  const device = model.device;
  return !!(
    device?.running &&
    device.supervisor &&
    device.listeners &&
    (!device.capabilities.capture || device.network)
  );
}

/** Status color: green healthy, amber transitional, gray stopped, blue setup, red unknown. */
function tone(model: GatewayModel) {
  const device = model.device;
  if (!device) return model.busy ? '#0a84ff' : '#ff6961';
  if (healthy(model)) return '#30d158';
  if (device.running || device.capture) return '#ff9f0a';
  return stageOf(model) === 'ready' ? '#8e8e93' : '#0a84ff';
}

export function StatusDot({ model }: { model: GatewayModel }) {
  const color = tone(model);
  return (
    <span aria-hidden className="ufi:relative ufi:flex ufi:size-2.5 ufi:shrink-0">
      {healthy(model) && (
        <span
          className="ufi:absolute ufi:inset-0 ufi:animate-ping ufi:rounded-full ufi:opacity-60 ufi:motion-reduce:hidden"
          style={{ background: color }}
        />
      )}
      <span className="ufi:relative ufi:size-2.5 ufi:rounded-full" style={{ background: color }} />
    </span>
  );
}

function subtitle(model: GatewayModel) {
  const { device } = model;
  if (!device)
    return model.busy === 'uninstall'
      ? '正在停止服务并清理安装文件'
      : model.stateError.split('\n')[0] || '可重新检测，或卸载现有安装后重新安装';
  if (healthy(model))
    return [
      device.capabilities.capture ? '本地接管就绪' : '网络由系统管理',
      device.coreVersion && `内核 ${device.coreVersion}`,
    ].filter(Boolean).join(' · ');
  if (device.running) return '可在日志中查看启动过程';
  if (device.capture) return '代理已退出，网络规则仍需清理';
  return stageOf(model) === 'ready' ? '随时可以启动' : '完成以下步骤即可启动代理';
}

const steps = [
  ['安装 Mihomo 服务', 'service'],
  ['安装 Mihomo 内核', 'core'],
  ['添加订阅', 'config'],
] as const;

function Setup({
  model,
  addSubscription,
  openSettings,
}: {
  model: GatewayModel;
  addSubscription: () => void;
  openSettings: () => void;
}) {
  const device = model.device!;
  const current = steps.findIndex(([, key]) => !device[key]);
  const version = { service: device.version, core: device.coreVersion, config: '' };
  return (
    <>
      <ol aria-label="安装进度" className="ufi:m-0 ufi:mb-4 ufi:list-none ufi:p-0">
        {steps.map(([label, key], index) => {
          const done = device[key];
          return (
            <li
              key={key}
              aria-current={index === current ? 'step' : undefined}
              className={clsx(
                'ufi:relative ufi:flex ufi:min-h-11 ufi:items-center ufi:gap-3',
                !done && index !== current && muted,
              )}
            >
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className={clsx(
                    'ufi:absolute ufi:left-3 ufi:top-[calc(50%+14px)] ufi:h-[calc(100%-28px)] ufi:w-px ufi:-translate-x-1/2',
                    done ? 'ufi:bg-[#30d158]/50' : 'ufi:bg-[var(--mh-line)]',
                  )}
                />
              )}
              <span
                className={clsx(
                  'ufi:flex ufi:size-6 ufi:shrink-0 ufi:items-center ufi:justify-center ufi:rounded-full ufi:text-xs ufi:font-semibold ufi:tabular-nums',
                  done
                    ? 'ufi:bg-[#30d158]/20 ufi:text-[#30d158]'
                    : index === current
                      ? 'ufi:bg-[var(--mh-accent)] ufi:text-white ufi:ring-4 ufi:ring-[var(--mh-accent)]/25'
                      : 'ufi:bg-[var(--mh-fill-strong)]',
                )}
              >
                {done ? <Check size={14} strokeWidth={3} aria-label="已完成" /> : index + 1}
              </span>
              <span className={clsx('ufi:min-w-0 ufi:flex-1', index === current && 'ufi:font-medium')}>
                {label}
              </span>
              {done && version[key] && (
                <span className={`ufi:text-xs ufi:tabular-nums ${muted}`}>{version[key]}</span>
              )}
            </li>
          );
        })}
      </ol>
      {current === 0 ? (
        <>
          <ActionButton model={model} action="install" label="安装 Mihomo 服务" icon={Download} primary />
          {!device.agent && (
            <Hint>
              从 GitHub 下载较慢？
              <button
                type="button"
                onClick={openSettings}
                className={`ufi:m-0 ufi:cursor-pointer ufi:border-0 ufi:bg-transparent ufi:p-0 ufi:text-xs ufi:text-[#0a84ff] ${focus}`}
              >
                设置下载加速
              </button>
            </Hint>
          )}
        </>
      ) : current === 1 ? (
        <ActionButton model={model} action="download" label="安装 Mihomo 内核" icon={Download} primary />
      ) : (
        <Button
          full
          variant="primary"
          disabled={!!model.busy || device.locked}
          onClick={addSubscription}
        >
          添加订阅
        </Button>
      )}
    </>
  );
}

function Runtime({ model }: { model: GatewayModel }) {
  const { device, busy } = model;
  if (!device?.running) {
    return device?.capture ? (
      <ActionButton model={model} action="stop" label="清理残留规则" icon={Square} primary />
    ) : (
      <ActionButton model={model} action="start" label="启动代理" icon={Play} primary />
    );
  }
  const reason = disabledReason('open-dashboard', device, !!busy);
  return (
    <>
      <Button
        data-action="open-dashboard"
        full
        variant="primary"
        icon={ExternalLink}
        disabled={!!reason}
        title={reason}
        loading={busy === 'open-dashboard'}
        onClick={() => void model.openDashboard()}
      >
        {busy === 'open-dashboard' ? '正在打开面板…' : '打开面板'}
      </Button>
      <div className="ufi:mt-2 ufi:grid ufi:grid-cols-2 ufi:gap-2">
        <ActionButton model={model} action="restart" label="重启代理" icon={RotateCw} full />
        <ActionButton model={model} action="stop" label="停止代理" icon={Square} full />
      </div>
      <Hint>{reason}</Hint>
    </>
  );
}

export function Overview({
  model,
  addSubscription,
  openSettings,
  confirmUninstall,
}: {
  model: GatewayModel;
  addSubscription: () => void;
  openSettings: () => void;
  confirmUninstall: () => void;
}) {
  const { device, busy } = model;
  const stage = stageOf(model);
  return (
    <div data-overview className={`ufi:relative ufi:overflow-hidden ufi:p-4 ${card}`}>
      <div
        aria-hidden
        className="ufi:pointer-events-none ufi:absolute ufi:-left-20 ufi:-top-24 ufi:size-64 ufi:rounded-full ufi:opacity-20 ufi:blur-3xl ufi:transition-colors ufi:duration-700"
        style={{ background: tone(model) }}
      />
      <div className="ufi:relative ufi:mb-4 ufi:flex ufi:items-start ufi:gap-3">
        <span className="ufi:flex ufi:h-8 ufi:items-center">
          <StatusDot model={model} />
        </span>
        <div className="ufi:min-w-0 ufi:flex-1">
          <h2 data-status className="ufi:m-0 ufi:text-xl ufi:font-semibold ufi:leading-8 ufi:tracking-tight">
            {runtimeTitle(model)}
          </h2>
          <p className={`ufi:m-0 ufi:text-sm ${muted}`}>{subtitle(model)}</p>
        </div>
        {stage !== 'unknown' && (
          <Button
            variant="ghost"
            icon={RefreshCw}
            aria-label="刷新状态"
            title="刷新状态"
            className="ufi:-mr-2 ufi:-mt-2"
            disabled={!!busy}
            loading={busy === 'refresh'}
            onClick={() => void model.perform('refresh')}
          />
        )}
      </div>
      <div className="ufi:relative">
        {stage === 'unknown' ? (
          <>
            <ActionButton model={model} action="refresh" label="重新检测" icon={RefreshCw} primary />
            <div className="ufi:mt-2 ufi:grid ufi:grid-cols-2 ufi:gap-2">
              <ActionButton model={model} action="stop" label="停止代理" full />
              <Button full variant="danger" disabled={!!busy} loading={busy === 'uninstall'} onClick={confirmUninstall}>
                {busy === 'uninstall' ? '正在卸载…' : '卸载现有安装'}
              </Button>
            </div>
            <Hint>卸载不依赖状态读取；完成后可重新安装。</Hint>
          </>
        ) : device?.running || device?.capture || stage === 'ready' ? (
          <Runtime model={model} />
        ) : (
          <Setup model={model} addSubscription={addSubscription} openSettings={openSettings} />
        )}
        {model.error ? (
          <Button
            full
            variant="danger"
            className="ufi:mt-3"
            onClick={() => {
              model.setLogSource('details');
              model.setDetailOpen(true);
            }}
          >
            查看错误详情
          </Button>
        ) : (
          topTask(model.task) && model.task && <TaskNotice model={model} job={model.task} />
        )}
        {device?.locked && !topTask(device.task) && (
          <Hint error>控制锁尚未释放，请查看最近任务和日志。</Hint>
        )}
      </div>
    </div>
  );
}
