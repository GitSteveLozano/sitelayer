# RUNBOOK — Flip `GitSteveLozano/sitelayer` PRIVATE without breaking deploys

**Status:** repo is PUBLIC and anonymously clonable as of 2026-06-12.
**Decision owners:** Taylor (operator) + Steve (repo owner — the GitHub repo
lives under his account; only he or an org admin can flip visibility).

Why this exists: until 2026-06-12 the deploy/e2e paths hard-coded the
anonymous `https://github.com/GitSteveLozano/sitelayer.git` clone URL in four
scripts (`deploy.sh`, `deploy-production-local.sh`, `fleet-auto-deploy.sh`,
`e2e-runner.sh`), so flipping the repo private would have broken prod deploy,
dev/demo auto-deploy, and the scheduled e2e run. All four now resolve the
remote through **one knob**: `SITELAYER_REPO_URL` (see
`scripts/repo-remote.sh`; default is still the anonymous https URL, so
nothing changes until you set it). The same date, the tracked client data
(WhatsApp thread export + real customer estimate PDFs with GST numbers) was
removed from HEAD — but it **remains in git history** until step (e).

Run the steps **in order**. Steps (a)–(b) are safe at any time; step (c) is
the actual cutover; (d) verifies; (e) is a separate decision.

---

## (a) Mint a read-only credential (Steve, ~10 min)

Pick ONE of the two forms. Prefer the fine-grained token (https) because every
consumer already speaks https and no per-host SSH key management is needed.

**Option 1 — fine-grained PAT (recommended):**

1. GitHub (as Steve) → Settings → Developer settings → Fine-grained personal
   access tokens → _Generate new token_.
2. Name: `sitelayer-deploy-ro`. Resource owner: `GitSteveLozano`.
   Repository access: **Only select repositories → sitelayer**.
3. Permissions: **Contents: Read-only**. Nothing else. Expiry: 1 year
   (calendar a rotation).
4. The resulting URL form every consumer uses:

   ```
   SITELAYER_REPO_URL=https://x-access-token:<TOKEN>@github.com/GitSteveLozano/sitelayer.git
   ```

**Option 2 — per-host SSH deploy key:** generate `ssh-keygen -t ed25519` on
each consumer host, add each public key under repo → Settings → Deploy keys
(read-only), and use
`SITELAYER_REPO_URL=git@github.com:GitSteveLozano/sitelayer.git`. More keys to
manage, but no secret ever appears in a URL / process env / `.git/config`.

> Secret-hygiene notes (token form): the token rides inside the URL, so it
> ends up (1) in `.git/config` of each dedicated checkout
> (fleet `~/.cache/sitelayer-autodeploy/repo`, e2e
> `~/.cache/sitelayer-e2e-runner/repo`, preview droplet
> `~/sitelayer-deploy-src`, prod droplet `/app/sitelayer`), and (2) briefly in
> the `ssh` argv of a running deploy (visible in `ps` on the fleet box and the
> droplet for the duration of the ssh call). All of these hosts are
> operator-controlled; the token is Contents:Read-only on one repo. If that
> residual is unacceptable, use Option 2 (SSH). The scripts themselves never
> echo the URL — logs go through `sitelayer_repo_url_redacted`
> (`scripts/repo-remote.sh`), and there is no `set -x` around it.

## (b) Place the credential on every consumer (Taylor)

Four consumers. `SITELAYER_REPO_URL` is exported by `scripts/repo-remote.sh`,
so child invocations inherit it automatically.

1. **Operator fleet box (manual `scripts/deploy.sh prod|dev|demo`)** — the
   prod droplet and preview droplet never store the credential at rest in env
   files: `deploy.sh` / `deploy-production-local.sh` pass `SITELAYER_REPO_URL`
   into the remote heredoc env on each deploy. So the only place it must live
   is the fleet side:
   - Add to the gitignored build-secrets file
     `~/projects/sitelayer/ops/env/production.build.env` (mode 600 — created
     if absent):

     ```
     SITELAYER_REPO_URL=https://x-access-token:<TOKEN>@github.com/GitSteveLozano/sitelayer.git
     ```

     `deploy-production-local.sh` sources that file. For `deploy.sh dev|demo`
     (which does NOT source it), also export it in the operator shell profile
     or `~/.env.local`, or invoke as
     `SITELAYER_REPO_URL=... scripts/deploy.sh dev`.

2. **Fleet auto-deploy watcher** (user systemd on the fleet box, e.g.
   taylor-pc-ubuntu): units `sitelayer-auto-deploy.service` +
   `sitelayer-auto-deploy.timer` (installed to `~/.config/systemd/user/` by
   `scripts/install-auto-deploy-systemd.sh`, sources in `ops/systemd/`).
   Don't put the token in the 0644 unit file — use a drop-in pointing at a
   0600 env file:

   ```bash
   mkdir -p ~/.config/sitelayer && touch ~/.config/sitelayer/repo-remote.env
   chmod 600 ~/.config/sitelayer/repo-remote.env
   echo 'SITELAYER_REPO_URL=https://x-access-token:<TOKEN>@github.com/GitSteveLozano/sitelayer.git' \
     > ~/.config/sitelayer/repo-remote.env
   mkdir -p ~/.config/systemd/user/sitelayer-auto-deploy.service.d
   printf '[Service]\nEnvironmentFile=%%h/.config/sitelayer/repo-remote.env\n' \
     > ~/.config/systemd/user/sitelayer-auto-deploy.service.d/repo-remote.conf
   systemctl --user daemon-reload
   ```

   The watcher exports the var to the `deploy.sh` it runs, which forwards it
   to the preview droplet — no droplet-side config needed.

3. **E2E runner** (user systemd wherever it's installed — preview droplet or a
   quiet box): units `sitelayer-e2e-runner.service` +
   `sitelayer-e2e-runner.timer` (installed by
   `scripts/install-e2e-runner-systemd.sh`). Same drop-in pattern:

   ```bash
   mkdir -p ~/.config/systemd/user/sitelayer-e2e-runner.service.d
   printf '[Service]\nEnvironmentFile=%%h/.config/sitelayer/repo-remote.env\n' \
     > ~/.config/systemd/user/sitelayer-e2e-runner.service.d/repo-remote.conf
   systemctl --user daemon-reload
   ```

4. **Droplet checkouts (one-time hygiene, optional but tidy):** the next
   deploy rewrites `origin` from the passed env automatically
   (`git remote set-url origin "$SITELAYER_REPO_URL"` runs every deploy on
   both droplets), so no manual step is required. If you flip private and
   want the checkouts working _before_ the first post-cutover deploy, set the
   remote by hand once:
   - prod: `ssh sitelayer@165.245.230.3` →
     `git -C /app/sitelayer remote set-url origin '<URL>'`
   - preview: `ssh sitelayer@159.203.53.218` →
     `git -C ~/sitelayer-deploy-src remote set-url origin '<URL>'`

   SSH form instead: install the deploy key + `github.com` known_hosts on
   both droplets and both runner hosts.

Also update any collaborator machines (Steve's local Claude Code clone per
`docs/STEVE_LOCAL_CLAUDE_CODE_HANDOFF.md` uses his own GitHub auth — owner
access survives the flip; nothing to do).

## (c) Flip the repo private (Steve, 1 min)

GitHub → `GitSteveLozano/sitelayer` → Settings → General → Danger Zone →
_Change repository visibility_ → Private.

Notes:

- The repo runs **ZERO GitHub Actions** (purged 2026-06-01/02; gates are
  `scripts/verify-local.sh`, `scripts/*lint*`, `.githooks/pre-push`) — so
  there is no Actions/runner entitlement to lose in the flip.
- GitHub branch protection on `main` is optional hygiene, not a deploy gate;
  private-repo protection rules on a free personal account may be limited —
  acceptable, the pre-push hook is the real gate.
- Forks/stars are detached by GitHub on the flip; anonymous clones stop
  immediately. **Anything already cloned/cached by third parties is not
  recalled — that is what step (e) + token-class rotation is for.**

## (d) Verify every consumer (Taylor, ~15 min)

Run in this order, same day as the flip:

1. **Anonymous access is dead:**
   `git ls-remote https://github.com/GitSteveLozano/sitelayer.git` from any
   box WITHOUT the credential → must FAIL.
2. **Credentialed access works:**
   `git ls-remote "$SITELAYER_REPO_URL" refs/heads/dev` on the fleet box →
   prints a SHA. (Do not echo the URL.)
3. **Watcher:** `systemctl --user start sitelayer-auto-deploy.service`, then
   `journalctl --user -u sitelayer-auto-deploy.service -n 50` — expect
   `OK tier=...` or a normal `DEPLOY`, no fetch/auth errors. The clone log
   line shows the redacted URL (`https://***@github.com/...`).
4. **Dev deploy end-to-end:** push a trivial commit to `dev` (or re-run the
   watcher) and confirm `https://dev.sitelayer.sandolab.xyz/api/version`
   advances to the new SHA — this proves the _preview-droplet_ checkout
   fetches with the credential.
5. **Prod deploy path (next scheduled prod ship, or a code-only drill):**
   `scripts/deploy.sh prod` (optionally `SKIP_MIGRATIONS=1`) — proves the
   _prod-droplet_ checkout fetches with the credential.
6. **E2E runner:** `systemctl --user start sitelayer-e2e-runner.service` on
   its host; check `~/.cache/sitelayer-e2e-runner/e2e-runner.log` for
   `VERIFY`/`PASS`, no auth errors.

If any consumer fails: the break-glass is to temporarily flip the repo back
to public (visibility is reversible), fix the credential placement, re-flip.

## (e) Decide the history rewrite (Taylor + Steve, separate decision)

The 2026-06-12 `git rm` removed the client data from HEAD only. **Every blob
below is still fetchable from history by anyone with read access** (and was
fetchable by _anyone at all_ while the repo was public — treat the contents
as disclosed; flipping private + rewriting limits future exposure, it does
not un-leak).

Candidate blobs (SHAs at the pre-removal HEAD of `agent/claude/debt-campaign`):

| Blob SHA       | Size   | Path (historical)                             | Contents                                                                                                                                                |
| -------------- | ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e23ae704baae` | 21 KB  | `docs/WhatsApp Chat with LA  Tiny Bison.txt`  | full client WhatsApp thread (LA / Tiny Bison)                                                                                                           |
| `cd15b97aeaae` | 312 KB | `docs/WhatsApp Chat with LA _ Tiny Bison.zip` | same thread, zip export (was explicitly allowlisted in `.gitignore`)                                                                                    |
| `f3b48fece12b` | 1.7 MB | `blueprints_sample/1580_Warde_estimate.pdf`   | real customer estimate                                                                                                                                  |
| `417af5ac3f44` | 136 KB | `blueprints_sample/215_Cinnamon_Colors.pdf`   | real customer doc                                                                                                                                       |
| `b5974e184fca` | 37 KB  | `blueprints_sample/Estimate_5981.pdf`         | real customer estimate — GST/HST reg. no. 813435252, client address/email                                                                               |
| `c11a26c4b5fa` | 1.2 MB | `Sitelayer (2).zip`                           | the 2026-05-04 web-UI upload incident (commits `43612f3` → deleted in `a80163a` 2 min later) — precedent already documented at `.gitignore` lines 20–27 |

**Precedent:** the 05-04 zip was deliberately NOT rewritten ("force-pushing
all of main wasn't worth it"). The calculus differs now: that blob was a
design bundle; these are client PII/financial documents that sat on a public
repo. Recommendation: **rewrite once, covering all six blobs in one pass**,
right after the private flip (smallest collaborator set; Steve + fleet
checkouts only).

Rewrite (operator/Steve only — agents must NOT run this; it force-pushes all
branches and invalidates every clone):

```bash
# Preferred: git-filter-repo (fresh mirror clone)
git clone --mirror "$SITELAYER_REPO_URL" sitelayer-rewrite.git
cd sitelayer-rewrite.git
git filter-repo \
  --invert-paths \
  --path 'docs/WhatsApp Chat with LA  Tiny Bison.txt' \
  --path 'docs/WhatsApp Chat with LA _ Tiny Bison.zip' \
  --path 'blueprints_sample/1580_Warde_estimate.pdf' \
  --path 'blueprints_sample/215_Cinnamon_Colors.pdf' \
  --path 'blueprints_sample/Estimate_5981.pdf' \
  --path 'Sitelayer (2).zip'
git push --force --mirror origin

# Alternative: BFG (same effect, blob-size/name driven)
#   bfg --delete-files '{Estimate_5981.pdf,1580_Warde_estimate.pdf,215_Cinnamon_Colors.pdf}' \
#       --delete-files 'WhatsApp Chat*' --delete-files 'Sitelayer (2).zip' sitelayer-rewrite.git
#   cd sitelayer-rewrite.git && git reflog expire --expire=now --all && git gc --prune=now --aggressive
#   git push --force --mirror origin
```

After the rewrite:

- GitHub support request to purge cached views/PR refs of the old blobs
  (rewritten blobs can remain reachable by SHA on GitHub until purged).
- Every checkout must re-clone (or `git fetch && git reset --hard` onto the
  rewritten refs): operator working tree, Steve's machine, fleet watcher repo
  (`rm -rf ~/.cache/sitelayer-autodeploy/repo` — it re-clones itself), e2e
  runner repo (same), preview droplet `~/sitelayer-deploy-src` (deploy.sh
  re-clones if you delete it), prod droplet `/app/sitelayer` (**careful:**
  delete only `.git`-tracked content, PRESERVE `.env`, `.last_*`,
  `.env.bak.*` — or just `git fetch && git reset --hard <new main>` there).
- The pre-push hook + merge discipline apply as normal afterwards; never
  rewrite again casually.

**Client-facing follow-up (operator judgment):** the GST number and contact
details were public; decide whether to tell Cavy/LA Stucco. No credentials
were in these files (the WhatsApp thread should be skimmed once for any
shared passwords before closing this).

## Residual references (known, intentional)

- `docs/CUSTOMER_REQUIREMENTS_CAVY.md` cites
  `docs/WhatsApp Chat with LA  Tiny Bison.txt` as its source of truth — now a
  dangling prose citation (kept: the requirements table stands on its own;
  point it at an offline copy if desired). Several code comments cite
  "WhatsApp 4/x" by date — prose only, no file dependency.
- `packages/pipe-blueprint/NOTES.md` mentions `1580_Warde_estimate.pdf` in a
  historical demo command — prose only.
- `blueprints_sample/blueprints_example.pdf` (8.4 MB, added 2026-05-30) is
  KEPT: it is the sanitized synthetic sample that `apps/api/scripts/seed-dev.ts`
  (`npm run seed:dev`), `scenarios/takeoff-canvas-states.yaml`, and
  `scripts/takeoff-vision/*` reference. The seed iterates whatever PDFs exist
  in `blueprints_sample/`, so removing the client PDFs does not break it.
- The systemd unit `Documentation=` lines point at
  `https://github.com/GitSteveLozano/sitelayer/blob/main/docs/...` — they are
  links for humans, fine on a private repo (they just require login).
