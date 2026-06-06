import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'

/**
 * Verifies the FK constraints added by migration 084 are present.
 *
 * The migration backfills foreign keys onto high-exposure *_id columns
 * that historically had no parent constraint. If any of these constraints
 * goes missing (e.g. a future migration drops one without rationale), the
 * orphan-risk window reopens silently — so this test is a structural
 * guard, not a behavioural one.
 *
 * Gated on RUN_API_INTEGRATION=1 because it needs a live, migrated DB.
 * Other test suites in this repo use the same flag (see rls.test.ts,
 * server.test.ts).
 */
const describeIntegration = process.env.RUN_API_INTEGRATION === '1' ? describe : describe.skip

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'

describeIntegration('fk constraints from migration 084 (fk_orphan_backfills)', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 })
  })

  afterAll(async () => {
    if (pool) await pool.end()
  })

  const expectedConstraints: ReadonlyArray<{
    name: string
    table: string
    column: string
    parentTable: string
  }> = [
    {
      name: 'fk_estimate_push_lines_source_estimate_line_id',
      table: 'estimate_push_lines',
      column: 'source_estimate_line_id',
      parentTable: 'estimate_lines',
    },
    {
      name: 'fk_scaffold_tags_last_inspection_id',
      table: 'scaffold_tags',
      column: 'last_inspection_id',
      parentTable: 'scaffold_inspections',
    },
    {
      name: 'fk_companycam_photo_imports_daily_log_photo_id',
      table: 'companycam_photo_imports',
      column: 'daily_log_photo_id',
      parentTable: 'daily_log_photos',
    },
  ]

  for (const ec of expectedConstraints) {
    it(`enforces ${ec.name} (${ec.table}.${ec.column} -> ${ec.parentTable})`, async () => {
      const { rows } = await pool.query<{
        conname: string
        confdeltype: string
        conrelid_name: string
        confrelid_name: string
      }>(
        `SELECT
           c.conname,
           c.confdeltype,
           r.relname AS conrelid_name,
           f.relname AS confrelid_name
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         JOIN pg_class f ON f.oid = c.confrelid
         WHERE c.conname = $1`,
        [ec.name],
      )
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.conrelid_name).toBe(ec.table)
      expect(row.confrelid_name).toBe(ec.parentTable)
      // 'r' = RESTRICT. Financial / audit / safety lineage should never
      // silently cascade or null.
      expect(row.confdeltype).toBe('r')
    })
  }

  it('rejects an insert that would orphan estimate_push_lines.source_estimate_line_id', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // company + push parents
      const { rows: c } = await client.query<{ id: string }>(
        `insert into companies (slug, name) values ($1, 'fk-orphan-test') returning id`,
        [`fk-orphan-${Date.now()}`],
      )
      const companyId = c[0]!.id
      const { rows: p } = await client.query<{ id: string }>(
        `insert into projects (company_id, name, customer_name, division_code)
         values ($1, 'fk-orphan', 'fk-orphan', 'D1') returning id`,
        [companyId],
      )
      const projectId = p[0]!.id
      const { rows: ep } = await client.query<{ id: string }>(
        `insert into estimate_pushes (company_id, project_id) values ($1, $2) returning id`,
        [companyId, projectId],
      )
      const pushId = ep[0]!.id
      // Insert a push_line referencing a non-existent estimate_line — must
      // fail because of fk_estimate_push_lines_source_estimate_line_id.
      await expect(
        client.query(
          `insert into estimate_push_lines (company_id, estimate_push_id, source_estimate_line_id, description)
           values ($1, $2, gen_random_uuid(), 'orphan')`,
          [companyId, pushId],
        ),
      ).rejects.toThrow(/violates foreign key constraint/)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })
})
