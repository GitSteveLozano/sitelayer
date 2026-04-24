-- 001_schema.sql originally seeded several non-unique tables with
-- `ON CONFLICT DO NOTHING`, which is not enough when no uniqueness constraint
-- exists. This cleanup removes duplicate seed-shaped rows while preserving the
-- earliest row and avoiding rows referenced by child tables.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, name, is_default, config
      ORDER BY created_at, id
    ) AS rn
  FROM pricing_profiles
  WHERE deleted_at IS NULL
)
DELETE FROM pricing_profiles p
USING ranked r
WHERE p.id = r.id
  AND r.rn > 1;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, name, config, is_active
      ORDER BY created_at, id
    ) AS rn
  FROM bonus_rules
  WHERE deleted_at IS NULL
)
DELETE FROM bonus_rules b
USING ranked r
WHERE b.id = r.id
  AND r.rn > 1;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, name, role
      ORDER BY created_at, id
    ) AS rn
  FROM workers
  WHERE deleted_at IS NULL
),
victims AS (
  SELECT r.id
  FROM ranked r
  WHERE r.rn > 1
    AND NOT EXISTS (
      SELECT 1 FROM labor_entries l WHERE l.worker_id = r.id
    )
)
DELETE FROM workers w
USING victims v
WHERE w.id = v.id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, coalesce(external_id, ''), name, source
      ORDER BY created_at, id
    ) AS rn
  FROM customers
  WHERE deleted_at IS NULL
),
victims AS (
  SELECT r.id
  FROM ranked r
  WHERE r.rn > 1
    AND NOT EXISTS (
      SELECT 1 FROM projects p WHERE p.customer_id = r.id
    )
)
DELETE FROM customers c
USING victims v
WHERE c.id = v.id;

WITH ranked AS (
  SELECT
    id,
    (
      EXISTS (SELECT 1 FROM blueprint_documents b WHERE b.project_id = projects.id) OR
      EXISTS (SELECT 1 FROM takeoff_measurements t WHERE t.project_id = projects.id) OR
      EXISTS (SELECT 1 FROM estimate_lines e WHERE e.project_id = projects.id) OR
      EXISTS (SELECT 1 FROM crew_schedules s WHERE s.project_id = projects.id) OR
      EXISTS (SELECT 1 FROM labor_entries l WHERE l.project_id = projects.id) OR
      EXISTS (SELECT 1 FROM material_bills m WHERE m.project_id = projects.id)
    ) AS has_child_rows,
    row_number() OVER (
      PARTITION BY
        company_id,
        coalesce(customer_id::text, ''),
        name,
        customer_name,
        division_code
      ORDER BY
        (
          EXISTS (SELECT 1 FROM blueprint_documents b WHERE b.project_id = projects.id) OR
          EXISTS (SELECT 1 FROM takeoff_measurements t WHERE t.project_id = projects.id) OR
          EXISTS (SELECT 1 FROM estimate_lines e WHERE e.project_id = projects.id) OR
          EXISTS (SELECT 1 FROM crew_schedules s WHERE s.project_id = projects.id) OR
          EXISTS (SELECT 1 FROM labor_entries l WHERE l.project_id = projects.id) OR
          EXISTS (SELECT 1 FROM material_bills m WHERE m.project_id = projects.id)
        ) DESC,
        created_at,
        id
    ) AS rn
  FROM projects
  WHERE deleted_at IS NULL
),
victims AS (
  SELECT r.id
  FROM ranked r
  WHERE r.rn > 1
    AND NOT r.has_child_rows
)
DELETE FROM projects p
USING victims v
WHERE p.id = v.id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, provider, coalesce(provider_account_id, '')
      ORDER BY created_at, id
    ) AS rn
  FROM integration_connections
  WHERE deleted_at IS NULL
),
victims AS (
  SELECT r.id
  FROM ranked r
  WHERE r.rn > 1
    AND NOT EXISTS (
      SELECT 1 FROM sync_events s WHERE s.integration_connection_id = r.id
    )
)
DELETE FROM integration_connections i
USING victims v
WHERE i.id = v.id;
