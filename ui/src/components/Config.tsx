import { useState, type RefObject } from 'react';
import { useController } from 'react-hook-form';
import { Check, Link, RefreshCw, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';
import type { GatewayModel } from '../use-gateway';
import { ActionButton, Button, Hint, Input, Section, card, muted } from './ui';
import { YamlEditor } from './YamlEditor';

function Badge({ tone, children }: { tone: 'blue' | 'green' | 'gray'; children: string }) {
  return (
    <span
      className={clsx(
        'ufi:rounded-full ufi:px-2 ufi:py-0.5 ufi:text-xs ufi:font-medium',
        tone === 'blue' && 'ufi:bg-[#0a84ff]/15 ufi:text-[#0a84ff]',
        tone === 'green' && 'ufi:bg-[#30d158]/15 ufi:text-[#30d158]',
        tone === 'gray' && `ufi:bg-[var(--mh-fill-strong)] ${muted}`,
      )}
    >
      {children}
    </span>
  );
}

function Subscription({
  model,
  anchor,
}: {
  model: GatewayModel;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const { form, values, device, busy } = model;
  const [replacing, setReplacing] = useState(false);
  const error = form.formState.errors.subscription;
  const draft = !!values.subscription?.trim();
  const saved = !!device?.subscription;
  const editing = !saved || replacing || draft;
  const update = async () => {
    await model.perform('update');
    if (!form.getValues('subscription').trim()) setReplacing(false);
  };
  return (
    <div data-group="subscription" ref={anchor} className={`ufi:p-4 ${card}`}>
      <div className="ufi:mb-3 ufi:flex ufi:items-center ufi:justify-between ufi:gap-2">
        <label htmlFor="ufi-subscription" className="ufi:flex ufi:items-center ufi:gap-2 ufi:font-medium">
          <Link size={16} className={muted} aria-hidden />
          订阅
        </label>
        {draft ? <Badge tone="blue">待应用</Badge> : saved ? <Badge tone="green">已保存</Badge> : <Badge tone="gray">未配置</Badge>}
      </div>
      {editing ? (
        <>
          <Input
            {...form.register('subscription', {
              validate: (value) => model.validate('subscription', value),
            })}
            id="ufi-subscription"
            data-url
            type="password"
            placeholder="粘贴订阅链接"
            autoFocus={replacing}
            disabled={!!busy}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby="ufi-subscription-help"
            enterKeyHint="go"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void update();
              }
            }}
          />
          <Hint id="ufi-subscription-help" error={!!error?.message}>
            {error?.message || '链接加密传输并保存在设备上，不会写入日志。'}
          </Hint>
          <div className="ufi:mt-3 ufi:flex ufi:gap-2">
            {saved && (
              <Button
                disabled={!!busy}
                onClick={() => {
                  form.resetField('subscription', { defaultValue: '' });
                  setReplacing(false);
                }}
              >
                取消
              </Button>
            )}
            <div className="ufi:flex-1">
              <ActionButton
                model={model}
                action="update"
                label="保存并更新"
                icon={RefreshCw}
                full
                variant="primary"
                onClick={() => void update()}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          <p className={`ufi:m-0 ufi:mb-3 ufi:text-sm ${muted}`}>订阅链接已加密保存在设备上。</p>
          <div className="ufi:flex ufi:gap-2">
            <div className="ufi:flex-1">
              <ActionButton model={model} action="update" label="更新订阅" icon={RefreshCw} full onClick={() => void update()} />
            </div>
            <Button disabled={!!busy} onClick={() => setReplacing(true)}>
              更换链接
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Overrides({ model }: { model: GatewayModel }) {
  const { device, form } = model;
  const { field, fieldState } = useController({
    control: form.control,
    name: 'controllerYaml',
    rules: { validate: (value) => model.validate('controllerYaml', value) },
  });
  const pending = model.controllerDirty || (device?.config && !device.controller?.applied);
  const unavailable = !model.controllerLoaded || !device?.controller?.overrides;
  return (
    <Section
      id="controller"
      title="本地覆写"
      hidden={!device?.service}
      aside={
        model.controllerDirty ? (
          <Badge tone="blue">待应用</Badge>
        ) : (
          <span className={`ufi:pb-1 ufi:text-xs ${muted}`}>
            {device?.controller?.applied ? '已应用' : '已保存'}
          </span>
        )
      }
    >
      <div className="ufi:px-4 ufi:py-3">
        <p className={`ufi:m-0 ufi:mb-2 ufi:text-xs ${muted}`}>
          在订阅配置之上修改字段：映射递归合并，数组整体替换；TPROXY、DNS 监听和平台绑定由管理器维护。
          <span id="ufi-controller-yaml-help">
            {device?.running ? '应用后会重启代理。' : device?.config ? '保存后生效。' : '保存后随订阅生效。'}
          </span>
        </p>
        <YamlEditor
          id="ufi-controller-yaml"
          label="覆写 YAML"
          describedBy="ufi-controller-yaml-error ufi-controller-yaml-help"
          placeholder={'# 例如\nmode: rule\nlog-level: warning'}
          value={field.value}
          invalid={!!fieldState.error}
          disabled={unavailable}
          onBlur={field.onBlur}
          onChange={(value) => {
            field.onChange(value);
            if (form.getFieldState('controllerYaml').error) void form.trigger('controllerYaml');
          }}
        />
        <Hint error>
          {device?.controller && !device.controller.overrides
            ? '请先更新 mihomoctl 以使用通用覆写'
            : model.controllerError}
        </Hint>
        <div className="ufi:mt-3 ufi:flex ufi:justify-end ufi:gap-2">
          <Button
            icon={RotateCcw}
            disabled={unavailable}
            title="清空自定义覆写；保存后恢复基础管理设置，保留当前端口和密钥"
            onClick={() => form.setValue('controllerYaml', '', { shouldDirty: true, shouldValidate: true })}
          >
            恢复默认
          </Button>
          <ActionButton
            model={model}
            action="save-controller"
            label="应用"
            icon={Check}
            variant="primary"
            extraReason={unavailable ? '请先读取设备覆写' : pending ? '' : '设置未改变'}
          />
        </div>
        <Hint id="ufi-controller-yaml-error" error>
          {fieldState.error?.message}
        </Hint>
      </div>
    </Section>
  );
}

export function Config({
  model,
  anchor,
}: {
  model: GatewayModel;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="ufi:flex ufi:flex-col ufi:gap-5">
      <Subscription model={model} anchor={anchor} />
      <Overrides model={model} />
    </div>
  );
}
