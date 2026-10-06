import { Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import {
  componentVersion,
  disabledReason,
  installationTask,
  lifecycleAction,
} from '../state';
import type { GatewayModel } from '../use-gateway';
import {
  ActionButton,
  Hint,
  Input,
  Row,
  Section,
  SettingInput,
  Switch,
  focus,
  muted,
} from './ui';
import { TaskNotice } from './TaskNotice';

function Runtime({ model }: { model: GatewayModel }) {
  const action = model.device?.boot ? 'boot-off' : 'boot-on';
  const reason = disabledReason(action, model.device, !!model.busy);
  return (
    <Section id="runtime" title="运行" hidden={!model.device?.service}>
      <Row label="开机启动" htmlFor="ufi-boot" description="设备重启后自动运行代理；与当前运行状态互不影响">
        <Switch
          id="ufi-boot"
          data-boot
          checked={model.device?.boot || false}
          disabled={!!reason}
          title={reason}
          onCheckedChange={(enabled) =>
            void model.perform(enabled ? 'boot-on' : 'boot-off')
          }
        />
      </Row>
      <SettingInput model={model} />
    </Section>
  );
}

const updateLabels = {
  available: (latest: string) => `可更新至 ${latest}`,
  'up-to-date': () => '已是最新',
  'not-installed': (latest: string) => `最新 ${latest}`,
  unknown: (latest: string) => `最新 ${latest} · 当前版本无法比较`,
  error: () => '检查失败',
};

function Components({ model }: { model: GatewayModel }) {
  const { device } = model;
  const task =
    device?.task && installationTask(device.task.action) && !['queued', 'running'].includes(device.task.state)
      ? device.task
      : null;
  const rows = [
    ['self', 'mihomoctl', device?.agent, device?.version, 'self-update'],
    ['core', 'Mihomo 内核', device?.core, device?.coreVersion, 'download'],
    ['dashboard', 'Zashboard 面板', device?.dashboard.installed, device?.dashboard.version, 'download-dashboard'],
  ] as const;
  return (
    <Section
      id="maintenance"
      title="组件"
      aside={
        <span className="ufi:flex ufi:items-center ufi:gap-2">
          {model.updates && (
            <span data-update-checked className={`ufi:text-xs ${muted}`}>
              上次检查{' '}
              {new Date(model.updates.checkedAt).toLocaleString([], {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
          <ActionButton model={model} action="check-updates" label="检查更新" variant="ghost" />
        </span>
      }
    >
      {rows.map(([id, name, installed, version, action]) => {
        const checked = model.updates?.[id];
        const update =
          checked?.current === (installed === false ? '' : version || '') ? checked : undefined;
        return (
          <Row
            key={id}
            label={name}
            description={
              <>
                <span data-version={id} className="ufi:break-all">
                  {componentVersion(installed, version)}
                </span>
                {update && (
                  <>
                    {' · '}
                    <span
                      data-update={id}
                      title={update.error || `最新正式版 ${update.latest}`}
                      className={clsx(
                        update.state === 'available' && 'ufi:text-[#0a84ff]',
                        update.state === 'error' && 'ufi:text-[#ff6961]',
                      )}
                    >
                      {updateLabels[update.state](update.latest)}
                    </span>
                  </>
                )}
              </>
            }
          >
            <ActionButton
              model={model}
              action={action === 'self-update' && installed === false ? 'install' : action}
              label={installed === false ? '安装' : '更新'}
              variant={update?.state === 'available' ? 'primary' : 'default'}
              extraReason={update?.state === 'up-to-date' ? '已是最新正式版' : ''}
            />
          </Row>
        );
      })}
      {task && <TaskNotice model={model} job={task} installation />}
    </Section>
  );
}

function ReleaseProxy({ model }: { model: GatewayModel }) {
  const { device, form, values } = model;
  const error = form.formState.errors.releaseProxy;
  return (
    <Section
      id="release"
      title="下载加速"
      aside={
        <a
          href="https://github.com/netnr/workers"
          target="_blank"
          rel="noopener noreferrer"
          className={`ufi:pb-1 ufi:text-xs ufi:text-[#0a84ff] ufi:no-underline ${focus}`}
        >
          自行部署
        </a>
      }
    >
      <div className="ufi:px-4 ufi:py-3">
        <label htmlFor="ufi-release-proxy" className="ufi:mb-2 ufi:block">
          发行转发地址
        </label>
        <div className="ufi:flex ufi:gap-2">
          <Input
            id="ufi-release-proxy"
            data-release-proxy
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="留空直连 GitHub"
            disabled={!device}
            {...form.register('releaseProxy', {
              validate: (value) => model.validate('releaseProxy', value),
            })}
            aria-invalid={!!error}
            aria-describedby="ufi-release-proxy-help"
          />
          {device?.service && (
            <ActionButton
              model={model}
              action="save-release-proxy"
              label="保存"
              extraReason={values.releaseProxy === device.settings.releaseProxy ? '设置未改变' : ''}
            />
          )}
        </div>
        <Hint id="ufi-release-proxy-help" error={!!error}>
          {error?.message ||
            (device?.service
              ? '用于检查更新和下载组件，例如 https://mirror.example.com'
              : '安装时保存到设备，例如 https://mirror.example.com')}
        </Hint>
      </div>
    </Section>
  );
}

export function Settings({
  model,
  confirmUninstall,
}: {
  model: GatewayModel;
  confirmUninstall: () => void;
}) {
  return (
    <div data-settings className="ufi:flex ufi:flex-col ufi:gap-5">
      <Runtime model={model} />
      <Components model={model} />
      <ReleaseProxy model={model} />
      {lifecycleAction(model.device) === 'uninstall' && (
        <Section id="danger" title="卸载">
          <div className="ufi:p-3">
            <ActionButton
              model={model}
              action="uninstall"
              label="卸载 Mihomo 服务"
              icon={Trash2}
              full
              onClick={confirmUninstall}
            />
            <Hint>停止代理、关闭开机启动，并删除本安装的全部文件和数据。</Hint>
          </div>
        </Section>
      )}
    </div>
  );
}
