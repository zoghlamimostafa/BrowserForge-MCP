import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// GitHub rejects a workflow file it cannot read and shows only a failed "push" run with no jobs, so a mistake here is silent until after the merge.
// The classic one: an unquoted value that contains " #" (for example "PR agent #5"): YAML treats it as a comment and cuts the value off.
const DIR = join(__dirname, '../../.github/workflows');
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

/** Every string in the parsed document, with where it was. */
function strings(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

describe.each(files)('workflow %s', (file) => {
  const doc = parse(readFileSync(join(DIR, file), 'utf8'));

  it('parses and has a name and jobs', () => {
    expect(typeof doc.name).toBe('string');
    expect(Object.keys(doc.jobs ?? {}).length).toBeGreaterThan(0);
  });

  it('has no expression cut off by a YAML comment', () => {
    for (const [path, value] of strings(doc)) {
      const opens = (value.match(/\$\{\{/g) ?? []).length;
      const closes = (value.match(/\}\}/g) ?? []).length;
      expect(closes, `${file}${path}: "${value}" has an unclosed \${{ (an unquoted " #" starts a YAML comment)`).toBe(opens);
      // Quotes inside an expression must pair up too.
      for (const m of value.matchAll(/\$\{\{([^}]*)\}\}/g)) expect(((m[1] ?? '').match(/'/g) ?? []).length % 2, `${file}${path}: odd quotes in ${m[0]}`).toBe(0);
    }
  });
});

describe('the PR agent workflow names', () => {
  const doc = parse(readFileSync(join(DIR, 'pr-agent.yml'), 'utf8'));
  it('keeps the whole run-name and the per-PR job name', () => {
    expect(doc['run-name']).toContain("format('PR agent #{0}'");
    expect(doc['run-name']).toContain('github.event_name');
    expect(doc.jobs.sweep.name).toBe('PR agent #${{ matrix.pr }}');
  });
});

describe('the store release workflow keeps credentials away from anything that could read them', () => {
  const text = readFileSync(join(DIR, 'store-release.yml'), 'utf8');
  const doc = parse(text);
  const steps = (job: string): { run?: string; uses?: string }[] => doc.jobs[job].steps;

  it('only reads the repository (no write permission anywhere)', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values<any>(doc.jobs)) expect(job.permissions).toBeUndefined();
  });

  it('a tag push builds and checks only: no secret, no environment, no store call', () => {
    expect(JSON.stringify(doc.jobs.package)).not.toMatch(/secrets\./);
    expect(doc.jobs.package.environment).toBeUndefined();
    const runs = steps('package').map((s) => s.run ?? '').join('\n');
    expect(runs).not.toMatch(/--upload|--publish/); // the checks run without them
    expect(runs).toContain('scripts/store-upload.mjs chrome');
  });

  it.each(['chrome', 'firefox'])('%s: only by hand, only from a tag, only after the environment approves', (job) => {
    const j = doc.jobs[job];
    expect(j.environment).toBe('store-release');
    expect(j.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(j.if).toContain("github.ref_type == 'tag'");
    expect(j.needs).toBe('package');
  });

  it.each(['chrome', 'firefox'])('%s: installs nothing next to the credentials, and runs only the dependency-free script', (job) => {
    const all = steps(job).map((s) => `${s.run ?? ''} ${s.uses ?? ''}`).join('\n');
    expect(all).not.toMatch(/npm (ci|install|i)\b|npx|yarn|pnpm|pip install/);
    expect(all).toContain('scripts/store-upload.mjs');
  });

  it('every credential is used by exactly one store job, and none by the other', () => {
    const own = (job: string) => JSON.stringify(doc.jobs[job]);
    for (const name of ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID', 'CWS_ITEM_ID']) { expect(own('chrome')).toContain(`secrets.${name}`); expect(own('firefox')).not.toContain(name); }
    for (const name of ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']) { expect(own('firefox')).toContain(`secrets.${name}`); expect(own('chrome')).not.toContain(name); }
  });

  it('never puts a workflow input into a shell command text (inputs travel as environment variables)', () => {
    for (const job of ['chrome', 'firefox']) for (const s of steps(job)) expect(s.run ?? '').not.toMatch(/\$\{\{\s*inputs\./);
  });

  it('submits for review only when asked, and --publish never appears on a tag push', () => {
    expect(doc.on.workflow_dispatch.inputs.submit.default).toBe(false);
    expect(doc.on.workflow_dispatch.inputs.store.default).toBe('none');
    expect(doc.on.push.tags).toEqual(['v*']);
  });
});
