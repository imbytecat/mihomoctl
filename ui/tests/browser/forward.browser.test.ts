import { expect, test } from 'vitest';
import { app, evaluate, idle, open, reload, expand } from './app';

test('custom forwarding is used before installation and restored from the device', async () => {
  await open('missing-service');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  const input = app.getByCSS('[data-release-proxy]');
  await expect.element(app.getByRole('link', { name: '自行部署' })).toHaveAttribute('href', 'https://github.com/netnr/workers');
  await input.fill('https://mirror.example.com/?token=private');
  await app.getByCSS('[data-primary=true][data-action=install]').click();
  await idle();
  await expect.element(input).toHaveAttribute('aria-invalid', 'true');
  expect(evaluate('mockRequests.some(u => u.includes("api.github.com"))')).toBe(false);

  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await input.fill('https://mirror.example.com/');
  await app.getByCSS('[data-primary=true][data-action=install]').click();
  await expect.poll(() => evaluate('mockDeviceState.service')).toBe(true);
  await idle();
  expect(evaluate('mockDeviceState.settings.releaseProxy')).toBe('https://mirror.example.com');
  expect(evaluate('mockRequests.filter(u => u.includes("api.github.com"))')).toEqual([
    'https://mirror.example.com/' + encodeURIComponent('https://api.github.com/repos/imbytecat/mihomoctl/releases/latest'),
  ]);
  expect(evaluate('mockCommands.some(c => c.includes("https://mirror.example.com/https%3A%2F%2Fgithub.com"))')).toBe(true);
  await reload();
  await expand();
  await idle();
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await expect.element(input).toHaveValue('https://mirror.example.com');
});

test('saving forwarding preserves newer edits, survives refresh and can restore direct access', async () => {
  await open('running');
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  const input = app.getByCSS('[data-release-proxy]');
  const save = app.getByCSS('[data-action=save-release-proxy]');
  await evaluate('mockTaskDelayMs = 2000');
  await input.fill('https://mirror.example.com');
  await save.click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBe(true);
  await input.fill('https://new.example.com');
  await expect.poll(() => evaluate('mockDeviceState.settings.releaseProxy')).toBe('https://mirror.example.com');
  await idle();
  await expect.element(input).toHaveValue('https://new.example.com');
  await save.click();
  await expect.poll(() => evaluate('mockDeviceState.settings.releaseProxy')).toBe('https://new.example.com');
  await idle();
  await reload();
  await expand();
  await idle();
  await app.getByRole('tab', { name: '设置', exact: true }).click();
  await expect.element(input).toHaveValue('https://new.example.com');
  await input.fill('');
  await save.click();
  await expect.poll(() => evaluate('mockDeviceState.settings.releaseProxy')).toBe('');
  await idle();
  expect(evaluate('mockDeviceState.running')).toBe(true);
});
