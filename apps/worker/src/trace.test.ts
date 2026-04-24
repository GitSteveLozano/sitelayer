import { describe, expect, it } from 'vitest'
import { spanForAppliedRow } from './trace.js'

describe('worker trace spans', () => {
  it('does not throw when trace fields are null', () => {
    expect(() =>
      spanForAppliedRow({
        id: '00000000-0000-0000-0000-000000000001',
        kind: 'outbox',
        entity_type: 'project',
        sentry_trace: null,
        sentry_baggage: null,
        request_id: null,
      }),
    ).not.toThrow()
  })
})
