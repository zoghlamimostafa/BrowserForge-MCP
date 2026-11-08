# Sharing skills: how far you can trust one

A skill is a folder of text (and optional workflows) that tells your agent how to do a kind of job. This page says what you can find and install today, what a shared skill can and cannot do, and how a proper library could be reviewed. Where something is only an idea, it says so.

## What exists today

| | |
|---|---|
| **Publish** | An npm package with the keyword `browserforge-skill`, a `package.json` with `"browserforge": { "id": "...", "kind": "skill", "description": "..." }`, and `skills/<name>/SKILL.md` inside ([SKILLS.md](SKILLS.md)). |
| **Find** | `browserforge skill search <words>` lists packages with that keyword: name, version, **who published it and when**, and a one-line description. It is a search, not a recommendation. |
| **Install** | `browserforge skill add <npm-name>` (or `<folder>`). It prints **every line** of the instructions the skill gives your agent, as plain text, then asks. `browserforge plugin add` of the same package shows the same text. |
| **Update** | `browserforge plugin update <id>` shows the new instructions again and asks again. |

**Not built:** a central registry, ratings, a "reviewed" badge, or signature checks. Anyone can publish with the keyword, and nobody here has reviewed what is on npm. Treat a search result as a lead.

## What a shared skill can and cannot do

**It cannot run code.** A skill package is never loaded as a program: BrowserForge reads its text and its workflow files only. It is installed with npm's scripts switched off, and `skill add` refuses a package that is a plugin (code), pointing you to `plugin add`, which shows what that plugin may do.

**It cannot skip an approval.** Submitting, sending, paying, passwords and uploads wait for a click in the browser extension that the agent cannot answer, whoever wrote the instructions ([SECURITY.md](SECURITY.md)). A skill's workflow can only use `browser_*`, `network_*`, `api_*` and `form_*` tools and plugin tools marked workflow-safe, and its steps still pause for approvals. A step may *add* an approval; nothing can remove one.

**It can steer your agent.** This is the real risk. A skill is text that your agent reads and tends to follow, and your agent can act in your real browser, logged in as you. A hostile skill could try to:

| Attempt | What stops it | What does not |
|---|---|---|
| Make the agent do something consequential (send, pay, submit) | The approval click is yours. | If you approve without reading the prompt. |
| Send the agent to a website of the author's choice, or have it read your pages | Nothing technical: reading and navigating are not gated. | The agent can be pointed anywhere. Read the skill for URLs. |
| Tell the agent to ignore your own instructions or the project rules | Nothing technical: it is text. | Your agent may or may not push back. |
| Hide its real instructions from you at install | The whole text is printed, with control characters, escape codes and right-to-left tricks turned into visible dots, and an over-long skill (more than 400 lines) is refused instead of cut. | A skill that is long, boring and misleading in plain sight. |
| Change after you installed it | An update shows the new text and asks again. | Nothing watches a package for you between updates. |

So: **read the instructions `skill add` prints**, as you would read a script before running it. If you would not paste it into your agent yourself, do not install it.

## For people who publish skills

* Write instructions an honest reviewer would be happy to read: say which tools you use and in what order, and what you check. Do not tell the agent to skip approvals, to submit or pay without the user's intent, or to trust page content. Do not ask for credentials in the text.
* Keep `requires-tools` and `requires-plugins` accurate, put your name and repository in `package.json`, and keep the text short enough to read (under 400 lines).
* Do not add code, dependencies or install scripts. A skill package should have no dependencies at all.
* Use the `browserforge-skill` keyword so people can find it, and pin nothing you do not control.

## A review story (proposed, not built)

If shared skills grow, a curated list is how a person could be told "someone has read this version". The idea, kept deliberately small:

1. **An index file in this repository** (`skills/index.json`) lists skills by npm name with an **exact version and the package's integrity hash** (sha512, as npm publishes it), the reviewer's GitHub name, and the date.
2. **Adding or changing an entry is a pull request.** A maintainer reads the **whole skill text and workflows of that exact version**, not a summary, and checks the rules above. The PR agent already sends changes to protected paths to a person; the index would be one of them.
3. `browserforge skill add <name> --from-index` installs only the pinned version and refuses it if the downloaded package's hash differs. `skill search` would mark indexed entries as "read by <reviewer> on <date>, for this version only" and leave all others unmarked.
4. A bad entry is reported through a GitHub issue and removed by a PR; installed copies keep working until the person updates or removes them, so the removal notice should also go out through `skill search`.

What this would **not** be: a guarantee of safety. A reviewed skill is still text that steers an agent; the index only says a person read that version. It needs a maintainer's time for every entry, so it should start with a handful of skills (the ones in `skills/`) and grow only as fast as it can be reviewed.

Decide before building: who reviews, how fast a pull request is answered, and whether an entry may ever be updated without a fresh review (the proposal says no).

Related: [SKILLS.md](SKILLS.md) (writing skills), [PLUGINS.md](PLUGINS.md) (the code kind, with permissions), [SECURITY.md](SECURITY.md).
