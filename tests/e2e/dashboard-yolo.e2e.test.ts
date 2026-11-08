import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { commit, stage } from '../../apps/mcp-server/src/plugins/installer.js';
import { PluginStore } from '../../apps/mcp-server/src/plugins/store.js';
import { startStack, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];
const HELLO = path.join(path.resolve(import.meta.dirname, '../..'), 'examples/plugins/hello');

// With the REAL extension: a permission change must be a person's answer, so YOLO mode (which approves everything by itself) must stop it, and
// without YOLO the question appears in the extension and only a person's answer changes the plugin list.
describe.each(kinds)('plugin switch and YOLO — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    stack = await startStack({ beforeStart: async (home) => { const store = new PluginStore(home); commit(store, await stage(store, HELLO)); } });
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/');
  });
  afterAll(async () => { await browser?.close(); await stack?.close(); });
  const origin = () => `http://127.0.0.1:${stack.app.port}`;
  const post = (verb: string) => fetch(`${origin()}/dashboard/plugins/hello/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${stack.app.ctx.config.dashboardToken}`, origin: origin() } });
  const flag = () => new PluginStore(stack.app.ctx.config.configDir).get('hello')!.enabled;

  it('refuses while YOLO is on in the extension, and nothing is asked or changed', async () => {
    await browser.popupMessage('setYolo', { on: true });
    try {
      const r = await post('disable');
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/YOLO/);
      expect(flag()).toBe(true);
      expect((await browser.popupSnapshot()).approvals).toBe(0);
    } finally {
      await browser.popupMessage('setYolo', { on: false });
    }
  });

  it('with YOLO off, asks a person in the extension; a denial changes nothing, an approval switches it off', async () => {
    const denied = post('disable');
    expect(await browser.decideApproval(false)).toMatch(/hello/);
    expect((await denied).status).toBe(403);
    expect(flag()).toBe(true);
    const approved = post('disable');
    expect(await browser.decideApproval(true)).toMatch(/Switch the plugin "hello" OFF/);
    expect((await approved).status).toBe(200);
    expect(flag()).toBe(false);
  });
});
