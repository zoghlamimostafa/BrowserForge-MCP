import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { commit, stage } from '../../apps/mcp-server/src/plugins/installer.js';
import { PluginStore } from '../../apps/mcp-server/src/plugins/store.js';
import { findChromium } from '../helpers/browsers.js';
import { connectFake, NEVER, type Fake } from '../helpers/fake-extension.js';
import { startStack, type Stack } from '../helpers/stack.js';

// The real dashboard page, in a real browser, under its strict Content-Security-Policy. The BrowserForge extension is played by a fake that answers the question.
const HELLO = path.join(path.resolve(import.meta.dirname, '../..'), 'examples/plugins/hello');

describe('dashboard: switching a plugin from the page', () => {
  let stack: Stack;
  let browser: Browser;
  let page: Page;
  let fake: Fake;
  let answer: { approved: boolean } = { approved: true };
  const csp: string[] = [];
  const flag = () => new PluginStore(stack.app.ctx.config.configDir).get('hello')!.enabled;

  beforeAll(async () => {
    stack = await startStack({ beforeStart: async (home) => { const store = new PluginStore(home); commit(store, await stage(store, HELLO)); } });
    fake = await connectFake(stack.app.port, { token: stack.app.ctx.config.extensionToken });
    fake.onRequest = () => answer;
    await new Promise((r) => setTimeout(r, 150));
    browser = await chromium.launch({ executablePath: findChromium() });
    page = await browser.newPage();
    page.on('console', (m) => { if (/content security policy/i.test(m.text())) csp.push(m.text()); });
    await page.goto(`http://127.0.0.1:${stack.app.port}/dashboard#t=${encodeURIComponent(stack.app.ctx.config.dashboardToken)}`);
    await page.getByRole('button', { name: 'Plugins' }).click();
  });
  afterAll(async () => { await browser?.close(); fake?.close(); await stack?.close(); });

  const card = () => page.locator('.card', { has: page.locator('h2', { hasText: 'hello' }) });
  const text = (loc: ReturnType<typeof card>) => expect.poll(() => loc.innerText(), { timeout: 10_000 });
  const disabled = (loc: ReturnType<typeof card>) => expect.poll(() => loc.isDisabled(), { timeout: 10_000 });

  it('shows a switch on a plugin card, with where the approval happens', async () => {
    await card().getByRole('button', { name: 'Switch off' }).waitFor({ state: 'visible' });
    await text(card()).toContain('approval in the browser extension');
  });

  it('a denial changes nothing and says so', async () => {
    answer = { approved: false };
    await card().getByRole('button', { name: 'Switch off' }).click();
    await text(card().getByRole('status')).toMatch(/not approved.*nothing was changed/is);
    expect(flag()).toBe(true);
    await disabled(card().getByRole('button', { name: 'Switch off' })).toBe(false);
  });

  it('an approval switches it off, and the card says it takes effect after a restart', async () => {
    answer = { approved: true };
    await card().getByRole('button', { name: 'Switch off' }).click();
    await text(card().getByRole('status')).toMatch(/approved.*restarts/is);
    expect(flag()).toBe(false);
    await text(card().locator('.badge')).toContain('off after restart');
    await card().getByRole('button', { name: 'Switch on' }).waitFor({ state: 'visible' });
  });

  it('keeps the waiting message while the person has not answered, and disables the button meanwhile', async () => {
    fake.onRequest = () => NEVER; // the person has not answered
    await card().getByRole('button', { name: 'Switch on' }).click();
    await text(card().getByRole('status')).toMatch(/waiting for your approval/i);
    await disabled(card().getByRole('button', { name: 'Switch on' })).toBe(true);
    await new Promise((r) => setTimeout(r, 6000)); // the page refreshes every 5 s; the message must survive it
    await text(card().getByRole('status')).toMatch(/waiting for your approval/i);
    expect(flag()).toBe(false);
  }, 30_000);

  it('the Content-Security-Policy blocked nothing the page needs', () => {
    expect(csp).toEqual([]);
  });
});
