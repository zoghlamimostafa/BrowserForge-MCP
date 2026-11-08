import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];

// A closed shadow root is hidden from the page's own scripts. The extension reaches it through the browser's `dom.openOrClosedShadowRoot`,
// which runs in the extension's isolated world: no JavaScript is put in the page.
describe.each(kinds)('closed shadow roots — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/');
    expect((await stack.call('browser_navigate', { url: stack.demo.url + '/shadow-closed' })).isError).toBe(false);
  });
  afterAll(async () => { await browser?.close(); await stack?.close(); });
  const inside = () => browser.evalInPage<{ value: string; clicks: number; secret: string; sent: number }>('return window.__closed()');

  it('is really closed for the page (the control for this test)', async () => {
    expect(await browser.evalInPage<boolean>('return document.getElementById("cf").shadowRoot === null')).toBe(true);
  });

  const call = (n: string, a: Record<string, unknown> = {}) => stack.call(n, a);
  const ok = async (n: string, a: Record<string, unknown> = {}) => {
    const r = await call(n, a);
    expect(r.isError, `${n} failed: ${JSON.stringify(r.data)}`).toBe(false);
    return r.data;
  };
  const inner = (d: any) => d.data ?? d;
  const elements = async () => inner(await ok('browser_get_interactive_elements')).elements as any[];
  const find = async (needle: string) => (await elements()).find((e) => JSON.stringify(e).includes(needle));

  it('lists the controls inside the closed root, each once', async () => {
    const all = await elements();
    for (const needle of ['Closed email', 'Save closed']) {
      expect(all.filter((e) => JSON.stringify(e).includes(needle)).length, `${needle} in ${JSON.stringify(all).slice(0, 500)}`).toBe(1);
    }
    const table = inner(await ok('browser_get_interactive_elements', { format: 'table' }));
    expect(table.rows.some((r: string) => /Save closed/.test(r))).toBe(true);
  });

  it('fills and clicks controls inside the closed root, by ref', async () => {
    const field = await find('Closed email');
    const button = await find('Save closed');
    expect(field?.ref).toBeTruthy();
    expect(button?.ref).toBeTruthy();
    await ok('browser_fill_field', { ref: field.ref, value: 'closed@example.test' });
    await ok('browser_click', { ref: button.ref });
    expect(await inside()).toMatchObject({ value: 'closed@example.test', clicks: 1 });
  });

  it('can address the same controls by selector through the closed root', async () => {
    await ok('browser_fill_field', { selector: '#ce', value: 'second@example.test' });
    await ok('browser_click', { selector: '#cb' });
    expect(await inside()).toMatchObject({ value: 'second@example.test', clicks: 2 });
  });

  // The protections are decided per element, so they must hold the same way for controls reached through a closed root.
  describe('protections still apply to controls inside a closed root', () => {
    it('never returns a password value, in the element list or in the forms view', async () => {
      const all = await elements();
      const pw = all.find((e) => JSON.stringify(e).includes('Closed secret'));
      expect(pw, JSON.stringify(all).slice(0, 400)).toBeTruthy();
      expect(JSON.stringify(await ok('browser_get_interactive_elements'))).not.toContain('hunter2-prefilled');
      expect(JSON.stringify(await ok('browser_get_forms'))).not.toContain('hunter2-prefilled');
      expect(JSON.stringify(await ok('browser_get_page_text'))).not.toContain('hunter2-prefilled');
    });

    it('does not let the agent type into a password field unless a person approves, and a denial changes nothing', async () => {
      const pw = await find('Closed secret');
      const attempt = call('browser_fill_field', { ref: pw.ref, value: 'agent-typed-secret' });
      let asked = false;
      try { await browser.decideApproval(false); asked = true; } catch { /* refused without a prompt is also fine */ }
      const result = await attempt;
      expect(result.isError, `asked=${asked} ${JSON.stringify(result.data)}`).toBe(true);
      expect((await inside()).secret).toBe('');
    });

    it('holds a risky click ("Send") for approval, and a denial prevents it', async () => {
      const send = await find('Send closed');
      const before = (await inside()).sent;
      const attempt = call('browser_click', { ref: send.ref });
      expect(await browser.decideApproval(false)).toBeTruthy();
      expect((await attempt).isError).toBe(true);
      expect((await inside()).sent).toBe(before);
    });
  });
});
