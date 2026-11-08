# Sending a release to the stores

Status: **written from the stores' documentation and tested against fake servers. It has not been run against the real Chrome Web Store or Firefox Add-ons.** The first real run is yours: do it with the upload-only option, look at each store's dashboard, and only then use "submit". If a store has changed its API since this was written, the failing step says which one.

## What it does

A tag-triggered workflow ([`store-release.yml`](../.github/workflows/store-release.yml)) in two separate steps, so the manual approval the roadmap asked for is real:

| Step | Who starts it | What happens | Credentials |
|---|---|---|---|
| **Build and check** | pushing a tag `v<version>` | Builds the store packages and the source zip, and checks them with [`scripts/store-upload.mjs`](../scripts/store-upload.mjs): the version matches `package.json` and the tag, manifest version 3, **no manifest `key`** in the Chrome build, a gecko id in the Firefox build, no `web_accessible_resources`, and no `e2e-config.json`, `.env`, source maps or key files. Keeps the packages as a workflow artifact. | none |
| **Send** | **you**, by hand: Actions → *Store release* → Run workflow, on the tag | Uploads to the store you pick (Chrome, Firefox or both). *Upload only* by default: nothing is reviewed or published. Tick **submit** to also submit for review. | in the `store-release` environment, after its reviewers approve |

Nothing is published by a store job directly: a store's own review still happens, and the extension is not live until the store says so.

## Setting it up (once)

1. **Create the approval gate first.** Repository → Settings → Environments → New environment `store-release` → **Required reviewers**: add yourself. Do this before the first run: if the environment does not exist, GitHub creates it with no protection and the jobs would not wait for anyone. Also restrict it to tags `v*` ("Deployment branches and tags").
2. **Chrome Web Store.** In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) note the **publisher id** (account) and the **item id** (`ihbkpcclcolaeppmfgmndmemjljmiaec`). In Google Cloud, enable the *Chrome Web Store API*, create an OAuth client, and get a **refresh token** for the scope `https://www.googleapis.com/auth/chromewebstore` (see [Using the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)). Add these as secrets of the `store-release` environment: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID`, `CWS_ITEM_ID`.
3. **Firefox Add-ons.** Create an API key on the [credentials page](https://addons.mozilla.org/developers/addon/api/key/) and add `AMO_JWT_ISSUER` (the "JWT issuer") and `AMO_JWT_SECRET` as environment secrets. Optional: `AMO_ADDON` if the add-on's slug is not `browserforge`.
4. Type each secret into GitHub's page or at the `gh secret set --env store-release NAME` prompt. Never into a chat or a file.

## Releasing

1. Follow [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) (version bumps, tests, smoke runs), merge, then tag: `git tag v0.2.2 && git push origin v0.2.2`.
2. The build-and-check run must be green. Download the `store-packages` artifact if you want to look inside.
3. Actions → *Store release* → Run workflow → pick **the tag** (not a branch: the store jobs refuse anything else) → store: `chrome` / `firefox` / `both`, submit: **off** for the first try. Approve it when GitHub asks.
4. Look at the store's dashboard: the draft (Chrome) or the validated upload (Firefox) is there. Run it again with **submit** on when you are happy, or press the submit button in the dashboard yourself. Nothing here stops you doing the last step by hand.

## What it does not do

* **The listing:** the text, screenshots, categories and permission justifications ([STORE_LISTING.md](STORE_LISTING.md)) and the privacy policy stay as they are in the dashboards. For Firefox, Mozilla asks for the source of a bundled extension (the workflow attaches `git archive` of the tagged commit) and reviewers read the *notes to reviewer* you set in the dashboard.
* **The Chrome "publish" setting:** the store keeps the item's visibility. If someone changed it in the dashboard, the API cannot publish until it is published once by hand there.
* **Review and waiting:** both stores review a submission, which can take days and can reject it.
* **Rollback:** use each store's own tools.

## How the credentials are kept safe

* They are secrets of the `store-release` environment, which only the two store jobs can use, after a person approves. The build job and the pull-request agent never see them.
* The store jobs run **only from a version tag**, only when started by hand, and **install nothing** (no `npm ci`): they run one dependency-free script from the tagged commit, so no package can read the credentials.
* The script reads credentials only from environment variables, never prints them (tests check this for failures too), and talks only to the two stores' own addresses.
* The tests ([`tests/unit/workflows.test.ts`](../tests/unit/workflows.test.ts)) fail if a later change gives the build job a secret, lets a store job install packages, runs it from a branch, or puts a workflow input into a shell command.

## Trying the script by hand

```bash
node scripts/store-upload.mjs chrome  --zip artifacts/browserforge-chrome-store-0.2.1.zip      # checks only; no credentials, nothing sent
node scripts/store-upload.mjs firefox --zip artifacts/browserforge-firefox-0.2.1.zip --source artifacts/browserforge-source-0.2.1.zip
# with credentials in the environment: add --upload (a draft), then --upload --publish (submit for review)
```
