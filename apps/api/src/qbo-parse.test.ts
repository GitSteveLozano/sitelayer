import { describe, expect, it } from 'vitest'
import {
  QboParseError,
  parseQboBill,
  parseQboClass,
  parseQboCustomer,
  parseQboEstimateCreateResponse,
  parseQboItem,
  parseQboVendor,
} from './qbo-parse.js'

describe('parseQboItem', () => {
  it('parses PascalCase production payload', () => {
    const item = parseQboItem({ Id: '42', Name: 'Drywall', UnitPrice: 12.5, Type: 'Service' })
    expect(item).toEqual({ id: '42', name: 'Drywall', unitPrice: 12.5, type: 'Service' })
  })

  it('parses camelCase legacy payload', () => {
    const item = parseQboItem({ id: 7, name: 'Lumber', unitPrice: '8.25', type: 'Inventory' })
    expect(item).toEqual({ id: '7', name: 'Lumber', unitPrice: 8.25, type: 'Inventory' })
  })

  it('falls back to qbo-<id> when name is missing', () => {
    expect(parseQboItem({ Id: '99' })).toEqual({ id: '99', name: 'qbo-99', unitPrice: 0 })
  })

  it('throws QboParseError on a malformed payload', () => {
    expect(() => parseQboItem({ Name: 'no id here' })).toThrow(QboParseError)
    expect(() => parseQboItem(null)).toThrow(QboParseError)
    expect(() => parseQboItem('not an object')).toThrow(QboParseError)
  })

  it('embeds the raw blob in the error message', () => {
    try {
      parseQboItem({ Name: 'oops' })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(QboParseError)
      const err = e as QboParseError
      expect(err.message).toContain('Name')
      expect(err.raw).toEqual({ Name: 'oops' })
    }
  })
})

describe('parseQboClass', () => {
  it('parses PascalCase', () => {
    expect(parseQboClass({ Id: '5', Name: 'Drywall' })).toEqual({ id: '5', name: 'Drywall' })
  })

  it('parses camelCase', () => {
    expect(parseQboClass({ id: '6', name: 'Framing' })).toEqual({ id: '6', name: 'Framing' })
  })

  it('throws when name is missing', () => {
    expect(() => parseQboClass({ Id: '5' })).toThrow(QboParseError)
  })
})

describe('parseQboCustomer', () => {
  it('parses PascalCase', () => {
    expect(parseQboCustomer({ Id: '11', DisplayName: 'Tiny Bison' })).toEqual({
      id: '11',
      displayName: 'Tiny Bison',
    })
  })

  it('parses camelCase', () => {
    expect(parseQboCustomer({ id: '12', displayName: 'LA Operations' })).toEqual({
      id: '12',
      displayName: 'LA Operations',
    })
  })

  it('falls back to id when DisplayName is absent', () => {
    expect(parseQboCustomer({ Id: '13' })).toEqual({ id: '13', displayName: '13' })
  })

  it('throws on missing id', () => {
    expect(() => parseQboCustomer({ DisplayName: 'no id' })).toThrow(QboParseError)
  })
})

describe('parseQboVendor', () => {
  it('parses both casings', () => {
    expect(parseQboVendor({ Id: '21', DisplayName: 'Acme Lumber' })).toEqual({
      id: '21',
      displayName: 'Acme Lumber',
    })
    expect(parseQboVendor({ id: '22', displayName: 'Bob Supply' })).toEqual({
      id: '22',
      displayName: 'Bob Supply',
    })
  })

  it('throws on garbage', () => {
    expect(() => parseQboVendor(undefined)).toThrow(QboParseError)
  })
})

describe('parseQboBill', () => {
  it('parses PascalCase', () => {
    expect(parseQboBill({ Id: '101', DocNumber: 'B-001', TotalAmt: 250.5 })).toEqual({
      id: '101',
      docNumber: 'B-001',
      totalAmt: 250.5,
    })
  })

  it('parses camelCase', () => {
    expect(parseQboBill({ id: '102', docNumber: 'B-002', totalAmt: '99.99' })).toEqual({
      id: '102',
      docNumber: 'B-002',
      totalAmt: 99.99,
    })
  })

  it('throws when Id is missing', () => {
    expect(() => parseQboBill({ DocNumber: 'B-003' })).toThrow(QboParseError)
  })
})

describe('parseQboEstimateCreateResponse', () => {
  it('parses wrapped PascalCase shape', () => {
    expect(parseQboEstimateCreateResponse({ Estimate: { Id: '500', DocNumber: 'EST-1' } })).toEqual({
      id: '500',
      docNumber: 'EST-1',
    })
  })

  it('parses wrapped camelCase shape', () => {
    expect(parseQboEstimateCreateResponse({ estimate: { id: '501', docNumber: 'EST-2' } })).toEqual({
      id: '501',
      docNumber: 'EST-2',
    })
  })

  it('parses flat PascalCase shape', () => {
    expect(parseQboEstimateCreateResponse({ Id: '502', DocNumber: 'EST-3' })).toEqual({
      id: '502',
      docNumber: 'EST-3',
    })
  })

  it('parses flat camelCase shape', () => {
    expect(parseQboEstimateCreateResponse({ id: '503' })).toEqual({ id: '503' })
  })

  it('throws on a wrapped Estimate with no Id', () => {
    expect(() => parseQboEstimateCreateResponse({ Estimate: { DocNumber: 'EST-X' } })).toThrow(QboParseError)
  })

  it('throws on a malformed payload', () => {
    expect(() => parseQboEstimateCreateResponse({})).toThrow(QboParseError)
    expect(() => parseQboEstimateCreateResponse(null)).toThrow(QboParseError)
    expect(() => parseQboEstimateCreateResponse([])).toThrow(QboParseError)
  })
})
