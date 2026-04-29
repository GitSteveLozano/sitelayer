import { describe, expect, it } from 'vitest'
import { collectRequestIds, sanitizeSupportJson } from './support-packets.js'

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
})
