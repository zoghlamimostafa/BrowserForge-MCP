import { TraceStore, splitTraces, type TraceStep } from '@browserforge/knowledge';
import fs from 'node:fs';
import path from 'node:path';
import { ollamaDecider } from './decider.js';
import { decisionSchema, renderTraceForTraining } from './goal-runner.js';

/**
 * Measuring a local decider offline. Each held-out step is shown to the model exactly as the goal runner would show it (the same system prompt, the same
 * prompt text, the same constrained answer format), and its answer is compared with what the person actually did. No browser and no page is touched, and
 * nothing here prints a trace: the report holds counts and percentages only.
 *
 * Read the numbers with care. The "right answer" is one person's choice on one day; a form can be filled in another valid order, so a correct model can
 * score below 100%. Compare models on the SAME split: what matters is the difference, and the interval says whether it is larger than chance.
 */

export interface PerOp { n: number; opRight: number; actionRight: number }
export interface EvalReport {
  model: string;
  examples: number;
  answered: number;
  errors: number;
  opAccuracy: number;
  actionAccuracy: number;
  /** 95% Wilson interval of the action accuracy: two models whose intervals overlap have not been shown to differ. */
  actionInterval: [number, number];
  byOp: Record<string, PerOp>;
  /** Why a model could not answer, with counts. Only short messages from the model server or from this tool, never a prompt or a page. */
  errorKinds: Record<string, number>;
  latencyMs: { mean: number; p95: number };
  baseline?: { majorityOp: string; opAccuracy: number };
}

export type Ask = (system: string, user: string, schema: object, signal: AbortSignal) => Promise<unknown>;

export function wilson(right: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = right / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** An even spread over the list, so a limit keeps steps from many runs and not just the first ones. */
export function sample<T>(items: T[], limit?: number): T[] {
  if (!limit || limit >= items.length) return items;
  return Array.from({ length: limit }, (_v, i) => items[Math.floor((i * items.length) / limit)]!);
}

export const majorityOp = (steps: TraceStep[]): string | undefined => {
  const tally = new Map<string, number>();
  for (const s of steps) tally.set(s.decision.op, (tally.get(s.decision.op) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

export async function evaluateDecider(
  test: TraceStep[],
  opts: { model: string; url: string; timeoutMs?: number; limit?: number; majority?: string; ask?: Ask; onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
): Promise<EvalReport> {
  const ask = opts.ask ?? ollamaDecider({ url: opts.url, model: opts.model, timeoutMs: opts.timeoutMs ?? 120_000 });
  const picked = sample(test, opts.limit);
  const byOp: Record<string, PerOp> = {};
  const times: number[] = [];
  const errorKinds: Record<string, number> = {};
  let answered = 0, errors = 0, opRight = 0, actionRight = 0;
  for (const [i, s] of picked.entries()) {
    const slot = (byOp[s.decision.op] ??= { n: 0, opRight: 0, actionRight: 0 });
    slot.n++;
    const { system, user } = renderTraceForTraining(s);
    const t0 = Date.now();
    try {
      const a = (await ask(system, user, decisionSchema(s.table.length, s.inputKeys), opts.signal ?? new AbortController().signal)) as { op?: unknown; target?: unknown; inputKey?: unknown };
      times.push(Date.now() - t0);
      answered++;
      const op = a?.op === s.decision.op;
      const action = op && (a.target ?? null) === (s.decision.target ?? null) && (a.inputKey ?? null) === (s.decision.inputKey ?? null);
      if (op) { opRight++; slot.opRight++; }
      if (action) { actionRight++; slot.actionRight++; }
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      errors++; // a model that cannot answer counts as wrong, never as skipped
      // Only the part before the first colon, and short: a message must never carry a piece of what the model said or of a page into the report.
      const why = (e instanceof Error ? e.message : String(e)).split(':')[0]!.replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 80) || 'error';
      errorKinds[why] = (errorKinds[why] ?? 0) + 1;
    }
    opts.onProgress?.(i + 1, picked.length);
  }
  const n = picked.length;
  const sorted = [...times].sort((a, b) => a - b);
  return {
    model: opts.model,
    examples: n,
    answered,
    errors,
    opAccuracy: n ? opRight / n : 0,
    actionAccuracy: n ? actionRight / n : 0,
    actionInterval: wilson(actionRight, n),
    byOp,
    errorKinds,
    latencyMs: { mean: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0, p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : 0 },
    ...(opts.majority ? { baseline: { majorityOp: opts.majority, opAccuracy: n ? picked.filter((s) => s.decision.op === opts.majority).length / n : 0 } } : {}),
  };
}

/** The split every command uses, read from the trace store WITHOUT letting it rewrite the file (an enabled store prunes on load). */
export function loadSplit(knowledgeDir: string, o: { include: 'good' | 'unlabelled'; testPercent: number; by: 'run' | 'host'; seed?: string }) {
  const store = new TraceStore(knowledgeDir, { enabled: false, retentionDays: 3650 });
  const all = store.examples(o.include === 'good' ? 'good' : 'any');
  return { all, ...splitTraces(all, { testPercent: o.testPercent, by: o.by, seed: o.seed }) };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatReport(reports: EvalReport[], info: { train: number; test: number; by: string; include: string }): string {
  const lines = [`Held-out steps: ${info.test} (split by ${info.by}, ${info.include} runs; ${info.train} steps stay for training)`, ''];
  for (const r of reports) {
    lines.push(`${r.model}`);
    lines.push(`  steps scored ${r.examples}, answered ${r.answered}, could not answer ${r.errors}`);
    lines.push(`  right operation ${pct(r.opAccuracy)}   right action (operation + row + value) ${pct(r.actionAccuracy)}  (95% interval ${pct(r.actionInterval[0])} to ${pct(r.actionInterval[1])})`);
    for (const [why, count] of Object.entries(r.errorKinds).sort((a, b) => b[1] - a[1]).slice(0, 3)) lines.push(`  could not answer ${count}x: ${why}`);
    lines.push(`  time per step: mean ${r.latencyMs.mean} ms, p95 ${r.latencyMs.p95} ms`);
    for (const [op, v] of Object.entries(r.byOp).sort((a, b) => b[1].n - a[1].n)) lines.push(`    ${op.padEnd(12)} ${String(v.n).padStart(4)} steps   op ${pct(v.opRight / v.n).padStart(6)}   action ${pct(v.actionRight / v.n).padStart(6)}`);
    if (r.baseline) lines.push(`  for scale: always answering ${r.baseline.majorityOp} gets the operation right ${pct(r.baseline.opAccuracy)} of the time`);
    lines.push('');
  }
  lines.push('How to read this: the answer key is what one person did, and a form can be filled in another valid order, so a good model can score below 100%.');
  lines.push('Models whose intervals overlap have not been shown to differ. A fine-tuned model is only better if it wins on the same held-out steps by more than the interval.');
  return lines.join('\n');
}

/** Writes train.jsonl and test.jsonl (chat format) and returns the counts. The files hold control labels and decisions, never typed values, but they do hold page controls of your sites: keep them private. */
export function writeSplit(dir: string, split: { train: TraceStep[]; test: TraceStep[] }): { train: number; test: number; files: string[] } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const [name, steps] of [['train', split.train], ['test', split.test]] as const) {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, steps.map((s) => {
      const { system, user, assistant } = renderTraceForTraining(s);
      return JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }, { role: 'assistant', content: assistant }] }) + '\n';
    }).join(''), { mode: 0o600 });
    files.push(file);
  }
  return { train: split.train.length, test: split.test.length, files };
}
