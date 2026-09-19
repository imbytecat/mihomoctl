import { useRef, useState } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { createPortal } from 'react-dom';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { Toaster } from 'sonner';
import { useGateway } from './use-gateway';
import { topTask } from './state';
import { Overview, runtimeTitle, stageOf } from './components/Overview';
import { Settings } from './components/Settings';
import { Subscription } from './components/Subscription';
import { TaskNotice } from './components/TaskNotice';
import { LogPanel } from './components/LogPanel';
import { Button, Input, Modal, focus } from './components/ui';

export default function Gateway({ container }: { container: HTMLElement }) {
  const model = useGateway();
  const [tab, setTab] = useState('overview');
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const subscription = useRef<HTMLDivElement>(null);
  const setup = ['unknown', 'agent', 'service', 'core'].includes(
    stageOf(model),
  );

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
      <details
        data-plugin
        className="ufi:group/plugin ufi:overflow-hidden ufi:rounded-[22px] ufi:border ufi:border-solid ufi:border-[var(--mh-line)] ufi:bg-[var(--mh-bg)] ufi:text-[var(--mh-text)]"
        onToggle={(event) => {
          if (event.target === event.currentTarget)
            model.open.current = event.currentTarget.open;
        }}
      >
        <summary
          className={`ufi:flex ufi:list-none ufi:items-center ufi:gap-3 ufi:px-5 ufi:py-4 ufi:cursor-pointer ufi:[&::-webkit-details-marker]:hidden ${focus}`}
        >
          <ShieldCheck size={22} className="ufi:text-[#0a84ff]" aria-hidden />
          <strong className="ufi:text-base ufi:font-semibold">Mihomo</strong>
          <span className="ufi:ml-auto ufi:text-xs ufi:opacity-65">
            {runtimeTitle(model)}
          </span>
          <ChevronDown
            size={17}
            className="ufi:group-open/plugin:rotate-180"
            aria-hidden
          />
        </summary>
        <div
          data-gateway-body
          aria-busy={!!model.busy}
          className="ufi:px-4 ufi:pb-4"
        >
          <Overview
            model={model}
            container={container}
            confirmUninstall={() => setUninstallOpen(true)}
            addSubscription={() => {
              setTab('overview');
              model.setDetailOpen(false);
              requestAnimationFrame(() => {
                subscription.current?.scrollIntoView({
                  block: 'center',
                  behavior: 'smooth',
                });
                model.form.setFocus('subscription');
              });
            }}
          />
          {model.error ? (
            <div className="ufi:mt-3">
              <Button
                full
                variant="danger"
                onClick={() => { model.setLogSource('details'); model.setDetailOpen(true); }}
              >
                查看错误详情
              </Button>
            </div>
          ) : (
            topTask(model.task) &&
            model.task && (
              <TaskNotice model={model} job={model.task} />
            )
          )}
          <Tabs.Root value={model.detailOpen ? 'logs' : tab} onValueChange={(value) => {
            if (value === 'logs') {
              model.setDetailOpen(true);
            }
            else { setTab(String(value)); model.setDetailOpen(false); }
          }} className="ufi:mt-4">
            <Tabs.List aria-label="Mihomo 功能" className="ufi:flex ufi:gap-1 ufi:rounded-xl ufi:bg-[var(--mh-group)] ufi:p-1">
              {([['overview', '概览'], ['settings', '设置'], ['logs', '日志']] as const).map(([value, label]) => (
                <Tabs.Tab key={value} value={value} className={`ufi:m-0 ufi:min-h-11 ufi:min-w-0 ufi:flex-1 ufi:rounded-lg ufi:border-0 ufi:bg-none ufi:bg-transparent ufi:px-3 ufi:text-sm ufi:font-medium ufi:text-[var(--mh-text)] ufi:cursor-pointer ufi:data-[active]:bg-[#0a84ff] ufi:data-[active]:text-white ${focus}`}>
                  {label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel value="overview" keepMounted className="ufi:data-[hidden]:hidden">
              <Subscription model={model} anchor={subscription} />
            </Tabs.Panel>
            <Tabs.Panel value="settings" keepMounted className="ufi:data-[hidden]:hidden">
              <Settings model={model} setup={setup} confirmUninstall={() => setUninstallOpen(true)} />
            </Tabs.Panel>
            <Tabs.Panel value="logs" keepMounted className="ufi:data-[hidden]:hidden">
              <LogPanel model={model} />
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
        <div className="ufi:flex ufi:justify-end ufi:gap-3">
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
      <Modal
        container={container}
        kind="secret"
        open={!!model.secret}
        onOpenChange={(open) => {
          if (!open) model.setSecret('');
        }}
        title="API 密钥"
        description="首次连接面板时填写。选中文本即可复制。"
        closeLabel="关闭密钥"
      >
        <Input
          type="text"
          aria-label="当前 API 密钥"
          readOnly
          value={model.secret}
          onFocus={(event) => event.currentTarget.select()}
        />
      </Modal>
    </>
  );
}
