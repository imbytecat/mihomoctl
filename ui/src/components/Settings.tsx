import { Check } from 'lucide-react';
import {
  componentVersion,
  disabledReason,
  installationTask,
  lifecycleAction,
} from '../state';
import type { GatewayModel } from '../use-gateway';
import {
  ActionButton,
  Button,
  Hint,
  Input,
  Row,
  SettingInput,
  Switch,
  focus,
} from './ui';
import { TaskNotice } from './TaskNotice';

function RuntimeSettings({ model }: { model: GatewayModel }) {
  const action = model.device?.boot ? 'boot-off' : 'boot-on';
  const reason = disabledReason(action, model.device, !!model.busy);
  return (
    <section
      data-group="runtime"
      hidden={!model.device?.service}
      aria-labelledby="ufi-runtime-heading"
    >
      <h3
        id="ufi-runtime-heading"
        className="ufi:m-0 ufi:px-4 ufi:pt-5 ufi:pb-2 ufi:text-xs ufi:font-medium ufi:opacity-60"
      >
        运行
      </h3>
      <Row>
        <label htmlFor="ufi-boot">开机启动</label>
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
      <div className="ufi:px-4"><Hint>停止代理不会关闭自启；关闭自启不会停止当前代理。</Hint></div>
      <SettingInput model={model} />
    </section>
  );
}

function PanelSettings({ model }: { model: GatewayModel }) {
  const { device, form } = model;
  const { errors } = form.formState;
  const pending = model.controllerDirty || (device?.config && !device.controller?.applied);
  return (
    <section data-group="controller" hidden={!device?.service} aria-labelledby="ufi-controller-heading">
      <h3 id="ufi-controller-heading" className="ufi:m-0 ufi:flex ufi:items-center ufi:justify-between ufi:px-4 ufi:pt-5 ufi:pb-2 ufi:text-xs ufi:font-medium ufi:opacity-60">
        本地覆写
        <span>{model.controllerDirty ? '待应用' : device?.controller?.applied ? '已应用' : '已保存'}</span>
      </h3>
      <div className="ufi:p-4">
        <label htmlFor="ufi-controller-yaml" className="ufi:mb-2.5 ufi:block">覆写 YAML</label>
        <textarea id="ufi-controller-yaml" rows={9} maxLength={20480} spellCheck={false} autoComplete="off" autoCapitalize="off"
          disabled={!model.controllerLoaded || !device?.controller?.overrides}
          className={`ufi:block ufi:w-full ufi:min-w-0 ufi:m-0 ufi:resize-y ufi:rounded-xl ufi:border ufi:border-solid ufi:border-[var(--mh-line)] ufi:bg-none ufi:bg-white/5 ufi:p-3 ufi:font-mono ufi:text-base ufi:text-inherit ufi:leading-relaxed ufi:disabled:opacity-40 ${focus}`}
          {...form.register('controllerYaml', { validate: (value) => model.validate('controllerYaml', value), onChange: () => { if (form.getFieldState('controllerYaml').error) void form.trigger('controllerYaml'); } })}
          aria-invalid={!!errors.controllerYaml} aria-describedby="ufi-controller-yaml-help ufi-controller-yaml-error" />
        <Hint error>{device?.controller && !device.controller.overrides ? '请先更新 mihomoctl 以使用通用覆写' : model.controllerError}</Hint>
        <Hint id="ufi-controller-yaml-help">使用 Mihomo 配置字段；映射递归合并，数组整体替换。恢复默认会清空自定义覆写，保存后填入基础管理设置，保留当前端口和密钥。TPROXY、DNS 监听及平台绑定由管理器维护。</Hint>
        <div className="ufi:mt-3 ufi:flex ufi:flex-wrap ufi:gap-2">
          <ActionButton model={model} action="save-controller" label="保存并应用" icon={Check} primary extraReason={!model.controllerLoaded || !device?.controller?.overrides ? '请先读取设备覆写' : pending ? '' : '设置未改变'} />
          <Button disabled={!model.controllerLoaded || !device?.controller?.overrides}
            onClick={() => form.setValue('controllerYaml', '', { shouldDirty: true, shouldValidate: true })}>恢复默认</Button>
        </div>
        <Hint id="ufi-controller-yaml-error" error>{errors.controllerYaml?.message}</Hint>
        <Hint>{device?.running ? '应用后会重启代理' : device?.config ? '保存后生效' : '保存后随订阅生效'}</Hint>
      </div>
    </section>
  );
}

function Installation({
  model,
  confirmUninstall,
}: {
  model: GatewayModel;
  confirmUninstall: () => void;
}) {
  const { device } = model;
  const task =
    device?.task && installationTask(device.task.action) && !['queued', 'running'].includes(device.task.state) ? device.task : null;
  const lifecycle = lifecycleAction(device);
  return (
    <section data-group="maintenance" aria-labelledby="ufi-maintenance-heading">
      <div className="ufi:flex ufi:items-center ufi:justify-between ufi:gap-3 ufi:px-4 ufi:pt-5 ufi:pb-2">
        <h3
          id="ufi-maintenance-heading"
          className="ufi:m-0 ufi:text-xs ufi:font-medium ufi:opacity-60"
        >
          安装与更新
        </h3>
        <ActionButton model={model} action="check-updates" label="检查更新" />
      </div>
      <div className="ufi:border-0 ufi:border-b ufi:border-solid ufi:border-[var(--mh-line)] ufi:p-4">
        <div className="ufi:mb-2.5 ufi:flex ufi:items-center ufi:justify-between ufi:gap-2">
          <label htmlFor="ufi-release-proxy">发行转发地址</label>
          <a
            href="https://github.com/netnr/workers"
            target="_blank"
            rel="noopener noreferrer"
            className={`ufi:text-xs ufi:text-[#0a84ff] ufi:no-underline ${focus}`}
          >
            自行部署
          </a>
        </div>
        <Input
          id="ufi-release-proxy"
          data-release-proxy
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://mirror.example.com"
          disabled={!device}
          {...model.form.register('releaseProxy', {
            validate: (value) => model.validate('releaseProxy', value),
          })}
          aria-invalid={!!model.form.formState.errors.releaseProxy}
          aria-describedby="ufi-release-proxy-help"
        />
        <Hint id="ufi-release-proxy-help" error={!!model.form.formState.errors.releaseProxy}>
          {model.form.formState.errors.releaseProxy?.message ||
            (device?.service
              ? model.values.releaseProxy !== device.settings.releaseProxy
                ? '地址待保存；留空恢复直连 GitHub。'
                : '用于检查更新和下载组件；留空直连 GitHub。'
              : '留空直连 GitHub；自定义地址将在安装时保存到设备。')}
        </Hint>
        {device?.service && (
          <ActionButton
            model={model}
            action="save-release-proxy"
            label="保存转发设置"
            icon={Check}
            extraReason={model.values.releaseProxy === device.settings.releaseProxy ? '设置未改变' : ''}
          />
        )}
      </div>
      {model.updates && (
        <p
          data-update-checked
          className="ufi:m-0 ufi:px-4 ufi:text-xs ufi:opacity-60"
        >
          上次检查{' '}
          {new Date(model.updates.checkedAt).toLocaleString([], {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      )}
      {(
        [
          [
            'self',
            'mihomoctl',
            device?.agent,
            device?.version,
            'self-update',
          ],
          [
            'core',
            'Mihomo 内核',
            device?.core,
            device?.coreVersion,
            'download',
          ],
          [
            'dashboard',
            'Zashboard',
            device?.dashboard.installed,
            device?.dashboard.version,
            'download-dashboard',
          ],
        ] as const
      ).map(([id, name, installed, version, action]) => {
        const checked = model.updates?.[id];
        const update =
          checked?.current === (installed === false ? '' : version || '')
            ? checked
            : undefined;
        const label =
          update &&
          {
            available: `可更新至 ${update.latest}`,
            'up-to-date': '已是最新',
            'not-installed': `最新 ${update.latest}`,
            unknown: `最新 ${update.latest} · 当前版本无法比较`,
            error: '检查失败',
          }[update.state];
        return (
          <Row key={id}>
            <span className="ufi:flex ufi:min-w-0 ufi:flex-wrap ufi:items-baseline ufi:gap-x-2">
              <span>{name}</span>
              <span
                data-version={id}
                className="ufi:break-all ufi:text-xs ufi:opacity-60"
              >
                {componentVersion(installed, version)}
              </span>
              {label && (
                <span
                  data-update={id}
                  title={update?.error || `最新正式版 ${update?.latest}`}
                  className={
                    update?.state === 'available'
                      ? 'ufi:text-xs ufi:text-[#0a84ff]'
                      : update?.state === 'error'
                        ? 'ufi:text-xs ufi:text-[#ff6961]'
                        : 'ufi:text-xs ufi:opacity-60'
                  }
                >
                  {label}
                </span>
              )}
            </span>
            <ActionButton
              model={model}
              action={
                action === 'self-update' && installed === false
                  ? 'install'
                  : action
              }
              label={installed === false ? '安装' : '更新'}
              extraReason={
                update?.state === 'up-to-date' ? '已是最新正式版' : ''
              }
            />
          </Row>
        );
      })}
      {task && <TaskNotice model={model} job={task} installation />}
      <Row>
        <span data-lifecycle>
          Mihomo 服务{' '}
          <span className="ufi:text-xs ufi:opacity-60">
            {device
              ? device.service
                ? '已安装'
                : device.agent
                  ? '未完成'
                  : '未安装'
              : '状态未知'}
          </span>
        </span>
        <ActionButton
          model={model}
          action={lifecycle}
          label={
            lifecycle === 'uninstall' ? '卸载' : '安装'
          }
          onClick={lifecycle === 'uninstall' ? confirmUninstall : undefined}
        />
      </Row>
    </section>
  );
}

export function Settings({
  model,
  setup,
  confirmUninstall,
}: {
  model: GatewayModel;
  setup: boolean;
  confirmUninstall: () => void;
}) {
  const groups = {
    runtime: <RuntimeSettings key="runtime" model={model} />,
    controller: <PanelSettings key="controller" model={model} />,
    maintenance: (
      <Installation
        key="maintenance"
        model={model}
        confirmUninstall={confirmUninstall}
      />
    ),
  };
  const order: (keyof typeof groups)[] = setup
    ? ['maintenance', 'runtime', 'controller']
    : ['runtime', 'controller', 'maintenance'];
  return (
    <div data-settings className="ufi:mt-4 ufi:overflow-hidden ufi:rounded-2xl ufi:bg-[var(--mh-group)]">
      {order.map((name) => groups[name])}
    </div>
  );
}
