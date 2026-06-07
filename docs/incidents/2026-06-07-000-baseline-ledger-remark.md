# Incident note — prod `000_baseline` ledger checksum re-mark

**Date:** 2026-06-07
**Operation:** `--mark-applied`-class re-mark of `schema_migrations` on prod (DO managed Postgres `sitelayer_prod`).
**Authority:** Operator explicitly granted ("Work through all of this, you have authority", 2026-06-07).
**Classification:** Emergency-only / operator-approval operation per the production-change rules (CLAUDE.md → Deploy procedure rule 2; global production rules). This note is the required incident record.

## What changed

A single `UPDATE` on prod's `schema_migrations`:

```
UPDATE schema_migrations
   SET checksum = '96ee771636f45032fedb9da2576a961c545e2c4bff28392f396c0df4e93a6c5f'
 WHERE name = '000_baseline.sql' AND checksum <> '96ee771636f45032fedb9da2576a961c545e2c4bff28392f396c0df4e93a6c5f';
-- UPDATE 1 (transactional, committed)
```

- **Old checksum (recorded for reversibility):** `b39f202a6cfb9109aceb26056d94eb3cfd47f02198181aa798bf393104c24f58` (applied_at `2026-06-03 01:18:05Z`)
- **New checksum:** `96ee771636f45032fedb9da2576a961c545e2c4bff28392f396c0df4e93a6c5f` (= current `sha256(docker/postgres/init/000_baseline.sql)`)
- No schema/data touched — only the ledger row's recorded checksum.

## Why

The rebaseline regenerated `000_baseline.sql` **after** prod recorded its ledger row, so prod's recorded checksum was stale relative to the file. Effect: every `migrate-db.sh` run logged `ERROR: migration '000_baseline.sql' was already applied with a different checksum` (a `\quit 3` in the per-migration wrapper). This proved **non-fatal** in practice — deploys 011, 012, and 013 all applied past it — but it produced a recurring scary ERROR line and left the ledger inconsistent with the repo.

Migration `013_prod_baseline_reconcile.sql` (deployed 2026-06-07, prod `76fcaab7`) reconciled the only real schema drift (added `feedback_invites` + `context_work_items_request_ref_uidx`), so prod's actual schema now matches `000_baseline + 001..013`. The parity diagnosis confirmed full set-equality. Re-marking the baseline checksum therefore aligns the ledger with a schema that genuinely matches the current baseline file.

## Effect / verification

- Next `migrate-db.sh` run: `000_baseline.sql` → name in ledger, checksum matches → "Skipping already-applied migration" (no ERROR, no `\quit 3`). The recurring deploy ERROR is gone.
- 001..013 checksums already matched the repo (verified in the parity diagnosis); only the baseline was stale.
- Confirmed: `UPDATE 1`, post-update `SELECT` shows the new checksum.

## Reversibility

```
UPDATE schema_migrations
   SET checksum = 'b39f202a6cfb9109aceb26056d94eb3cfd47f02198181aa798bf393104c24f58'
 WHERE name = '000_baseline.sql';
```

(Reverting would simply restore the cosmetic ERROR; it does not affect schema correctness either way.)
