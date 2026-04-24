import { describe, expect, it } from 'vitest'
import { loadAppConfig, TierConfigError } from './tier.js'

const localDatabaseUrl = 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
const prodDatabaseUrl = 'postgres://sitelayer_prod_app:secret@db.example.com:25060/sitelayer_prod?sslmode=require'
const devDatabaseUrl = 'postgres://sitelayer_dev_app:secret@db.example.com:25060/sitelayer_dev?sslmode=require'
const previewDatabaseUrl =
  'postgres://sitelayer_preview_app:secret@db.example.com:25060/sitelayer_preview?sslmode=require'
const prodReadOnlyUrl = 'postgres://sitelayer_prod_ro:secret@db.example.com:25060/sitelayer_prod?sslmode=require'

describe('loadAppConfig', () => {
  it('defaults to local outside production', () => {
    const config = loadAppConfig({ DATABASE_URL: localDatabaseUrl })
    expect(config.tier).toBe('local')
    expect(config.ribbon?.label).toContain('LOCAL')
  })

  it('requires APP_TIER in production', () => {
    expect(() => loadAppConfig({ NODE_ENV: 'production', DATABASE_URL: prodDatabaseUrl })).toThrow(TierConfigError)
  })

  it('requires the prod tier to use the prod database', () => {
    expect(() => loadAppConfig({ APP_TIER: 'prod', DATABASE_URL: devDatabaseUrl })).toThrow(TierConfigError)
  })

  it('refuses prod database access from non-prod tiers', () => {
    expect(() => loadAppConfig({ APP_TIER: 'preview', DATABASE_URL: prodDatabaseUrl })).toThrow(TierConfigError)
  })

  it('accepts preview tier with preview database', () => {
    const config = loadAppConfig({ APP_TIER: 'preview', DATABASE_URL: previewDatabaseUrl })
    expect(config.tier).toBe('preview')
    expect(config.ribbon?.label).toContain('PREVIEW')
  })

  it('requires a read-only prod user for read-prod-ro', () => {
    expect(() =>
      loadAppConfig({
        APP_TIER: 'preview',
        DATABASE_URL: previewDatabaseUrl,
        FEATURE_FLAGS: 'read-prod-ro',
        DATABASE_URL_PROD_RO: prodDatabaseUrl,
      }),
    ).toThrow(TierConfigError)

    const config = loadAppConfig({
      APP_TIER: 'preview',
      DATABASE_URL: previewDatabaseUrl,
      FEATURE_FLAGS: 'read-prod-ro',
      DATABASE_URL_PROD_RO: prodReadOnlyUrl,
    })
    expect(config.databaseUrlProdRo).toBe(prodReadOnlyUrl)
  })
})
