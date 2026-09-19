import { expect, test } from 'vitest';
import { app, evaluate, idle, open, reload } from './app';

const output = () => app.getByCSS('[data-output]');
const source = (name: string) => app.getByRole('tablist', { name: '日志来源' }).getByRole('tab', { name, exact: true }).click();

test('separate log sources accumulate automatically across tabs, pause and reconnect', async () => {
  await open('ready');
  await evaluate('mockRuntimeLog = "core first"; mockSupervisorLog = "supervisor first"; mockTasksLog = "task first"');
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect.element(output()).toMatchTextContent('core first');
  await expect.element(output()).not.toMatchTextContent('supervisor first');
  await source('管理器');
  await expect.element(output()).toMatchTextContent('supervisor first');
  await expect.element(output()).toMatchTextContent('task first');
  await expect.element(output()).not.toMatchTextContent('core first');
  await source('Mihomo');
  await app.getByRole('button', { name: '暂停收集', exact: true }).click();
  await evaluate('mockRuntimeLog += "\\ncore second"');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await expect.element(output()).not.toMatchTextContent('core second');
  await app.getByRole('button', { name: '继续收集', exact: true }).click();
  await expect.element(output()).toMatchTextContent('core second');
  await expect.element(output()).toMatchTextContent('core first');
  await app.getByRole('tab', { name: '概览', exact: true }).click();
  await evaluate('mockRuntimeLog += "\\nbackground line"');
  await expect.poll(() => evaluate('document.querySelector("[data-output]").textContent.includes("background line")')).toBe(true);
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect.element(output()).toMatchTextContent('core first');
  await evaluate('mockLogFailure = true');
  await expect.element(app.getByText('日志读取失败：', { exact: false })).toBeVisible();
  await expect.element(output()).toMatchTextContent('background line');
  await evaluate('mockLogFailure = false; mockRuntimeLog += "\\nreconnected"');
  await expect.element(output()).toMatchTextContent('reconnected');
  await expect.element(app.getByText('日志读取失败：', { exact: false })).not.toBeInTheDocument();
  await app.getByRole('button', { name: '清空显示', exact: true }).click();
  await expect.element(output()).toMatchTextContent('暂无日志');
  await evaluate('mockRuntimeLog += "\\nafter clear"');
  await expect.element(output()).toMatchTextContent('after clear');
  await expect.element(output()).not.toMatchTextContent('core first');
});

test('scrolling preserves the reading position while new lines keep arriving', async () => {
  await open('ready');
  await evaluate('mockRuntimeLog = Array.from({length:150}, (_,i)=>"line "+i).join("\\n")');
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect.element(output()).toMatchTextContent('line 149');
  await evaluate('document.querySelector("[data-output] [data-virtuoso-scroller]").scrollTop = 0');
  await expect.element(app.getByRole('button', { name: '跟随最新', exact: true }).first()).toBeVisible();
  await expect.element(output()).toMatchTextContent('line 0');
  const reads = evaluate<number>('mockCommands.filter(c => c.includes("log-read")).length');
  await evaluate('mockRuntimeLog += "\\nwhile reading"');
  await expect.poll(() => evaluate<number>('mockCommands.filter(c => c.includes("log-read")).length')).toBeGreaterThan(reads + 2);
  await expect.element(output()).toMatchTextContent('line 0');
  await app.getByRole('button', { name: '跟随最新', exact: true }).first().click();
  await expect.element(output()).toMatchTextContent('while reading');
  expect(evaluate<number>('document.querySelectorAll("[data-output] [data-log-level]").length')).toBeLessThan(150);
});

test('startup failure automatically opens task evidence separately from runtime logs', async () => {
  await open('ready');
  await evaluate('mockTaskFailure = "代理启动失败\\ncore.log（本次启动）:\\nlisten tcp :1053: address already in use"');
  await app.getByRole('button', { name: '启动代理', exact: true }).click();
  await idle();
  await expect.element(app.getByCSS('[data-log-panel]')).toBeVisible();
  await expect.element(output()).toMatchTextContent('address already in use');
  await expect.element(app.getByCSS('[data-log-source]')).toHaveTextContent('任务详情');
  await source('Mihomo');
  await expect.element(output()).toMatchTextContent('代理运行正常');
  await expect.element(output()).not.toMatchTextContent('任务 ID');
});

test('startup streams kernel output before completion and reconnects without resubmission', async () => {
  await open('ready');
  await evaluate('mockTaskDelayMs = 60000; mockRuntimeLog = "Starting kernel"');
  await app.getByRole('button', { name: '启动代理', exact: true }).click();
  await expect.element(app.getByRole('tab', { name: '日志', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.element(output()).toMatchTextContent('Starting kernel');
  await evaluate('mockRuntimeLog += "\\nlevel=error msg=\\"listen tcp :9090: address already in use\\""');
  await expect.element(output()).toMatchTextContent('address already in use');
  await expect.element(app.getByCSS('[data-output] [data-log-level=error]').last()).toHaveStyle({ color: 'rgb(255, 105, 97)' });
  expect(evaluate('mockDeviceState.task.state')).toBe('running');
  await reload();
  await app.getByCSS('[data-plugin] > summary').click();
  await expect.element(app.getByRole('tab', { name: '日志', exact: true })).toHaveAttribute('aria-selected', 'true');
  await evaluate('mockRuntimeLog = "Kernel output after reconnect"');
  await expect.element(output()).toMatchTextContent('Kernel output after reconnect');
  expect(evaluate('mockIntents.length')).toBe(0);
});

test('viewer provides ANSI colors, safe literal HTML and built-in search', async () => {
  await open('ready');
  await evaluate(`mockRuntimeLog = ${JSON.stringify('\u001b[31mANSI red\u001b[0m\n<script>literal text</script>')}`);
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect.element(output()).toMatchTextContent('<script>literal text</script>');
  await expect.element(app.getByCSS('[data-output] script')).not.toBeInTheDocument();
  await expect.element(app.getByCSS('[data-output] span[style*=color]')).toMatchTextContent('ANSI red');
  await app.getByCSS('[data-output] input').fill('ANSI red');
  await expect.element(output()).not.toMatchTextContent('literal text');
  await expect.element(output()).toMatchTextContent('ANSI red');
});
