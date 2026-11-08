#!/usr/bin/env node
// Uploads a built extension to the Chrome Web Store or Firefox Add-ons, from a release workflow. Read docs/STORE_RELEASE.md first.
//
//   node scripts/store-upload.mjs chrome  --zip artifacts/browserforge-chrome-store-0.2.1.zip [--upload [--publish]]
//   node scripts/store-upload.mjs firefox --zip artifacts/browserforge-firefox-0.2.1.zip --source artifacts/browserforge-source-0.2.1.zip [--upload [--publish]]
//
// It does nothing to a store unless you say so, and it says so in two separate steps:
//   (nothing)              check the package only: the version, no manifest key, no test files. No credentials are read, nothing is sent.
//   --upload               send the package to the store as a draft / for validation. The store does not review or publish it.
//   --upload --publish     also submit it for review (Chrome: publish; Firefox: create the new listed version). A person still has to wait for the review.
// Credentials come only from environment variables (repository or environment secrets in the workflow) and are never printed.
// Written from the stores' documentation and tested against fake servers (tests/unit/store-upload.test.ts); it has not been run against the real stores.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const URLS = {
  cwsApi: 'https://chromewebstore.googleapis.com',
  cwsToken: 'https://oauth2.googleapis.com/token',
  amo: 'https://addons.mozilla.org',
};

const fail = (message) => { throw Object.assign(new Error(message), { storeUploadFailure: true }); };
const clip = (s, n = 300) => String(s).replace(/\s+/g, ' ').slice(0, n);

// ---------- reading the package: a small zip reader, so no extra tool or dependency is needed ----------

/** Names and contents of what is in a zip (stored or deflated entries only, which is all `web-ext build` writes). */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('Not a zip file (no end-of-archive record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail('Damaged zip (bad central directory)');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    return fail(`Unsupported zip compression (${e.method}) for ${name}`);
  };
  return { names: [...entries.keys()], read };
}

/** Everything that must be true of a package before it goes near a store. Returns the problems; empty means fine. */
export function packageProblems(zipPath, kind, version) {
  const out = [];
  let zip;
  try { zip = readZip(fs.readFileSync(zipPath)); } catch (e) { return [`${path.basename(zipPath)}: ${e.message}`]; }
  const raw = zip.read('manifest.json');
  if (!raw) return ['manifest.json is missing from the package'];
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { return ['manifest.json is not valid JSON']; }
  if (m.version !== version) out.push(`the package is version ${m.version}, not ${version}`);
  if (m.manifest_version !== 3) out.push('manifest_version is not 3');
  if (kind === 'chrome' && 'key' in m) out.push('the Chrome store build must not carry a manifest "key" (use the *-store-* zip)');
  if (kind === 'chrome' && m.browser_specific_settings) out.push('the Chrome build carries Firefox-only settings');
  if (kind === 'firefox' && !m.browser_specific_settings?.gecko?.id) out.push('the Firefox build has no browser_specific_settings.gecko.id');
  if (m.web_accessible_resources) out.push('the manifest has web_accessible_resources (the release checklist forbids it)');
  const forbidden = zip.names.filter((n) => /(^|\/)(e2e-config\.json|\.env[^/]*|[^/]+\.map|[^/]+\.pem)$/.test(n));
  if (forbidden.length) out.push(`files that must not ship: ${forbidden.slice(0, 5).join(', ')}`);
  return out;
}

// ---------- small helpers ----------

async function call(fetchFn, url, init, what) {
  let res;
  try { res = await fetchFn(url, init); } catch (e) { return fail(`${what}: could not reach the server (${clip(e.message, 120)})`); }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) fail(`${what} failed: HTTP ${res.status} ${clip(body?.error?.message ?? body?.detail ?? body?.error ?? text)}`);
  return body ?? {};
}

const need = (env, names) => {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) fail(`Missing credentials (set these as secrets): ${missing.join(', ')}`);
};

async function poll(check, { sleep, tries, what }) {
  for (let i = 0; i < tries; i++) {
    const r = await check();
    if (r !== undefined) return r;
    await sleep(i < 3 ? 2_000 : 10_000);
  }
  return fail(`${what}: still not done after waiting; check the store's dashboard`);
}

// ---------- Chrome Web Store (API v2) ----------

export async function chromeUpload({ zipPath, publish, env, urls = URLS, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  need(env, ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID', 'CWS_ITEM_ID']);
  const item = `${urls.cwsApi}/v2/publishers/${encodeURIComponent(env.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(env.CWS_ITEM_ID)}`;
  const token = (await call(fetchFn, urls.cwsToken, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET, refresh_token: env.CWS_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  }, 'Getting a Chrome Web Store access token')).access_token;
  if (!token) fail('Getting a Chrome Web Store access token: the answer had no access_token');
  const auth = { authorization: `Bearer ${token}` };

  log('Chrome Web Store: uploading the package (a draft; nothing is published yet)...');
  const up = await call(fetchFn, `${urls.cwsApi}/upload/v2/publishers/${encodeURIComponent(env.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(env.CWS_ITEM_ID)}:upload`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/zip' }, body: fs.readFileSync(zipPath),
  }, 'Chrome Web Store upload');
  let state = String(up.uploadState ?? '');
  if (/PROGRESS/i.test(state)) {
    state = await poll(async () => {
      const s = String((await call(fetchFn, `${item}:fetchStatus`, { headers: auth }, 'Chrome Web Store status')).lastAsyncUploadState ?? '');
      return /PROGRESS/i.test(s) ? undefined : s;
    }, { sleep, tries: 40, what: 'Chrome Web Store upload' });
  }
  if (!/^SUCCEED|^SUCCESS/i.test(state)) fail(`Chrome Web Store upload did not succeed (state: ${clip(state || 'unknown', 60)})`);
  log(`Chrome Web Store: uploaded (version ${up.crxVersion ?? 'unknown'}).`);
  if (!publish) return { uploaded: true, published: false };

  log('Chrome Web Store: submitting for review...');
  const pub = await call(fetchFn, `${item}:publish`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }) }, 'Chrome Web Store publish');
  log(`Chrome Web Store: submitted (${clip(pub.state ?? 'state not reported', 60)}). Google reviews it; it is not live yet.`);
  return { uploaded: true, published: true, state: pub.state };
}

// ---------- Firefox Add-ons (AMO API v5) ----------

const b64url = (b) => Buffer.from(b).toString('base64url');
/** A short-lived JWT (HS256), as the AMO API asks for: five minutes at most. */
export function amoToken(issuer, secret, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: issuer, jti: crypto.randomUUID(), iat: now, exp: now + 60 }));
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

export async function firefoxUpload({ zipPath, sourcePath, publish, env, urls = URLS, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  need(env, ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']);
  const addon = env.AMO_ADDON || 'browserforge';
  const headers = () => ({ authorization: `JWT ${amoToken(env.AMO_JWT_ISSUER, env.AMO_JWT_SECRET)}` });
  const blob = (p) => new Blob([fs.readFileSync(p)]);

  log('Firefox Add-ons: uploading the package for validation (nothing is submitted yet)...');
  const form = new FormData();
  form.set('upload', blob(zipPath), path.basename(zipPath));
  form.set('channel', 'listed');
  const first = await call(fetchFn, `${urls.amo}/api/v5/addons/upload/`, { method: 'POST', headers: headers(), body: form }, 'Firefox Add-ons upload');
  const uuid = first.uuid;
  if (!uuid) fail('Firefox Add-ons upload: the answer had no upload id');
  const done = await poll(async () => {
    const u = await call(fetchFn, `${urls.amo}/api/v5/addons/upload/${encodeURIComponent(uuid)}/`, { headers: headers() }, 'Firefox Add-ons validation');
    return u.processed ? u : undefined;
  }, { sleep, tries: 40, what: 'Firefox Add-ons validation' });
  if (!done.valid) {
    const errors = (done.validation?.messages ?? []).filter((m) => m.type === 'error').slice(0, 10).map((m) => `  - ${clip(m.message ?? m.id ?? 'error', 160)}`);
    fail(`Firefox Add-ons validation failed (${done.validation?.errors ?? errors.length} errors):\n${errors.join('\n')}`);
  }
  log(`Firefox Add-ons: validated (${done.validation?.warnings ?? 0} warnings).`);
  if (!publish) return { uploaded: true, published: false };

  log('Firefox Add-ons: creating the new listed version (this submits it for review)...');
  const v = new FormData();
  v.set('upload', uuid);
  if (sourcePath) v.set('source', blob(sourcePath), path.basename(sourcePath));
  const made = await call(fetchFn, `${urls.amo}/api/v5/addons/addon/${encodeURIComponent(addon)}/versions/`, { method: 'POST', headers: headers(), body: v }, 'Firefox Add-ons create version');
  log(`Firefox Add-ons: version ${made.version ?? 'unknown'} submitted (id ${made.id ?? '?'}). Mozilla reviews it; it is not live yet.`);
  return { uploaded: true, published: true, version: made.version };
}

// ---------- command line ----------

export function parseArgs(argv) {
  const [store, ...rest] = argv;
  const a = { store, upload: false, publish: false };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === '--upload') a.upload = true;
    else if (k === '--publish') a.publish = true;
    else if (k === '--zip' || k === '--source' || k === '--version') { a[k.slice(2)] = rest[++i]; if (!a[k.slice(2)]) fail(`${k} needs a value`); }
    else fail(`Unknown option ${k}`);
  }
  return a;
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  const a = parseArgs(argv);
  if (a.store !== 'chrome' && a.store !== 'firefox') fail('Usage: store-upload.mjs <chrome|firefox> --zip FILE [--source FILE] [--upload [--publish]]');
  if (a.publish && !a.upload) fail('--publish needs --upload (a package is uploaded before it can be submitted)');
  if (!a.zip) fail('--zip FILE is required');
  if (!fs.existsSync(a.zip)) fail(`${a.zip} does not exist`);
  if (a.source && !fs.existsSync(a.source)) fail(`${a.source} does not exist`);
  const version = a.version ?? JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

  const problems = packageProblems(a.zip, a.store, version);
  if (problems.length) fail(`${path.basename(a.zip)} is not ready for the ${a.store === 'chrome' ? 'Chrome Web Store' : 'Firefox Add-ons'}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  log(`${path.basename(a.zip)}: version ${version}, checks passed.`);
  if (a.store === 'firefox' && !a.source) log('Note: no --source given. Mozilla asks for the source of a bundled extension; pass the browserforge-source zip.');
  if (!a.upload) { log('Dry run: nothing was sent to the store. Add --upload to send it, and --publish to submit it for review.'); return { uploaded: false, published: false }; }

  const common = { zipPath: a.zip, publish: a.publish, env, log, urls: deps.urls, fetchFn: deps.fetchFn, sleep: deps.sleep };
  return a.store === 'chrome' ? chromeUpload(common) : firefoxUpload({ ...common, sourcePath: a.source });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.storeUploadFailure ? e.message : `store-upload failed: ${clip(e.message)}`);
    process.exit(1);
  });
}
