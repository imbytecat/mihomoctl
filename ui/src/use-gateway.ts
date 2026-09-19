import { waitTask, describeTask, taskDetails, TaskCancelled, TaskFailed } from './gateway';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import PQueue from 'p-queue';
import { toast } from 'sonner';
import { subscriptionURL, interfaces, releaseProxy } from './config';
import {
  bootstrapAgent,
  uninstallAgent,
  cancelDeviceTask,
  checkUpdates,
  deviceLogs,
  readDeviceState,
  submitTask,
  readControllerSecret,
  stopAgent,
} from './transport/ufi';
import {
  disabledReason,
  installationTask,
  type Action,
  type DeviceState,
  type DeviceJob,
} from './state';

type Fields = {
  releaseProxy: string;
  subscription: string;
  interfaces: string;
  controlEnabled: boolean;
  controlPort: string;
  controlSecret: string;
  resetSecret: boolean;
};
export type Operation = Exclude<Action, 'save-interfaces' | 'open-dashboard'>;
const defaults: Fields = {
  releaseProxy: '',
  subscription: '',
  interfaces: '',
  controlEnabled: true,
  controlPort: '9090',
  controlSecret: '',
  resetSecret: false,
};
const notification = {
  id: 'mihomoctl-operation',
  toasterId: 'mihomoctl',
};

export function useGateway() {
  const form = useForm<Fields>({
    defaultValues: defaults,
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });
  const values = useWatch({ control: form.control }) as Fields;
  const [queue] = useState(() => new PQueue({ concurrency: 1 }));
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [stateError, setStateError] = useState('');
  const [observedTask, setObservedTask] = useState<DeviceJob | null>(null);
  const deviceRef = useRef<DeviceState | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelPending = useRef(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const busyRef = useRef(false);
  const pendingSaves = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const savedRef = useRef(saved);
  const loaded = useRef(false);
  const open = useRef(false);
  const [detail, setDetail] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTitle, setDetailTitle] = useState('操作详情');
  const detailTitleRef = useRef(detailTitle);
  detailTitleRef.current = detailTitle;
  const [secret, setSecret] = useState('');
  const [error, setError] = useState(false);
  const detailRequest = useRef(0);
  const followedTask = useRef('');
  const followStartup = (task: DeviceJob | null) => {
    if (!task || !['start', 'restart'].includes(task.action) || !['queued', 'running'].includes(task.state) || followedTask.current === task.id) return;
    followedTask.current = task.id;
    detailRequest.current++;
    setDetailTitle('任务详情');
    setDetail(describeTask(task));
    setDetailOpen(true);
  };
  const observe = (task: DeviceJob) => {
    if (deviceRef.current) {
      const state = {
        ...deviceRef.current,
        task,
        locked: ['queued', 'running'].includes(task.state),
      };
      deviceRef.current = state;
      setDevice(state);
    } else setObservedTask(task);
    followStartup(task);
  };

  const readState = async () => {
    try {
      const state = await readDeviceState();
      setStateError('');
      setObservedTask(null);
      if (!state.service && loaded.current) {
        loaded.current = false;
        savedRef.current = null;
        setSaved(savedRef.current);
      }
      deviceRef.current = state;
      setDevice(state);
      followStartup(state.task);
      return state;
    } catch (error) {
      setStateError(error instanceof Error ? error.message : String(error));
      deviceRef.current = null;
      setDevice(null);
      throw error;
    }
  };
  const refresh = async () => {
    const state = await readState();
    if (state.agent && !form.getFieldState('releaseProxy').isDirty)
      form.resetField('releaseProxy', { defaultValue: state.settings.releaseProxy });
    if (state.service) {
      try {
        const value = interfaces(state.settings.interfaces.join(' '));
        let current: string | null = null;
        try {
          current = interfaces(form.getValues('interfaces'));
        } catch {}
        const replace =
          !form.getFieldState('interfaces').isDirty ||
          current === savedRef.current ||
          current === value;
        savedRef.current = value;
        if (replace)
          form.resetField('interfaces', {
            defaultValue: value === 'auto' ? '' : value,
          });
        setSaved(value);
        loaded.current = true;
        if (state.controller) {
          if (!form.getFieldState('controlEnabled').isDirty)
            form.resetField('controlEnabled', {
              defaultValue: state.controller.enabled,
            });
          if (!form.getFieldState('controlPort').isDirty)
            form.resetField('controlPort', {
              defaultValue: String(state.controller.port),
            });
        }
      } catch (error) {
        deviceRef.current = null;
        setDevice(null);
        throw error;
      }
    }
    return state;
  };

  const cancelTask = async () => {
    const task = deviceRef.current?.task;
    if (!task || !task.cancellable || task.cancelRequested || cancelPending.current) return;
    cancelPending.current = true;
    setCancelling(true);
    try {
      observe(await cancelDeviceTask(task));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), { toasterId: 'mihomoctl' });
    } finally {
      cancelPending.current = false;
      setCancelling(false);
    }
  };

  const showTask = async () => {
    const task = deviceRef.current?.task || observedTask;
    if (!task) return;
    const revision = ++detailRequest.current;
    setDetailTitle('任务详情');
    setDetail(describeTask(task));
    setDetailOpen(true);
    try {
      const text = await taskDetails(task);
      if (revision === detailRequest.current)
        setDetail(text);
    } catch {
      if (revision === detailRequest.current)
        setDetail((value) => value + '\n\n暂时无法读取任务日志');
    }
  };

  const refreshDetail = async (accept = () => true) => {
    const revision = detailRequest.current;
    const task = deviceRef.current?.task || observedTask;
    const text = detailTitle === '任务详情' && task ? await taskDetails(task)
      : detailTitle === '运行日志' ? await deviceLogs() : null;
    if (text !== null && revision === detailRequest.current && accept()) setDetail(text);
  };

  const showRuntimeLogs = async () => {
    const revision = ++detailRequest.current;
    setDetailTitle('运行日志');
    setDetail('正在读取运行日志…');
    setDetailOpen(true);
    try {
      const text = await deviceLogs();
      if (revision === detailRequest.current) setDetail(text || '暂无运行日志');
    } catch (error) {
      if (revision === detailRequest.current) setDetail(error instanceof Error ? error.message : String(error));
    }
  };

  function dirty() {
    try {
      return interfaces(form.getValues('interfaces')) !== savedRef.current;
    } catch {
      return true;
    }
  }

  // Called inside the queue. A completed save must not overwrite newer typing.
  const persist = async (snapshot: string) => {
    const name = 'interfaces';
    let value: string;
    try {
      value = interfaces(snapshot);
    } catch (error) {
      form.setError(name, {
        type: 'validate',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (value === savedRef.current) return;
    const state = await readState();
    const reason = disabledReason('save-interfaces', state);
    if (reason) throw new Error(reason);
    setSaving(true);
    try {
      await waitTask(
        await submitTask('save-interfaces', { interfaces: value }),
        () => {},
      );
      savedRef.current = value;
      setSaved(savedRef.current);
      if (form.getValues(name) === snapshot)
        form.resetField(name, { defaultValue: value === 'auto' ? '' : value });
      toast.dismiss(`mihomoctl-${name}`);
    } catch (error) {
      form.setError(name, { type: 'server', message: '保存失败，点此重试' });
      throw error;
    } finally {
      setSaving(false);
      await readState();
    }
  };

  const autosave = () => {
    const name = 'interfaces';
    if (busyRef.current || !deviceRef.current?.service || !dirty()) return;
    const snapshot = form.getValues(name);
    pendingSaves.current++;
    void queue
      .add(() => persist(snapshot))
      .catch((error) => {
        if (form.getFieldState(name).error?.type !== 'validate') {
          form.setError(name, {
            type: 'server',
            message: '保存失败，点此重试',
          });
          toast.error('接口保存失败', {
            id: `mihomoctl-${name}`,
            toasterId: 'mihomoctl',
            description: (error instanceof Error
              ? error.message
              : String(error)
            ).split('\n')[0],
            action: {
              label: '详情',
              onClick: () => {
                setDetail(
                  error instanceof Error ? error.message : String(error),
                );
                setDetailOpen(true);
              },
            },
          });
        }
      })
      .finally(() => {
        pendingSaves.current--;
      });
  };

  const perform = async (id: Operation, quiet = false) => {
    const snapshot = form.getValues();
    if (
      busyRef.current ||
      disabledReason(id, deviceRef.current, false, snapshot.subscription)
    )
      return;
    detailRequest.current++;
    busyRef.current = true;
    setBusy(id);
    setError(false);
    if (!['任务详情', '运行日志'].includes(detailTitleRef.current)) setDetailTitle('操作详情');
    let failed = false;
    if (!quiet && !installationTask(id) && !['start', 'restart'].includes(id))
      toast.loading('正在处理…', notification);
    try {
      await queue.add(async () => {
        const state = await readState().catch((error) => {
          if (id === 'stop' || id === 'uninstall') return null;
          throw error;
        });
        const reason = disabledReason(id, state, false, snapshot.subscription);
        if (reason) throw new Error(reason);
        let result = '';
        switch (id) {
          case 'install':
            if (!state?.agent && !(await form.trigger('releaseProxy')))
              throw new Error('请检查发行转发地址');
            result = await waitTask(
              !state?.agent
                ? await bootstrapAgent(snapshot.releaseProxy)
                : await submitTask('install'),
              observe,
            );
            if (!state?.agent && form.getValues('releaseProxy') === snapshot.releaseProxy)
              form.resetField('releaseProxy', { defaultValue: releaseProxy(snapshot.releaseProxy) });
            result = 'Mihomo 服务已安装';
            break;
          case 'save-release-proxy': {
            if (!(await form.trigger('releaseProxy')))
              throw new Error('请检查发行转发地址');
            const value = releaseProxy(snapshot.releaseProxy);
            result = await waitTask(
              await submitTask('save-release-proxy', { releaseProxy: value }),
              observe,
            );
            if (form.getValues('releaseProxy') === snapshot.releaseProxy)
              form.resetField('releaseProxy', { defaultValue: value });
            break;
          }
          case 'stop':
            result = await waitTask(
              state ? await submitTask('stop') : await stopAgent(),
              observe,
            );
            break;
          case 'download':
            result = await waitTask(
              await submitTask('download'),
              observe,
            );
            loaded.current = false;
            break;
          case 'update':
            if (snapshot.subscription.trim()) {
              try {
                subscriptionURL(snapshot.subscription.trim());
              } catch (error) {
                form.setError('subscription', {
                  message: '请输入有效订阅链接',
                });
                throw error;
              }
            }
            result = await waitTask(
              await submitTask('update', { url: snapshot.subscription.trim() }),
              observe,
            );
            if (form.getValues('subscription') === snapshot.subscription)
              form.resetField('subscription', { defaultValue: '' });
            break;
          case 'start':
            result = await waitTask(
              await submitTask(
                'start',
                deviceRef.current?.capabilities.interfaces
                  ? { interfaces: interfaces(snapshot.interfaces) }
                  : {},
              ),
              observe,
            );
            loaded.current = false;
            break;
          case 'save-controller': {
            if (!(await form.trigger(['controlPort', 'controlSecret'])))
              throw new Error('请检查控制面板设置');
            const input = {
              enabled: snapshot.controlEnabled,
              port: Number(snapshot.controlPort),
              secret: snapshot.controlSecret || undefined,
              reset: snapshot.resetSecret,
            };
            result = await waitTask(
              await submitTask('save-controller', { controller: input }),
              observe,
            );
            form.resetField('controlSecret', { defaultValue: '' });
            form.resetField('resetSecret', { defaultValue: false });
            form.resetField('controlEnabled', {
              defaultValue: snapshot.controlEnabled,
            });
            form.resetField('controlPort', {
              defaultValue: String(input.port),
            });
            setSecret('');
            break;
          }
          case 'check-updates': {
            const checked = await checkUpdates();
            if (
              [checked.self, checked.core, checked.dashboard].some(
                (item) => item.state === 'error',
              )
            )
              throw new Error('部分组件检查失败，请重试');
            result = '更新检查完成';
            break;
          }
          case 'view-secret':
            setSecret(await readControllerSecret());
            result = '密钥已读取';
            break;
          case 'uninstall':
            result = await waitTask(await uninstallAgent(), observe);
            loaded.current = false;
            form.reset(defaults);
            savedRef.current = null;
            setSaved(savedRef.current);
            break;
          case 'diagnose':
            result = await deviceLogs(true);
            break;
          case 'logs':
            result = await deviceLogs();
            break;
          case 'refresh':
            result = '状态已刷新';
            break;
          default:
            result = await waitTask(await submitTask(id), observe);
        }
        if (!quiet && id !== 'refresh' && !['任务详情', '运行日志'].includes(detailTitleRef.current)) setDetail(result);
        if (id === 'logs' || id === 'diagnose') {
          detailRequest.current++;
          setDetail(result);
          setDetailTitle(id === 'logs' ? '运行日志' : '网络诊断');
          setDetailOpen(true);
        }
        if (!quiet && !installationTask(id))
          toast.success(
            id === 'logs'
              ? '日志已加载'
              : id === 'diagnose'
                ? '诊断完成'
                : result.split('\n')[0]!.slice(0, 180),
            notification,
          );
      });
    } catch (error) {
      if (error instanceof TaskCancelled) {
        setDetail(error.message);
        if (!quiet) toast.message(error.message, notification);
        return;
      }
      failed = true;
      detailRequest.current++;
      setDetailTitle(error instanceof TaskFailed ? '任务详情' : '操作详情');
      const text = error instanceof Error ? error.message : String(error);
      setError(true);
      setDetail(text);
      setDetailOpen(true);
      if (!quiet)
        toast.error(text.split('\n')[0]!.slice(0, 160), {
          ...notification,
          duration: 10000,
          action: { label: '详情', onClick: () => setDetailOpen(true) },
        });
    } finally {
      try {
        await refresh();
      } catch (error) {
        setError(true);
        setDetail(
          (value) =>
            value +
            '\n\n状态刷新失败：\n' +
            (error instanceof Error ? error.message : String(error)),
        );
        if (!quiet && !failed)
          toast.error('无法刷新状态', {
            ...notification,
            action: { label: '详情', onClick: () => setDetailOpen(true) },
          });
      }
      busyRef.current = false;
      setBusy(null);
    }
  };

  useEffect(() => {
    void perform('refresh', true);
    let probing = false;
    const timer = setInterval(() => {
      if (!open.current || document.hidden || probing) return;
      if (busyRef.current) {
        // Observe runtime changes even while a detached task is being watched.
        probing = true;
        void readState()
          .catch(() => {})
          .finally(() => {
            probing = false;
          });
      } else if (!queue.pending && !queue.size) {
        probing = true;
        void queue
          .add(refresh)
          .catch(() => {})
          .finally(() => {
            probing = false;
          });
      }
    }, 5000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        pendingSaves.current ||
        form.getValues('subscription').trim() ||
        (
          [
            'releaseProxy',
            'controlEnabled',
            'controlPort',
            'controlSecret',
            'resetSecret',
          ] as const
        ).some((name) => form.getFieldState(name).isDirty) ||
        (form.getFieldState('interfaces').isDirty && dirty())
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  const validate = (
    name: 'subscription' | 'interfaces' | 'controlPort' | 'controlSecret' | 'releaseProxy',
    value: string,
  ) => {
    try {
      if (name === 'releaseProxy') {
        releaseProxy(value);
        return true;
      }
      if (name === 'controlPort')
        return (
          (/^\d+$/.test(value) &&
            Number(value) >= 1024 &&
            Number(value) <= 65535 &&
            ![7894, 1053].includes(Number(value))) ||
          '请输入可用的 1024–65535 端口'
        );
      if (name === 'controlSecret')
        return (
          /^[\x21-\x7e]*$/.test(value) || '密钥包含无法用于 HTTP 鉴权的字符'
        );
      if (name === 'subscription') {
        if (value.trim()) subscriptionURL(value.trim());
      } else interfaces(value);
      return true;
    } catch (error) {
      return error instanceof Error ? error.message : '格式不正确';
    }
  };
  const saveStatus = () => {
    if (saving) return '保存中';
    if (form.formState.errors.interfaces)
      return form.formState.errors.interfaces.message!;
    if (!device?.service) return '草稿';
    if (saved === null) return '读取中';
    return dirty()
      ? '未保存'
      : !form.getValues('interfaces').trim()
        ? '自动'
        : '已保存';
  };
  return {
    device,
    stateError,
    task: device?.task || observedTask,
    cancelling,
    cancelTask,
    updates: device?.updates ?? null,
    busy,
    form,
    values,
    saveStatus,
    validate,
    autosave,
    perform,
    open,
    detail,
    detailTitle,
    detailOpen,
    setDetailOpen,
    error,
    showTask,
    refreshDetail,
    showRuntimeLogs,
    secret,
    setSecret,
  };
}

export type GatewayModel = ReturnType<typeof useGateway>;
