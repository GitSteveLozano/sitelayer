import { describe, expect, it } from 'vitest'
import { isBlueprintPiiScanEnabled, maybeScanBlueprintForPii } from './blueprint-pii-scan.js'

describe('isBlueprintPiiScanEnabled', () => {
  it('is OFF by default (unset / empty)', () => {
    expect(isBlueprintPiiScanEnabled({})).toBe(false)
    expect(isBlueprintPiiScanEnabled({ BLUEPRINT_PII_SCAN: '' })).toBe(false)
    expect(isBlueprintPiiScanEnabled({ BLUEPRINT_PII_SCAN: '   ' })).toBe(false)
  })

  it('is OFF for explicit falsey values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'maybe', 'enabled?']) {
      expect(isBlueprintPiiScanEnabled({ BLUEPRINT_PII_SCAN: v }), v).toBe(false)
    }
  })

  it('is ON only for explicit truthy values', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', 'On', ' yes ']) {
      expect(isBlueprintPiiScanEnabled({ BLUEPRINT_PII_SCAN: v }), v).toBe(true)
    }
  })
})

describe('maybeScanBlueprintForPii', () => {
  it('is a no-op (scanned: false) when disabled', async () => {
    const result = await maybeScanBlueprintForPii({ storageKey: 'co/bp/plan.pdf', mimeType: 'application/pdf' }, {})
    expect(result).toEqual({ scanned: false })
  })

  it('stays a no-op even when the flag is ON (scan not yet built)', async () => {
    const result = await maybeScanBlueprintForPii(
      { storageKey: 'co/bp/plan.pdf', mimeType: 'application/pdf' },
      { BLUEPRINT_PII_SCAN: '1' },
    )
    // Flipping the flag changes nothing until the real scan ships — it must
    // never start touching blob contents or spending on its own.
    expect(result).toEqual({ scanned: false })
  })
})
