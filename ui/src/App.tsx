import { useRef, useState } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Toaster } from 'sonner';
import { useGateway } from './use-gateway';
import { Overview, StatusDot, runtimeTitle } from './components/Overview';
import { Settings } from './components/Settings';
import { Config } from './components/Config';
import { LogPanel } from './components/LogPanel';
import { Button, Modal, Segmented, focus, muted } from './components/ui';

const tabs = [
  ['config', '配置'],
  ['settings', '设置'],
  ['logs', '日志'],
] as const;
const openKey = 'mihomoctl-open';

export default function Gateway({ container }: { container: HTMLElement }) {
  const model = useGateway();
  const [initiallyOpen] = useState(() => {
    // Remember whether the user left the plugin expanded; polling only runs while open.
    const value = localStorage.getItem(openKey) === '1';
    model.open.current = value;
    return value;
  });
  const [tab, setTab] = useState('config');
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const subscription = useRef<HTMLDivElement>(null);
  const show = (value: string, target: () => void) => {
    setTab(value);
    model.setDetailOpen(false);
    requestAnimationFrame(target);
  };

  return (
    <>
      {createPortal(
        <Toaster
          id="mihomoctl"
          position="top-center"
          theme="dark"
          richColors
          closeButton
          containerAriaLabel="操作通知"
          toastOptions={{ closeButtonAriaLabel: '关闭提示' }}
        />,
        container,
      )}
      {/* Container query: layout follows the plugin's own width, not the viewport. Containment and
          backdrop-filter trap fixed descendants, so the fullscreen log viewer portals out. */}
      <details
        data-plugin
        open={initiallyOpen}
        className="ufi:group/plugin ufi:@container ufi:rounded-[22px] ufi:border ufi:border-solid ufi:border-[var(--mh-line)] ufi:bg-[var(--mh-bg)] ufi:text-[var(--mh-text)] ufi:shadow-lg ufi:backdrop-blur-(--mh-blur)"
        onToggle={(event) => {
          if (event.target !== event.currentTarget) return;
          model.open.current = event.currentTarget.open;
          localStorage.setItem(openKey, event.currentTarget.open ? '1' : '0');
        }}
      >
        <summary
          className={`ufi:flex ufi:min-h-14 ufi:cursor-pointer ufi:list-none ufi:items-center ufi:gap-3 ufi:rounded-[22px] ufi:px-5 ufi:select-none ufi:[&::-webkit-details-marker]:hidden ${focus}`}
        >
          <StatusDot model={model} />
          <strong className="ufi:text-base ufi:font-semibold">Mihomo</strong>
          <span className={`ufi:ml-auto ufi:text-sm ufi:transition-opacity ufi:group-open/plugin:opacity-0 ${muted}`}>
            {runtimeTitle(model)}
          </span>
          <ChevronDown
            size={18}
            className={`ufi:shrink-0 ufi:transition-transform ufi:duration-200 ufi:group-open/plugin:rotate-180 ${muted}`}
            aria-hidden
          />
        </summary>
        <div
          data-gateway-body
          aria-busy={!!model.busy}
          className="ufi:flex ufi:flex-col ufi:gap-4 ufi:px-3 ufi:pb-3 ufi:@sm:px-4 ufi:@sm:pb-4 ufi:@4xl:grid ufi:@4xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] ufi:@4xl:items-start ufi:@4xl:gap-5"
        >
          <div className="ufi:@4xl:sticky ufi:@4xl:top-4">
            <Overview
              model={model}
              confirmUninstall={() => setUninstallOpen(true)}
              openSettings={() =>
                show('settings', () => document.getElementById('ufi-release-proxy')?.focus())
              }
              addSubscription={() =>
                show('config', () => {
                  subscription.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  model.form.setFocus('subscription');
                })
              }
            />
          </div>
          <Tabs.Root
            value={model.detailOpen ? 'logs' : tab}
            onValueChange={(value) => {
              if (value === 'logs') model.setDetailOpen(true);
              else {
                setTab(String(value));
                model.setDetailOpen(false);
              }
            }}
          >
            <Segmented label="Mihomo 功能" items={tabs} className="ufi:mb-4" />
            <Tabs.Panel value="config" keepMounted className="ufi:data-[hidden]:hidden">
              <Config model={model} anchor={subscription} />
            </Tabs.Panel>
            <Tabs.Panel value="settings" keepMounted className="ufi:data-[hidden]:hidden">
              <Settings model={model} confirmUninstall={() => setUninstallOpen(true)} />
            </Tabs.Panel>
            <Tabs.Panel value="logs" keepMounted className="ufi:data-[hidden]:hidden">
              <LogPanel model={model} portal={container} />
            </Tabs.Panel>
          </Tabs.Root>
        </div>
      </details>
      <Modal
        container={container}
        kind="uninstall"
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        title="卸载 Mihomo 服务？"
        description="停止代理并关闭开机启动，删除本安装的 mihomoctl、内核和全部数据，不可恢复。"
        closeLabel="取消卸载"
      >
        <div className="ufi:flex ufi:justify-end ufi:gap-2">
          <Button data-uninstall-cancel onClick={() => setUninstallOpen(false)}>
            取消
          </Button>
          <Button
            data-uninstall-confirm
            variant="danger"
            onClick={() => {
              setUninstallOpen(false);
              void model.perform('uninstall');
            }}
          >
            卸载并删除数据
          </Button>
        </div>
      </Modal>
    </>
  );
}
