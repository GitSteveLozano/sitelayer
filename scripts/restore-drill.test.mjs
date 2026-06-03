import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const script = 'scripts/restore-drill.sh'
const repoRoot = new URL('..', import.meta.url)

// The restore drill needs `docker` on PATH to get past its preflight check, but
// the failure paths we exercise here (no backup file / missing BACKUP_DIR) trip
// BEFORE any docker is invoked. So we stub a no-op `docker` binary on PATH to
// keep the test hermetic on boxes without Docker installed.
function makeStubBin() {
  const dir = mkdtempSync(join(tmpdir(), 'sitelayer-drill-bin.'))
  const docker = join(dir, 'docker')
  writeFileSync(docker, '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(docker, 0o755)
  return dir
}

function runDrill({ backupDir, resultFile, extraEnv = {} }) {
  const stubBin = makeStubBin()
  const result = spawnSync('bash', [script], {
    cwd: repoRoot,
    env: {
      PATH: `${stubBin}:${process.env.PATH}`,
      BACKUP_DIR: backupDir,
      RESULT_FILE: resultFile,
      // No MESH_API_URL -> the best-effort mesh call is a guaranteed no-op.
      RESTORE_DRILL_HOST: 'test-host',
      RESTORE_DRILL_SUBSYSTEM: 'sitelayer-test-postgres',
      RECENCY_HOURS: '48',
      ...extraEnv,
    },
    encoding: 'utf8',
  })
  rmSync(stubBin, { recursive: true, force: true })
  return result
}

test('emits a durable FAILED result file when no backups exist (does not false-pass)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sitelayer-drill-empty.'))
  const resultFile = join(dir, 'restore-drill-last.json')
  try {
    const result = runDrill({ backupDir: dir, resultFile })

    // No backups => failure, not silence.
    assert.equal(result.status, 1, result.stderr)

    const body = JSON.parse(readFileSync(resultFile, 'utf8'))
    assert.equal(body.status, 'failed')
    assert.equal(body.subsystem, 'sitelayer-test-postgres')
    assert.equal(body.host, 'test-host')
    assert.equal(body.recency_hours_threshold, 48)
    assert.match(body.detail, /no backup files/)
    // Durable result must always carry the start/complete timestamps.
    assert.match(body.started_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(body.completed_at, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('records a FAILED result when BACKUP_DIR is missing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'sitelayer-drill-missing.'))
  const missingDir = join(parent, 'does-not-exist')
  // Put the result file somewhere that DOES exist so emit_result can write it.
  const resultFile = join(parent, 'restore-drill-last.json')
  try {
    const result = runDrill({ backupDir: missingDir, resultFile })
    assert.equal(result.status, 1, result.stderr)
    const body = JSON.parse(readFileSync(resultFile, 'utf8'))
    assert.equal(body.status, 'failed')
    assert.match(body.detail, /BACKUP_DIR not found/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('recency is measured against BACKUP file age, not row created_at (no SQL recency query)', () => {
  // Guard against a regression back to data-age recency: the script must not
  // contain a created_at-based recency query, and must compute backup age from
  // the dump file mtime.
  const src = readFileSync(new URL('./restore-drill.sh', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /now\(\)\s*-\s*max\(created_at\)/)
  assert.match(src, /backup_age_hours/)
  assert.match(src, /check_backup_recency/)
})
