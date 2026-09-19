import { useEffect, useRef, useState } from 'react';
import Anser from 'anser';
import type { GatewayModel } from '../use-gateway';
import { Button, Hint, Input } from './ui';

export function LogPanel({ model }: { model: GatewayModel }) {
  const [live, setLive] = useState(true);
  const [following, setFollowingState] = useState(true);
  const followingRef = useRef(true);
  const setFollowing = (value: boolean) => { followingRef.current = value; setFollowingState(value); };
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);
  const pending = useRef(false);
  const output = useRef<HTMLPreElement>(null);
  const [search, setSearch] = useState('');
  const refresh = useRef(model.refreshDetail);
  refresh.current = model.refreshDetail;
  const source = model.detailTitle;
  const taskID = source === '任务详情' ? model.task?.id : undefined;
  const taskEnded = source === '任务详情' && !!model.task && !['queued', 'running'].includes(model.task.state);
  useEffect(() => {
    setLive(true);
    setError('');
    setFollowing(true);
  }, [source, taskID]);
  useEffect(() => {
    if (!model.detailOpen || !live || !following || !['任务详情', '运行日志'].includes(source)) return;
    let stopped = false;
    const poll = () => {
      if (pending.current || document.hidden || !model.open.current) return;
      pending.current = true;
      void refresh.current(() => !stopped && followingRef.current && !document.hidden && model.open.current).then(() => { if (!stopped) { setError(''); setUpdated(new Date()); } })
        .catch((error) => { if (!stopped) setError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { pending.current = false; });
    };
    poll();
    if (taskEnded) return () => { stopped = true; };
    const timer = setInterval(poll, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [model.detailOpen, live, following, source, taskID, taskEnded]);
  useEffect(() => {
    if (following && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [model.detail, model.detailOpen, following, search]);
  const lines = (model.detail || '暂无记录，可选择当前任务或运行日志。').split('\n').slice(-1000);
  const visible = search ? lines.filter((line) => Anser.ansiToText(line).toLocaleLowerCase().includes(search.toLocaleLowerCase())) : lines;
  return (
    <div data-log-panel className="ufi:mt-4 ufi:rounded-2xl ufi:bg-[var(--mh-group)]">
      <div className="ufi:p-4">
        <div className="ufi:mb-3 ufi:flex ufi:flex-wrap ufi:items-center ufi:gap-2">
          <Button disabled={!model.task} onClick={() => void model.showTask()}>当前任务</Button>
          <Button disabled={!model.device?.agent} onClick={() => void model.showRuntimeLogs()}>运行日志</Button>
          <Button aria-pressed={live} onClick={() => setLive(!live)}>{live ? '暂停刷新' : '继续刷新'}</Button>
          {!following && <Button onClick={() => setFollowing(true)}>跟随最新</Button>}
          {model.task?.cancellable && <Button disabled={model.cancelling || model.task.cancelRequested} onClick={() => void model.cancelTask()}>取消当前任务</Button>}
          <Button aria-label="关闭详情" onClick={() => model.setDetailOpen(false)}>返回</Button>
        </div>
        <div className="ufi:mb-2 ufi:flex ufi:flex-wrap ufi:items-center ufi:justify-between ufi:gap-2 ufi:text-xs ufi:opacity-65">
          <span data-log-source>{source}</span>
          <span data-log-status>{!live || !following ? '已暂停' : ['任务详情', '运行日志'].includes(source) ? taskEnded ? '任务已结束' : '实时跟随 · 约 1 秒刷新' : '操作结果'}{updated && ` · ${updated.toLocaleTimeString()}`} · 最多 1000 行</span>
        </div>
        <Input aria-label="搜索日志" type="search" placeholder="按关键词筛选日志" value={search}
          className="ufi:mb-3" onChange={(event) => setSearch(event.target.value)} />
        {source === '任务详情' && model.task?.error && (
          <p data-log-summary className="ufi:my-2 ufi:whitespace-pre-wrap ufi:break-words ufi:text-xs ufi:text-[#ff6961]">
            {[model.task.error.split('\n')[0], model.task.error.split('\n').find((line) => line.startsWith('清理结果：'))].filter(Boolean).join('\n')}
          </p>
        )}
        <pre ref={output} data-output role="log" tabIndex={0} aria-label={source} aria-live="off"
          className="ufi:m-0 ufi:h-80 ufi:overflow-auto ufi:rounded-xl ufi:bg-black/25 ufi:p-3 ufi:whitespace-pre-wrap ufi:wrap-break-word ufi:select-text ufi:font-mono ufi:text-xs ufi:leading-relaxed"
          onScroll={(event) => { const node = event.currentTarget; setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 24); }}>
          {visible.length ? visible.map((line, index) => <span key={index} data-log-level={logLevel(line)}
            className="ufi:data-[log-level=error]:text-[#ff6961] ufi:data-[log-level=warning]:text-[#ffd60a]">
            {Anser.ansiToJson(line, { remove_empty: true }).map((part, index) => <span key={index}
              style={{ color: part.fg ? `rgb(${part.fg})` : undefined, backgroundColor: part.bg ? `rgb(${part.bg})` : undefined }}
              className={part.decorations.includes('bold') ? 'ufi:font-bold' : undefined}>{part.content}</span>)}{'\n'}
          </span>) : '没有匹配的日志'}
        </pre>
        <Hint error>{error && `日志刷新失败：${error}`}</Hint>
      </div>
    </div>
  );
}

function logLevel(text: string) {
  return /\blevel="?error\b|失败|已被占用/.test(text) ? 'error' : /\blevel="?warn(?:ing)?\b/.test(text) ? 'warning' : undefined;
}
