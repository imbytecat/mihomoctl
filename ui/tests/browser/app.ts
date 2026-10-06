import { beforeEach, afterEach, expect } from 'vitest';
import {
  page,
  locators,
  type Locator,
  type FrameLocator,
} from 'vitest/browser';

// Use Vitest's supported locator extension for existing plugin data attributes.
declare module 'vitest/browser' {
  interface LocatorSelectors {
    getByCSS(selector: string): Locator;
  }
}
locators.extend({ getByCSS: (selector: string) => `css=${selector}` });

export let frame: HTMLIFrameElement;
export let app: FrameLocator;
let errors: string[];
function captureError(event: MessageEvent) {
  if (
    event.source === frame.contentWindow &&
    event.origin === location.origin &&
    event.data?.type === 'ufi-test-error'
  ) {
    errors.push(event.data.message);
  }
}
beforeEach(async () => {
  // A Browser Mode page is shared within a test file. Reset only our fixture state.
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('ufi-mock-')) sessionStorage.removeItem(key);
  }
  localStorage.removeItem('mihomoctl-open');
  errors = [];
  await page.viewport(1280, 900);
  frame = document.createElement('iframe');
  frame.dataset.testid = 'ufi-app';
  frame.title = 'UFI host';
  frame.style.cssText = 'width:1280px;height:900px;border:0;display:block';
  document.body.style.margin = '0';
  window.addEventListener('message', captureError);
  document.body.append(frame);
  app = page.frameLocator(page.getByTestId('ufi-app'));
});
afterEach(() => {
  window.removeEventListener('message', captureError);
  frame.remove();
  expect(errors).toEqual([]);
});
export function evaluate<T = unknown>(expression: string): T {
  return (frame.contentWindow as Window & typeof globalThis).eval(
    expression,
  ) as T;
}
export async function idle() {
  await expect
    .element(app.getByCSS('[data-gateway-body]'))
    .not.toHaveAttribute('aria-busy', 'true');
  const close = app.getByCSS(
    '[data-sonner-toast][data-removed=false] [data-close-button]',
  );
  while (close.elements().length) {
    await close.first().click();
    await expect
      .poll(
        () =>
          app.getByCSS('[data-sonner-toast][data-removed=true]').elements()
            .length,
      )
      .toBe(0);
  }
}
export async function leaveLogs(tab = '配置') {
  await app.getByRole('tab', { name: tab, exact: true }).click();
  await expect.element(app.getByCSS('[data-log-panel]')).not.toBeVisible();
  await idle();
}
/** Override YAML as shown by CodeMirror: one .cm-line per document line, placeholder excluded. */
export function yamlText() {
  return [...app.getByCSS('#ufi-controller-yaml').element().querySelectorAll('.cm-line')]
    .map((line) => [...line.childNodes]
      .filter((node) => !(node as Element).classList?.contains('cm-placeholder'))
      .map((node) => node.textContent)
      .join(''))
    .join('\n');
}
/** Opens the plugin if needed; it remembers being expanded across reloads. */
export async function expand() {
  const summary = app.getByCSS('[data-plugin] > summary');
  await expect.element(summary).toBeVisible();
  if (!(app.getByCSS('[data-plugin]').element() as HTMLDetailsElement).open) await summary.click();
  await expect.element(app.getByCSS('[data-gateway-body]')).toBeVisible();
}
export async function open(state: string) {
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  );
  frame.src = `/tests/browser/host.html?state=${state}`;
  await loaded;
  await expand();
  await idle();
}
export async function reload() {
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  );
  frame.contentWindow!.location.reload();
  await loaded;
  // Every caller had expanded the plugin, which must survive the reload.
  await expect.element(app.getByCSS('[data-gateway-body]')).toBeVisible();
}
