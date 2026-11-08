import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TraceStore, splitTraces, type TraceStep } from '@browserforge/knowledge';
import { evaluateDecider, formatReport, loadSplit, majorityOp, sample, wilson, writeSplit } from '../../apps/mcp-server/src/decider-eval.js';
import { SYSTEM_PROMPT } from '../../apps/mcp-server/src/goal-runner.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const execAsync = promisify(execFile);
const tmps: string[] = [];
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-eval-')); tmps.push(d); return d; };

const SECRET = 'ZZ-PRIVATE-SITE-LABEL';
let n = 0;
function step(over: Partial<TraceStep> & { runId: string }): TraceStep {
  return {
    at: Date.now() + n++, promptVersion: 'v1', host: 'jobs.example', pathPattern: '/apply', goal: `Apply (${SECRET})`, inputKeys: ['email'],
    table: [`1 | input:text | Email ${SECRET}`, '2 | button | Send', '3 | link | Home'], recent: [], notesKey: '',
    decision: { op: 'TYPE', target: 1, targetLabel: 'Email', inputKey: 'email', confidence: 1 },
    result: { ok: true, pageChanged: true, approvalDenied: false }, source: 'human', ...over,
  };
}
const runs = (count: number, host = (i: number) => `site${i % 4}.example`) =>
  Array.from({ length: count }, (_v, i) => [step({ runId: `run-${i}`, host: host(i) }), step({ runId: `run-${i}`, host: host(i), recent: ['TYPE email'], decision: { op: 'CLICK', target: 2, targetLabel: 'Send', inputKey: null, confidence: 1 } })]).flat();

describe('splitting traces', () => {
  it('puts a whole run on one side, the same way every time', () => {
    const steps = runs(60);
    const a = splitTraces(steps, { testPercent: 25 });
    const b = splitTraces(steps, { testPercent: 25 });
    expect(a.test.map((s) => s.at)).toEqual(b.test.map((s) => s.at));
    const testRuns = new Set(a.test.map((s) => s.runId));
    for (const s of a.train) expect(testRuns.has(s.runId)).toBe(false);
    expect(a.train.length + a.test.length).toBe(steps.length);
    expect(a.test.length / steps.length).toBeGreaterThan(0.1);
    expect(a.test.length / steps.length).toBeLessThan(0.4);
  });
  it('by host, a site is wholly in training or wholly in test', () => {
    const { train, test } = splitTraces(runs(80, (i) => `site${i % 12}.example`), { testPercent: 30, by: 'host' });
    const t = new Set(test.map((s) => s.host));
    expect(t.size).toBeGreaterThan(0);
    for (const s of train) expect(t.has(s.host)).toBe(false);
  });
  it('does not reshuffle old runs when new ones arrive, and a different seed gives a different split', () => {
    const steps = runs(60);
    const side = (all: TraceStep[], seed?: string) => new Map(splitTraces(all, { testPercent: 25, seed }).test.map((s) => [s.runId, true]));
    const before = side(steps);
    const after = side([...steps, ...runs(20).map((s) => ({ ...s, runId: `new-${s.runId}` }))]);
    for (const r of before.keys()) expect(after.has(r)).toBe(true);
    expect([...side(steps, 'other').keys()].sort()).not.toEqual([...before.keys()].sort());
  });
  it('0 percent keeps everything for training and 100 puts everything in test', () => {
    const steps = runs(10);
    expect(splitTraces(steps, { testPercent: 0 }).test).toHaveLength(0);
    expect(splitTraces(steps, { testPercent: 100 }).train).toHaveLength(0);
  });
});

describe('which steps count as examples, and reading the store without changing it', () => {
  it('takes working, non-memory steps of good runs (or, with unlabelled, of runs not judged bad)', () => {
    const dir = tmp();
    const store = new TraceStore(dir, { enabled: true, retentionDays: 90 });
    for (const s of [step({ runId: 'g' }), step({ runId: 'g', source: 'memory' }), step({ runId: 'g', result: { ok: false, pageChanged: false, approvalDenied: false } }), step({ runId: 'b' }), step({ runId: 'u' })]) store.record(s);
    store.label('g', 'good'); store.label('b', 'bad');
    expect(store.examples('good').map((s) => s.runId)).toEqual(['g']);
    expect(store.examples('any').map((s) => s.runId).sort()).toEqual(['g', 'u']);
  });
  it('loadSplit does not rewrite the file, even when it holds expired steps (an enabled store would prune them)', () => {
    const dir = tmp();
    const old = step({ runId: 'old', at: 1 });
    const file = path.join(dir, 'traces.jsonl');
    fs.writeFileSync(file, JSON.stringify(old) + '\n' + JSON.stringify(step({ runId: 'new' })) + '\n');
    const before = fs.readFileSync(file);
    const s = loadSplit(dir, { include: 'unlabelled', testPercent: 50, by: 'run' });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(s.all.map((x) => x.runId)).toEqual(['new']); // the expired step is not used, but it is not deleted either
  });
});

describe('scoring a model', () => {
  const truth = (s: TraceStep) => ({ op: s.decision.op, target: s.decision.target, inputKey: s.decision.inputKey, confidence: 0.9 });
  it('asks with the runner\'s own prompt and answer format, and scores right and wrong answers', async () => {
    const steps = runs(10);
    const calls: { system: string; user: string; schema: any }[] = [];
    let i = 0;
    const report = await evaluateDecider(steps, {
      model: 'm', url: 'http://127.0.0.1:1', majority: 'TYPE',
      ask: async (system, user, schema) => {
        calls.push({ system, user, schema });
        const s = steps[i++]!;
        if (i === 1) return { op: 'CLICK', target: 2, inputKey: null, confidence: 1 }; // wrong operation (truth TYPE)
        if (i === 2) return { ...truth(s), target: 3 }; // right operation, wrong row
        if (i === 3) throw new Error('model down'); // cannot answer: counted wrong
        return truth(s);
      },
    });
    expect(calls[0]!.system).toBe(SYSTEM_PROMPT);
    expect(calls[0]!.user).toContain('Goal: Apply');
    expect(calls[0]!.user).toContain('Controls:');
    expect(calls[0]!.schema.properties.op.enum).toContain('DONE');
    expect(calls[0]!.schema.properties.target.enum).toEqual([1, 2, 3, null]);
    expect(report).toMatchObject({ model: 'm', examples: 20, answered: 19, errors: 1 });
    expect(report.opAccuracy).toBeCloseTo(18 / 20); // 20 - 1 wrong op - 1 error
    expect(report.actionAccuracy).toBeCloseTo(17 / 20); // ...and one wrong row
    expect(report.byOp.TYPE).toMatchObject({ n: 10 });
    expect(report.errorKinds).toEqual({ 'model down': 1 }); // the reason, not just a count
    expect(report.baseline).toEqual({ majorityOp: 'TYPE', opAccuracy: 0.5 });
    expect(report.actionInterval[0]).toBeLessThan(0.85);
    expect(report.actionInterval[1]).toBeGreaterThan(0.85);
  });
  it('a perfect model scores 100% and a limit scores an even spread over many runs', async () => {
    const steps = runs(40);
    const seen = new Set<string>();
    const r = await evaluateDecider(steps, { model: 'perfect', url: 'x', limit: 20, ask: async (_s, _u, _sch) => { return { op: 'TYPE', target: 1, inputKey: 'email', confidence: 1 }; } });
    expect(r.examples).toBe(20);
    for (const s of sample(steps, 20)) seen.add(s.runId);
    expect(seen.size).toBeGreaterThan(8); // not just the first runs
    expect(r.byOp.TYPE!.opRight).toBe(r.byOp.TYPE!.n);
  });
  it('wilson interval and majority helpers behave', () => {
    const [lo, hi] = wilson(80, 100);
    expect(lo).toBeCloseTo(0.711, 2); expect(hi).toBeCloseTo(0.867, 2);
    expect(wilson(0, 0)).toEqual([0, 0]);
    expect(wilson(10, 10)[1]).toBe(1);
    expect(majorityOp(runs(5))).toBeDefined();
    expect(sample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
  it('keeps only a short, plain reason for an error: nothing after a colon, no control characters', async () => {
    const r = await evaluateDecider(runs(2), { model: 'm', url: 'x', ask: async () => { throw new Error(`The local model did not return valid JSON: {"echo":"${SECRET}"}\u001b[2K`); } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.errorKinds).toEqual({ 'The local model did not return valid JSON': 4 });
    const odd = await evaluateDecider(runs(1), { model: 'm', url: 'x', ask: async () => { throw new Error(`\u001b[2Kbad\u0007 ${'x'.repeat(300)}`); } });
    // eslint-disable-next-line no-control-regex
    expect(Object.keys(odd.errorKinds).join()).not.toMatch(/[\u001b\u0007]/);
    expect(Object.keys(odd.errorKinds)[0]!.length).toBeLessThanOrEqual(80);
  });

  it('the report holds numbers only: no goal, control label or page text from a trace', async () => {
    const steps = runs(8);
    const r = await evaluateDecider(steps, { model: 'm', url: 'x', ask: async () => ({ op: 'DONE', target: null, inputKey: null, confidence: 1 }) });
    const text = formatReport([r], { train: 3, test: 16, by: 'run', include: 'good' }) + JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('jobs.example');
    expect(text).toMatch(/right action .*95% interval/);
    expect(formatReport([{ ...r, errors: 2, errorKinds: { 'Local model server returned 500': 2 } }], { train: 1, test: 1, by: 'run', include: 'good' })).toContain('could not answer 2x: Local model server returned 500');
    expect(text).toMatch(/Models whose intervals overlap have not been shown to differ/);
  });
});

describe('writing the split', () => {
  it('writes chat-format train and test files, private to you, with decisions and no typed values', () => {
    const dir = path.join(tmp(), 'out');
    const w = writeSplit(dir, splitTraces(runs(20), { testPercent: 30 }));
    expect(w.train + w.test).toBe(40);
    for (const f of w.files) {
      if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o077).toBe(0);
      for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) {
        const m = JSON.parse(line).messages;
        expect(m.map((x: { role: string }) => x.role)).toEqual(['system', 'user', 'assistant']);
        expect(JSON.parse(m[2].content)).toMatchObject({ op: expect.any(String), confidence: 1 });
      }
    }
  });
});

describe('the command line, against a fake local model server', () => {
  let server: http.Server; let url = ''; let bodies: any[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        bodies.push(b);
        res.writeHead(200, { 'content-type': 'application/json' });
        const afterTyping = String(b.messages?.[1]?.content).includes('Recent steps:'); // a model that reads the history
        res.end(JSON.stringify({ message: { content: JSON.stringify(b.model === 'good-model' ? (afterTyping ? { op: 'CLICK', target: 2, inputKey: null, confidence: 1 } : { op: 'TYPE', target: 1, inputKey: 'email', confidence: 1 }) : { op: 'DONE', target: null, inputKey: null, confidence: 1 }) } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const home = () => {
    const h = tmp();
    fs.mkdirSync(path.join(h, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(h, 'knowledge', 'traces.jsonl'), runs(50).map((s) => JSON.stringify(s) + '\n').join(''));
    return h;
  };
  const cli = (h: string, args: string[]) => execAsync(process.execPath, [path.join(ROOT, 'apps/mcp-server/dist/cli.js'), 'decider', ...args], { env: { ...process.env, BROWSERFORGE_HOME: h } });

  it('says plainly why there is nothing to evaluate when no run is labelled good', async () => {
    const h = home();
    await expect(cli(h, ['eval', '--decider-url', url])).rejects.toMatchObject({ stderr: expect.stringMatching(/No held-out steps \(0 good steps in all\).*--include unlabelled/s) });
  });

  it('splits, then compares two models on the same held-out steps and writes a json report', async () => {
    const h = home();
    bodies = [];
    const split = await cli(h, ['split', '--include', 'unlabelled', '--out', path.join(h, 'ds'), '--test', '30']);
    expect(split.stdout).toMatch(/Wrote \d+ training and \d+ test steps/);
    const out = path.join(h, 'report.json');
    const r = await cli(h, ['eval', '--include', 'unlabelled', '--test', '30', '--decider-url', url, '--model', 'good-model', '--model', 'lazy-model', '--limit', '12', '--json', out]);
    expect(r.stdout).toMatch(/good-model[\s\S]*right action \(operation \+ row \+ value\) 100\.0%/);
    expect(r.stdout).toMatch(/lazy-model[\s\S]*right action \(operation \+ row \+ value\) 0\.0%/);
    expect(r.stdout).not.toContain(SECRET);
    const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(rep.reports.map((x: { model: string }) => x.model)).toEqual(['good-model', 'lazy-model']);
    // The same held-out steps for both, asked with constrained, temperature-0 answers.
    expect(bodies.length).toBe(24);
    expect(bodies[0].options.temperature).toBe(0);
    expect(bodies[0].format.properties.op.enum).toContain('TYPE');
    expect(bodies.slice(0, 12).map((b) => b.messages[1].content)).toEqual(bodies.slice(12).map((b) => b.messages[1].content));
    // Reading the traces did not change them.
    expect(fs.readFileSync(path.join(h, 'knowledge', 'traces.jsonl'), 'utf8').trim().split('\n')).toHaveLength(100);
  }, 60_000);

  it('refuses a model server that is not on this machine (page content is sent to it) and bad options', async () => {
    const h = home();
    await expect(cli(h, ['eval', '--include', 'unlabelled', '--decider-url', 'http://example.com:11434'])).rejects.toMatchObject({ stderr: expect.stringMatching(/must run on this machine/) });
    await expect(cli(h, ['eval', '--include', 'sometimes'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Invalid --include/) });
    await expect(cli(h, ['eval', '--test', '0'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Invalid --test/) });
    await expect(cli(h, ['eval', '--include', 'unlabelled', '--limit', 'many'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Invalid --limit/) });
    await expect(cli(h, ['frobnicate'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Usage: browserforge decider split\|eval/) });
    await expect(cli(h, ['split'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Usage: browserforge decider split --out/) });
  });
});
