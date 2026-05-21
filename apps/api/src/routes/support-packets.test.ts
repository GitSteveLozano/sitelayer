import { describe, expect, it } from 'vitest'
import { collectEntityRefs, collectRequestIds, sanitizeSupportJson } from './support-packets.js'

describe('support packet sanitization', () => {
  it('redacts obvious secrets and contact details', () => {
    expect(
      sanitizeSupportJson({
        authorization: 'Bearer abc',
        nested: {
          email: 'person@example.com',
          phone: '204-555-1212',
        },
      }),
    ).toEqual({
      authorization: '[redacted]',
      nested: {
        email: '[email]',
        phone: '[phone]',
      },
    })
  })

  it('collects client and server request ids', () => {
    expect(
      collectRequestIds(
        {
          requests: [{ request_id: 'web-one', response_request_id: 'api-one' }, { requestId: 'web-two' }],
        },
        'api-current',
      ),
    ).toEqual(['api-current', 'web-one', 'api-one', 'web-two'])
  })

  it('collects entity refs from Probe path payloads', () => {
    expect(
      collectEntityRefs({
        path: {
          route: '/financial/estimate-pushes/11111111-1111-4111-8111-111111111111',
          entity_type: 'estimate_push',
          entity_id: '11111111-1111-4111-8111-111111111111',
        },
      }),
    ).toEqual([
      {
        entity_type: 'estimate_push',
        entity_id: '11111111-1111-4111-8111-111111111111',
      },
    ])
  })
})
