import { describe, expect, it, vi } from 'vitest'
import { loadEmailConfig, sendEmail, type EmailConfig } from './email.js'

describe('worker loadEmailConfig', () => {
  it('defaults to console when EMAIL_PROVIDER is unset', () => {
    const config = loadEmailConfig({} as NodeJS.ProcessEnv)
    expect(config.provider).toBe('console')
    expect(config.from).toBe('noreply@sitelayer.sandolab.xyz')
  })
})

describe('worker sendEmail console path', () => {
  const consoleConfig: EmailConfig = { provider: 'console', from: 'noreply@example.com' }

  it('returns ok without making any HTTP call', async () => {
    const fetchImpl = vi.fn()
    const result = await sendEmail(
      { to: 'alice@example.com', subject: 'hi', text: 'hello' },
      { config: consoleConfig, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('console')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
