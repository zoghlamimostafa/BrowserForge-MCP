// The PR agent's rules, as plain functions with no network and no model. The model's opinion is ONE input; these rules decide whether
// anything is merged, and every one of them can only make the agent more cautious. Read docs/PR_AGENT.md for the reasoning.

/** Who the author is, as GitHub reports it. These two may change the agent's protected files only with a human's sign-off (see below). */
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER'];

/** The checks that must have succeeded for the exact commit being merged. They are listed one by one on purpose, even though CI now fails when any
 *  of them fails: the agent never relies on the run's overall result (macOS and Windows used to be "continue on error"). */
export const REQUIRED_CHECKS = [
  'test (ubuntu-latest)',
  'test (macos-latest)',
  'test (windows-latest)',
  'install package (ubuntu-latest)',
  'install package (macos-latest)',
  'install package (windows-latest)',
];

/** Never merged by the agent, whoever wrote it: the agent and the pipeline itself. A change here could switch the rules off. */
const ALWAYS_HUMAN = [/^\.github\//, /^scripts\/pr-agent\//];

/** Not merged by the agent when an outside contributor changes them: what gets published or installed, and the dependencies (supply chain). */
const HUMAN_FOR_OUTSIDERS = [
  /^scripts\/package-release\.mjs$/,
  /^scripts\/smoke-/,
  /^installer\//,
  /^server\.json$/,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)\.npmrc$/,
  /^release\//,
];

export const LIMITS = { files: 60, changedLines: 2500, diffChars: 250_000 };

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/** Which of these paths the agent must leave to a person, for this kind of author. */
export function protectedFiles(paths, authorAssociation) {
  const trusted = TRUSTED_ASSOCIATIONS.includes(authorAssociation);
  const patterns = trusted ? ALWAYS_HUMAN : [...ALWAYS_HUMAN, ...HUMAN_FOR_OUTSIDERS];
  return paths.map(norm).filter((p) => patterns.some((re) => re.test(p)));
}

/** A rename's old name counts too: moving a protected file away is a change to it. */
export function changedPaths(files) {
  return files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
}

export function sizeProblems(pr, files) {
  const out = [];
  if (files.length > LIMITS.files) out.push(`touches ${files.length} files (the agent handles at most ${LIMITS.files})`);
  const lines = files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  if (lines > LIMITS.changedLines) out.push(`changes ${lines} lines (the agent handles at most ${LIMITS.changedLines})`);
  return out;
}

/** @param {{name:string, status:string, conclusion:string|null}[]} checkRuns check runs of the head commit */
export function checkProblems(checkRuns, required = REQUIRED_CHECKS) {
  const out = [];
  for (const name of required) {
    // The newest attempt wins (a re-run replaces an older failure, and a queued re-run blocks an older success). Check-run ids only grow, and
    // unlike started_at they exist from the moment a run is queued.
    const run = checkRuns.filter((c) => c.name === name).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
    if (!run) out.push(`${name}: has not run`);
    else if (run.status !== 'completed') out.push(`${name}: still running`);
    else if (run.conclusion !== 'success') out.push(`${name}: ${run.conclusion}`);
  }
  return out;
}

/** The model's structured answer, judged. Anything unclear or worrying means a person decides. */
export function verdictProblems(v) {
  if (!v || typeof v !== 'object') return ['no review result'];
  const out = [];
  if (v.verdict !== 'approve') out.push(`the review says "${v.verdict ?? 'nothing'}"`);
  if (v.confidence === 'low') out.push('the review is not confident');
  const bad = (v.findings ?? []).filter((f) => f.severity === 'high' || f.severity === 'critical');
  if (bad.length) out.push(`${bad.length} high-severity finding${bad.length > 1 ? 's' : ''}`);
  if (v.prompt_injection_suspected) out.push('the diff seems to address the reviewer');
  return out;
}

/**
 * Everything that must be true to merge, evaluated from fresh data. Returns the reasons it must wait; an empty list means "merge".
 * @param {object} i
 * @param {{state:string, draft:boolean, base:{ref:string}, head:{sha:string}, mergeable:boolean|null, labels:{name:string}[], author_association:string, user:{login:string}}} i.pr
 */
export function mergeBlockers(i) {
  const out = [];
  const { pr } = i;
  if (pr.state !== 'open') out.push('the pull request is not open');
  if (pr.draft) out.push('it is a draft');
  if (pr.base.ref !== i.defaultBranch) out.push(`it targets ${pr.base.ref}, not ${i.defaultBranch}`);
  if (pr.mergeable === false) out.push('it has conflicts with the base branch');
  if (pr.mergeable === null) out.push('GitHub is still working out whether it merges cleanly');
  const hold = (pr.labels ?? []).map((l) => l.name).filter((n) => ['do-not-merge', 'needs-human', 'no-agent'].includes(n));
  if (hold.length) out.push(`it carries the label ${hold.map((n) => `"${n}"`).join(', ')}`);
  const paths = changedPaths(i.files);
  const prot = protectedFiles(paths, pr.author_association);
  if (prot.length) out.push(`it changes files a person must review: ${[...new Set(prot)].slice(0, 5).join(', ')}`);
  out.push(...sizeProblems(pr, i.files));
  if (!i.verdict) out.push('no review of this exact commit exists');
  else if (i.verdict.sha !== pr.head.sha) out.push('the review is of an older commit');
  else out.push(...verdictProblems(i.verdict));
  out.push(...checkProblems(i.checkRuns));
  return out;
}

// ---- the agent's own comment: a hidden marker carries the machine-readable part, so a later run can find it ----
export const MARKER = 'pr-agent:verdict';

export function renderComment({ sha, verdict, summary, findings = [], notes = [], blockers = [] }) {
  const data = JSON.stringify({ sha, verdict: verdict.verdict, confidence: verdict.confidence ?? null, findings: verdict.findings ?? [], prompt_injection_suspected: verdict.prompt_injection_suspected === true });
  const sev = { critical: '🛑', high: '🔴', medium: '🟠', low: '🟡' };
  const lines = [`<!-- ${MARKER} ${data} -->`, `### PR agent review of \`${sha.slice(0, 8)}\`: **${verdict.verdict.replace('_', ' ')}**`, '', summary];
  if (findings.length) {
    lines.push('', '**Findings**');
    for (const f of findings) lines.push(`- ${sev[f.severity] ?? '•'} **${f.severity}**${f.file ? ` \`${f.file}\`` : ''}: ${f.issue}`);
  }
  if (notes.length) lines.push('', ...notes.map((n) => `- ${n}`));
  if (blockers.length) lines.push('', '**Waiting for a person because:**', ...blockers.map((b) => `- ${b}`));
  lines.push('', '<sub>Automated review. It merges only when every rule in docs/PR_AGENT.md holds; it can be wrong, so a person can always reopen, revert or label the PR `do-not-merge`.</sub>');
  return lines.join('\n');
}

const VERDICTS = ['approve', 'request_changes', 'needs_human'];
const CONFIDENCE = ['high', 'medium', 'low'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

/** True only for a complete, well-formed stored verdict. A marker missing a field (or with an unknown value) must never count as an approval. */
export function validStoredVerdict(v) {
  return Boolean(v) && typeof v === 'object'
    && /^[0-9a-f]{40}$/.test(String(v.sha))
    && VERDICTS.includes(v.verdict)
    && CONFIDENCE.includes(v.confidence)
    && typeof v.prompt_injection_suspected === 'boolean'
    && Array.isArray(v.findings)
    && v.findings.every((f) => f && typeof f === 'object' && SEVERITIES.includes(f.severity));
}

/** Reads the marker back out of a comment body written by the agent. Returns null for anything else, including an incomplete marker. */
export function parseComment(body) {
  const m = new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`, 's').exec(body ?? '');
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return validStoredVerdict(v) ? v : null;
  } catch {
    return null;
  }
}

/** Files the Website workflow watches (keep in step with .github/workflows/pages.yml). A merge made with the workflow token does not start it. */
const PAGES_WATCHED = [/^site\//, /^docs\/assets\/demo/, /^docs\/assets\/social-preview\.png$/, /^\.github\/workflows\/pages\.yml$/];
export const pagesAffected = (paths) => paths.map(norm).some((p) => PAGES_WATCHED.some((re) => re.test(p)));
