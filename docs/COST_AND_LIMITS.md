# Sitelayer Cost & Limits

**Last reconciled:** 2026-04-25.
**Currency:** USD unless noted.
**Source of truth:** DigitalOcean billing dashboard, Cloudflare dashboard, Clerk dashboard, Sentry usage page.

This is the standing burn for keeping prod + preview alive. Customer-driven costs (e.g. inbound Spaces egress on blueprint downloads) are tracked separately as variable usage.

---

## Current monthly recurring infra

| Line item                               | Plan / SKU                          | Notes                                                | Cost (USD)  |
| --------------------------------------- | ----------------------------------- | ---------------------------------------------------- | ----------- |
| Production droplet (`sitelayer`)        | `s-4vcpu-8gb` Toronto               | 4 vCPU / 8 GB RAM / 160 GB SSD                       | $48.00      |
| Preview droplet (`sitelayer-preview`)   | `s-2vcpu-4gb` Toronto               | Hosts self-hosted GHA runner + per-PR preview stacks | $24.00      |
| Managed Postgres (`sitelayer-db`)       | `db-s-1vcpu-1gb` Toronto, 1 node    | PG 18, automatic backups + 7-day PITR included       | $15.00      |
| Reserved IP `159.203.51.158`            | DO reserved IP, attached to prod    | Free while attached to a running droplet             | $0.00       |
| Reserved IP `159.203.53.218`            | DO reserved IP, attached to preview | Free while attached to a running droplet             | $0.00       |
| Reserved IP `159.203.51.235`            | DO reserved IP, unassigned          | Release it or account for any unassigned-IP billing  | TBD         |
| Droplet weekly backups (prod + preview) | DO droplet backup add-on            | 20% of droplet price; (48 + 24) × 0.20               | $14.40      |
| Spaces (`sitelayer-blueprints-prod`)    | Standard Storage, Toronto           | 250 GB storage + 1 TB outbound transfer included     | $5.00       |
| Container Registry (`sitelayer`)        | Starter, Toronto                    | 1 repo / 500 MiB; immutable runtime image tags       | $0.00       |
| Cloudflare DNS — 4 zones                | Free plan                           | `sandolab.xyz` + 3 sibling zones                     | $0.00       |
| Clerk auth                              | Hobby (Free)                        | 50,000 MAU, 100 retained orgs, 3 social providers    | $0.00       |
| Sentry                                  | Developer (Free) — **TBD verify**   | DSN ingest only; plan page not scraped this cycle    | $0.00       |
| **Subtotal — DigitalOcean**             |                                     |                                                      | **$106.40** |
| **Subtotal — non-DO recurring**         |                                     |                                                      | **$0.00**   |

### Annualized

| Line item             | Provider             | Annual cost            |
| --------------------- | -------------------- | ---------------------- |
| `sandolab.xyz` domain | Cloudflare Registrar | ~$10.44/yr (≈$0.87/mo) |

Domain renewal is a year-billed item; treat it as ~$1/mo equivalent for budgeting purposes.

---

## Upgrade triggers

Tripping any of these means it's time to upsize. Re-evaluate quarterly (paired with the secret-rotation calendar reminder).

| Metric                                       | Current cap                                 | Trigger                                                                            | Upgrade action                                                                                                                 | Δ cost                  |
| -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Postgres CPU                                 | 1 vCPU                                      | > 70% sustained 1h                                                                 | `doctl databases resize 9948c96b-... --size db-s-2vcpu-4gb`                                                                    | +$15 → $30              |
| Postgres connections                         | 22 (1GB tier)                               | > 18 used                                                                          | Same resize; 4GB tier → 97 connections                                                                                         | +$15                    |
| Droplet bandwidth (prod)                     | 4 TB included                               | > 80% (3.2 TB)                                                                     | `doctl compute droplet resize 566798325 --size s-4vcpu-16gb` (8 TB)                                                            | +$48 → $96              |
| Droplet disk                                 | 160 GB                                      | > 75% (`df -h /`)                                                                  | Resize droplet (disk grows with size class)                                                                                    | varies                  |
| Clerk MAU                                    | 50,000 (Hobby)                              | > 40,000 (80% of cap)                                                              | Move to Pro (~$25/mo + per-MAU > 10k); pricing curve favors Hobby until ~10k organizations or auth features (MFA enforce, SSO) | +$25+                   |
| Clerk retained orgs                          | 100                                         | > 80                                                                               | Same Pro upgrade                                                                                                               | +$25+                   |
| Sentry events / replays                      | Free tier — **verify quota**                | > 80% any line                                                                     | Drop `tracesSampleRate` (currently 1.0) to 0.2; if still tight, upgrade to Team ($26/mo)                                       | +$0–$26                 |
| Spaces storage (`sitelayer-blueprints-prod`) | 250 GB included                             | > 200 GB                                                                           | Add 250 GB block: $5/mo (Spaces extra-storage SKU)                                                                             | +$5                     |
| Spaces egress                                | 1 TB included                               | > 800 GB                                                                           | Same Spaces extra-bandwidth SKU                                                                                                | +$5/TB                  |
| Container Registry storage                   | 500 MiB included                            | > 400 MiB or frequent image-prune pressure                                         | Move registry from Starter to Basic                                                                                            | +$5                     |
| Backup retention spillover                   | 30 days local + 30 days off-host on preview | `/app/backups/postgres` or `/app/offsite-backups/postgres-from-prod` > 75% of disk | Move the second copy to Spaces or another object store                                                                         | $0 compute; storage TBD |

For each trigger: log the breach in mesh (`mcp__mesh__add_planning_note project=sitelayer kind=infra-trigger`), execute the upgrade in the next maintenance window (Sun 02:00–06:00 ET, low-traffic), and update the cost line above.

---

## Sentry plan — TBD verification

Could not confirm the active Sentry plan from CLI/env alone. To verify:

1. Open https://sandolabs.sentry.io/settings/billing/ (browser, signed in as Taylor).
2. Note the plan name and the monthly quota for "Errors", "Transactions", and "Replays".
3. Update the table above and remove the **TBD verify** marker.

If the plan is "Developer" (free), expect 5k errors / 10k transactions / 50 replays per month. With `tracesSampleRate=1.0` we will burn through 10k transactions fast at any meaningful traffic — this is the most likely first upgrade trigger.

---

## Total monthly recurring infra spend

**~$106/month.** (Plus ~$0.87/mo amortized domain renewal — call it $107/mo all-in.)
