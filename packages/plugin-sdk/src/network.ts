import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BrowserForgeError } from '@browserforge/shared';
import { isPublicAddress, localHostReason } from './address.js';

export interface PluginFetchOptions { method?: 'GET' | 'HEAD'; timeoutMs?: number }
export interface PluginFetchResponse { status: number; headers: Record<string, string>; body: string }

const MAX_BODY = 1024 * 1024;

const resolveAll = (host: string): Promise<{ address: string }[]> => lookup(host, { all: true, verbatim: true });

const NOT_PUBLIC = 'Network origin is not a public address (loopback, private and link-local hosts are refused)';

/** Rejects a promise when the signal fires, so a slow DNS answer cannot outlive the timeout or a cancel. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

/** Read public data from an explicitly approved origin. This restricts the API, not arbitrary plugin code. */
export async function fetchPublic(origins: string[], input: string, opts: PluginFetchOptions = {}, signal?: AbortSignal): Promise<PluginFetchResponse> {
  let url: URL;
  try { url = new URL(input); } catch { throw new BrowserForgeError('INVALID_ARGUMENTS', 'Expected an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin)) {
    throw new BrowserForgeError('PERMISSION_DENIED', 'Network origin was not granted, or the URL contains credentials');
  }
  if (localHostReason(url.hostname)) throw new BrowserForgeError('PERMISSION_DENIED', NOT_PUBLIC);
  const method = opts.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') throw new BrowserForgeError('PERMISSION_DENIED', 'Only public GET/HEAD requests are allowed');
  const ms = opts.timeoutMs ?? 10_000;
  if (!Number.isFinite(ms) || ms < 100 || ms > 30_000) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Network timeout must be between 100 and 30000 ms');
  const timeout = AbortSignal.timeout(ms);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    // A public-looking name must also resolve to public addresses only: refuse if any answer is loopback, private or link-local.
    if (!isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
      const answers = await until(resolveAll(url.hostname), combined);
      if (!answers.length) throw new BrowserForgeError('INTERNAL', 'Public network request failed', { retryable: true });
      if (answers.some((a) => !isPublicAddress(a.address))) throw new BrowserForgeError('PERMISSION_DENIED', NOT_PUBLIC);
    }
    const response = await fetch(url, {
      method, redirect: 'manual', credentials: 'omit', signal: combined,
      headers: { accept: 'application/json', 'user-agent': 'BrowserForge-plugin' },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new BrowserForgeError('PERMISSION_DENIED', 'Network redirects are refused');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) {
            await reader.cancel();
            throw new BrowserForgeError('LIMIT_EXCEEDED', 'Network response exceeds 1 MB');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks).toString('utf8') };
  } catch (error) {
    if (error instanceof BrowserForgeError) throw error;
    if (signal?.aborted) throw new BrowserForgeError('CANCELLED', 'Network request cancelled');
    if (timeout.aborted) throw new BrowserForgeError('TIMEOUT', 'Network request timed out', { retryable: true });
    throw new BrowserForgeError('INTERNAL', 'Public network request failed', { retryable: true });
  }
}
