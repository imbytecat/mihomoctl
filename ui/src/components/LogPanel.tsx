import { useEffect, useRef, useState } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import Anser from 'anser';
import type { GatewayModel } from '../use-gateway';
import { Button, Hint, Input, focus } from './ui';

const labels = { core: 'Mihomo', manager: '管理器', details: '任务 / 详情' } as const;
export function LogPanel({ model }: { model: GatewayModel }) {
  const { logs, logSource: source } = model;
  const refresh = useRef(model.refreshDetail);
  const [detailError, setDetailError] = useState('');
  refresh.current = model.refreshDetail;
  const taskEnded = !!model.task && !['queued', 'running'].includes(model.task.state);
  useEffect(() => {
    if (!model.detailOpen || source !== 'details' || logs.paused || model.detailTitle !== '任务详情') return;
    let stopped = false, pending = false;
    const poll = async () => {
      if (pending || document.hidden || !model.open.current) return;
      pending = true;
      try { await refresh.current(() => !stopped); if (!stopped) setDetailError(''); }
      catch (error) { if (!stopped) setDetailError(error instanceof Error ? error.message : String(error)); }
      finally { pending = false; }
    };
    void poll();
    const timer = taskEnded ? undefined : setInterval(() => void poll(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [model.detailOpen, source, logs.paused, model.detailTitle, model.task?.id, taskEnded]);
  const text = source === 'core' ? logs.core : source === 'manager' ? logs.manager : model.detail;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mihomoctl-${source}.log`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div data-log-panel className="ufi:mt-4 ufi:rounded-2xl ufi:bg-[var(--mh-group)] ufi:p-4">
      <Tabs.Root value={source} onValueChange={(value) => model.setLogSource(value as typeof source)}>
        <Tabs.List aria-label="日志来源" className="ufi:mb-3 ufi:flex ufi:gap-1">
          {(Object.entries(labels) as [typeof source, string][]).map(([value, label]) => (
            <Tabs.Tab key={value} value={value} className={`ufi:m-0 ufi:min-h-11 ufi:min-w-0 ufi:flex-1 ufi:rounded-lg ufi:border-0 ufi:bg-transparent ufi:px-2 ufi:text-sm ufi:text-inherit ufi:cursor-pointer ufi:data-[active]:bg-white/10 ${focus}`}>{label}</Tabs.Tab>
          ))}
        </Tabs.List>
        <div className="ufi:mb-3 ufi:flex ufi:flex-wrap ufi:items-center ufi:gap-2">
          <Button aria-pressed={logs.paused} onClick={() => logs.setPaused(!logs.paused)}>{logs.paused ? '继续收集' : '暂停收集'}</Button>
          <Button disabled={!text} onClick={download}>下载日志</Button>
          {source !== 'details' && <Button disabled={!text} onClick={() => logs.clear(source)}>清空显示</Button>}
          {model.task?.cancellable && <Button disabled={model.cancelling || model.task.cancelRequested} onClick={() => void model.cancelTask()}>取消当前任务</Button>}
          <Button aria-label="关闭详情" onClick={() => model.setDetailOpen(false)}>返回</Button>
        </div>
        <div className="ufi:mb-2 ufi:flex ufi:flex-wrap ufi:justify-between ufi:gap-2 ufi:text-xs ufi:opacity-65">
          <span data-log-source>{source === 'details' ? model.detailTitle : labels[source]}</span>
          <span data-log-status>{logs.paused ? '已暂停收集' : !model.device?.agent ? '等待设备连接' : '自动收集 · 约 2 秒刷新'}{logs.updated && ` · ${logs.updated.toLocaleTimeString()}`}</span>
        </div>
        {model.task?.error && <p data-log-summary className="ufi:my-2 ufi:whitespace-pre-wrap ufi:break-words ufi:text-xs ufi:text-[#ff6961]">
          {[model.task.error.split('\n')[0], model.task.error.split('\n').find((line) => line.startsWith('清理结果：'))].filter(Boolean).join('\n')}
        </p>}
        {(['core', 'manager', 'details'] as const).map((value) => (
          <Tabs.Panel key={value} value={value} keepMounted className="ufi:data-[hidden]:hidden">
            <LogView text={value === 'core' ? logs.core : value === 'manager' ? logs.manager : model.detail}
              active={source === value} label={value === 'details' ? model.detailTitle : labels[value]} />
          </Tabs.Panel>
        ))}
        <Hint>上翻只停止滚动跟随，新日志仍会收集。当前页面每类保留最近 5000 行；切换页面标签不会清空。清空显示不删除设备日志。</Hint>
        <Hint error>{logs.error && `日志读取失败：${logs.error}`}</Hint>
        <Hint error>{source === 'details' && detailError && `任务详情读取失败：${detailError}`}</Hint>
      </Tabs.Root>
    </div>
  );
}

function LogView({ text, active, label }: { text: string; active: boolean; label: string }) {
  const viewer = useRef<VirtuosoHandle>(null);
  const [following, setFollowing] = useState(true);
  const [search, setSearch] = useState('');
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  const visible = search ? lines.filter((line) => Anser.ansiToText(line).toLocaleLowerCase().includes(search.toLocaleLowerCase())) : lines;
  return <div data-output={active || undefined} role="log" aria-label={label} aria-live="off" className="ufi:flex ufi:h-96 ufi:min-w-0 ufi:flex-col ufi:gap-2">
    <div className="ufi:flex ufi:items-center ufi:gap-2">
      <Input type="search" aria-label="搜索日志" placeholder="搜索日志" value={search} onChange={(event) => setSearch(event.target.value)} className="ufi:min-w-0 ufi:flex-1" />
      <span className="ufi:shrink-0 ufi:text-xs ufi:opacity-65">{visible.length} 行</span>
    </div>
    {!following && <Button onClick={() => viewer.current?.scrollToIndex({ index: 'LAST', align: 'end' })}>跟随最新</Button>}
    <div className="ufi:min-h-0 ufi:flex-1 ufi:overflow-hidden ufi:rounded-xl ufi:bg-black/25 ufi:font-mono ufi:text-xs ufi:leading-relaxed ufi:select-text">
      {visible.length ? <Virtuoso ref={viewer} data={visible} followOutput="auto" atBottomStateChange={setFollowing} atBottomThreshold={24}
        initialTopMostItemIndex={visible.length - 1} increaseViewportBy={150}
        itemContent={(index, line) => <div className="ufi:flex ufi:gap-3 ufi:px-3 ufi:py-0.5">
          <span aria-hidden className="ufi:w-9 ufi:shrink-0 ufi:text-right ufi:opacity-35">{index + 1}</span>
          <span data-log-level={/\blevel="?error\b|失败|已被占用/i.test(line) ? 'error' : /\blevel="?warn(?:ing)?\b/i.test(line) ? 'warning' : undefined}
            className="ufi:min-w-0 ufi:flex-1 ufi:whitespace-pre-wrap ufi:wrap-anywhere ufi:data-[log-level=error]:text-[#ff6961] ufi:data-[log-level=warning]:text-[#ffd60a]">
            {Anser.ansiToJson(line, { remove_empty: true }).map((part, partIndex) => <span key={partIndex}
              style={{ color: part.fg ? `rgb(${part.fg})` : undefined, backgroundColor: part.bg ? `rgb(${part.bg})` : undefined }}
              className={part.decorations.includes('bold') ? 'ufi:font-bold' : undefined}>{part.content}</span>)}
          </span>
        </div>} /> : <p className="ufi:p-3 ufi:opacity-60">{search ? '没有匹配的日志' : '暂无日志'}</p>}
    </div>
  </div>;
}
