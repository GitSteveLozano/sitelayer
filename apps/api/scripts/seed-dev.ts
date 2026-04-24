// Idempotent seed for sitelayer_dev (and local/preview): attaches the sample
// blueprints from blueprints_sample/ to the LA Operations demo project and
// uploads them through the active storage adapter. Re-running is a no-op.
//
// Run manually: npm run seed:dev
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import {
  buildBlueprintStorageKey,
  createBlueprintStorage,
  getBlueprintMimeType,
  readStorageEnv,
} from '../src/storage.js'
import { loadAppConfig, TierConfigError, type AppTier } from '../src/tier.js'

const SAMPLE_DIRS = [
  path.resolve(process.cwd(), 'blueprints_sample'),
  path.resolve(process.cwd(), '..', '..', 'blueprints_sample'),
  path.resolve(process.cwd(), '..', 'blueprints_sample'),
]

function findSampleDir(): string | null {
  for (const dir of SAMPLE_DIRS) {
    if (existsSync(dir)) return dir
  }
  return null
}

function getPoolConfig(connectionString: string, tier: AppTier) {
  const databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
  try {
    const url = new URL(connectionString)
    const sslMode = url.searchParams.get('sslmode')
    if (!databaseSslRejectUnauthorized && sslMode && sslMode !== 'disable') {
      url.searchParams.delete('sslmode')
      return {
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: false },
        options: `-c app.tier=${tier}`,
      }
    }
  } catch {
    return { connectionString, options: `-c app.tier=${tier}` }
  }
  return { connectionString, options: `-c app.tier=${tier}` }
}

export async function seedDev(): Promise<{ inserted: number; skipped: number }> {
  const config = loadAppConfig()
  if (config.tier === 'prod') {
    throw new TierConfigError('seed-dev refuses to run when APP_TIER=prod')
  }

  const sampleDir = findSampleDir()
  if (!sampleDir) {
    console.warn('[seed] no blueprints_sample/ directory found — nothing to seed')
    return { inserted: 0, skipped: 0 }
  }

  const companySlug = process.env.ACTIVE_COMPANY_SLUG ?? 'la-operations'
  const storage = await createBlueprintStorage(readStorageEnv(process.env, config.tier))
  const pool = new Pool(getPoolConfig(config.databaseUrl, config.tier))

  try {
    const companyResult = await pool.query<{ id: string }>(
      'select id from companies where slug = $1 limit 1',
      [companySlug],
    )
    const company = companyResult.rows[0]
    if (!company) {
      console.warn(`[seed] company "${companySlug}" not found — run 001_schema.sql first`)
      return { inserted: 0, skipped: 0 }
    }

    const projectResult = await pool.query<{ id: string }>(
      'select id from projects where company_id = $1 order by created_at asc limit 1',
      [company.id],
    )
    const project = projectResult.rows[0]
    if (!project) {
      console.warn(`[seed] no project found for company ${companySlug} — skipping blueprint seed`)
      return { inserted: 0, skipped: 0 }
    }

    const samples = readdirSync(sampleDir).filter((name) => name.toLowerCase().endsWith('.pdf'))
    let inserted = 0
    let skipped = 0

    for (const fileName of samples) {
      const existing = await pool.query<{ id: string }>(
        `select id from blueprint_documents
         where company_id = $1 and project_id = $2 and file_name = $3 and deleted_at is null
         limit 1`,
        [company.id, project.id, fileName],
      )
      if (existing.rows[0]) {
        skipped += 1
        continue
      }

      const blueprintId = randomUUID()
      const key = buildBlueprintStorageKey(company.id, blueprintId, fileName)
      const contents = readFileSync(path.join(sampleDir, fileName))
      await storage.put(key, contents, getBlueprintMimeType(fileName))

      await pool.query(
        `insert into blueprint_documents
          (id, company_id, project_id, file_name, storage_path, preview_type, version)
         values ($1, $2, $3, $4, $5, 'storage_path', 1)`,
        [blueprintId, company.id, project.id, fileName, key],
      )
      inserted += 1
      console.log(`[seed] inserted blueprint ${fileName} → ${storage.backend}:${key}`)
    }

    console.log(`[seed] done. inserted=${inserted} skipped=${skipped} backend=${storage.backend}`)
    return { inserted, skipped }
  } finally {
    await pool.end()
  }
}

// Direct invocation: run once and exit
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed-dev.ts')
if (isMain) {
  seedDev()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err)
      process.exit(1)
    })
}
