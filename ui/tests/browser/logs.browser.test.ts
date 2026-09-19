import { expect, test } from 'vitest';
import { app, evaluate, idle, open, reload } from './app';

test('inline runtime logs refresh, pause and stop following while reading older lines', async () => {
  await open('ready');
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await app.getByCSS('[data-log-panel]').getByRole('button', { name: '运行日志', exact: true }).click();
  await expect.element(app.getByCSS('[data-log-source]')).toHaveTextContent('运行日志');
  await evaluate('mockRuntimeLog = "fresh log line"');
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('fresh log line');
  await app.getByRole('button', { name: '暂停刷新', exact: true }).click();
  await evaluate('mockRuntimeLog = "next log line"');
  await new Promise((resolve) => setTimeout(resolve, 2800));
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('fresh log line');
  await app.getByRole('button', { name: '继续刷新', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('next log line');
  await evaluate('mockRuntimeLog = Array.from({length:100}, (_,i)=>"line "+i).join("\\n")');
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('line 99');
  await evaluate('const log = document.querySelector("[data-output]"); log.scrollTop=0; log.dispatchEvent(new Event("scroll"))');
  await expect.element(app.getByRole('button', { name: '跟随最新', exact: true })).toBeVisible();
  await evaluate('mockRuntimeLog = "latest line"');
  await new Promise((resolve) => setTimeout(resolve, 2800));
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('line 0');
  await app.getByRole('button', { name: '跟随最新', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('latest line');
  await app.getByRole('tab', { name: '概览', exact: true }).click();
  await evaluate('mockRuntimeLog = "hidden tab update"');
  await new Promise((resolve) => setTimeout(resolve, 2800));
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('latest line');
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('hidden tab update');
});

test('startup failure automatically opens the inline reason and runtime evidence', async () => {
  await open('ready');
  await evaluate('mockTaskFailure = "代理启动失败\\ncore.log（本次启动）:\\nlisten tcp :1053: address already in use"');
  await app.getByRole('button', { name: '启动代理', exact: true }).click();
  await idle();
  await expect.element(app.getByCSS('[data-log-panel]')).toBeVisible();
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('address already in use');
  await expect.element(app.getByCSS('[data-dialog=result]')).not.toBeInTheDocument();
});


test('startup shows kernel output before completion and resumes after page reload', async () => {
  await open('ready');
  await evaluate('mockTaskDelayMs = 60000; mockRuntimeLog = "core.log\\nStarting kernel"');
  await app.getByRole('button', { name: '启动代理', exact: true }).click();
  await expect.element(app.getByRole('tab', { name: '日志', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('Starting kernel');
  expect(evaluate('mockDeviceState.task.state')).toBe('running');
  await evaluate('mockRuntimeLog = "core.log\\nlevel=error msg=\\"External controller listen error: listen tcp 0.0.0.0:9090: bind: address already in use\\""');
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('address already in use');
  await expect.element(app.getByCSS('[data-log-level=error]').last()).toHaveStyle({ color: 'rgb(255, 105, 97)' });
  expect(evaluate('mockDeviceState.task.state')).toBe('running');
  await app.getByRole('searchbox', { name: '搜索日志', exact: true }).fill('9090');
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('9090');
  await expect.element(app.getByCSS('[data-output]')).not.toMatchTextContent('任务日志');
  await reload();
  await app.getByCSS('[data-plugin] > summary').click();
  await expect.element(app.getByRole('tab', { name: '日志', exact: true })).toHaveAttribute('aria-selected', 'true');
  await evaluate('mockRuntimeLog = "core.log\\nKernel output after reconnect"');
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('Kernel output after reconnect');
  expect(evaluate('mockIntents.length')).toBe(0);
});


test('ANSI colors and literal HTML stay inside the log viewer', async () => {
  await open('ready');
  await evaluate(`mockRuntimeLog = ${JSON.stringify('core.log\n\u001b[31mANSI red\u001b[0m\n<script>literal text</script>')}`);
  await app.getByRole('tab', { name: '日志', exact: true }).click();
  await expect.element(app.getByCSS('[data-output]')).toMatchTextContent('<script>literal text</script>');
  await expect.element(app.getByCSS('[data-output] script')).not.toBeInTheDocument();
  await expect.element(app.getByCSS('[data-output] span[style*=color]')).toHaveTextContent('ANSI red');
  await app.getByRole('searchbox', { name: '搜索日志', exact: true }).fill('ANSI red');
  await expect.element(app.getByCSS('[data-output]')).toHaveTextContent('ANSI red');
});
