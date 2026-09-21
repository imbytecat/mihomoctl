import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { app, evaluate, idle, closeModal, open, reload } from './app';

const panelYaml = (port: number, extra = '') => `external-controller: 0.0.0.0:${port}\n${extra}`;

function stubDashboardWindow() {
  evaluate(`window.open = (url, target) => {
    window.mockPopup = {
      url, target, opener: window, closed: false,
      document: document.implementation.createHTMLDocument(),
      location: { replace: value => { mockPopup.url = value; } },
      close: () => { mockPopup.closed = true; },
    };
    return mockPopup;
  }`);
}

async function openDashboard(port: number, secret: string) {
  stubDashboardWindow();
  await app.getByCSS('[data-action=open-dashboard]').click();
  await idle();
  const url = new URL(evaluate<string>('mockPopup.url'));
  expect(url.port).toBe(String(port));
  expect(url.pathname).toBe('/ui/');
  expect(url.hash).toBe('#/setup');
  expect(url.searchParams.get('hostname')).toBe(url.hostname);
  expect(url.searchParams.get('port')).toBe(String(port));
  expect(url.searchParams.get('secret')).toBe(secret);
  expect(evaluate('mockPopup.opener')).toBeNull();
  expect(evaluate('mockPopup.document.querySelector("meta[name=referrer]").content')).toBe('no-referrer');
  expect(evaluate(`mockCommands.every(c => !c.includes(${JSON.stringify(secret)}))`)).toBe(true);
}

test('unsaved drafts cancel navigation with the current browser event API', async () => {
  await open('ready');
  const canLeave = () => evaluate('window.dispatchEvent(new Event("beforeunload", { cancelable: true }))');
  expect(canLeave()).toBe(true);
  await app.getByCSS('[data-url]').fill('https://draft.example/subscription');
  expect(canLeave()).toBe(false);
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  const initialYaml = (app.getByCSS('#ufi-controller-yaml').element() as HTMLTextAreaElement).value;
  await app.getByCSS('#ufi-controller-yaml').fill(panelYaml(9191));
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await expect.element(app.getByCSS('#ufi-controller-yaml')).toHaveValue(panelYaml(9191));
  await app.getByCSS('#ufi-controller-yaml').fill(initialYaml);
  await app.getByRole('tab', { name: '概览', exact: true }).click();
  await expect.element(app.getByCSS('[data-url]')).toHaveValue('https://draft.example/subscription');
  await app.getByCSS('[data-url]').fill('');
  expect(canLeave()).toBe(true);
});

test('interface autosave preserves newer drafts and handles failures', async () => {
  await open('ready');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  const input = app.getByCSS('[data-setting=interfaces]');
  await input.fill('wlan0');
  await evaluate('window.mockUploadDelayMs = 900');
  // Clicking download blurs the input; the queued save must complete first.
  await app.getByCSS('[data-group=maintenance] [data-action=download]').click();
  await expect.element(app.getByCSS('[data-version=core]')).toHaveTextContent('v9.8.7');
  await idle();
  expect(evaluate('mockDeviceState.settings.interfaces')).toEqual(['wlan0']);
  expect(evaluate('mockIntents.filter(x => x.action === "save-interfaces").length')).toBe(1);
  await expect.element(app.getByCSS('[data-task]')).not.toBeInTheDocument();
  await expect.element(app.getByCSS('[data-group=maintenance] [data-install-task]')).toBeInTheDocument();

  await input.fill('rndis0');
  await userEvent.tab();
  await expect.element(app.getByCSS('[data-save-status=interfaces]')).toMatchTextContent('保存中');
  await input.fill('usb0');
  await expect.poll(() => evaluate('mockDeviceState.settings.interfaces.join(" ")')).toBe('rndis0');
  await expect.element(input).toHaveValue('usb0');
  await userEvent.tab();
  await expect.poll(() => evaluate('mockDeviceState.settings.interfaces.join(" ")')).toBe('usb0');

  await evaluate('window.mockUploadDelayMs = 0; window.mockUploadFailure = true');
  await input.fill('br-lan');
  await userEvent.tab();
  await expect.element(app.getByText('重试保存', { exact: true }).first()).toBeVisible();
  expect(evaluate('mockDeviceState.settings.interfaces')).toEqual(['usb0']);
  await evaluate('window.mockUploadFailure = false');
  await app.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect.poll(() => evaluate('mockDeviceState.settings.interfaces.join(" ")')).toBe('br-lan');

  const submitted = evaluate('mockIntents.length');
  await input.fill('rmnet_data0');
  await userEvent.tab();
  await expect.element(input).toHaveAttribute('aria-invalid', 'true');
  expect(evaluate('mockIntents.length')).toBe(submitted);
  expect(evaluate('mockDeviceState.settings.interfaces')).toEqual(['br-lan']);
});

test('controller transactions, encrypted secrets and task details', async () => {
  await open('running');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await app.getByCSS('#ufi-controller-yaml').fill('external-controller: [\n');
  await app.getByCSS('[data-action=save-controller]').click();
  await idle();
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await expect.element(app.getByCSS('#ufi-controller-yaml-error')).toBeVisible();
  expect(evaluate('mockIntents.length')).toBe(0);
  await openDashboard(9090, 'mock-controller-key-not-a-real-secret');
  await app.getByCSS('#ufi-controller-yaml').fill(panelYaml(9191, 'secret: short\n'));
  await evaluate('window.mockTaskDelayMs = 5000');
  await app.getByCSS('[data-action=save-controller]').click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBeTruthy();
  await expect
    .element(app.getByCSS('[data-status]'))
    .toHaveTextContent('运行中');
  expect(evaluate('mockDeviceState.controller.port')).toBe(9090);
  await app.getByCSS('#ufi-controller-yaml').fill(panelYaml(9393, 'secret: newer-draft-secret\n'));
  await expect
    .poll(() => evaluate('mockDeviceState.controller.port === 9191'))
    .toBeTruthy();
  await idle();
  await openDashboard(9191, 'short');
  await expect.element(app.getByCSS('#ufi-controller-yaml')).toHaveValue(panelYaml(9393, 'secret: newer-draft-secret\n'));
  await app.getByRole('button', { name: '更多操作', exact: true }).click();
  await app.getByRole('menuitem', { name: '运行日志', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-log-panel]'))
    .toBeVisible();
  await expect
    .element(app.getByCSS('[data-log-source]'))
    .toHaveTextContent('Mihomo');
  await closeModal();
  await app.getByRole('button', { name: '更多操作', exact: true }).click();
  await app.getByRole('menuitem', { name: '最近任务', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-log-panel]'))
    .toBeVisible();
  await expect
    .element(app.getByCSS('[data-log-source]'))
    .toHaveTextContent('任务详情');
  await expect
    .element(app.getByCSS('[data-output]'))
    .toMatchTextContent('覆写');
  await expect
    .element(app.getByCSS('[data-output]'))
    .not.toMatchTextContent('core.log');
  await closeModal();
  await evaluate(
    'window.mockTaskDelayMs = 300; window.mockTaskFailure = "配置校验失败"',
  );
  await app.getByCSS('#ufi-controller-yaml').fill(panelYaml(9292));
  await app.getByCSS('[data-action=save-controller]').click();
  await expect
    .poll(() => evaluate('mockDeviceState.task.state === "failed"'))
    .toBeTruthy();
  await idle();
  expect(evaluate('mockDeviceState.controller.port')).toBe(9191);
  await expect.element(app.getByCSS('#ufi-controller-yaml')).toHaveValue(panelYaml(9292));
});

test('dashboard handles blocked popups, failed secret reads and encoded credentials', async () => {
  await open('running');
  await evaluate('window.open = () => null');
  await app.getByCSS('[data-action=open-dashboard]').click();
  await expect.element(app.getByText('浏览器阻止了新标签页，请允许弹出窗口后重试')).toBeVisible();
  await idle();

  stubDashboardWindow();
  await evaluate('window.mockSecretFailure = true');
  await app.getByCSS('[data-action=open-dashboard]').click();
  await expect.poll(() => evaluate('mockPopup.closed')).toBe(true);
  expect(evaluate('mockPopup.url')).toBe('about:blank');
  await expect.element(app.getByText('模拟密钥读取失败', { exact: false })).toBeVisible();
  await idle();

  await evaluate('window.mockSecretFailure = false');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  const key = 'key &#+%?中文';
  await app.getByCSS('#ufi-controller-yaml').fill(panelYaml(9191, `secret: ${JSON.stringify(key)}\n`));
  await app.getByCSS('[data-action=save-controller]').click();
  await idle();
  await openDashboard(9191, key);
});

test('update checks show component results without submitting mutations or clearing drafts', async () => {
  await open('ready');
  await app.getByCSS('[data-url]').fill('https://draft.example/subscription');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await idle();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .toHaveTextContent('可更新至 v9.8.7');
  await expect
    .element(app.getByCSS('[data-update=core]'))
    .toHaveTextContent('已是最新');
  await expect
    .element(app.getByCSS('[data-update=dashboard]'))
    .toMatchTextContent('最新 v3.26.0');
  await expect
    .element(app.getByCSS('[data-update-checked]'))
    .toMatchTextContent('上次检查');
  await expect
    .element(app.getByCSS('[data-group=maintenance] [data-action=download]'))
    .toBeDisabled();
  await expect
    .element(app.getByCSS('[data-url]'))
    .toHaveValue('https://draft.example/subscription');
  expect(evaluate('mockIntents.length')).toBe(0);
  await evaluate('window.mockUpdateFailure = true');
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await idle();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .toHaveTextContent('检查失败');
  await expect
    .element(app.getByCSS('[data-update=core]'))
    .toHaveTextContent('已是最新');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await evaluate('window.mockUpdateFailure = false');
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await idle();
  expect(evaluate('mockIntents.length')).toBe(0);
  expect(
    evaluate(
      'mockRequests.every(u => new URL(u, location.href).origin === location.origin)',
    ),
  ).toBe(true);
  await reload();
  await app.getByCSS('[data-plugin] > summary').click();
  await idle();
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .toHaveTextContent('可更新至 v9.8.7');
  expect(evaluate('mockCommands.some(c => c.includes("check-updates"))')).toBe(false);
  await app.getByCSS('[data-action=self-update]').click();
  await idle();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .toHaveTextContent('已是最新');
  await expect
    .element(app.getByCSS('[data-update=core]'))
    .toHaveTextContent('已是最新');
});


test('install after checking updates immediately disables redundant component updates', async () => {
  await open('missing-core');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await idle();
  const checked = evaluate('mockDeviceState.updates.checkedAt');
  for (const action of ['download', 'download-dashboard']) {
    await app.getByCSS(`[data-group=maintenance] [data-action=${action}]`).click();
    await idle();
    await expect.element(app.getByCSS(`[data-group=maintenance] [data-action=${action}]`)).toBeDisabled();
  }
  expect(evaluate('mockDeviceState.updates.checkedAt')).toBe(checked);
  expect(evaluate('mockCommands.filter(c => c.includes("check-updates")).length')).toBe(1);
  await reload();
  await app.getByCSS('[data-plugin] > summary').click();
  await idle();
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await expect.element(app.getByCSS('[data-group=maintenance] [data-action=download]')).toBeDisabled();
  await expect.element(app.getByCSS('[data-group=maintenance] [data-action=download-dashboard]')).toBeDisabled();
  expect(evaluate('mockCommands.some(c => c.includes("check-updates"))')).toBe(false);
});

test('restoring override defaults is a draft edit and preserves newer typing during save', async () => {
  await open('ready');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  const editor = app.getByCSS('#ufi-controller-yaml');
  const original = (editor.element() as HTMLTextAreaElement).value;
  await evaluate('mockTaskDelayMs = 2500');
  await editor.fill(panelYaml(9191, 'future-option: true\n'));
  await app.getByCSS('[data-action=save-controller]').click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBe(true);
  await editor.fill(original);
  await idle();
  expect(evaluate('mockDeviceState.controller.port')).toBe(9191);
  await expect.element(editor).toHaveValue(original);
  expect(evaluate('window.dispatchEvent(new Event("beforeunload", { cancelable: true }))')).toBe(false);
  const submitted = evaluate('mockIntents.length');
  await editor.fill('secret: [\n');
  await app.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect.element(editor).toHaveValue('');
  await expect.element(editor).toHaveAttribute('aria-invalid', 'false');
  expect(evaluate('mockIntents.length')).toBe(submitted);
  await app.getByCSS('[data-action=save-controller]').click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBe(true);
  const newerDraft = panelYaml(9393, 'future-option: newer\n');
  await editor.fill(newerDraft);
  await idle();
  await expect.element(editor).toHaveValue(newerDraft);
  expect(evaluate('mockDeviceState.controller.port')).toBe(9191);
  await app.getByRole('button', { name: '恢复默认', exact: true }).click();
  await app.getByCSS('[data-action=save-controller]').click();
  await idle();
  await expect.element(editor).toHaveValue(expect.stringContaining('external-controller: 0.0.0.0:9191'));
  await expect.element(editor).toHaveValue(expect.stringContaining('mock-controller-key-not-a-real-secret'));
  await expect.element(editor).not.toHaveValue(expect.stringContaining('future-option'));
  expect(evaluate('mockCommands.every(c => !c.includes("mock-controller-key-not-a-real-secret"))')).toBe(true);
});
