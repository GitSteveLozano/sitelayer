# Repo-admin TODOs (owner-only)

These three settings on `GitSteveLozano/sitelayer` require the **repo owner** (Steve) to enable; they are not blockers for shipping. Listed here so they're not forgotten if Steve ever wants to lock things down.

## 1. Branch protection on `main`

Settings → Branches → Add rule (`main`)

- Require status checks: `Quality / validate`
- Block force pushes
- Block branch deletion
- Optional stricter mode: require one approving pull-request review. `scripts/configure-github-protection.sh` enables this because it is the source-controlled default.

## 2. Repo description + homepage

Settings → General

- Description: `Construction operations platform: blueprint takeoff, estimation, crew scheduling, QBO sync`
- Website: `https://sitelayer.sandolab.xyz`

## 3. Security tab

Settings → Code security

- Enable Secret scanning + Push protection
- Enable Dependabot security updates

If Steve ever wants to grant Taylor admin role: Settings → Collaborators → change `taylorSando` → role `Admin`. After that the three above can be done from this repo via the `gh` CLI.
