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
