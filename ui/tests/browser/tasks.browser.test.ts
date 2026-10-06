import { expect, test } from 'vitest';
import { app, evaluate, idle, open, reload, expand } from './app';

test('download progress stays visible after reconnect and cancellation stops the original task', async () => {
  await open('missing-core');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await evaluate('mockTaskDelayMs = 60000');
  await app.getByCSS('[data-group=maintenance] [data-action=download]').click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBe(true);
  await reload();
  await expand();
  await idle();
  await evaluate('Object.assign(mockDeviceState.task, {downloaded:1048576,total:4194304,speed:524288,updated:new Date(Date.now()-15000).toISOString()})');
  await expect.element(app.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '25');
  await expect.element(app.getByCSS('[data-transfer]')).toMatchTextContent('1.0 MiB / 4.0 MiB');
  await expect.element(app.getByCSS('[data-transfer]')).toMatchTextContent('无新数据');
  await evaluate('mockDeviceState.task.total = 0');
  await expect.element(app.getByCSS('[data-transfer]')).toMatchTextContent('总大小未知');
  for (const name of ['设置', '日志', '配置']) {
    await app.getByRole('tab', { name, exact: true }).click();
    await expect.element(app.getByRole('button', { name: '取消任务', exact: true })).toBeEnabled();
  }
  await app.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect.poll(() => evaluate('mockDeviceState.task.state')).toBe('cancelled');
  expect(evaluate('mockDeviceState.core')).toBe(false);
  expect(evaluate('mockCommands.filter(c => c.includes("cancel")).length')).toBe(1);
  expect(evaluate('mockIntents.length')).toBe(0);
});

test('first installation can be cancelled without claiming the service is installed', async () => {
  await open('missing-service');
  await evaluate('mockTaskDelayMs = 60000');
  await app.getByCSS('[data-primary=true][data-action=install]').click();
  await expect.element(app.getByRole('button', { name: '取消任务', exact: true })).toBeEnabled();
  await app.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect.poll(() => evaluate('mockDeviceState.task.state')).toBe('cancelled');
  await idle();
  expect(evaluate('mockDeviceState.agent || mockDeviceState.service')).toBe(false);
  expect(evaluate('mockIntents.length')).toBe(1);
});
