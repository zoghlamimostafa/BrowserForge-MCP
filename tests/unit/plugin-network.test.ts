import { afterEach, describe, expect, it, vi } from 'vitest';
import { describePermissions, normalizePermissions, parseManifest, samePermissions } from '@browserforge/plugin-sdk';
import { createTestApi } from '@browserforge/plugin-sdk/testing';
import { isPublicAddress, localHostReason } from '../../packages/plugin-sdk/src/address.js';

// Hermetic: every public name resolves to one public address; tests that need another answer override it.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '140.82.112.6', family: 4 }]) }));

const base = { id: 'network-demo', toolPrefix: 'netdemo', description: 'Network test', permissions: { network: ['https://api.github.com'] } };
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllGlobals(); while (cleanups.length) cleanups.pop()!(); });
function api(grant: 'manifest' | 'none' = 'manifest') {
  const t = createTestApi(base, { grant }); cleanups.push(t.cleanup); return t.api;
}

describe('public network permissions', () => {
  it('normalizes legacy grants without introducing a permission, and detects origin changes', () => {
    const old = { browser: false, files: { read: [], write: [] }, exec: [] };
    expect(normalizePermissions(old)).toEqual(old);
    expect(samePermissions(old, { ...old, network: [] })).toBe(true);
    expect(samePermissions(old, { ...old, network: ['https://api.github.com'] })).toBe(false);
    expect(samePermissions({ ...old, network: ['https://a.test'] }, { ...old, network: ['https://b.test'] })).toBe(false);
    const manifest = parseManifest({ ...base, permissions: { network: ['https://api.github.com', 'https://api.github.com'] } });
    expect(manifest.permissions.network).toEqual(['https://api.github.com']);
    expect(describePermissions(manifest)).toEqual(['Read public data from: https://api.github.com (HTTPS GET/HEAD only; no credentials or redirects)']);
  });

  it.each(['http://api.github.com', 'https://*.github.com', 'https://api.github.com/', 'https://api.github.com/path', 'https://api.github.com?q=x', 'https://user:secret@api.github.com', 'https://api.github.com#fragment'])('rejects a non-origin permission: %s', (origin) => {
    expect(() => parseManifest({ ...base, permissions: { network: [origin] } })).toThrow(/exact HTTPS origin/);
  });

  it('only sends public GET/HEAD with fixed headers, no credentials and no redirect following', async () => {
    const request = vi.fn(async (_url: URL, _opts: RequestInit) => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    const response = await api().fetch('https://api.github.com/repos/demo/example');
    expect(response.body).toBe('{"ok":true}');
    expect(request.mock.calls[0]).toEqual([new URL('https://api.github.com/repos/demo/example'), expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'BrowserForge-plugin' } })]);
    await api().fetch('https://api.github.com/repos/demo/example', { method: 'HEAD' });
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: 'HEAD' });
  });

  it.each(['https://evil.test', 'https://api.github.com.evil.test/x', 'http://api.github.com/x', 'https://user:secret@api.github.com/x'])('refuses an unapproved URL before sending: %s', async (url) => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(api().fetch(url)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses an ungranted origin, write methods and invalid timeouts before sending', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(api('none').fetch('https://api.github.com')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const method of ['POST', 'PUT', 'DELETE']) await expect(api().fetch('https://api.github.com', { method: method as 'GET' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const timeoutMs of [NaN, Infinity, 0, 30_001]) await expect(api().fetch('https://api.github.com', { timeoutMs })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses redirects rather than contacting their destination', async () => {
    const request = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }));
    vi.stubGlobal('fetch', request);
    await expect(api().fetch('https://api.github.com')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Network redirects are refused' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds the decoded body even when content-length is absent or false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-length': '1' } })));
    await expect(api().fetch('https://api.github.com')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('times out a request and returns a safe error without reflecting network details', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: URL, opts: RequestInit) => new Promise((_resolve, reject) => {
      opts.signal!.addEventListener('abort', () => reject(new Error('network secret')), { once: true });
    })));
    await expect(api().fetch('https://api.github.com', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT', message: 'Network request timed out' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network secret'); }));
    await expect(api().fetch('https://api.github.com')).rejects.toMatchObject({ code: 'INTERNAL', message: 'Public network request failed' });
  });
});

describe('public-only network origins', () => {
  const PRIVATE_HOSTS = [
    'localhost', 'app.localhost', 'printer.local', 'router.lan', 'nas.home.arpa', 'intranet', // names that can only be local
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[fe80::1%25eth0]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:169.254.169.254]', '[64:ff9b::a00:1]', '[2002:c0a8:101::1]', '[ff02::1]',
    '0x7f.1', '2130706433', // other spellings of 127.0.0.1: the URL parser normalises them, and they must still be caught
  ];
  it.each(PRIVATE_HOSTS)('refuses %s in a manifest', (host) => {
    expect(() => parseManifest({ ...base, permissions: { network: [`https://${host}`] } })).toThrow(/exact HTTPS origin/);
  });

  it.each(['api.github.com', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[::ffff:808:808]'])('accepts the public host %s', (host) => {
    expect(() => parseManifest({ ...base, permissions: { network: [`https://${host}`] } })).not.toThrow();
  });

  it.each(['https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://10.1.2.3', 'https://169.254.169.254', 'https://[fe80::1]'])('refuses %s at request time even when an older grant allows it', async (origin) => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const t = createTestApi({ ...base, permissions: { network: ['https://api.github.com'] } }, { grant: 'manifest' }); cleanups.push(t.cleanup);
    const sdk = await import('../../packages/plugin-sdk/src/network.js');
    await expect(sdk.fetchPublic([origin], `${origin}/latest/meta-data`)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('not a public address') });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([['127.0.0.1'], ['10.0.0.8'], ['169.254.169.254'], ['::1'], ['fd00::5'], ['::ffff:192.168.0.1']])('refuses a public name that resolves to %s, before sending', async (address) => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }] as never);
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(api().fetch('https://api.github.com/x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('not a public address') });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses when only one of several answers is private', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '140.82.112.6', family: 4 }, { address: '10.0.0.1', family: 4 }] as never);
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(api().fetch('https://api.github.com/x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('turns a DNS failure or an empty answer into a safe retryable error, and stops waiting at the timeout', async () => {
    const { lookup } = await import('node:dns/promises');
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    vi.mocked(lookup).mockRejectedValueOnce(new Error('ENOTFOUND secret-host'));
    await expect(api().fetch('https://api.github.com/x')).rejects.toMatchObject({ code: 'INTERNAL', message: 'Public network request failed' });
    vi.mocked(lookup).mockResolvedValueOnce([] as never);
    await expect(api().fetch('https://api.github.com/x')).rejects.toMatchObject({ code: 'INTERNAL' });
    vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}) as never);
    await expect(api().fetch('https://api.github.com/x', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not look up a literal public address, and checks it directly', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockClear();
    const request = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', request);
    const t = createTestApi({ ...base, permissions: { network: ['https://8.8.8.8'] } }, { grant: 'manifest' }); cleanups.push(t.cleanup);
    await t.api.fetch('https://8.8.8.8/x');
    expect(request).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('the address classifier itself', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.255.255.255', '100.64.0.0', '100.127.255.255', '127.0.0.1', '127.9.9.9', '169.254.0.1', '169.254.169.254', '172.16.0.0', '172.31.255.255', '192.0.0.1', '192.0.2.7', '192.168.0.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::', 'fdff:ffff::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:a9fe:a9fe::1',
    'not-an-ip', '', '1.2.3', '1.2.3.256', '::g', '1:2:3:4:5:6:7:8:9',
  ])('is not public: %j', (address) => { expect(isPublicAddress(address)).toBe(false); });

  it.each([
    '8.8.8.8', '1.1.1.1', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.1', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1', 'fbff::1', 'fe7f::1',
  ])('is public: %s', (address) => { expect(isPublicAddress(address)).toBe(true); });

  it('judges host names by their spelling, and brackets and zones do not hide an address', () => {
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'x.local', 'x.internal', 'x.lan', 'x.home.arpa', 'intranet', '[::1]', '[fe80::1%eth0]', '127.0.0.1']) expect(localHostReason(h), h).toBeTruthy();
    for (const h of ['api.github.com', 'github.com.', '8.8.8.8', '[2606:4700:4700::1111]', 'localhost.example.com', 'notlocal.example.org']) expect(localHostReason(h), h).toBeUndefined();
  });
});
