import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { app, frame, evaluate, open } from './app';

for (const width of [360, 1280]) {
  test(`Tailwind host isolation and log panel layout at ${width}px`, async () => {
    await page.viewport(width, 900);
    frame.style.width = `${width}px`;
    await open('ready');
    await app.getByRole('tab', { name: '设置', exact: true }).click();
    await expect
      .element(app.getByCSS('#host-probe'))
      .toHaveStyle({ display: 'block', marginTop: '19px' });
    const start = app.getByRole('button', { name: '启动代理', exact: true });
    await expect
      .element(start)
      .toHaveStyle({
        marginTop: '0px',
        borderTopStyle: 'solid',
        borderTopWidth: '1px',
        fontSize: '14px',
        backgroundImage: 'none',
      });
    await expect.element(app.getByRole('tab', { name: '设置', exact: true })).toHaveStyle({
      marginTop: '0px', backgroundImage: 'none', fontSize: '14px', borderTopWidth: '0px',
    });
    await expect
      .element(app.getByCSS('#ufi-controller-yaml'))
      .toHaveStyle({ fontSize: '16px' });
    await expect
      .element(app.getByCSS('#ufi-boot'))
      .toHaveStyle({ width: '48px' });
    await expect
      .poll(() => evaluate('document.documentElement.scrollWidth'))
      .toBeLessThanOrEqual(width);
    await app.getByRole('button', { name: '更多操作', exact: true }).click();
    await app.getByRole('menuitem', { name: '运行日志', exact: true }).click();
    const dialog = app.getByCSS('[data-log-panel]');
    await expect.element(dialog).toBeVisible();
    const bounds = dialog.element().getBoundingClientRect();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(app.getByCSS('[data-output]').element().getBoundingClientRect().height).toBeLessThanOrEqual(320);
    expect(bounds!.width).toBeLessThanOrEqual(width - 32);
    await app.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect.element(dialog).not.toBeVisible();
  });
}
