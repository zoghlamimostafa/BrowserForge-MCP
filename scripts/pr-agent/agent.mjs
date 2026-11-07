// The PR agent. One agent per pull request (the workflow starts a separate, isolated run for each PR; `pending` lists the ones that still need one). Both run from the default branch by .github/workflows/pr-agent.yml, never from the pull request's own code:
//   review --pr N    read the PR through the API, ask Claude, post the verdict, approve CI for a clean fork PR, then try to merge
//   merge  --sha S   CI finished for commit S: merge its PR if every rule in policy.mjs holds
// Flags: --dry-run (change nothing, print what would happen).  Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, ANTHROPIC_API_KEY (review only).
// Nothing here checks out, installs or executes anything from a pull request.
import { LIMITS, MARKER, REQUIRED_CHECKS, changedPaths, mergeBlockers, pagesAffected, parseComment, protectedFiles, renderComment, sizeProblems, verdictProblems } from './policy.mjs';
import { reviewPullRequest } from './review.mjs';

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const DRY = args.includes('--dry-run');
const API = process.env.GITHUB_API_URL || 'https://api.github.com'; // GitHub Actions sets this itself; tests point it at a fake server
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
if (!REPO || !TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');

const log = (m) => console.log(m);
async function gh(method, path, body, accept = 'application/vnd.github+json') {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'browserforge-pr-agent', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return accept.includes('diff') ? res.text() : res.json();
}
async function all(path, key) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const data = await gh('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = key ? data[key] : data;
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getRepo = () => gh('GET', `/repos/${REPO}`);
/** GitHub works out "mergeable" in the background: ask again for a few seconds. */
async function getPr(n) {
  for (let i = 0; i < 5; i++) {
    const pr = await gh('GET', `/repos/${REPO}/pulls/${n}`);
    if (pr.mergeable !== null || pr.state !== 'open') return pr;
    await sleep(4000);
  }
  return gh('GET', `/repos/${REPO}/pulls/${n}`);
}
/** The change, pinned to the exact commits: a push that arrives while the agent works cannot swap what was reviewed for something else. */
const snapshot = (pr) => `/repos/${REPO}/compare/${pr.base.sha}...${pr.head.sha}`;
const getFilesAt = async (pr) => (await gh('GET', `${snapshot(pr)}?per_page=100`)).files ?? [];
const getDiffAt = (pr) => gh('GET', snapshot(pr), undefined, 'application/vnd.github.v3.diff');

/** The agent's latest verdict comment (written by github-actions[bot] only: nobody else can post as it) for this exact commit. */
async function findVerdict(n, sha) {
  const comments = await all(`/repos/${REPO}/issues/${n}/comments`);
  const mine = comments.filter((c) => c.user?.login === 'github-actions[bot]' && c.user?.type === 'Bot' && (c.body ?? '').includes(`<!-- ${MARKER} `));
  const parsed = mine.map((c) => ({ c, v: parseComment(c.body) })).filter((x) => x.v);
  return { existing: mine.at(-1) ?? null, verdict: parsed.filter((x) => x.v.sha === sha).at(-1)?.v ?? null };
}

async function upsertComment(n, existing, body) {
  if (DRY) return log(`[dry run] would post:\n${body}`);
  if (existing) await gh('PATCH', `/repos/${REPO}/issues/comments/${existing.id}`, { body });
  else await gh('POST', `/repos/${REPO}/issues/${n}/comments`, { body });
}

/** First-time contributors' CI waits for a maintainer's approval. The agent gives it only after a clean review of this exact commit. */
async function approveCi(sha) {
  const runs = (await gh('GET', `/repos/${REPO}/actions/runs?head_sha=${sha}&status=action_required&per_page=20`)).workflow_runs ?? [];
  const note = [];
  for (const run of runs) {
    if (DRY) { note.push(`[dry run] would approve run ${run.id} (${run.name})`); continue; }
    try {
      await gh('POST', `/repos/${REPO}/actions/runs/${run.id}/approve`);
      note.push(`Approved the first-time-contributor CI run "${run.name}".`);
    } catch (e) {
      note.push(`Could not approve CI run "${run.name}" (${e.status ?? 'error'}): a maintainer needs to press "Approve and run workflows".`);
    }
  }
  return note;
}

async function review(n) {
  const repo = await getRepo();
  const pr = await getPr(n);
  if (pr.state !== 'open') return log(`#${n} is ${pr.state}: nothing to do`);
  if (pr.draft) return log(`#${n} is a draft: the agent waits until it is ready`);
  if ((pr.labels ?? []).some((l) => l.name === 'no-agent')) return log(`#${n} is labelled no-agent: nothing to do`);
  const sha = pr.head.sha;
  const files = await getFilesAt(pr);
  const { existing } = await findVerdict(n, sha);
  const prot = protectedFiles(changedPaths(files), pr.author_association);
  const big = sizeProblems(pr, files);

  let verdict;
  let blockers = [];
  if (prot.length || big.length) {
    blockers = [...(prot.length ? [`it changes files only a person may review: ${[...new Set(prot)].slice(0, 6).join(', ')}`] : []), ...big];
    verdict = { verdict: 'needs_human', confidence: 'high', summary: 'This change needs a maintainer: the agent does not merge it by itself.', findings: [], prompt_injection_suspected: false };
  } else {
    let diff = '';
    try {
      diff = await getDiffAt(pr);
    } catch (e) {
      diff = 'x'.repeat(LIMITS.diffChars + 1); // GitHub refused to produce the diff (too large): treated as "too big to read whole"
    }
    verdict = await reviewPullRequest({ pr, files, diff });
    blockers = verdictProblems(verdict);
  }

  // The review took a while. If the PR moved meanwhile, this verdict is of a commit that is no longer the head: say nothing about it
  // (a new run is already on its way for the new commit) and, above all, approve nothing.
  const after = await gh('GET', `/repos/${REPO}/pulls/${n}`);
  if (after.head.sha !== sha) return log(`#${n} moved from ${sha.slice(0, 8)} to ${after.head.sha.slice(0, 8)} during the review: dropping this result`);

  const notes = [];
  if (blockers.length === 0 && pr.head.repo?.full_name !== pr.base.repo.full_name) notes.push(...(await approveCi(sha)));
  await upsertComment(n, existing, renderComment({ sha, verdict, summary: verdict.summary, findings: verdict.findings, notes, blockers }));
  log(`#${n} ${sha.slice(0, 8)}: ${verdict.verdict}${blockers.length ? ` (waiting: ${blockers.join('; ')})` : ''}`);
  await tryMerge(n, repo.default_branch);
}

async function tryMerge(n, defaultBranch) {
  const branch = defaultBranch ?? (await getRepo()).default_branch;
  const pr = await getPr(n);
  if (pr.state !== 'open') return log(`#${n} is ${pr.state}: nothing to merge`);
  const files = await getFilesAt(pr);
  const { verdict } = await findVerdict(n, pr.head.sha);
  const checkRuns = (await gh('GET', `/repos/${REPO}/commits/${pr.head.sha}/check-runs?per_page=100`)).check_runs ?? [];
  const blockers = mergeBlockers({ pr, files, verdict, checkRuns, defaultBranch: branch });
  if (blockers.length) return log(`#${n}: not merging yet: ${blockers.join('; ')}`);
  if (DRY) return log(`[dry run] #${n} would be squash-merged at ${pr.head.sha.slice(0, 8)}`);
  // `sha` makes GitHub refuse the merge if the branch moved after the checks above.
  try {
    await gh('PUT', `/repos/${REPO}/pulls/${n}/merge`, { merge_method: 'squash', sha: pr.head.sha, commit_title: `${pr.title} (#${n})` });
  } catch (e) {
    // 405/409: already merged by a parallel run, the branch moved after the checks, or branch rules need a person. Either way, not an error.
    if (e.status === 405 || e.status === 409 || e.status === 422) return log(`#${n}: GitHub did not merge it (${e.status}): ${e.message}`);
    throw e;
  }
  log(`#${n}: merged`);
  await gh('POST', `/repos/${REPO}/issues/${n}/comments`, { body: `Merged by the PR agent: the review of \`${pr.head.sha.slice(0, 8)}\` was "approve" and all ${REQUIRED_CHECKS.length} required checks passed (tests and package install on Ubuntu, macOS and Windows).` }).catch(() => undefined);
  // A merge made with the workflow token does not start the push workflows, so start the tests on the new main by hand.
  await gh('POST', `/repos/${REPO}/actions/workflows/ci.yml/dispatches`, { ref: branch }).catch((e) => log(`could not start CI on ${branch}: ${e.message}`));
  // Same for the website: its push trigger is also silent for a token-made merge.
  if (pagesAffected(changedPaths(files))) await gh('POST', `/repos/${REPO}/actions/workflows/pages.yml/dispatches`, { ref: branch }).catch((e) => log(`could not start the website workflow: ${e.message}`));
}

async function mergeBySha(sha) {
  const open = await all(`/repos/${REPO}/pulls?state=open`);
  const pr = open.find((p) => p.head.sha === sha);
  if (!pr) return log(`no open pull request has head ${sha.slice(0, 8)}: nothing to do`);
  await tryMerge(pr.number);
}

/** Open, ready PRs whose current commit has no review from the agent yet. The sweep job runs one agent per number in this list. */
async function pending() {
  const open = (await all(`/repos/${REPO}/pulls?state=open`)).filter((p) => !p.draft);
  const todo = [];
  for (const p of open) {
    const labels = (p.labels ?? []).map((l) => l.name);
    if (labels.includes('no-agent')) continue;
    if (!(await findVerdict(p.number, p.head.sha)).verdict) todo.push(p.number);
  }
  log(`PRs waiting for an agent: ${todo.length ? todo.map((n) => `#${n}`).join(', ') : 'none'}`);
  if (process.env.GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(process.env.GITHUB_OUTPUT, `prs=${JSON.stringify(todo)}\n`);
  return todo;
}

try {
  if (mode === 'pending') await pending();
  else if (mode === 'review') await review(Number(flag('pr')));
  else if (mode === 'merge' && flag('pr')) await tryMerge(Number(flag('pr')));
  else if (mode === 'merge' && flag('sha')) await mergeBySha(flag('sha'));
  else throw new Error('usage: agent.mjs review --pr N | merge --sha SHA | merge --pr N | pending   [--dry-run]');
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exitCode = 1;
}
