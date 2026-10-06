import type { ComponentProps, ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Switch as Toggle } from '@base-ui/react/switch';
import { Tabs } from '@base-ui/react/tabs';
import { clsx } from 'clsx';
import { LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { disabledReason } from '../state';
import type { GatewayModel, Operation } from '../use-gateway';

export const focus =
  'ufi:focus-visible:outline ufi:focus-visible:outline-2 ufi:focus-visible:outline-offset-2 ufi:focus-visible:outline-[#0a84ff]';
export const muted = 'ufi:text-[var(--mh-muted)]';
/** Rounded surface inside the plugin; follows the UFI tag color. */
export const card = 'ufi:rounded-2xl ufi:bg-[var(--mh-group)]';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  default:
    'ufi:border-[var(--mh-line)] ufi:bg-[var(--mh-fill)] ufi:text-inherit ufi:enabled:hover:bg-[var(--mh-fill-strong)]',
  primary:
    'ufi:border-transparent ufi:bg-[var(--mh-accent)] ufi:text-white ufi:shadow-sm ufi:enabled:hover:brightness-110',
  danger:
    'ufi:border-transparent ufi:bg-[#ff453a]/15 ufi:text-[#ff6961] ufi:enabled:hover:bg-[#ff453a]/25',
  ghost:
    'ufi:border-transparent ufi:bg-transparent ufi:text-inherit ufi:enabled:hover:bg-[var(--mh-fill)]',
};

type ButtonProps = ComponentProps<'button'> & {
  variant?: Variant;
  full?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
};
/** Icon-only buttons (no children) must pass aria-label. */
export function Button({
  variant = 'default',
  full,
  loading,
  icon: Icon,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        'ufi:m-0 ufi:inline-flex ufi:min-h-11 ufi:shrink-0 ufi:select-none ufi:items-center ufi:justify-center ufi:gap-2 ufi:rounded-xl ufi:border ufi:border-solid ufi:bg-none ufi:text-sm ufi:font-medium ufi:leading-normal ufi:no-underline ufi:cursor-pointer ufi:transition ufi:duration-150 ufi:enabled:active:scale-[0.97] ufi:disabled:cursor-not-allowed ufi:disabled:opacity-40 ufi:motion-reduce:transition-none',
        children ? 'ufi:px-4 ufi:py-2.5' : 'ufi:size-11 ufi:p-0',
        variants[variant],
        full && 'ufi:w-full',
        focus,
        className,
      )}
    >
      {loading ? (
        <LoaderCircle
          size={17}
          className="ufi:shrink-0 ufi:animate-spin ufi:motion-reduce:animate-none"
          aria-hidden
        />
      ) : (
        Icon && <Icon size={17} className="ufi:shrink-0" aria-hidden />
      )}
      {children}
    </button>
  );
}

export function ActionButton({
  model,
  action,
  label,
  icon,
  primary,
  variant,
  full = primary,
  onClick,
  extraReason = '',
}: {
  model: GatewayModel;
  action: Operation;
  label: string;
  icon?: LucideIcon;
  /** Main call to action of its context. */
  primary?: boolean;
  variant?: Variant;
  full?: boolean;
  onClick?: () => void;
  extraReason?: string;
}) {
  const reason =
    disabledReason(
      action,
      model.device,
      !!model.busy,
      model.values.subscription,
    ) || extraReason;
  return (
    <Button
      data-action={action}
      data-primary={primary || undefined}
      icon={icon}
      loading={model.busy === action}
      disabled={!!reason}
      title={reason}
      full={full}
      variant={
        variant ||
        (action === 'uninstall' ? 'danger' : primary ? 'primary' : 'default')
      }
      onClick={onClick || (() => void model.perform(action))}
    >
      {label}
    </Button>
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={clsx(
        'ufi:m-0 ufi:block ufi:h-11 ufi:w-full ufi:min-w-0 ufi:rounded-xl ufi:border ufi:border-solid ufi:border-[var(--mh-line)] ufi:bg-none ufi:bg-[var(--mh-fill)] ufi:px-3 ufi:py-2.5 ufi:text-base ufi:font-normal ufi:leading-normal ufi:text-inherit ufi:transition-colors ufi:placeholder:text-[var(--mh-muted)] ufi:focus:border-[var(--mh-accent)] ufi:aria-invalid:border-[#ff6961] ufi:disabled:opacity-40',
        focus,
        className,
      )}
    />
  );
}

export function Switch(props: ComponentProps<typeof Toggle.Root>) {
  return (
    <Toggle.Root
      {...props}
      render={<button type="button" />}
      nativeButton
      className={clsx(
        'ufi:relative ufi:m-0 ufi:h-7 ufi:w-12 ufi:shrink-0 ufi:cursor-pointer ufi:rounded-full ufi:border-0 ufi:bg-none ufi:bg-[var(--mh-fill-strong)] ufi:p-0.5 ufi:transition-colors ufi:data-[checked]:bg-[#30d158] ufi:disabled:cursor-not-allowed ufi:disabled:opacity-40',
        focus,
        props.className,
      )}
    >
      <Toggle.Thumb className="ufi:block ufi:h-6 ufi:w-6 ufi:rounded-full ufi:bg-white ufi:shadow-md ufi:transition-transform ufi:duration-200 ufi:data-[checked]:translate-x-5" />
    </Toggle.Root>
  );
}

/** Segmented control for Base UI Tabs with a sliding selection pill. */
export function Segmented({
  label,
  items,
  className,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
  className?: string;
}) {
  return (
    <Tabs.List
      aria-label={label}
      className={clsx(
        'ufi:relative ufi:z-0 ufi:flex ufi:gap-1 ufi:rounded-xl ufi:bg-[var(--mh-fill)] ufi:p-1',
        className,
      )}
    >
      {items.map(([value, text]) => (
        <Tabs.Tab
          key={value}
          value={value}
          className={`ufi:m-0 ufi:min-h-9 ufi:min-w-0 ufi:flex-1 ufi:cursor-pointer ufi:rounded-lg ufi:border-0 ufi:bg-none ufi:bg-transparent ufi:px-3 ufi:text-sm ufi:font-medium ufi:text-[var(--mh-muted)] ufi:transition-colors ufi:data-[active]:text-[var(--mh-text)] ${focus}`}
        >
          {text}
        </Tabs.Tab>
      ))}
      <Tabs.Indicator className="ufi:absolute ufi:top-(--active-tab-top) ufi:left-(--active-tab-left) ufi:-z-10 ufi:h-(--active-tab-height) ufi:w-(--active-tab-width) ufi:rounded-lg ufi:bg-[var(--mh-fill-strong)] ufi:shadow-sm ufi:transition-all ufi:duration-200 ufi:ease-out ufi:motion-reduce:transition-none" />
    </Tabs.List>
  );
}

/** Grouped list: muted caption above a rounded card with hairline separators. */
export function Section({
  id,
  title,
  aside,
  hidden,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <section data-group={id} hidden={hidden} aria-labelledby={`ufi-${id}-heading`}>
      <div className="ufi:mb-1.5 ufi:flex ufi:min-h-8 ufi:items-end ufi:justify-between ufi:gap-3 ufi:px-4">
        <h3
          id={`ufi-${id}-heading`}
          className={`ufi:m-0 ufi:pb-1 ufi:text-[13px] ufi:font-medium ${muted}`}
        >
          {title}
        </h3>
        {aside}
      </div>
      {/* divide-* compiles to zero-specificity :where(), which the scoped border reset overrides. */}
      <div className={`ufi:overflow-hidden ufi:[&>*+*]:border-t ufi:[&>*+*]:border-[var(--mh-line)] ${card}`}>
        {children}
      </div>
    </section>
  );
}

export function Row({
  label,
  description,
  htmlFor,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className="ufi:flex ufi:min-h-14 ufi:items-center ufi:justify-between ufi:gap-3 ufi:px-4 ufi:py-2.5">
      <div className="ufi:min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="ufi:block">
            {label}
          </label>
        ) : (
          <div>{label}</div>
        )}
        {description && (
          <div className={`ufi:mt-0.5 ufi:text-xs ${muted}`}>{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

export function Hint({
  children,
  error,
  id,
}: {
  children?: ReactNode;
  error?: boolean;
  id?: string;
}) {
  return children ? (
    <p
      id={id}
      className={clsx(
        'ufi:m-0 ufi:mt-2 ufi:text-xs ufi:leading-relaxed',
        error ? 'ufi:text-[#ff6961]' : muted,
      )}
    >
      {children}
    </p>
  ) : null;
}

export function SettingInput({ model }: { model: GatewayModel }) {
  const name = 'interfaces';
  const field = model.form.register(name, {
    validate: (value) => model.validate(name, value),
  });
  const error = model.form.formState.errors[name];
  return (
    <div className="ufi:px-4 ufi:py-3">
      <div className="ufi:mb-2 ufi:flex ufi:min-h-8 ufi:items-center ufi:justify-between ufi:gap-2">
        <label htmlFor={`ufi-${name}`}>共享接口</label>
        {error?.type === 'server' ? (
          <Button onClick={() => model.autosave()}>重试保存</Button>
        ) : (
          <span
            data-save-status={name}
            className={clsx('ufi:text-xs', error ? 'ufi:text-[#ff6961]' : muted)}
          >
            {model.saveStatus()}
          </span>
        )}
      </div>
      <Input
        {...field}
        id={`ufi-${name}`}
        data-setting={name}
        type="text"
        placeholder="自动识别"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-invalid={!!error}
        aria-describedby={`ufi-${name}-help`}
        disabled={
          !!model.busy ||
          !!model.device?.running ||
          model.device?.capabilities.interfaces === false
        }
        onBlur={(event) => {
          void field.onBlur(event);
          model.autosave();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <Hint id={`ufi-${name}-help`} error={!!error}>
        {error?.message ||
          (model.device?.capabilities.interfaces === false
            ? '由系统网络配置管理'
            : model.device?.running
              ? '停止代理后可修改'
              : '留空自动识别；离开输入框即保存')}
      </Hint>
    </div>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  container,
  children,
  closeLabel = '关闭',
  kind,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  container: HTMLElement;
  children: ReactNode;
  closeLabel?: string;
  kind: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Backdrop className="ufi:fixed ufi:inset-0 ufi:z-[2147483640] ufi:bg-black/50 ufi:backdrop-blur-sm ufi:transition-opacity ufi:duration-200 ufi:data-[ending-style]:opacity-0 ufi:data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-dialog={kind}
          data-state={open ? 'open' : 'closed'}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          className="ufi:fixed ufi:left-1/2 ufi:top-1/2 ufi:z-[2147483641] ufi:max-h-[80vh] ufi:w-[calc(100vw-32px)] ufi:max-w-md ufi:-translate-x-1/2 ufi:-translate-y-1/2 ufi:overflow-auto ufi:rounded-3xl ufi:border ufi:border-solid ufi:border-[var(--mh-line)] ufi:bg-[var(--mh-popup)] ufi:p-5 ufi:text-[var(--mh-text)] ufi:shadow-2xl ufi:transition-[opacity,scale] ufi:duration-200 ufi:focus:outline-hidden ufi:data-[ending-style]:scale-95 ufi:data-[ending-style]:opacity-0 ufi:data-[starting-style]:scale-95 ufi:data-[starting-style]:opacity-0"
        >
          <div className="ufi:flex ufi:items-start ufi:justify-between ufi:gap-3">
            <Dialog.Title
              data-dialog-title
              className="ufi:m-0 ufi:pt-2 ufi:text-lg ufi:font-semibold"
            >
              {title}
            </Dialog.Title>
            <Dialog.Close
              render={<Button variant="ghost" aria-label={closeLabel} icon={X} />}
            />
          </div>
          {description && (
            <Dialog.Description className={`ufi:m-0 ufi:mt-2 ufi:text-sm ufi:leading-relaxed ${muted}`}>
              {description}
            </Dialog.Description>
          )}
          <div className="ufi:mt-5">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
