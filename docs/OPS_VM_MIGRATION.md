# Ops VM Migration — move the deploy authority off `taylor-pc`

**Goal:** move the **deploy authority** (`scripts/deploy.sh` for prod/dev/demo)
and the **auto-deploy watcher** (`docs/AUTO_DEPLOY.md`) off the operator's
workstation (`taylor-pc`) onto a small **always-on DigitalOcean ops VM**, using a
**dedicated deploy SSH key** and a **git deploy token** — never the operator's
personal credentials.

**Status:** runbook only. Nothing here is automated; the operator provisions the
VM and runs these steps. Cross-reference: `docs/AUTO_DEPLOY.md` (the watcher),
`scripts/deploy.sh` / `scripts/deploy-production-local.sh` (the deploy path),
`INFRASTRUCTURE_READY.md` (the live footprint).

## Why

Today the deploy path runs from `taylor-pc`:

- `scripts/deploy.sh prod` builds the image, `doctl registry login`s, pushes to
  the DO registry, and SSHes to the prod droplet (`sitelayer@165.245.230.3`) to
  pull + migrate + swap. It reuses the **operator's** ssh key, git creds, and
  `doctl` context.
- The auto-deploy **user** systemd timer also runs as the operator and reuses
  the **operator's** ssh key + git creds (see the unit header in
  `ops/systemd/sitelayer-auto-deploy.service`).

That couples production deploys to one laptop being awake, logged in, and
holding personal credentials. An always-on ops VM with **scoped** creds removes
the laptop from the critical path and shrinks the blast radius of those creds.

> **Prod stays manual-by-policy.** Moving the deploy authority to the ops VM does
> **not** change the rule that `deploy.sh prod` is a deliberate operator action;
> the auto-deploy watcher still **never** touches prod (it manages `dev`/`demo`
> only). The ops VM is simply where both now run from.

## Target shape

```
                         DO ops VM (always-on, $6/mo)
                         user: ops
   origin/dev advances ─▶  ├─ sitelayer-auto-deploy.timer (user) ─▶ deploy.sh dev/demo
                         │  ├─ scripts/deploy.sh prod  (operator runs by hand)
   deploy SSH key  ──────┘  ├─ doctl context (scoped DO token)
   git deploy token ──────▶ └─ dedicated checkout(s) under ~/.cache + ~/projects
                                        │ ssh (deploy key)
                                        ▼
                         prod droplet (sitelayer@165.245.230.3)
                         preview droplet (sitelayer@159.203.53.218)
```

## 0. Prerequisites (decide first)

- A new small DO droplet for ops (`s-1vcpu-1gb`, ~$6/mo) in `tor1` is fine — it
  only builds/pushes images and SSHes out. If you want image builds to be fast,
  size up to `s-2vcpu-4gb`; BuildKit caching helps either way.
- It needs **egress** to: GitHub (clone/fetch), the DO registry, and SSH to the
  prod + preview droplets. Add it to the droplets' SSH allow-lists (the
  `digitalocean_firewall` `source_droplet_ids` / `ssh_allow_cidrs` in
  `infra/terraform`, or via `doctl`/console) — prefer the droplet-id source rule
  over a broad CIDR.
- Decide the VM user name (this runbook uses `ops`).

## 1. Provision the ops VM

```bash
# From a box with doctl + the DO token (or via the DO console):
doctl compute droplet create sitelayer-ops \
  --region tor1 --size s-1vcpu-1gb --image ubuntu-22-04-x64 \
  --ssh-keys <your-bootstrap-key-id> --vpc-uuid <tor1-vpc-uuid> --wait

# Then, as root on the new VM:
adduser --disabled-password --gecos "" ops
usermod -aG docker ops            # image builds; docker group is root-equivalent
loginctl enable-linger ops        # user timers fire while logged out
# Install toolchain: docker, git, curl, jq, nodejs+npm (for the verify gate),
# and doctl. Match the node major used by the repo.
```

## 2. Dedicated deploy SSH key (NOT a personal key)

```bash
# As `ops` on the ops VM — generate a key used ONLY for deploys:
sudo -iu ops
ssh-keygen -t ed25519 -f ~/.ssh/sitelayer_deploy -C "sitelayer-ops-deploy" -N ""

# Add the PUBLIC key to the droplets' deploy user (sitelayer):
#   append ~/.ssh/sitelayer_deploy.pub to /home/sitelayer/.ssh/authorized_keys
#   on BOTH the prod droplet (165.245.230.3) and the preview droplet
#   (159.203.53.218). scripts/setup-deploy-user.sh prepares that file.
```

Wire the key in `~/.ssh/config` so `deploy.sh` / the watcher pick it up without
extra env:

```sshconfig
# ~/.ssh/config on the ops VM (user ops)
Host sitelayer-prod
  HostName 165.245.230.3
  User sitelayer
  IdentityFile ~/.ssh/sitelayer_deploy
  IdentitiesOnly yes
Host sitelayer-preview
  HostName 159.203.53.218
  User sitelayer
  IdentityFile ~/.ssh/sitelayer_deploy
  IdentitiesOnly yes
```

`scripts/deploy-production-local.sh` reads `DEPLOY_HOST`/`DEPLOY_USER`
(defaults `165.245.230.3` / `sitelayer`); `scripts/deploy.sh` reads
`PREVIEW_BOX` (default `159.203.53.218`). The watcher uses `ssh` directly. With
the `~/.ssh/config` above the host IP still resolves the dedicated key via
`IdentityFile`, so no override is strictly required — but you can also set
`GIT_SSH_COMMAND="ssh -i ~/.ssh/sitelayer_deploy -o IdentitiesOnly=yes"` in the
unit environment to be explicit.

> Treat this key like a production root key: docker-group membership on the
> droplets is root-equivalent (see `scripts/setup-deploy-user.sh`).

## 3. Git deploy token (NOT personal git creds)

The watcher and the deploy checkouts clone over HTTPS
(`https://github.com/GitSteveLozano/sitelayer.git`). Use a **scoped, read-only
deploy token**, not the operator's account:

- Preferred: a GitHub **deploy key** (read-only) on the `sitelayer` repo, and
  set `AUTODEPLOY_REMOTE_URL=git@github.com:GitSteveLozano/sitelayer.git` plus an
  `~/.ssh/config` `Host github.com` entry using that deploy key. Read-only is
  enough — the deploy path never pushes.
- Or a fine-grained PAT scoped to `Contents: read` on the single repo, stored in
  `~/.git-credentials` (mode 600) with `git config --global credential.helper store`.

Confirm the token can only **read** the repo and touches nothing else in the
operator's account.

## 4. doctl context (scoped DO token)

```bash
# As ops on the ops VM:
doctl auth init --context sitelayer-ops    # paste a DO token scoped to:
#   - container registry read/write (push images, GC tags)
#   - droplet read (for firewall/source-droplet checks, optional)
# Do NOT reuse the operator's full-access personal DO token.
doctl auth switch --context sitelayer-ops
doctl registry login    # caches registry docker creds for image push/pull
```

`scripts/deploy-production-local.sh` requires `doctl` and runs
`doctl registry login` + tag GC itself, so the context above is all it needs.

## 5. Copy the watcher + units, then install

The watcher script and units already live in the repo — you do **not** hand-copy
the script bytes; you check out the repo on the ops VM and run the installer.
What to bring over / set up:

- The repo checkout the operator runs from: `~/projects/sitelayer` (the units use
  `WorkingDirectory=%h/projects/sitelayer`). Clone it as `ops`.
- `~/.local/bin/fleet-auto-deploy.sh` — **not needed to copy**: the unit's
  `ExecStart` points at `%h/projects/sitelayer/scripts/fleet-auto-deploy.sh` in
  the checkout, not a `~/.local/bin` copy. (If you keep a personal
  `~/.local/bin/fleet-auto-deploy.sh` symlink on `taylor-pc`, drop it here too
  for muscle-memory, but it is optional.)
- The systemd units: `ops/systemd/sitelayer-auto-deploy.{service,timer}` ship in
  the repo; the installer copies them to `~/.config/systemd/user/`.

```bash
# As ops on the ops VM:
git clone <deploy-token-or-deploy-key-url> ~/projects/sitelayer
cd ~/projects/sitelayer
# The unit PATH must resolve git/curl/jq/ssh/flock AND node/npm/docker (the
# verify gate + image build). Edit ops/systemd/sitelayer-auto-deploy.service
# Environment=PATH=... if your node/docker live outside the defaults.
scripts/install-auto-deploy-systemd.sh
```

If the ops VM should also run the deterministic e2e suite, install that timer
too (it is a separate, quiet-box concern — see `docs/E2E_RUNNER.md`):

```bash
scripts/install-e2e-runner-systemd.sh --nightly 04:30
```

## 6. Environment the units need

The auto-deploy unit runs the verify gate before shipping (`VERIFY_LEVEL=fast`
by default; raise via the unit `Environment=`). On the ops VM that means:

- `node`/`npm` on the unit `PATH` (the watcher's dedicated checkout has no
  `node_modules`; it ships an already-gated SHA with `SKIP_VERIFY=1`, but a
  manual `scripts/deploy.sh` you run from `~/projects/sitelayer` WILL run the
  gate and needs `npm ci` there once).
- `docker` reachable (for the prod image build + the integration/e2e stages).
- `DEPLOY_HOST`/`DEPLOY_USER`/`PREVIEW_BOX` default correctly; override only if a
  host moves.
- Optional alerting env (`SENTRY_DSN`, `PUSHOVER_TOKEN`/`PUSHOVER_USER`) if you
  want the e2e runner / timer monitor to page from this box.

Keep any secrets in a `root`-readable env file with mode `600`, referenced by the
unit `EnvironmentFile=` — **not** committed.

## 7. Cutover

1. **Pause the laptop watcher** so two boxes don't race the same tier:
   ```bash
   # On taylor-pc:
   touch ~/.cache/sitelayer-autodeploy/PAUSED
   ```
2. **Verify the ops VM watcher is live and idle-clean:**
   ```bash
   # On the ops VM:
   systemctl --user start sitelayer-auto-deploy.service
   journalctl --user -u sitelayer-auto-deploy.service -n 50 --no-pager
   # Expect "OK tier=dev ... (no deploy)" / "OK tier=demo ..." when already-current.
   ```
3. **Force a dev round-trip:** push a trivial commit to `dev`, watch the ops VM
   pick it up within ~2 min and deploy `dev`+`demo`, then confirm:
   ```bash
   curl -fsS https://dev.sitelayer.sandolab.xyz/api/version  | jq .build_sha
   curl -fsS https://demo.preview.sitelayer.sandolab.xyz/api/version | jq .build_sha
   ```
4. **Prod dry run (manual, deliberate):** from the ops VM checkout, run a prod
   deploy of the current `main` tip and confirm the registry push + droplet swap
   work with the **deploy key + doctl context** (not personal creds):
   ```bash
   cd ~/projects/sitelayer && git fetch origin && git checkout origin/main
   scripts/deploy.sh prod
   curl -fsS https://sitelayer.sandolab.xyz/api/version | jq .build_sha
   ```

## 8. Verification checklist (done = all green)

- [ ] Ops VM auto-deploy timer enabled, linger on, idle poll logs `OK ... (no deploy)`.
- [ ] A `dev` push auto-deploys `dev`+`demo` from the ops VM (build_sha matches).
- [ ] `scripts/deploy.sh prod` works from the ops VM using the **deploy key** +
      scoped **doctl context** + read-only **git token** (no personal creds in
      the path).
- [ ] The laptop watcher stays paused (or its timer is disabled):
      `systemctl --user disable --now sitelayer-auto-deploy.timer` on `taylor-pc`.
- [ ] Deploy SSH key + doctl token + git token are all **scoped** and stored
      mode-600 on the ops VM only; the operator's personal creds are NOT on it.
- [ ] (Optional) e2e runner timer installed per `docs/E2E_RUNNER.md`.

## 9. Rollback

If the ops VM misbehaves, fall back to the laptop immediately:

```bash
# On taylor-pc:
rm ~/.cache/sitelayer-autodeploy/PAUSED        # resume laptop watcher
# On the ops VM:
systemctl --user disable --now sitelayer-auto-deploy.timer
```

The laptop path is unchanged and resumes managing `dev`/`demo`. Prod is always a
manual `scripts/deploy.sh prod` from whichever box holds the deploy creds, so
there is no half-migrated prod state to unwind.

## Notes

- This migration is **credential hygiene + availability**, not a deploy-mechanism
  change: `scripts/deploy.sh` and the watcher behave byte-identically; only the
  box and the credentials change.
- Keep the ops VM patched and its firewall tight — it holds deploy-capable creds.
  Prefer droplet-id SSH source rules over broad CIDRs.
- Update `INFRASTRUCTURE_READY.md` / mesh once the ops VM is the source of truth
  so the next on-call knows deploys originate there, not from `taylor-pc`.
