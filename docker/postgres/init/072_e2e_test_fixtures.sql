-- 072_e2e_test_fixtures.sql
--
-- Dedicated tenant for role-based E2E (Playwright) testing.
--
-- Sitelayer ships with a single seeded tenant (`la-operations`) plus the
-- `beta-build` shadow used by the bootstrap fan-out tests. Both share a
-- single membership row (`demo-user`, role `admin`), which means the
-- Playwright suite cannot exercise the role × workflow event matrix
-- — every non-admin code path is dark.
--
-- This migration is purely additive and stands up a NEW company,
-- `e2e-fixtures`, with one membership per supported role
-- (admin, foreman, office, member, bookkeeper). The actual workflow
-- ready-state rows (one project in `draft`, one time-review-run in
-- `pending`, etc.) are seeded by `apps/api/scripts/seed-e2e-fixtures.ts`
-- — keeping them in TypeScript lets the script reuse `seedCompanyDefaults`
-- and derive deterministic UUIDs without `INSERT ... SELECT id ...` gymnastics.
--
-- Re-running is safe: every insert is guarded with ON CONFLICT DO NOTHING.
-- The existing `la-operations` / `beta-build` seed data is NOT touched.

INSERT INTO companies (slug, name)
VALUES ('e2e-fixtures', 'E2E Fixtures')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO company_memberships (company_id, clerk_user_id, role)
SELECT id, 'e2e-admin', 'admin' FROM companies WHERE slug = 'e2e-fixtures'
ON CONFLICT (company_id, clerk_user_id) DO NOTHING;

INSERT INTO company_memberships (company_id, clerk_user_id, role)
SELECT id, 'e2e-foreman', 'foreman' FROM companies WHERE slug = 'e2e-fixtures'
ON CONFLICT (company_id, clerk_user_id) DO NOTHING;

INSERT INTO company_memberships (company_id, clerk_user_id, role)
SELECT id, 'e2e-office', 'office' FROM companies WHERE slug = 'e2e-fixtures'
ON CONFLICT (company_id, clerk_user_id) DO NOTHING;

INSERT INTO company_memberships (company_id, clerk_user_id, role)
SELECT id, 'e2e-member', 'member' FROM companies WHERE slug = 'e2e-fixtures'
ON CONFLICT (company_id, clerk_user_id) DO NOTHING;

INSERT INTO company_memberships (company_id, clerk_user_id, role)
SELECT id, 'e2e-bookkeeper', 'bookkeeper' FROM companies WHERE slug = 'e2e-fixtures'
ON CONFLICT (company_id, clerk_user_id) DO NOTHING;
