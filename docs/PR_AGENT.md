# The PR agent

Every pull request gets its own agent. It reads the change, asks Claude to review it, and **merges it by itself when every rule below holds**. When any rule fails, it stops and leaves the PR to a person, with the reasons written in a comment.

It lives in [`scripts/pr-agent/`](../scripts/pr-agent) and runs from [`.github/workflows/pr-agent.yml`](../.github/workflows/pr-agent.yml).

## What happens to a pull request

| Moment | What runs | Result |
|---|---|---|
| A PR is opened or updated | `review` (one run per PR, named "PR agent #N", with its own lock) | Claude reads the whole diff and returns a verdict. The agent posts it as a comment. For a first-time contributor, whose CI waits for a maintainer, the agent approves the CI run only after a clean review of that exact commit. |
| CI finishes for a commit | `merge` | Squash-merges the PR if every rule holds, then starts the tests on `main` (a merge made with the workflow token does not start them by itself). |
| Every 6 hours, or by hand | `sweep`: one job per open PR that has no review of its current commit | Catches PRs that were open before the agent existed, and anything missed. |

You can also run it on one PR: **Actions → PR agent → Run workflow**, with the PR number.

## The rules

The model's opinion is one input. These rules are plain code in [`policy.mjs`](../scripts/pr-agent/policy.mjs), tested in [`tests/unit/pr-agent.test.ts`](../tests/unit/pr-agent.test.ts), and every one of them can only make the agent *more* cautious.

A PR is merged only when **all** of these are true:

1. It is open, not a draft, aimed at `main`, and merges cleanly.
2. It has no `do-not-merge`, `needs-human` or `no-agent` label.
3. The review is of **the exact commit being merged** (a newer push needs a new review), is `approve`, is confident, has **no high or critical finding**, and does not suspect that the diff is talking to the reviewer. The stored review must be complete and well-formed: a comment with a missing field or an unknown value counts as no review.
4. **Every required check passed for that commit**: tests and package installs on Ubuntu, macOS and Windows. CI now fails when any of them fails, and the agent still checks each one on its own, so it never depends on the run as a whole. The newest attempt of each check counts, so a re-run that is still queued blocks an older success.
5. It is small enough to review whole: at most 60 files, 2,500 changed lines, 250,000 characters of diff.
6. It does not touch the files below.

### Files a person must review

| Files | Who is held back |
|---|---|
| `.github/**`, `scripts/pr-agent/**` (the pipeline and the agent itself) | Everyone, the owner included. A change here could switch the rules off. (GitHub also refuses to let the workflow token merge a change to workflow files.) |
| `package.json`, `package-lock.json`, `.npmrc` anywhere; `installer/**`; `server.json`; `scripts/package-release.mjs`; `scripts/smoke-*`; `release/**` | Outside contributors. These decide what is installed and published, and which dependencies run. |

Everything else, including the extension, the daemon, the plugin SDK and the security code, is **left to the review and the tests**. If you want more of it held back for a person, add a pattern to `HUMAN_FOR_OUTSIDERS` in `policy.mjs` (that file is itself protected, so you change it by a normal PR that you merge).

## Fails closed

The agent merges nothing when:

- `ANTHROPIC_API_KEY` is not set, the API is down, the model declines to review, runs out of room, or answers with something that does not parse;
- the diff is too large to read whole;
- the review was written for an older commit;
- anyone other than `github-actions[bot]` wrote the "approve" (the marker in the comment only counts from the bot);
- any check has not finished.

The review prompt tells the model that the PR (title, description and diff) is **data written by a stranger**, and to flag text that addresses it as a critical finding. The model cannot be talked into a merge on its own: even a wrongly given "approve" still has to pass every rule above.

## Safety of the workflow itself

- It runs the agent **from `main` only**. It never checks out, installs, builds or runs anything from a pull request: it reads the PR through the GitHub API.
- The agent has its own folder and lockfile (`scripts/pr-agent/`), installed with `--ignore-scripts`, so a PR cannot change what gets installed.
- The only secret it uses is `ANTHROPIC_API_KEY`. It has no secrets to give a pull request, because the PR's code never runs there.
- **The review is of a snapshot, not of a moving target.** The diff and the file list are read from a comparison pinned to the two commit ids, never from the PR's live head. If the PR moves while Claude is reviewing, the result is dropped: nothing is posted, no CI is approved, and a new run reviews the new commit.
- Every merge passes the reviewed commit's SHA to GitHub, which refuses the merge if the branch moved after the checks.
- A merge made with the workflow token does not start the push workflows, so after a merge the agent starts the tests on `main` itself, and the website deployment too when the merge changed `site/**` or the demo files it publishes.
- The decision and its reasons are a comment on the PR, so there is always a trail.

## Turning it on

1. Merge the pull request that adds the agent (it changes `.github/`, so the agent will not merge it for you).
2. Add the key as a repository secret. Type it at the prompt, never into a chat or a file:
   ```bash
   gh secret set ANTHROPIC_API_KEY -R zoghlamimostafa/BrowserForge-MCP
   ```
   If `gh` cannot reach GitHub, add the same secret in the web page instead: **Settings → Secrets and variables → Actions → New repository secret**, name `ANTHROPIC_API_KEY`.
3. In **Settings → Actions → General**, check that workflows may run for pull requests from forks (the default is fine), and that "Require approval for first-time contributors" stays on: the agent gives the approval itself after a clean review.
4. Try it on one PR: **Actions → PR agent → Run workflow → pr = the number**, and read the comment it posts.

The default model is `claude-opus-5-5` (`PR_AGENT_MODEL` changes it). A review is one request per pull request or per new commit, so the cost follows how many PRs arrive.

## Turning it off, or holding one PR

- Hold one PR: label it `do-not-merge` or `needs-human` (it is still reviewed, and never merged). Label it `no-agent` to keep the agent away entirely: no review, no comment, no CI approval, no merge.
- Pause everything: **Actions → PR agent → ⋯ → Disable workflow**.
- Undo a merge: revert it like any other commit.

## What it cannot do

- It is a model reading a diff, plus tests. It can miss a subtle problem, and tests do not catch a malicious change that passes them. That is why the dependency, publishing and pipeline files are never merged without a person, and why a person can always revert.
- It judges the change, not whether the feature is wanted. A good-quality PR that does not fit the project's direction still merges if it passes. Label it, or close it.
- It cannot approve a first-time contributor's CI run if GitHub does not allow the workflow token to do so; the comment then says a maintainer must press "Approve and run workflows".
- Written and tested against a fake GitHub and a fake Anthropic server (`tests/integration/pr-agent.test.ts`) and read-only against the real GitHub API. It has been run for real once, on a one-line docs PR (#31): Claude reviewed it, CI passed on all three systems, and the agent merged it and started the tests on `main`. Larger and riskier PRs have not been through it yet.
