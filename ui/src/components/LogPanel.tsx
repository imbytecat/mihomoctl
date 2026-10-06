import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tabs } from '@base-ui/react/tabs';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import Anser from 'anser';
import { clsx } from 'clsx';
import {
  ArrowDown,
  Download,
  Eraser,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react';
import type { GatewayModel } from '../use-gateway';
import { Button, Hint, Input, Segmented, card, muted } from './ui';

const labels = { core: 'Mihomo', manager: '管理器', details: '详情' } as const;
type Source = keyof typeof labels;
type Level = 'error' | 'warning' | 'info' | 'debug';
type Line = {
  raw: string;
  text: string;
  level?: Level;
  /** Present when the line is logfmt (Mihomo/logrus and Go slog both write it). */
  entry?: { tag: string; time: string; msg: string; extra: string };
};

const fields = /([\w.-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
const levels: Record<string, Level> = {
  error: 'error', err: 'error', fatal: 'error', panic: 'error',
  warn: 'warning', warning: 'warning',
  info: 'info', debug: 'debug', trace: 'debug',
};

function parse(raw: string): Line {
  const text = Anser.ansiToText(raw);
  const [, tag = '', body = text] = /^(?:\[([^\]]+)\] )?(.*)$/s.exec(text)!;
  if (/(?:^|\s)(?:level|msg)=/.test(body)) {
    const values: Record<string, string> = {};
    const extra: string[] = [];
    for (const [pair, key, value] of body.matchAll(fields)) {
      let unquoted = value!;
      if (unquoted.startsWith('"'))
        try { unquoted = JSON.parse(unquoted); } catch { unquoted = unquoted.slice(1, -1); }
      if (['time', 'level', 'msg'].includes(key!)) values[key!] = unquoted;
      else extra.push(pair);
    }
    return {
      raw, text,
      level: levels[values.level?.toLowerCase() ?? ''],
      entry: {
        tag,
        time: /\d\d:\d\d:\d\d/.exec(values.time ?? '')?.[0] ?? '',
        msg: values.msg ?? '',
        extra: extra.join(' '),
      },
    };
  }
  return {
    raw, text,
    level: /\berror\b|失败|已被占用/i.test(text) ? 'error' : /\bwarn(?:ing)?\b/i.test(text) ? 'warning' : undefined,
  };
}

/** `portal` hosts the fullscreen viewer outside the plugin's containment and backdrop filter. */
export function LogPanel({ model, portal }: { model: GatewayModel; portal: HTMLElement }) {
  const { logs, logSource: source } = model;
  const refresh = useRef(model.refreshDetail);
  const [detailError, setDetailError] = useState('');
  const [search, setSearch] = useState('');
  const [problems, setProblems] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
  useEffect(() => {
    if (!model.detailOpen) setExpanded(false);
    if (!expanded) return;
    const exit = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    addEventListener('keydown', exit);
    return () => removeEventListener('keydown', exit);
  }, [expanded, model.detailOpen]);
  const texts: Record<Source, string> = { core: logs.core, manager: logs.manager, details: model.detail };
  const download = () => {
    const url = URL.createObjectURL(new Blob([texts[source]], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mihomoctl-${source}.log`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const live = !logs.paused && !!model.device?.agent;
  const panel = (
    <div
      data-log-panel
      data-expanded={expanded || undefined}
      className={clsx(
        'ufi:p-3',
        expanded
          ? 'ufi:fixed ufi:inset-0 ufi:z-[2147483630] ufi:flex ufi:flex-col ufi:bg-[var(--mh-popup)] ufi:pt-[max(0.75rem,env(safe-area-inset-top))] ufi:pb-[max(0.75rem,env(safe-area-inset-bottom))]'
          : card,
      )}
    >
      <Tabs.Root
        value={source}
        className={expanded ? 'ufi:flex ufi:min-h-0 ufi:flex-1 ufi:flex-col' : undefined}
        onValueChange={(value: Source) => {
          // Choosing the tab means "latest task"; keep diagnostics and failed-operation evidence in place.
          if (value === 'details' && model.task && !model.error && model.detailTitle !== '网络诊断')
            void model.showTask();
          else model.setLogSource(value);
        }}
      >
        <Segmented label="日志来源" items={Object.entries(labels)} />
        <div className="ufi:my-3 ufi:flex ufi:gap-2">
          <Input
            type="search"
            aria-label="搜索日志"
            placeholder="搜索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="ufi:flex-1"
          />
          <Button
            variant={problems ? 'primary' : 'default'}
            icon={TriangleAlert}
            aria-label="只看警告和错误"
            title="只看警告和错误"
            aria-pressed={problems}
            onClick={() => setProblems(!problems)}
          />
          <Button
            icon={logs.paused ? Play : Pause}
            aria-label={logs.paused ? '继续收集' : '暂停收集'}
            title={logs.paused ? '继续收集' : '暂停收集'}
            aria-pressed={logs.paused}
            onClick={() => logs.setPaused(!logs.paused)}
          />
        </div>
        {source === 'details' && model.task?.error && (
          <p data-log-summary className="ufi:m-0 ufi:mb-2 ufi:whitespace-pre-wrap ufi:break-words ufi:text-xs ufi:text-[#ff6961]">
            {[model.task.error.split('\n')[0], model.task.error.split('\n').find((line) => line.startsWith('清理结果：'))].filter(Boolean).join('\n')}
          </p>
        )}
        {(Object.keys(labels) as Source[]).map((value) => (
          <Tabs.Panel
            key={value}
            value={value}
            keepMounted
            className={clsx(expanded && 'ufi:flex ufi:min-h-0 ufi:flex-1 ufi:flex-col', 'ufi:data-[hidden]:hidden')}
          >
            <LogView
              text={texts[value]}
              active={source === value}
              label={value === 'details' ? model.detailTitle : labels[value]}
              search={search}
              problems={problems}
              expanded={expanded}
              empty={value === 'details' ? '暂无详情；可运行网络诊断' : '暂无日志'}
            />
          </Tabs.Panel>
        ))}
        <div className={`ufi:mt-1 ufi:flex ufi:items-center ufi:gap-1 ufi:text-xs ${muted}`}>
          <span aria-hidden className="ufi:relative ufi:mr-1 ufi:flex ufi:size-1.5 ufi:shrink-0">
            {live && <span className="ufi:absolute ufi:inset-0 ufi:animate-ping ufi:rounded-full ufi:bg-[#30d158] ufi:motion-reduce:hidden" />}
            <span className={clsx('ufi:relative ufi:size-1.5 ufi:rounded-full', live ? 'ufi:bg-[#30d158]' : 'ufi:bg-[var(--mh-muted)]')} />
          </span>
          <span className="ufi:min-w-0 ufi:flex-1 ufi:truncate">
            <span data-log-source>{source === 'details' ? model.detailTitle : labels[source]}</span>
            {' · '}
            <span data-log-status>
              {logs.paused ? '已暂停收集' : !model.device?.agent ? '等待设备连接' : '实时'}
              {logs.updated && ` · ${logs.updated.toLocaleTimeString()}`}
            </span>
          </span>
          {source === 'details' ? (
            <Button
              variant="ghost"
              icon={Stethoscope}
              aria-label="网络诊断"
              title="网络诊断"
              loading={model.busy === 'diagnose'}
              disabled={!!model.busy || !model.device?.agent}
              onClick={() => void model.perform('diagnose')}
            />
          ) : (
            <Button
              variant="ghost"
              icon={Eraser}
              aria-label="清空显示"
              title="清空显示（不删除设备日志）"
              disabled={!texts[source]}
              onClick={() => logs.clear(source)}
            />
          )}
          <Button
            variant="ghost"
            icon={Download}
            aria-label="下载日志"
            title="下载日志"
            disabled={!texts[source]}
            onClick={download}
          />
          <Button
            variant="ghost"
            icon={expanded ? Minimize2 : Maximize2}
            aria-label={expanded ? '退出全屏' : '全屏查看'}
            title={expanded ? '退出全屏' : '全屏查看'}
            className="ufi:-mr-1.5"
            onClick={() => setExpanded(!expanded)}
          />
        </div>
        <Hint error>{logs.error && `日志读取失败：${logs.error}`}</Hint>
        <Hint error>{source === 'details' && detailError && `任务详情读取失败：${detailError}`}</Hint>
      </Tabs.Root>
    </div>
  );
  // Switching parents remounts the viewer; search, filter and collection state live above it.
  return expanded ? createPortal(panel, portal) : panel;
}

// The viewer is a fixed dark terminal regardless of the host theme so ANSI colors stay legible.
const dim = 'ufi:text-white/45';
const levelStyle: Record<Level, string> = {
  error: 'ufi:text-[#ff6961]',
  warning: 'ufi:text-[#ffd60a]',
  info: 'ufi:text-[#64d2ff]',
  debug: dim,
};

function LogView({ text, active, label, search, problems, expanded, empty }: {
  text: string;
  active: boolean;
  label: string;
  search: string;
  problems: boolean;
  expanded: boolean;
  empty: string;
}) {
  const viewer = useRef<VirtuosoHandle>(null);
  const [following, setFollowing] = useState(true);
  const lines = useMemo(() => (text ? text.replace(/\n$/, '').split('\n').map(parse) : []), [text]);
  const query = search.toLocaleLowerCase();
  const visible = lines.filter((line) =>
    (!problems || line.level === 'error' || line.level === 'warning') &&
    (!query || line.text.toLocaleLowerCase().includes(query)));
  return (
    <div
      data-output={active || undefined}
      role="log"
      aria-label={label}
      aria-live="off"
      className={clsx(
        'ufi:relative ufi:min-w-0 ufi:overflow-hidden ufi:rounded-xl ufi:bg-[#0b0c10]/90 ufi:py-1 ufi:font-mono ufi:text-xs ufi:leading-5 ufi:text-[#e5e5ea] ufi:select-text',
        expanded ? 'ufi:min-h-0 ufi:flex-1' : 'ufi:h-96',
      )}
    >
      {visible.length ? (
        <Virtuoso
          ref={viewer}
          data={visible}
          followOutput="auto"
          atBottomStateChange={setFollowing}
          atBottomThreshold={24}
          initialTopMostItemIndex={visible.length - 1}
          increaseViewportBy={150}
          itemContent={(_, line) => (
            <div className="ufi:flex ufi:gap-2 ufi:px-3 ufi:py-px ufi:hover:bg-white/5">
              {line.entry ? (
                <>
                  <span className={`ufi:w-[8ch] ufi:shrink-0 ufi:tabular-nums ${dim}`}>{line.entry.time}</span>
                  <span className={clsx('ufi:w-[5ch] ufi:shrink-0 ufi:uppercase', line.level && levelStyle[line.level])}>
                    {line.level === 'warning' ? 'warn' : line.level}
                  </span>
                  <span
                    data-log-level={line.level === 'error' || line.level === 'warning' ? line.level : undefined}
                    className={clsx('ufi:min-w-0 ufi:flex-1 ufi:whitespace-pre-wrap ufi:wrap-anywhere', line.level === 'error' && levelStyle.error)}
                  >
                    {line.entry.tag && <span className={dim}>[{line.entry.tag}] </span>}
                    {line.entry.msg}
                    {line.entry.extra && <span className={dim}> {line.entry.extra}</span>}
                  </span>
                </>
              ) : (
                <span
                  data-log-level={line.level}
                  className={clsx('ufi:min-w-0 ufi:flex-1 ufi:whitespace-pre-wrap ufi:wrap-anywhere', line.level && line.level !== 'info' && levelStyle[line.level])}
                >
                  {Anser.ansiToJson(line.raw, { remove_empty: true }).map((part, index) => (
                    <span
                      key={index}
                      style={{ color: part.fg ? `rgb(${part.fg})` : undefined, backgroundColor: part.bg ? `rgb(${part.bg})` : undefined }}
                      className={part.decorations.includes('bold') ? 'ufi:font-bold' : undefined}
                    >
                      {part.content}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        />
      ) : (
        <p className={`ufi:m-0 ufi:p-4 ufi:font-sans ufi:text-sm ${dim}`}>
          {search || problems ? '没有匹配的日志' : empty}
        </p>
      )}
      {!following && visible.length > 0 && (
        <Button
          variant="primary"
          icon={ArrowDown}
          className="ufi:absolute ufi:bottom-3 ufi:left-1/2 ufi:-translate-x-1/2 ufi:font-sans ufi:shadow-lg"
          onClick={() => viewer.current?.scrollToIndex({ index: 'LAST', align: 'end' })}
        >
          跟随最新
        </Button>
      )}
    </div>
  );
}
