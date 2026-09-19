import { expect, test } from 'vitest';
import { app, evaluate, idle, open, closeModal } from './app';

test('uninstall remains usable when the entire status response is unreadable', async () => {
  await open('unreadable-state');
  await expect.element(app.getByCSS('[data-status]')).toHaveTextContent('状态不可用');
  const remove = app.getByRole('button', { name: '卸载现有安装', exact: true });
  await expect.element(remove).toBeEnabled();
  await remove.click();
  await app.getByCSS('[data-uninstall-cancel]').click();
  expect(evaluate('mockIntents.length')).toBe(0);
  await remove.click();
  await app.getByCSS('[data-uninstall-confirm]').click();
  await expect.poll(() => evaluate('mockDeviceState.agent')).toBe(false);
  await idle();
  await expect.element(app.getByCSS('[data-primary=true][data-action=install]')).toBeEnabled();
  expect(evaluate('mockIntents.filter(x => x.action === "uninstall").length')).toBe(1);
  expect(evaluate('mockUploads.length')).toBe(0);
  expect(evaluate('mockRequests.some(u => u.includes("api.github.com"))')).toBe(false);
});

test('failed cleanup preserves the uninstall entry and reports the actual failure', async () => {
  await open('unreadable-state');
  await evaluate('mockTaskFailure = "无法清理自启脚本"');
  await app.getByRole('button', { name: '卸载现有安装', exact: true }).click();
  await app.getByCSS('[data-uninstall-confirm]').click();
  await expect.poll(() => evaluate('mockDeviceState.task?.state')).toBe('failed');
  await idle();
  expect(evaluate('mockDeviceState.agent && mockDeviceState.service')).toBe(true);
  await app.getByRole('button', { name: '查看错误详情', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('无法清理自启脚本');
  await closeModal();
  await expect.element(app.getByRole('button', { name: '卸载现有安装', exact: true })).toBeEnabled();
});

test('remaining network state is shown as pending cleanup, not a clean stop', async () => {
  await open('running');
  await evaluate('Object.assign(mockDeviceState, { running: false, supervisor: false, listeners: false, network: false, capture: true })');
  await expect.element(app.getByCSS('[data-status]')).toHaveTextContent('待清理');
  await app.getByRole('button', { name: '清理残留规则', exact: true }).click();
  await idle();
  await expect.element(app.getByCSS('[data-status]')).toHaveTextContent('已停止');
  expect(evaluate('mockIntents.at(-1).action')).toBe('stop');
});
