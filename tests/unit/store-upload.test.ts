import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module
import { amoToken, main, packageProblems, parseArgs, readZip } from '../../scripts/store-upload.mjs';

// ---- a tiny zip writer (stored or deflated), so the tests need no zip tool ----
const crcTable = Array.from({ length: 256 }, (_v, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files: Record<string, string>, deflate = false): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text); const data = deflate ? zlib.deflateRawSync(raw) : raw; const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, n, data); central.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-store-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const manifest = (extra: object = {}) => JSON.stringify({ manifest_version: 3, name: 'BrowserForge', version: '0.2.1', ...extra });
const write = (name: string, files: Record<string, string>, deflate = false) => { const p = path.join(dir, name); fs.writeFileSync(p, makeZip(files, deflate)); return p; };
const chromeZip = write('chrome.zip', { 'manifest.json': manifest(), 'background.js': '//' });
const firefoxZip = write('firefox.zip', { 'manifest.json': manifest({ browser_specific_settings: { gecko: { id: 'browserforge@browserforge.local' } } }), 'background.js': '//' });
const sourceZip = write('source.zip', { 'README.md': 'source' });

describe('reading and checking a package', () => {
  it('reads stored and deflated entries', () => {
    for (const deflate of [false, true]) {
      const z = readZip(makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'x'.repeat(5000) }, deflate));
      expect(z.names).toEqual(['a.txt', 'dir/b.txt']);
      expect(z.read('a.txt').toString()).toBe('hello');
      expect(z.read('dir/b.txt').length).toBe(5000);
      expect(z.read('nope')).toBeNull();
    }
    expect(() => readZip(Buffer.from('not a zip at all, really'))).toThrow(/Not a zip/);
  });

  it('accepts a good Chrome and a good Firefox package', () => {
    expect(packageProblems(chromeZip, 'chrome', '0.2.1')).toEqual([]);
    expect(packageProblems(firefoxZip, 'firefox', '0.2.1')).toEqual([]);
  });

  it.each([
    ['the wrong version', { 'manifest.json': manifest({ version: '0.2.0' }) }, 'chrome', /version 0\.2\.0, not 0\.2\.1/],
    ['a manifest key (Chrome)', { 'manifest.json': manifest({ key: 'MIIB' }) }, 'chrome', /must not carry a manifest "key"/],
    ['Firefox-only settings in the Chrome build', { 'manifest.json': manifest({ browser_specific_settings: { gecko: { id: 'x' } } }) }, 'chrome', /Firefox-only/],
    ['no gecko id (Firefox)', { 'manifest.json': manifest() }, 'firefox', /gecko\.id/],
    ['manifest version 2', { 'manifest.json': JSON.stringify({ manifest_version: 2, version: '0.2.1' }) }, 'chrome', /not 3/],
    ['web_accessible_resources', { 'manifest.json': manifest({ web_accessible_resources: [] }) }, 'chrome', /web_accessible_resources/],
    ['the test config', { 'manifest.json': manifest(), 'e2e-config.json': '{}' }, 'chrome', /e2e-config\.json/],
    ['a source map', { 'manifest.json': manifest(), 'js/background.js.map': '{}' }, 'chrome', /\.map/],
    ['a private key file', { 'manifest.json': manifest(), 'key.pem': 'x' }, 'chrome', /key\.pem/],
    ['an .env file', { 'manifest.json': manifest(), '.env': 'X=1' }, 'chrome', /\.env/],
    ['no manifest', { 'a.txt': 'x' }, 'chrome', /manifest\.json is missing/],
    ['a broken manifest', { 'manifest.json': '{nope' }, 'chrome', /not valid JSON/],
  ])('refuses %s', (_n, files, kind, re) => {
    expect(packageProblems(write(`bad-${crypto.randomUUID()}.zip`, files as Record<string, string>), kind, '0.2.1').join('\n')).toMatch(re as RegExp);
  });

  it('refuses a file that is not a zip, and one that does not exist', () => {
    const p = path.join(dir, 'junk.zip'); fs.writeFileSync(p, 'junk junk junk junk junk junk');
    expect(packageProblems(p, 'chrome', '0.2.1').join()).toMatch(/Not a zip/);
  });

  it('checks the real built store zips when they exist', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const c = path.join(root, 'artifacts', `browserforge-chrome-store-${version}.zip`);
    const f = path.join(root, 'artifacts', `browserforge-firefox-${version}.zip`);
    if (fs.existsSync(c)) expect(packageProblems(c, 'chrome', version)).toEqual([]);
    if (fs.existsSync(f)) expect(packageProblems(f, 'firefox', version)).toEqual([]);
  });
});

describe('the command line', () => {
  const noNetwork = { fetchFn: () => { throw new Error('the network must not be touched'); }, log: () => undefined };
  it('does nothing to a store without --upload, reads no credentials, and says so', async () => {
    const lines: string[] = [];
    const r = await main(['chrome', '--zip', chromeZip, '--version', '0.2.1'], {}, { ...noNetwork, log: (l: string) => lines.push(l) });
    expect(r).toEqual({ uploaded: false, published: false });
    expect(lines.join('\n')).toMatch(/Dry run: nothing was sent/);
  });
  it('refuses --publish without --upload, bad options, missing files and a package that is not ready', async () => {
    await expect(main(['chrome', '--zip', chromeZip, '--publish'], {}, noNetwork)).rejects.toThrow(/--publish needs --upload/);
    await expect(main(['chrome', '--zip', chromeZip, '--bogus'], {}, noNetwork)).rejects.toThrow(/Unknown option/);
    await expect(main(['chrome'], {}, noNetwork)).rejects.toThrow(/--zip FILE is required/);
    await expect(main(['chrome', '--zip', path.join(dir, 'nope.zip')], {}, noNetwork)).rejects.toThrow(/does not exist/);
    await expect(main(['opera', '--zip', chromeZip], {}, noNetwork)).rejects.toThrow(/Usage/);
    await expect(main(['chrome', '--zip', chromeZip, '--version', '9.9.9', '--upload'], {}, noNetwork)).rejects.toThrow(/not ready.*version 0\.2\.1, not 9\.9\.9/s);
    expect(parseArgs(['firefox', '--zip', 'a', '--source', 'b', '--upload'])).toMatchObject({ store: 'firefox', zip: 'a', source: 'b', upload: true, publish: false });
  });
  it('names the missing credentials without touching the network', async () => {
    await expect(main(['chrome', '--zip', chromeZip, '--version', '0.2.1', '--upload'], { CWS_CLIENT_ID: 'x' }, noNetwork)).rejects.toThrow(/Missing credentials.*CWS_CLIENT_SECRET.*CWS_REFRESH_TOKEN/s);
    await expect(main(['firefox', '--zip', firefoxZip, '--version', '0.2.1', '--upload'], {}, noNetwork)).rejects.toThrow(/AMO_JWT_ISSUER, AMO_JWT_SECRET/);
  });
});

// ---- fake stores ----
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
let server: http.Server; let base = ''; let seen: Seen[] = []; let handler: (req: Seen, res: http.ServerResponse) => void;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) }; seen.push(s); handler(s, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => { seen = []; });
const send = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const urls = () => ({ cwsApi: base, cwsToken: `${base}/token`, amo: base });
const noSleep = async () => undefined;

const CWS = { CWS_CLIENT_ID: 'client-id-AAA', CWS_CLIENT_SECRET: 'client-secret-BBB', CWS_REFRESH_TOKEN: 'refresh-token-CCC', CWS_PUBLISHER_ID: 'pub1', CWS_ITEM_ID: 'item1' };
const AMO = { AMO_JWT_ISSUER: 'user:123:456', AMO_JWT_SECRET: 'jwt-secret-DDD', AMO_ADDON: 'browserforge' };
const secrets = [...Object.values(CWS), AMO.AMO_JWT_SECRET];

describe('Chrome Web Store (fake server)', () => {
  const run = (extra: string[], env = CWS, log: string[] = []) => main(['chrome', '--zip', chromeZip, '--version', '0.2.1', '--upload', ...extra], env, { urls: urls(), sleep: noSleep, log: (l: string) => log.push(l) });
  const routes = (over: { upload?: unknown; status?: unknown[]; publish?: unknown } = {}) => {
    const status = [...(over.status ?? [])];
    handler = (req, res) => {
      if (req.url === '/token') return send(res, 200, { access_token: 'AT-123' });
      if (req.headers.authorization !== 'Bearer AT-123') return send(res, 401, { error: { message: 'bad token' } });
      if (req.url === '/upload/v2/publishers/pub1/items/item1:upload') return send(res, 200, over.upload ?? { uploadState: 'SUCCEEDED', crxVersion: '0.2.1' });
      if (req.url === '/v2/publishers/pub1/items/item1:fetchStatus') return send(res, 200, status.shift() ?? { lastAsyncUploadState: 'SUCCEEDED' });
      if (req.url === '/v2/publishers/pub1/items/item1:publish') return send(res, 200, over.publish ?? { state: 'PENDING_REVIEW' });
      return send(res, 404, {});
    };
  };

  it('uploads a draft and stops there without --publish', async () => {
    routes();
    const r = await run([]);
    expect(r).toEqual({ uploaded: true, published: false });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /token', 'POST /upload/v2/publishers/pub1/items/item1:upload']);
    const up = seen[1]!;
    expect(up.headers['content-type']).toBe('application/zip');
    expect(up.body.equals(fs.readFileSync(chromeZip))).toBe(true); // exactly the package that was checked
    const form = new URLSearchParams(seen[0]!.body.toString());
    expect(Object.fromEntries(form)).toEqual({ client_id: 'client-id-AAA', client_secret: 'client-secret-BBB', refresh_token: 'refresh-token-CCC', grant_type: 'refresh_token' });
  });

  it('submits for review only with --publish, after the upload', async () => {
    routes();
    const log: string[] = [];
    const r = await run(['--publish'], CWS, log);
    expect(r).toMatchObject({ uploaded: true, published: true, state: 'PENDING_REVIEW' });
    expect(seen.map((s) => s.url)).toEqual(['/token', '/upload/v2/publishers/pub1/items/item1:upload', '/v2/publishers/pub1/items/item1:publish']);
    expect(JSON.parse(seen[2]!.body.toString())).toEqual({ publishType: 'DEFAULT_PUBLISH' });
    expect(log.join('\n')).toMatch(/not live yet/);
  });

  it('waits while the store is still processing the upload, then continues', async () => {
    routes({ upload: { uploadState: 'IN_PROGRESS' }, status: [{ lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }] });
    expect(await run([])).toEqual({ uploaded: true, published: false });
    expect(seen.filter((s) => s.url.endsWith(':fetchStatus'))).toHaveLength(2);
  });

  it('stops, and does not publish, when the upload fails or ends up failed', async () => {
    routes({ upload: { uploadState: 'FAILED' } });
    await expect(run(['--publish'])).rejects.toThrow(/did not succeed \(state: FAILED\)/);
    expect(seen.some((s) => s.url.endsWith(':publish'))).toBe(false);
    seen = [];
    routes({ upload: { uploadState: 'IN_PROGRESS' }, status: [{ lastAsyncUploadState: 'FAILED' }] });
    await expect(run(['--publish'])).rejects.toThrow(/FAILED/);
    expect(seen.some((s) => s.url.endsWith(':publish'))).toBe(false);
  });

  it('reports a refused token or publish clearly, and never prints a secret', async () => {
    handler = (_req, res) => send(res, 401, { error: { message: 'invalid_grant' } });
    const log: string[] = [];
    let message = '';
    try { await run(['--publish'], CWS, log); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/access token failed: HTTP 401 invalid_grant/);
    routes({ publish: undefined });
    handler = ((orig) => (req: Seen, res: http.ServerResponse) => (req.url!.endsWith(':publish') ? send(res, 400, { error: { message: 'Item has pending review' } }) : orig(req, res)))(handler);
    try { await run(['--publish'], CWS, log); } catch (e) { message += (e as Error).message; }
    expect(message).toMatch(/Chrome Web Store publish failed: HTTP 400 Item has pending review/);
    for (const s of secrets) { expect(message).not.toContain(s); expect(log.join('\n')).not.toContain(s); }
  });

  it('says it could not reach the server instead of a stack trace', async () => {
    await expect(main(['chrome', '--zip', chromeZip, '--version', '0.2.1', '--upload'], CWS, { urls: { cwsApi: 'http://127.0.0.1:1', cwsToken: 'http://127.0.0.1:1/token', amo: base }, sleep: noSleep, log: () => undefined })).rejects.toThrow(/could not reach the server/);
  });
});

describe('Firefox Add-ons (fake server)', () => {
  const run = (extra: string[], env = AMO, log: string[] = []) => main(['firefox', '--zip', firefoxZip, '--version', '0.2.1', '--upload', ...extra], env, { urls: urls(), sleep: noSleep, log: (l: string) => log.push(l) });
  const verify = (auth: string | undefined) => {
    const m = /^JWT (.+)$/.exec(auth ?? '');
    if (!m) return false;
    const [h, b, sig] = m[1]!.split('.');
    const ok = crypto.createHmac('sha256', AMO.AMO_JWT_SECRET).update(`${h}.${b}`).digest('base64url') === sig;
    const p = JSON.parse(Buffer.from(b!, 'base64url').toString());
    return ok && JSON.parse(Buffer.from(h!, 'base64url').toString()).alg === 'HS256' && p.iss === AMO.AMO_JWT_ISSUER && p.exp - p.iat <= 300 && typeof p.jti === 'string';
  };
  const routes = (over: { processedAfter?: number; valid?: boolean } = {}) => {
    let polls = 0;
    handler = (req, res) => {
      if (!verify(req.headers.authorization as string)) return send(res, 401, { detail: 'Signature verification failed.' });
      if (req.method === 'POST' && req.url === '/api/v5/addons/upload/') return send(res, 201, { uuid: 'up-1', processed: false });
      if (req.url === '/api/v5/addons/upload/up-1/') {
        const processed = ++polls > (over.processedAfter ?? 0);
        const valid = over.valid ?? true;
        return send(res, 200, { uuid: 'up-1', processed, valid: processed ? valid : null, validation: processed ? { errors: valid ? 0 : 1, warnings: 2, messages: valid ? [] : [{ type: 'error', message: 'Bad manifest key' }] } : null });
      }
      if (req.method === 'POST' && req.url === '/api/v5/addons/addon/browserforge/versions/') return send(res, 201, { id: 77, version: '0.2.1' });
      return send(res, 404, {});
    };
  };
  const form = async (s: Seen) => new Response(new Uint8Array(s.body), { headers: { 'content-type': s.headers['content-type'] as string } }).formData();

  it('makes a short-lived HS256 token the API will accept', () => {
    const t = amoToken('user:1:2', 'sekrit', 1_000_000);
    const [h, b, sig] = t.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    expect(p).toMatchObject({ iss: 'user:1:2', iat: 1_000_000, exp: 1_000_060 });
    expect(sig).toBe(crypto.createHmac('sha256', 'sekrit').update(`${h}.${b}`).digest('base64url'));
  });

  it('uploads for validation only, without --publish: no version is created', async () => {
    routes({ processedAfter: 1 });
    expect(await run([])).toEqual({ uploaded: true, published: false });
    expect(seen.some((s) => s.url.includes('/versions/'))).toBe(false);
    const f = await form(seen[0]!);
    expect(f.get('channel')).toBe('listed');
    expect(Buffer.from(await (f.get('upload') as File).arrayBuffer()).equals(fs.readFileSync(firefoxZip))).toBe(true);
    expect(seen.filter((s) => s.url === '/api/v5/addons/upload/up-1/')).toHaveLength(2); // it waited for validation
  });

  it('with --publish creates the new version from that upload, with the source', async () => {
    routes();
    const r = await run(['--source', sourceZip, '--publish']);
    expect(r).toMatchObject({ uploaded: true, published: true, version: '0.2.1' });
    const last = seen[seen.length - 1]!;
    expect(last.url).toBe('/api/v5/addons/addon/browserforge/versions/');
    const f = await form(last);
    expect(f.get('upload')).toBe('up-1');
    expect(Buffer.from(await (f.get('source') as File).arrayBuffer()).equals(fs.readFileSync(sourceZip))).toBe(true);
  });

  it('stops before creating a version when validation fails, and lists the errors', async () => {
    routes({ valid: false });
    await expect(run(['--publish'])).rejects.toThrow(/validation failed \(1 errors\):\n\s+- Bad manifest key/);
    expect(seen.some((s) => s.url.includes('/versions/'))).toBe(false);
  });

  it('is refused cleanly with a wrong secret, and never prints a secret', async () => {
    routes();
    const log: string[] = [];
    let message = '';
    try { await run(['--publish'], { ...AMO, AMO_JWT_SECRET: 'wrong-secret-EEE' }, log); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/Firefox Add-ons upload failed: HTTP 401 Signature verification failed/);
    for (const s of [...secrets, 'wrong-secret-EEE']) { expect(message).not.toContain(s); expect(log.join('\n')).not.toContain(s); }
  });
});
