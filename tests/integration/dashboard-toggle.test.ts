import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commit, stage } from '../../apps/mcp-server/src/plugins/installer.js';
import { PluginStore } from '../../apps/mcp-server/src/plugins/store.js';
import { connectFake, NEVER, type Fake } from '../helpers/fake-extension.js';
import { startStack, type Stack } from '../helpers/stack.js';

const HELLO = path.join(path.resolve(import.meta.dirname, '../..'), 'examples/plugins/hello');
const stacks: Stack[] = [];
const fakes: Fake[] = [];
afterEach(async () => {
  while (fakes.length) fakes.pop()!.close();
  while (stacks.length) await stacks.pop()!.close();
});

async function start(enabled = true) {
  const stack = await startStack({ beforeStart: async (home) => { const store = new PluginStore(home); commit(store, await stage(store, HELLO), enabled); } });
  stacks.push(stack);
  return stack;
}
const browser = async (stack: Stack, onRequest?: (req: any) => unknown) => {
  const fake = await connectFake(stack.app.port, { token: stack.app.ctx.config.extensionToken });
  fake.onRequest = onRequest;
  fakes.push(fake);
  await new Promise((r) => setTimeout(r, 150)); // let the hello be processed
  return fake;
};
const post = (stack: Stack, id: string, verb: 'enable' | 'disable', headers: Record<string, string> = {}) => {
  const origin = `http://127.0.0.1:${stack.app.port}`;
  return fetch(`${origin}/dashboard/plugins/${id}/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${stack.app.ctx.config.dashboardToken}`, origin, ...headers } });
};
const flag = (stack: Stack) => new PluginStore(stack.app.ctx.config.configDir).get('hello')!.enabled;
const asked = (fake: Fake) => fake.received.filter((m) => m.type === 'request' && m.action === 'request_approval');
const row = async (stack: Stack) => (await (await fetch(`http://127.0.0.1:${stack.app.port}/dashboard/data`, { headers: { authorization: `Bearer ${stack.app.ctx.config.dashboardToken}` } })).json() as { plugins: Record<string, unknown>[] }).plugins.find((p) => p.id === 'hello')!;

describe('switching a plugin from the dashboard needs a person', () => {
  it('changes nothing, and says why, when no browser is connected to ask', async () => {
    const stack = await start();
    const r = await post(stack, 'hello', 'disable');
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/No browser is connected.*approval/s);
    expect(flag(stack)).toBe(true);
  });

  it('asks in the extension, says what the plugin may do, and writes only after a yes', async () => {
    const stack = await start(false);
    const fake = await browser(stack, () => ({ approved: true }));
    const r = await post(stack, 'hello', 'enable');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: 'hello', enabled: true, changed: true, restartNeeded: true });
    expect(flag(stack)).toBe(true);
    const [ask] = asked(fake);
    expect(ask.args.title).toBe('Switch the plugin "hello" ON');
    expect(ask.args.detail).toMatch(/dashboard/i);
    expect(ask.args.detail).toMatch(/may:/); // what it was allowed at install, in plain words
    expect(ask.args.detail).toMatch(/restarts/);
    // The page shows it as waiting for a restart, not as vanished.
    expect(await row(stack)).toMatchObject({ state: 'restart', enabled: true });
  });

  it('keeps a running plugin loaded but marks it off-after-restart once switched off', async () => {
    const stack = await start();
    await browser(stack, () => ({ approved: true }));
    expect((await post(stack, 'hello', 'disable')).status).toBe(200);
    expect(flag(stack)).toBe(false);
    expect(await row(stack)).toMatchObject({ state: 'loaded', enabled: false });
    // ...and it can be switched back before the restart.
    expect((await post(stack, 'hello', 'enable')).status).toBe(200);
    expect(await row(stack)).toMatchObject({ state: 'loaded', enabled: true });
  });

  it('changes nothing when the person denies', async () => {
    const stack = await start();
    const fake = await browser(stack, () => ({ approved: false }));
    const r = await post(stack, 'hello', 'disable');
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/nothing was changed/i);
    expect(flag(stack)).toBe(true);
    expect(asked(fake)).toHaveLength(1);
  });

  it('changes nothing when the browser cannot answer (error, or a reply that is not a clear yes)', async () => {
    const stack = await start();
    await browser(stack, () => { throw Object.assign(new Error('Cancelled while waiting for approval'), { code: 'CANCELLED' }); });
    const r = await post(stack, 'hello', 'disable');
    expect(r.status).toBe(409);
    expect(flag(stack)).toBe(true);
    for (const reply of [{}, { approved: 'true' }, { approved: 1 }, null]) {
      stacks.length = 0;
      const s2 = await start();
      await browser(s2, () => reply);
      expect((await post(s2, 'hello', 'disable')).status, JSON.stringify(reply)).toBe(403);
      expect(flag(s2)).toBe(true);
      await s2.close();
    }
  });

  it('does not ask at all when the plugin is already in the state requested', async () => {
    const stack = await start();
    const fake = await browser(stack, () => ({ approved: true }));
    const r = await post(stack, 'hello', 'enable');
    expect(await r.json()).toMatchObject({ ok: true, changed: false });
    expect(asked(fake)).toHaveLength(0);
  });

  it('puts one question at a time in front of the person, and frees the slot when the request is given up', async () => {
    const stack = await start();
    const fake = await browser(stack, () => NEVER);
    const ac = new AbortController();
    const origin = `http://127.0.0.1:${stack.app.port}`;
    const waiting = fetch(`${origin}/dashboard/plugins/hello/disable`, { method: 'POST', headers: { authorization: `Bearer ${stack.app.ctx.config.dashboardToken}`, origin }, signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    const second = await post(stack, 'hello', 'disable');
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/waiting for your approval/);
    expect(asked(fake).length).toBeGreaterThanOrEqual(1);
    expect(flag(stack)).toBe(true);
    ac.abort();
    await waiting;
  }, 20_000);

  it('refuses an unknown, malformed or non-plugin id without asking anyone', async () => {
    const stack = await start();
    const fake = await browser(stack, () => ({ approved: true }));
    for (const id of ['nope', 'Hello', 'a', 'x'.repeat(40), 'hello%2Fx', 'hello;rm', 'he%6clo%00', '%E0%A4%A', '%']) {
      const r = await post(stack, id, 'disable');
      expect(r.status, id).toBe(404);
    }
    expect(asked(fake)).toHaveLength(0);
    expect(flag(stack)).toBe(true);
  });
});
