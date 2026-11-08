import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseManifest, type PluginManifest } from '@browserforge/plugin-sdk';
import { expandHome, isPathSpec, npmInvocation } from '@browserforge/shared';
import type { PluginStore } from './store.js';
import type { InstalledPlugin } from './types.js';

const run = promisify(execFile);

export interface Staged {
  manifest: PluginManifest;
  packageName: string;
  version: string;
  source: string;
  stagingDir: string;
  pkgRoot: string;
}

/** The manifest lives in package.json under "browserforge", or in browserforge-plugin.json next to it. */
export function readManifest(pkgRoot: string): { manifest: PluginManifest; version: string; main?: string } {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as { version?: string; main?: string; browserforge?: unknown };
  const sidecar = path.join(pkgRoot, 'browserforge-plugin.json');
  const raw = pj.browserforge ?? (fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : undefined);
  if (!raw) throw new Error('This package is not a BrowserForge plugin: add a "browserforge" field to package.json (or a browserforge-plugin.json)');
  return { manifest: parseManifest(raw), version: pj.version ?? '0.0.0', main: pj.main };
}

/** Anything that could be read as an npm option, or that has whitespace, is refused before it reaches npm. */
export function checkSpec(spec: string): string {
  // A folder path may contain spaces (npm is run without a shell, so that is safe); package names and URLs may not.
  const isPath = isPathSpec(spec);
  if (!spec || spec.startsWith('-') || spec.length > 300 || (!isPath && /\s/.test(spec))) throw new Error(`Not a valid plugin source: '${spec.slice(0, 60)}'`);
  return spec;
}

/**
 * Replace a symlinked package folder by a real copy of what it points to (without .git and node_modules), so the installed files are the ones that were read.
 * A link inside the folder that points outside it is refused: copying it would pull unrelated files into the plugin store.
 */
function materializeLink(pkgRoot: string): void {
  if (!fs.lstatSync(pkgRoot).isSymbolicLink()) return;
  const target = fs.realpathSync(pkgRoot);
  const inside = (p: string) => { const rel = path.relative(target, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  const skip = (p: string) => path.relative(target, p).split(path.sep).some((part) => part === 'node_modules' || part === '.git'); // judged inside the folder, not by where the folder sits
  const check = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (skip(p)) continue;
      if (e.isSymbolicLink()) {
        if (!inside(fs.realpathSync(p))) throw new Error(`'${path.relative(target, p)}' is a link that points outside the package. Replace it with the real file and try again.`);
      } else if (e.isDirectory()) check(p);
    }
  };
  check(target);
  fs.unlinkSync(pkgRoot);
  fs.cpSync(target, pkgRoot, { recursive: true, dereference: true, filter: (p) => !skip(p) });
}

/** npm links a local-folder plugin with a relative symlink; moving the staging folder would leave it dangling. */
function absolutizeLinks(nodeModules: string): void {
  const fix = (entry: string) => {
    if (!fs.lstatSync(entry).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(entry), fs.readlinkSync(entry));
    fs.unlinkSync(entry);
    fs.symlinkSync(target, entry, process.platform === 'win32' ? 'junction' : 'dir'); // a junction needs no special privilege on Windows
    return true;
  };
  for (const name of fs.readdirSync(nodeModules)) {
    if (name === '.bin' || name.startsWith('.')) continue;
    const entry = path.join(nodeModules, name);
    if (fix(entry)) continue;
    if (name.startsWith('@')) for (const inner of fs.readdirSync(entry)) fix(path.join(entry, inner));
  }
}

/**
 * Download a plugin into a staging folder and read its manifest, without running any of its code.
 * `npm install --ignore-scripts` means install hooks never run; the plugin's own code only runs once it is loaded, after consent.
 */
export async function stage(store: PluginStore, source: string): Promise<Staged> {
  checkSpec(source);
  const stagingDir = fs.mkdtempSync(path.join(store.root, '.staging-'));
  try {
    fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify({ name: 'browserforge-plugin-host', private: true }));
    const spec = isPathSpec(source) ? path.resolve(expandHome(source)) : source;
    const npm = npmInvocation();
    await run(npm.command, [...npm.args, 'install', spec, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error', '--prefix', stagingDir], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const deps = Object.keys((JSON.parse(fs.readFileSync(path.join(stagingDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {});
    if (deps.length !== 1) throw new Error('Expected exactly one package to be installed');
    absolutizeLinks(path.join(stagingDir, 'node_modules'));
    const packageName = deps[0]!;
    const pkgRoot = path.join(stagingDir, 'node_modules', ...packageName.split('/'));
    let read = readManifest(pkgRoot);
    // A skill is approved as the exact text that was shown. A local folder is linked, not copied, so later edits would reach the agent with no prompt: copy it instead,
    // then read the manifest again from the copy, so what is shown is what was copied.
    if (read.manifest.kind === 'skill') {
      materializeLink(pkgRoot);
      read = readManifest(pkgRoot);
    }
    const { manifest, version } = read;
    return { manifest, packageName, version, source, stagingDir, pkgRoot };
  } catch (e) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const msg = e instanceof Error ? e.message : String(e);
    const detail = (e as { stderr?: string }).stderr?.toString().trim().split('\n').slice(-3).join(' ');
    throw new Error(detail ? `${msg.split('\n')[0]} (${detail})` : msg, { cause: e });
  }
}

export function discard(staged: Staged): void {
  fs.rmSync(staged.stagingDir, { recursive: true, force: true });
}

/** After the user approved: move the staged package into place and record exactly what was granted. */
export function commit(store: PluginStore, staged: Staged, enabled = true): InstalledPlugin {
  const id = staged.manifest.id;
  const dir = store.pluginDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(dir, 'pkg'), { recursive: true, force: true });
  fs.renameSync(staged.stagingDir, path.join(dir, 'pkg'));
  const rec: InstalledPlugin = { id, kind: staged.manifest.kind, source: staged.source, packageName: staged.packageName, version: staged.version, enabled, granted: staged.manifest.permissions, installedAt: new Date().toISOString() };
  store.upsert(rec);
  return rec;
}

/** Search npm for packages tagged with a keyword (`browserforge-plugin` or `browserforge-skill`). Only called when the user runs `plugin search` or `skill search`. */
export async function searchNpm(words: string, fetchFn: typeof fetch = fetch, keyword: 'browserforge-plugin' | 'browserforge-skill' = 'browserforge-plugin'): Promise<{ name: string; version: string; description: string; publisher?: string; date?: string }[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`keywords:${keyword} ${words}`.trim())}&size=20`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`npm search failed (${res.status})`);
  const body = (await res.json()) as { objects?: { package: { name: string; version: string; description?: string; date?: string; publisher?: { username?: string } } }[] };
  return (body.objects ?? []).map((o) => ({
    name: o.package.name, version: o.package.version, description: o.package.description ?? '',
    ...(o.package.publisher?.username ? { publisher: o.package.publisher.username } : {}),
    ...(o.package.date ? { date: o.package.date } : {}),
  }));
}
