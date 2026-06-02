-- 140_unit_canonical_expand.sql
--
-- Typed unit-of-measure — EXPAND step only (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md
-- §4 "Units", the top canonical silent-error class).
--
-- Today every `unit` column in sitelayer is FREE TEXT — service_item_assembly_components.unit,
-- takeoff_measurements.unit, estimate_lines.unit, service_items.unit — with no
-- enum, no conversion table, and no dimensional guard. The assembly-explode
-- notes call this out: a sqft measurement exploding through a per-LF component
-- produces a dimensionally-incorrect line, silently. The typed UoM layer +
-- conversion table + non-fatal dimensional guard now live in @sitelayer/domain
-- (packages/domain/src/uom.ts: normalizeUnit / convert / assertCompatible) and
-- the explode path surfaces a NON-FATAL `unit_warning` on incompatible lines.
--
-- This migration is the EXPAND half of an expand/backfill/contract rollout. It
-- ADDITIVELY adds a NULLABLE `unit_canonical` column alongside each existing
-- free-text `unit` column. It does NOT backfill, does NOT rewrite, and does NOT
-- reject any existing row:
--
--   - Every existing row keeps unit_canonical IS NULL. The free-text `unit`
--     column is unchanged and remains the source of truth until contract.
--   - New code TOLERATES both shapes during rollout: when unit_canonical is
--     NULL, callers normalizeUnit(unit) at read time (returns null for free
--     text we can't type — the guard then simply doesn't fire). When
--     unit_canonical is populated, it is the already-typed value.
--   - A CHECK constrains unit_canonical to the canonical enum mirrored from
--     @sitelayer/domain UNIT_REGISTRY (keep the two in sync; the enum is small
--     and changes rarely). NULL always passes the CHECK.
--
-- FOLLOW-UP (NOT in this slice — flagged): the BACKFILL pass
-- (UPDATE ... SET unit_canonical = normalize(unit) where the free text maps
-- cleanly, leaving genuinely-ambiguous rows NULL for human review) and the
-- CONTRACT pass (make unit_canonical the source of truth / drop or repurpose
-- the free-text column). The free text is pervasive and a hard rejection
-- mid-flight would break live rows, so backfill is deliberately deferred to a
-- separate, reviewable migration once the typed layer has soaked. See the
-- deep-dive §6 "UoM migration".
--
-- No new TABLES => no new RLS policies. Each touched table already carries its
-- company_isolation ENABLE+FORCE policy; the new nullable column inherits the
-- existing row-level policy. Verify with scripts/audit-pg-schema-parity.py and
-- `make verify-pg-schema` after applying.
--
-- Immutability: once committed, this file is checksummed in schema_migrations.
-- Any later correction (including the backfill/contract) is a NEW 140+ file —
-- never edit this one.

-- The canonical enum, mirrored from @sitelayer/domain UNIT_REGISTRY. Reused by
-- every per-table CHECK below.
--   length:  IN, FT, LF, YD
--   area:    SQIN, SQFT, SQYD, SQUARE
--   volume:  CUFT, CUYD
--   count:   EA, JOB, HR

ALTER TABLE service_item_assembly_components
  ADD COLUMN IF NOT EXISTS unit_canonical text;

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS unit_canonical text;

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS unit_canonical text;

ALTER TABLE service_items
  ADD COLUMN IF NOT EXISTS unit_canonical text;

DO $$
BEGIN
  ALTER TABLE service_item_assembly_components
    ADD CONSTRAINT service_item_assembly_components_unit_canonical_chk
    CHECK (
      unit_canonical IS NULL OR unit_canonical IN
      ('IN','FT','LF','YD','SQIN','SQFT','SQYD','SQUARE','CUFT','CUYD','EA','JOB','HR')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE takeoff_measurements
    ADD CONSTRAINT takeoff_measurements_unit_canonical_chk
    CHECK (
      unit_canonical IS NULL OR unit_canonical IN
      ('IN','FT','LF','YD','SQIN','SQFT','SQYD','SQUARE','CUFT','CUYD','EA','JOB','HR')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE estimate_lines
    ADD CONSTRAINT estimate_lines_unit_canonical_chk
    CHECK (
      unit_canonical IS NULL OR unit_canonical IN
      ('IN','FT','LF','YD','SQIN','SQFT','SQYD','SQUARE','CUFT','CUYD','EA','JOB','HR')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE service_items
    ADD CONSTRAINT service_items_unit_canonical_chk
    CHECK (
      unit_canonical IS NULL OR unit_canonical IN
      ('IN','FT','LF','YD','SQIN','SQFT','SQYD','SQUARE','CUFT','CUYD','EA','JOB','HR')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
