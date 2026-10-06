import { expect, test } from 'vitest';
import { app, evaluate, idle, leaveLogs, open, reload, expand } from './app';

test('install, encrypted subscription, runtime, autostart and uninstall', async () => {
  await open('missing-service');
  await app.getByCSS('[data-primary=true][data-action=install]').click();
  await expect.poll(() => evaluate('mockDeviceState.service')).toBeTruthy();
  await idle();
  expect(evaluate('mockRequests.filter(u => u.includes("api.github.com"))')).toEqual([
    'https://api.github.com/repos/imbytecat/mihomoctl/releases/latest',
  ]);
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await app.getByCSS('[data-group=maintenance] [data-action=download]').click();
  await expect
    .element(app.getByCSS('[data-version=core]'))
    .toHaveTextContent('v9.8.7');
  await idle();
  await app.getByRole('tab', { name: '配置', exact: true }).click();
  await app.getByCSS('[data-url]').fill('https://example.com/subscription');
  await app.getByRole('button', { name: '保存并更新', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-sonner-toast]').getByText('配置已更新', { exact: true }))
    .toBeVisible();
  await idle();
  expect(evaluate('mockDeviceState.config')).toBe(true);
  // A cleared draft collapses the saved subscription back to its summary.
  await expect.element(app.getByCSS('[data-url]')).not.toBeInTheDocument();
  await expect
    .poll(() =>
      evaluate(
        'mockCommands.every(c => !c.includes("https://example.com/subscription")) && mockUploads.every(u => !new TextDecoder().decode(u.bytes).includes("https://example.com/subscription"))',
      ),
    )
    .toBe(true);
  await app.getByRole('button', { name: '启动代理', exact: true }).click();
  await expect.poll(() => evaluate('mockDeviceState.running')).toBeTruthy();
  await idle();
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await app.getByCSS('[data-boot]').click();
  await expect.poll(() => evaluate('mockDeviceState.boot')).toBeTruthy();
  await idle();
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-log-panel]'))
    .toBeVisible();
  await leaveLogs('设置');
  await app.getByRole('button', { name: '卸载 Mihomo 服务', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-dialog=uninstall][data-state=open]'))
    .toBeVisible();
  await app.getByCSS('[data-uninstall-cancel]').click();
  await expect
    .element(app.getByCSS('[data-dialog=uninstall]'))
    .not.toBeInTheDocument();
  await expect
    .poll(() => evaluate('!mockIntents.some(x => x.action === "uninstall")'))
    .toBe(true);
  await app.getByRole('button', { name: '卸载 Mihomo 服务', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-dialog=uninstall][data-state=open]'))
    .toBeVisible();
  await app.getByCSS('[data-uninstall-confirm]').click();
  await expect.poll(() => evaluate('!mockDeviceState.service')).toBeTruthy();
  await idle();
  await expect
    .poll(() =>
      evaluate(
        '!mockDeviceState.running && !mockDeviceState.boot && !mockDeviceState.agent',
      ),
    )
    .toBe(true);
});

test('reconnect observes the original task without resubmitting', async () => {
  await open('missing-core');
  await expect
    .element(app.getByCSS('[data-group=maintenance] [data-action=download]'))
    .toHaveTextContent('安装');
  await evaluate(
    'window.mockTaskFailure = "设备 TLS 握手失败：api.github.com"; window.mockTaskDelayMs = 9000',
  );
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await app.getByCSS('[data-group=maintenance] [data-action=download]').click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBeTruthy();
  await reload();
  await expect.element(app.getByCSS('[data-plugin] > summary')).toBeVisible();
  await expand();
  await expect
    .poll(() => evaluate('mockDeviceState.task?.state === "failed"'))
    .toBeTruthy();
  await app.getByCSS('[data-task]').click();
  await expect
    .element(app.getByCSS('[data-log-panel]'))
    .toBeVisible();
  await expect
    .element(app.getByCSS('[data-output]'))
    .toMatchTextContent('设备 TLS');
  await expect
    .poll(() =>
      evaluate(
        'mockIntents.length === 0 && mockRequests.every(u => new URL(u, location.href).origin === location.origin)',
      ),
    )
    .toBe(true);
  await leaveLogs();
  await evaluate('window.mockTaskFailure = ""; window.mockTaskDelayMs = 8000');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await app.getByCSS('[data-group=maintenance] [data-action=download]').click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBeTruthy();
  await reload();
  await expect.element(app.getByCSS('[data-plugin] > summary')).toBeVisible();
  await expand();
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.core && mockDeviceState.task?.state === "succeeded"',
      ),
    )
    .toBeTruthy();
  expect(evaluate('mockIntents.length')).toBe(0);
  await expect
    .element(app.getByCSS('[data-version=core]'))
    .toHaveTextContent('v9.8.7');
  await expect.element(app.getByCSS('[data-task]')).not.toBeInTheDocument();
});

test('Linux exposes shared capabilities without claiming network capture', async () => {
  await open('managed-linux');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-status]'))
    .toHaveTextContent('运行中');
  await expect
    .element(app.getByCSS('body'))
    .toMatchTextContent('网络由系统管理');
  await expect
    .element(app.getByCSS('[data-action=self-update]'))
    .toBeDisabled();
  await expect
    .element(app.getByCSS('[data-group=maintenance] [data-action=download]'))
    .toBeDisabled();
  await expect.element(app.getByCSS('[data-boot]')).toBeEnabled();
  await expect
    .element(app.getByCSS('[data-setting=interfaces]'))
    .toBeDisabled();
  await app.getByCSS('[data-action=stop]').click();
  await idle();
  await expect
    .element(app.getByCSS('[data-action=self-update]'))
    .toBeEnabled();
  await expect
    .element(app.getByCSS('[data-group=maintenance] [data-action=download]'))
    .toBeEnabled();
});
