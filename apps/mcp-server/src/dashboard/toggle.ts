import { BrowserForgeError } from '@browserforge/shared';
import { describePermissions, type PluginManifest } from '@browserforge/plugin-sdk';
import type { ServerContext } from '../context.js';

/**
 * Switching a plugin on or off from the dashboard. The page cannot do it by itself: the change waits for a person to approve it in the browser
 * extension, like every other consequential action, and nothing is written unless they do. It only flips the "enabled" flag in the plugin list.
 * It never installs a plugin, never changes what a plugin was allowed to do (that stays exactly what was approved at install), and the running
 * server keeps its current tools until it restarts.
 */

export interface ToggleResult { status: number; body: Record<string, unknown> }

/** One change at a time: a second request must not pile up approval prompts in front of the person. */
const busy = new WeakSet<ServerContext>();

const APPROVAL_MS = 120_000;

export async function togglePlugin(ctx: ServerContext, id: string, enable: boolean, signal: AbortSignal): Promise<ToggleResult> {
  const rec = ctx.pluginStore.get(id);
  if (!rec || rec.kind !== 'plugin') return { status: 404, body: { error: 'No such plugin' } };
  if (rec.enabled === enable) return { status: 200, body: { ok: true, id, enabled: enable, changed: false } };
  if (busy.has(ctx)) return { status: 409, body: { error: 'Another change is waiting for your approval in the browser. Answer it, or wait for it to time out.' } };

  let browserId: string;
  try {
    browserId = ctx.hub.resolvePeer().id;
  } catch (e) {
    const why = e instanceof BrowserForgeError ? e.message : 'No browser is connected.';
    return { status: 409, body: { error: `${why} This change needs your approval in the BrowserForge extension, so connect it first (or use the terminal command).` } };
  }

  busy.add(ctx);
  try {
    // What the plugin may do is read from what was approved at install, never from the plugin's own files.
    const may = describePermissions({ id, settings: {}, permissions: rec.granted } as unknown as PluginManifest);
    const title = `Switch the plugin "${id}" ${enable ? 'ON' : 'OFF'}`;
    const detail = `Asked from the BrowserForge dashboard. ${enable ? `Once on, it may: ${may.join('; ')}.` : ''} It takes effect when the server restarts. If you did not ask for this, deny it.`.replace(/\s+/g, ' ').trim();
    const answer = (await ctx.hub.call('request_approval', { title, detail: detail.slice(0, 480), timeoutMs: APPROVAL_MS }, { timeoutMs: APPROVAL_MS + 5_000, signal, browserId })) as { approved?: boolean };
    if (answer?.approved !== true) return { status: 403, body: { error: 'Not approved, so nothing was changed.' } };
  } catch (e) {
    if (signal.aborted) return { status: 499, body: { error: 'Cancelled' } };
    const why = e instanceof BrowserForgeError ? e.message : 'The approval did not come back.';
    return { status: 409, body: { error: `${why} Nothing was changed.` } };
  } finally {
    busy.delete(ctx);
  }
  // The list may have changed while the person decided: write only if the plugin is still there.
  if (!ctx.pluginStore.setEnabled(id, enable)) return { status: 404, body: { error: 'No such plugin' } };
  ctx.logger.info('plugin switched from the dashboard', { id, enabled: enable });
  return { status: 200, body: { ok: true, id, enabled: enable, changed: true, restartNeeded: true } };
}
