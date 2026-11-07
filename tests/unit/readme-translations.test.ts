import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The translations may change the words, never the commands, badges or where a link points.
const ROOT = join(__dirname, '../..');
// Windows checks files out with CRLF line endings; the checks below are written for LF.
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const en = read('README.md');
const codeBlocks = (md: string) => [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!.split('\n').map((l) => l.trim()).join('\n').trim());
const absoluteLinks = (md: string) => new Set([...md.matchAll(/\]\((https?:[^)\s]+)\)|href="(https?:[^"]+)"|src="(https?:[^"]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3]!));

describe.each([['fr', 'Français', /^---$/m], ['ar', 'العربية', /^---$/m]])('docs/README.%s.md', (code, label) => {
  const file = `docs/README.${code}.md`;
  const tr = read(file);

  it('is linked from the English README and links back', () => {
    expect(en).toContain(`[${label}](docs/README.${code}.md)`);
    expect(tr).toContain('(../README.md)');
  });

  it('keeps every quick-start command exactly as in English', () => {
    const quick = en.slice(en.indexOf('## Quick start'), en.indexOf('## Things you can ask your agent'));
    const original = codeBlocks(quick);
    expect(original.length).toBeGreaterThanOrEqual(2);
    const translated = codeBlocks(tr);
    for (const block of original) expect(translated, `missing in ${file}:\n${block}`).toContain(block);
  });

  it('keeps the install buttons, badges and every web link of the part it translates', () => {
    const top = en.slice(0, en.indexOf('## Things you can ask your agent'));
    // The demo video and image are not translated (the page links the English README instead).
    const skip = (u: string) => u.includes('demo.mp4') || u.includes('demo.gif');
    for (const url of absoluteLinks(top)) if (!skip(url)) expect(tr, `${url} missing from ${file}`).toContain(url);
    expect(tr).toContain('height="56"');
  });

  it('only points at files and anchors that exist', () => {
    for (const m of tr.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(#[^)\s]*)?\)|src="(?!https?:)([^"#]+)"/g)) {
      const rel = m[1] ?? m[3]!;
      expect(existsSync(join(ROOT, 'docs', rel)), `${rel} (from ${file}) does not exist`).toBe(true);
    }
    for (const m of tr.matchAll(/\]\((#[^)\s]+)\)/g)) {
      const anchor = decodeURIComponent(m[1]!.slice(1));
      const headings = [...tr.matchAll(/^#{1,4} (.+)$/gm)].map((h) => h[1]!.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'));
      expect(headings, `anchor #${anchor} in ${file}`).toContain(anchor);
    }
  });

  it('says plainly that no native speaker has reviewed it yet', () => {
    expect(tr).toMatch(/غير|pas encore/);
  });
});

describe('Arabic page', () => {
  const ar = read('docs/README.ar.md');
  it('wraps the text in a right-to-left block', () => {
    expect(ar).toContain('<div dir="rtl">');
    expect((ar.match(/<div/g) ?? []).length).toBe((ar.match(/<\/div>/g) ?? []).length);
  });
});
