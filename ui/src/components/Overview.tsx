import { Menu } from '@base-ui/react/menu';
import {
  Check,
  Download,
  FileText,
  MoreHorizontal,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Stethoscope,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { disabledReason, topTask } from '../state';
import type { GatewayModel, Operation } from '../use-gateway';
import { ActionButton, Button, Hint } from './ui';

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

export function Overview({
  model,
  container,
  addSubscription,
  confirmUninstall,
}: {
  model: GatewayModel;
  container: HTMLElement;
  addSubscription: () => void;
  confirmUninstall: () => void;
}) {
  const { device, busy } = model;
  const stage = stageOf(model);
  const healthy = !!(
    device?.running &&
    device.supervisor &&
    device.listeners &&
    (!device.capabilities.capture || device.network)
  );
  const dashboardReason = disabledReason('open-dashboard', device, !!busy);
  const menuItem = (action: Operation, name: string, Icon: LucideIcon) => (
    <Menu.Item
      key={action}
      disabled={!!disabledReason(action, device, !!busy)}
      onClick={() => void model.perform(action)}
      className="ufi:flex ufi:min-h-11 ufi:items-center ufi:gap-2 ufi:rounded-lg ufi:px-3 ufi:py-2 ufi:outline-hidden ufi:cursor-pointer ufi:data-[highlighted]:bg-white/10 ufi:data-[disabled]:opacity-40"
    >
      <Icon size={16} aria-hidden />
      {name}
    </Menu.Item>
  );
  return (
    <div
      data-overview
      className="ufi:rounded-2xl ufi:bg-[var(--mh-group)] ufi:p-5"
    >
      <div className="ufi:flex ufi:items-start ufi:justify-between">
        <span
          className={clsx(
            'ufi:flex ufi:size-14 ufi:items-center ufi:justify-center ufi:rounded-2xl',
            healthy
              ? 'ufi:bg-emerald-400/10 ufi:text-[#30d158]'
              : 'ufi:bg-blue-400/10 ufi:text-[#0a84ff]',
          )}
        >
          <ShieldCheck size={30} aria-hidden />
        </span>
        <Menu.Root modal={false}>
          <Menu.Trigger
            render={<Button icon={MoreHorizontal} aria-label="更多操作" />}
          />
          <Menu.Portal container={container}>
            <Menu.Positioner
              align="end"
              sideOffset={8}
              collisionPadding={12}
              className="ufi:z-[2147483639]"
            >
              <Menu.Popup
                data-ufi-menu
                className="ufi:z-[2147483639] ufi:min-w-48 ufi:rounded-xl ufi:border ufi:border-solid ufi:border-[var(--mh-line)] ufi:bg-[var(--mh-group)] ufi:p-1.5 ufi:text-sm ufi:text-[var(--mh-text)] ufi:shadow-xl"
              >
                {menuItem('refresh', '刷新状态', RefreshCw)}
                {menuItem('logs', '运行日志', FileText)}
                {menuItem('diagnose', '网络诊断', Stethoscope)}
                <Menu.Item
                  disabled={!device?.task}
                  onClick={() => void model.showTask()}
                  className="ufi:flex ufi:min-h-11 ufi:items-center ufi:gap-2 ufi:rounded-lg ufi:px-3 ufi:py-2 ufi:outline-hidden ufi:cursor-pointer ufi:data-[highlighted]:bg-white/10 ufi:data-[disabled]:opacity-40"
                >
                  <FileText size={16} aria-hidden />
                  最近任务
                </Menu.Item>
                <Menu.Separator className="ufi:my-1 ufi:h-px ufi:bg-white/10" />
                {menuItem(
                  device ? 'restart' : 'stop',
                  device ? '重启代理' : '停止代理',
                  device ? RefreshCw : Square,
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      <h2
        data-status
        className="ufi:m-0 ufi:mt-4 ufi:text-[28px] ufi:font-semibold ufi:tracking-tight"
      >
        {runtimeTitle(model)}
      </h2>
      <p className="ufi:m-0 ufi:mt-1 ufi:mb-5 ufi:text-sm ufi:opacity-60">
        {!device
          ? model.busy === 'uninstall' ? '正在停止服务并清理安装文件' : model.stateError.split('\n')[0] || '可重新检测，或卸载现有安装后重新安装'
          : healthy
            ? device.capabilities.capture
              ? '本地接管就绪'
              : '网络由系统管理'
            : stage === 'core'
              ? '请先安装 Mihomo 内核'
              : stage === 'subscription'
                ? '添加订阅后即可启动'
                : stage === 'agent' || stage === 'service'
                  ? '请先安装 Mihomo 服务'
                  : device.running
                    ? '可在更多菜单中查看日志'
                    : '随时可以启动'}
      </p>
      {stage === 'unknown' ? (
        <ActionButton
          model={model}
          action="refresh"
          label="重新检测"
          icon={RefreshCw}
          primary
        />
      ) : device?.running || device?.capture || stage === 'ready' ? (
        <ActionButton
          model={model}
          action={device?.running || device?.capture ? 'stop' : 'start'}
          label={device?.running ? '停止代理' : device?.capture ? '清理残留规则' : '启动代理'}
          icon={device?.running || device?.capture ? Square : Play}
          primary
        />
      ) : stage === 'agent' || stage === 'service' ? (
        <ActionButton
          model={model}
          action="install"
          label="安装 Mihomo 服务"
          icon={Download}
          primary
        />
      ) : stage === 'core' ? (
        <ActionButton
          model={model}
          action="download"
          label="安装 Mihomo 内核"
          icon={Download}
          primary
        />
      ) : (
        <Button
          full
          variant="primary"
          disabled={!!busy || device?.locked}
          onClick={addSubscription}
        >
          添加订阅
        </Button>
      )}
      {stage === 'unknown' && (
        <div className="ufi:mt-3">
          <Button full variant="danger" disabled={!!busy} loading={busy === 'uninstall'} onClick={confirmUninstall}>
            {busy === 'uninstall' ? '正在卸载现有安装…' : '卸载现有安装'}
          </Button>
          <Hint>卸载不依赖状态读取；完成后可重新初始化安装。</Hint>
        </div>
      )}
      {device?.locked && !topTask(device.task) && <Hint error>控制锁尚未释放，请查看最近任务和运行日志。</Hint>}
      {device?.service && (
        <div className="ufi:mt-3">
          <Button
            data-action="open-dashboard"
            full
            disabled={!!dashboardReason}
            title={dashboardReason}
            loading={busy === 'open-dashboard'}
            onClick={() => void model.openDashboard()}
          >
            {busy === 'open-dashboard' ? '正在打开面板…' : '打开面板'}
          </Button>
          <Hint>{dashboardReason}</Hint>
        </div>
      )}
      {device && stage !== 'ready' && (
        <div
          aria-label="安装进度"
          className="ufi:mt-4 ufi:flex ufi:justify-between ufi:gap-2 ufi:text-xs ufi:opacity-70"
        >
          {[
            ['服务', device.service],
            ['内核', device.core],
            ['配置', device.config],
          ].map(([label, done]) => (
            <span
              key={String(label)}
              className={clsx(
                'ufi:flex ufi:items-center ufi:gap-1',
                done && 'ufi:text-[#30d158]',
              )}
            >
              {done && <Check size={13} aria-hidden />}
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
