import { useEffect, useRef, useState, type RefObject } from 'react';
import { readLog } from './transport/ufi';

const sources = ['core', 'supervisor', 'tasks'] as const;
const keep = (text: string) => text.split('\n').slice(-5001).join('\n').slice(-2 * 1024 * 1024);
export function useLogs(enabled: boolean, open: RefObject<boolean>) {
  const [core, setCore] = useState('');
  const [manager, setManager] = useState('');
  const [paused, setPaused] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<typeof sources[number], string>>>({});
  const [updated, setUpdated] = useState<Date | null>(null);
  const cursors = useRef({ core: '', supervisor: '', tasks: '' });
  const pending = useRef(false);
  const record = (text: string) => setManager((old) => keep(`${old}${new Date().toISOString()} [插件] ${text.split('\n')[0]}\n`));
  useEffect(() => {
    if (!enabled || paused) return;
    let stopped = false;
    const poll = async () => {
      if (pending.current || document.hidden || !open.current) return;
      pending.current = true;
      try {
        await Promise.all(sources.map(async (source) => {
          try {
            const chunk = await readLog(source, cursors.current[source]);
            if (stopped) return;
            cursors.current[source] = chunk.cursor;
            const label = source === 'core' ? 'Mihomo' : source === 'supervisor' ? '守护' : '任务';
            const text = (chunk.reset ? `[${label}] 日志文件已轮换，继续读取新文件\n` : '') +
              (chunk.skipped ? `[${label}] 较早或过长的日志已省略\n` : '') + chunk.text;
            if (text) {
              if (source === 'core') setCore((old) => keep(old + text));
              else setManager((old) => keep(old + text.split('\n').filter(Boolean).map((line) => `[${label}] ${line}\n`).join('')));
            }
            setErrors((old) => old[source] ? { ...old, [source]: '' } : old);
            setUpdated(new Date());
          } catch (error) {
            if (!stopped) setErrors((old) => ({ ...old, [source]: error instanceof Error ? error.message : String(error) }));
          }
        }));
      } finally { pending.current = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [enabled, paused, open]);
  return { core, manager, paused, setPaused, updated, record,
    error: Object.values(errors).filter(Boolean).join('\n'),
    clear: (source: 'core' | 'manager') => source === 'core' ? setCore('') : setManager(''),
  };
}
