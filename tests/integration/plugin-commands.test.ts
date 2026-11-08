import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginAdd, pluginConfig, pluginNew, pluginUpdate, pluginValidate, plain, skillAdd, skillExport, skillNew, skillSearch, type Io } from '../../apps/mcp-server/src/plugins/commands.js';
import { PluginStore } from '../../apps/mcp-server/src/plugins/store.js';
import { discoverSkills } from '../../apps/mcp-server/src/plugins/skills.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HELLO = path.join(ROOT, 'examples/plugins/hello');
const execAsync = promisify(execFile);
const tmps: string[] = [];
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true }); });
const tmp = (inRepo = false) => { const d = fs.mkdtempSync(inRepo ? path.join(ROOT, 'node_modules', '.cache-cmd-') : path.join(os.tmpdir(), 'bf-cmd-')); tmps.push(d); return d; };
function io(answers: boolean[] = []): Io & { text(): string; questions: string[] } {
  let out = '';
  const questions: string[] = [];
  return { out: (t) => { out += t; }, ask: async (q) => { questions.push(q); return answers.shift() ?? false; }, text: () => out, questions };
}
const copyHello = (changes: (pkg: any) => void) => {
  const d = tmp();
  fs.cpSync(HELLO, d, { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
  changes(pj);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pj));
  return d;
};

describe('plugin add / update', () => {
  it('requires fresh consent when a legacy plugin adds a public network origin', async () => {
    const src = copyHello(() => undefined);
    const store = new PluginStore(tmp());
    await pluginAdd(store, src, io([true]));
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    pkg.version = '0.2.0';
    pkg.browserforge.permissions.network = ['https://api.github.com'];
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg));
    const decline = io([false]);
    expect(await pluginUpdate(store, 'hello', decline)).toBe(false);
    expect(decline.text()).toMatch(/PERMISSIONS CHANGED[\s\S]*Read public data from: https:\/\/api.github.com/);
    expect(decline.questions[0]).toMatch(/Approve the new permissions/);
    expect(store.get('hello')?.granted.network).toBeUndefined();
    expect(await pluginUpdate(store, 'hello', io([true]))).toBe(true);
    expect(store.get('hello')?.granted.network).toEqual(['https://api.github.com']);
  });
  it('shows the permissions and a warning, installs only after a yes, and cleans up after a no', async () => {
    const store = new PluginStore(tmp());
    const no = io([false]);
    expect(await pluginAdd(store, HELLO, no)).toBe(false);
    expect(no.text()).toMatch(/Plugin: hello {2}v0\.1\.0/);
    expect(no.text()).toMatch(/Create and change files in: data/);
    expect(no.text()).toMatch(/code that runs on this computer with your user rights/);
    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(store.root).filter((f) => f.startsWith('.staging'))).toEqual([]);

    const yes = io([true]);
    expect(await pluginAdd(store, HELLO, yes)).toBe(true);
    expect(store.list()[0]).toMatchObject({ id: 'hello', enabled: true });
    expect(yes.text()).toMatch(/Restart the BrowserForge server/);
    const again = io([true]);
    expect(await pluginAdd(store, HELLO, again)).toBe(false);
    expect(again.text()).toMatch(/already installed[\s\S]*plugin update hello/);
    expect(again.questions).toEqual([]);
  });

  it('asks again when an update changes the permissions, and keeps the old plugin if you decline', async () => {
    const src = copyHello(() => undefined);
    const store = new PluginStore(tmp());
    await pluginAdd(store, src, io([true]));
    const unchanged = io();
    expect(await pluginUpdate(store, 'hello', unchanged)).toBe(false);
    expect(unchanged.text()).toMatch(/up to date/);

    const pj = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    pj.version = '0.2.0';
    pj.browserforge.permissions = { browser: true, files: { read: ['data'], write: ['data'] }, exec: ['python3'] };
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pj));
    const decline = io([false]);
    expect(await pluginUpdate(store, 'hello', decline)).toBe(false);
    expect(decline.text()).toMatch(/PERMISSIONS CHANGED[\s\S]*Drive your browser[\s\S]*python3/);
    expect(decline.questions[0]).toMatch(/Approve the new permissions/);
    expect(store.get('hello')).toMatchObject({ version: '0.1.0', granted: { browser: false, exec: [] } });

    expect(await pluginUpdate(store, 'hello', io([true]))).toBe(true);
    expect(store.get('hello')).toMatchObject({ version: '0.2.0', granted: { browser: true, exec: ['python3'] } });
  });

  it('refuses an update that turns the plugin into a different one', async () => {
    const src = copyHello(() => undefined);
    const store = new PluginStore(tmp());
    await pluginAdd(store, src, io([true]));
    const pj = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    pj.version = '9.0.0';
    pj.browserforge.id = 'impostor';
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pj));
    await expect(pluginUpdate(store, 'hello', io([true]))).rejects.toThrow(/now provides 'impostor'/);
  });
});

describe('plugin config', () => {
  const withSettings = () => copyHello((pj) => {
    pj.browserforge.settings = { dir: { type: 'path', description: 'A folder', required: true }, limit: { type: 'number', description: 'n', default: 3 }, loud: { type: 'boolean', description: 'b' }, name: { type: 'string', description: 's' } };
    pj.browserforge.permissions = { files: { read: ['setting:dir'], write: ['data'] } };
  });
  it('shows settings, validates types and keys, and confirms folders that become file roots', async () => {
    const store = new PluginStore(tmp());
    await pluginAdd(store, withSettings(), io([true]));
    const view = io();
    await pluginConfig(store, 'hello', [], view);
    expect(view.text()).toMatch(/dir = \(not set\)\s+\[path, required\][\s\S]*limit = 3 \(default\)/);
    const folder = tmp();
    const denied = io([false]);
    await expect(pluginConfig(store, 'hello', [`dir=${folder}`], denied)).rejects.toThrow(/Cancelled/);
    expect(denied.questions[0]).toMatch(/allowed to read setting:dir => /);
    expect(store.settings('hello')).toEqual({});
    await pluginConfig(store, 'hello', [`dir=${folder}`, 'limit=7', 'loud=TRUE', 'name=Ada'], io([true]));
    expect(store.settings('hello')).toEqual({ dir: fs.realpathSync(folder) === folder ? folder : folder, limit: 7, loud: true, name: 'Ada' });
    await pluginConfig(store, 'hello', ['name='], io());
    expect(store.settings('hello').name).toBeUndefined();
    await expect(pluginConfig(store, 'hello', ['limit=abc'], io())).rejects.toThrow(/must be a number/);
    await expect(pluginConfig(store, 'hello', ['loud=maybe'], io())).rejects.toThrow(/true or false/);
    await expect(pluginConfig(store, 'hello', ['nope=1'], io())).rejects.toThrow(/no setting 'nope'. Known: dir, limit, loud, name/);
  });
});

describe('authoring', () => {
  it('a freshly scaffolded plugin validates, installs and passes its own test', async () => {
    const parent = tmp(true); // inside the repo so it can import @browserforge/plugin-sdk
    const out = io();
    const root = pluginNew('my-tool', parent, out);
    expect(path.basename(root)).toBe('browserforge-plugin-my-tool');
    expect(() => pluginNew('my-tool', parent, io())).toThrow(/already exists/);
    expect(() => pluginNew('Bad Id', parent, io())).toThrow(/lowercase/);
    const v = io();
    expect(await pluginValidate(root, v)).toEqual([]);
    expect(v.text()).toMatch(/1 tool\(s\): mytool_hello[\s\S]*Looks good/);
    const test = await execAsync('node', ['--test'], { cwd: root, timeout: 60_000 });
    expect(test.stdout).toMatch(/pass 1/);
    const store = new PluginStore(tmp());
    expect(await pluginAdd(store, root, io([true]))).toBe(true);
  });

  it('validate reports the problems an author needs to fix', async () => {
    const dir = tmp(true);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bad-plugin', version: '1.0.0', type: 'module', main: 'index.js', browserforge: { id: 'bad', toolPrefix: 'bad', description: 'd' } }));
    fs.writeFileSync(path.join(dir, 'index.js'), `import { definePlugin, tool, z } from '@browserforge/plugin-sdk';\nexport default definePlugin({ tools: [tool({ name: 'other_x', description: 'short', input: z.object({}), readOnly: true, run: async () => 1 })] });`);
    const probs = await pluginValidate(dir, io());
    expect(probs.join('\n')).toMatch(/must be named bad_[\s\S]*description of at least 20/);
    const empty = tmp();
    expect((await pluginValidate(empty, io()))[0]).toMatch(/package.json|ENOENT/);
  });
});

describe('skills commands', () => {
  it('creates, installs (after consent), lists and exports a skill', async () => {
    const parent = tmp();
    const config = tmp();
    const root = skillNew('my-skill', parent, io());
    expect(fs.existsSync(path.join(root, 'workflows/example.json'))).toBe(true);
    const decline = io([false]);
    expect(await skillAdd(config, root, decline)).toBe(false);
    expect(decline.text()).toMatch(/written by its author, not by you/);
    expect(fs.existsSync(path.join(config, 'skills'))).toBe(false);
    expect(await skillAdd(config, root, io([true]))).toBe(true);
    const skills = discoverSkills(config, new PluginStore(config), () => undefined);
    expect(skills.map((s) => s.name)).toEqual(['my-skill']);
    expect(Object.keys(skills[0]!.workflows)).toEqual(['example']);
    const dest = skillExport(config, 'my-skill', path.join(parent, 'claude-skills'), io());
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(() => skillExport(config, 'nope', parent, io())).toThrow(/No skill/);
    expect(() => skillNew('Bad Name', parent, io())).toThrow(/lowercase/);
  });
});

describe('the shared skill library: installing and finding skills from npm', () => {
  /** A skill package as it would be published: package.json with kind "skill" and the skill under skills/<name>/. */
  const skillPackage = (opts: { body?: string; description?: string; extra?: (pj: any) => void; noSkill?: boolean } = {}) => {
    const d = tmp();
    const pj: any = { name: 'browserforge-skill-demo', version: '1.0.0', description: 'A demo skill package', keywords: ['browserforge-skill'], browserforge: { id: 'demo-skills', kind: 'skill', description: opts.description ?? 'Demo skills for tests' } };
    opts.extra?.(pj);
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pj));
    if (!opts.noSkill) {
      fs.mkdirSync(path.join(d, 'skills/demo'), { recursive: true });
      fs.writeFileSync(path.join(d, 'skills/demo/SKILL.md'), `---\nname: demo\ndescription: ${opts.description ?? 'Demo skill'}\n---\n${opts.body ?? '# Demo\n\n1. Open the page.\n2. Read it.'}\n`);
    }
    return d;
  };
  const stagingLeft = (store: PluginStore) => fs.readdirSync(store.root).filter((f) => f.startsWith('.staging-'));

  it('shows every line of the instructions before asking, then installs the package as a skill', async () => {
    const body = Array.from({ length: 80 }, (_v, i) => `Step ${i + 1}: do the thing carefully.`).join('\n');
    const store = new PluginStore(tmp());
    const config = tmp();
    const ask = io([true]);
    expect(await skillAdd(config, skillPackage({ body }), ask, store)).toBe(true);
    for (const n of [1, 25, 26, 80]) expect(ask.text()).toContain(`Step ${n}: do the thing carefully.`); // the old display stopped at 25 lines
    expect(ask.text()).toMatch(/written by its author, not by you\), all \d+ lines/);
    expect(ask.text()).toMatch(/is not a program and cannot skip an approval.*Nobody has reviewed it for you/s);
    expect(ask.text()).not.toMatch(/runs on this computer with your user rights|It asks permission to|Adds tools named/); // that is for plugins; a skill is text
    expect(ask.questions[0]).toMatch(/Install the skill package demo-skills \(you have read its instructions above\)/);
    expect(store.get('demo-skills')).toMatchObject({ kind: 'skill', enabled: true });
    expect(discoverSkills(config, store, () => undefined).map((x) => x.name)).toEqual(['demo']);
    expect(stagingLeft(store)).toEqual([]);
  });

  it('installs nothing and cleans up on a no', async () => {
    const store = new PluginStore(tmp());
    expect(await skillAdd(tmp(), skillPackage(), io([false]), store)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(stagingLeft(store)).toEqual([]);
  });

  it('refuses a package that runs code: "skill add" only installs text, and says what to use instead', async () => {
    const store = new PluginStore(tmp());
    const out = io([true]);
    await expect(skillAdd(tmp(), HELLO, out, store)).rejects.toThrow(/is a plugin: it runs code.*browserforge plugin add/s);
    expect(out.questions).toEqual([]); // it never even asked
    expect(store.list()).toEqual([]);
    expect(stagingLeft(store)).toEqual([]);
  });

  it('refuses a skill package that contains no skill, and an unreadable one', async () => {
    const store = new PluginStore(tmp());
    await expect(skillAdd(tmp(), skillPackage({ noSkill: true }), io([true]), store)).rejects.toThrow(/contains no SKILL\.md/);
    expect(store.list()).toEqual([]);
    expect(stagingLeft(store)).toEqual([]);
  });

  it('refuses instructions too long to read before approving, in both ways of installing', async () => {
    const long = Array.from({ length: 450 }, (_v, i) => `line ${i}`).join('\n');
    const store = new PluginStore(tmp());
    await expect(skillAdd(tmp(), skillPackage({ body: long }), io([true]), store)).rejects.toThrow(/too long to read here \(4\d\d lines\)/);
    expect(store.list()).toEqual([]);
    const root = skillNew('long-skill', tmp(), io());
    fs.appendFileSync(path.join(root, 'SKILL.md'), `\n${long}\n`);
    const out = io([true]);
    await expect(skillAdd(tmp(), root, out, store)).rejects.toThrow(/too long to read here/);
    expect(out.questions).toEqual([]);
  });

  it('prints terminal control characters as dots, so nothing can hide or rewrite what you are approving', async () => {
    const evil = '# Demo\nSafe looking line\n\u001b[2K\u001b[1A\rYou can trust me\u001b]0;title\u0007\u202eesrever\u200b hidden';
    const store = new PluginStore(tmp());
    const ask = io([false]);
    await skillAdd(tmp(), skillPackage({ body: evil, description: 'Nice \u001b[31mred\u001b[0m skill' }), ask, store);
    // eslint-disable-next-line no-control-regex
    expect(ask.text()).not.toMatch(/[\u001b\u0007\r\u202e\u200b]/);
    expect(ask.text()).toContain('Safe looking line');
    const folder = skillNew('evil-skill', tmp(), io());
    fs.appendFileSync(path.join(folder, 'SKILL.md'), '\n\u001b[2Jhidden\u0008\u0008\n');
    const ask2 = io([false]);
    await skillAdd(tmp(), folder, ask2);
    // eslint-disable-next-line no-control-regex
    expect(ask2.text()).not.toMatch(/[\u001b\u0008]/);
  });

  it('shows the instructions when the same package is added with "plugin add" too (that path used to show only the permissions)', async () => {
    const store = new PluginStore(tmp());
    const ask = io([false]);
    await pluginAdd(store, skillPackage({ body: '# Demo\nA very specific instruction line.' }), ask);
    expect(ask.text()).toContain('A very specific instruction line.');
    expect(store.list()).toEqual([]);
  });

  it('a skill folder is still installed as before (the existing path is unchanged)', async () => {
    const config = tmp();
    const root = skillNew('folder-skill', tmp(), io());
    expect(await skillAdd(config, root, io([true]), new PluginStore(tmp()))).toBe(true);
    expect(fs.existsSync(path.join(config, 'skills/folder-skill/SKILL.md'))).toBe(true);
  });

  describe('skill search', () => {
    const answer = (objects: unknown[]) => (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ objects })); }) as never;
    const urls: string[] = [];
    it('searches by the skill keyword only, and shows who published what and when, with a plain warning', async () => {
      urls.length = 0;
      const out = io();
      await skillSearch('csv export', out, answer([{ package: { name: 'browserforge-skill-csv', version: '1.2.0', description: 'Export tables', date: '2026-10-01T12:00:00.000Z', publisher: { username: 'ada' } } }]));
      expect(decodeURIComponent(urls[0]!)).toContain('keywords:browserforge-skill csv export');
      expect(decodeURIComponent(urls[0]!)).not.toContain('browserforge-plugin');
      expect(out.text()).toContain('browserforge-skill-csv@1.2.0  by ada, published 2026-10-01');
      expect(out.text()).toMatch(/Nobody has reviewed these/);
      expect(out.text()).toContain('browserforge skill add <name>');
    });
    it('cleans what the packages say, and handles no results and a failing search', async () => {
      const out = io();
      await skillSearch('', out, answer([{ package: { name: 'x', version: '1.0.0', description: 'Evil \u001b[2Kline\nbreak'.padEnd(400, '!'), publisher: { username: 'bob\u001b[1A' } } }]));
      // eslint-disable-next-line no-control-regex
      expect(out.text()).not.toMatch(/[\u001b]/);
      expect(out.text().split('\n').find((l) => l.startsWith('    '))!.length).toBeLessThanOrEqual(170);
      const none = io();
      await skillSearch('zzz', none, answer([]));
      expect(none.text()).toMatch(/Nothing found/);
      await expect(skillSearch('x', io(), (async () => new Response('no', { status: 503 })) as never)).rejects.toThrow(/npm search failed \(503\)/);
    });
  });

  it('plain() keeps tabs and newlines and turns control and direction-changing characters into dots', () => {
    expect(plain('a\tb\nc')).toBe('a\tb\nc');
    expect(plain('x\u001b[2Ky\u0007z\u202ew\u200bv\r')).toBe('x\u00b7[2Ky\u00b7z\u00b7w\u00b7v\u00b7');
    expect(plain('plain text, ünïcode and emoji 🙂 stay')).toBe('plain text, ünïcode and emoji 🙂 stay');
  });
});
