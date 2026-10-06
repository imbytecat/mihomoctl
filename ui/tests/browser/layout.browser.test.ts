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
    // Fine pointers get 14px; coarse (touch) pointers get 16px to avoid focus zoom.
    await expect
      .element(app.getByCSS('#ufi-controller-yaml'))
      .toHaveStyle({ fontSize: '14px' });
    await expect
      .element(app.getByCSS('#ufi-boot'))
      .toHaveStyle({ width: '48px' });
    await expect
      .poll(() => evaluate('document.documentElement.scrollWidth'))
      .toBeLessThanOrEqual(width);
    await app.getByRole('tab', { name: '日志', exact: true }).click();
    const dialog = app.getByCSS('[data-log-panel]');
    await expect.element(dialog).toBeVisible();
    const bounds = dialog.element().getBoundingClientRect();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(app.getByCSS('[data-output]').element().getBoundingClientRect().height).toBeLessThanOrEqual(384);
    expect(bounds!.width).toBeLessThanOrEqual(width - 32);
    // Fullscreen must escape the plugin's container query and cover the whole viewport.
    await app.getByRole('button', { name: '全屏查看', exact: true }).click();
    await expect
      .poll(() => {
        const full = app.getByCSS('[data-log-panel][data-expanded]').element().getBoundingClientRect();
        return [full.x, full.y, full.width, full.height];
      })
      .toEqual([0, 0, width, 900]);
    await app.getByRole('button', { name: '退出全屏', exact: true }).click();
    await expect.element(app.getByCSS('[data-log-panel][data-expanded]')).not.toBeInTheDocument();
    await app.getByRole('tab', { name: '配置', exact: true }).click();
    await expect.element(dialog).not.toBeVisible();
  });
}
