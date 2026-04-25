import { describe, expect, it, vi } from 'vitest'
import { loadEmailConfig, sendEmail, type EmailConfig } from './email.js'

describe('loadEmailConfig', () => {
  it('defaults to console when EMAIL_PROVIDER is unset', () => {
    const config = loadEmailConfig({} as NodeJS.ProcessEnv)
    expect(config.provider).toBe('console')
    expect(config.from).toBe('noreply@sitelayer.sandolab.xyz')
    expect(config.resendApiKey).toBeUndefined()
    expect(config.sendgridApiKey).toBeUndefined()
  })

  it('normalizes unknown provider values to console', () => {
    const config = loadEmailConfig({ EMAIL_PROVIDER: 'mailgun' } as unknown as NodeJS.ProcessEnv)
    expect(config.provider).toBe('console')
  })

  it('reads resend + sendgrid API keys', () => {
    const config = loadEmailConfig({
      EMAIL_PROVIDER: 'resend',
      EMAIL_FROM: 'hi@example.com',
      RESEND_API_KEY: 're_123',
      SENDGRID_API_KEY: 'SG.abc',
    } as unknown as NodeJS.ProcessEnv)
    expect(config.provider).toBe('resend')
    expect(config.from).toBe('hi@example.com')
    expect(config.resendApiKey).toBe('re_123')
    expect(config.sendgridApiKey).toBe('SG.abc')
  })
})

describe('sendEmail console path', () => {
  const consoleConfig: EmailConfig = { provider: 'console', from: 'noreply@example.com' }

  it('returns ok without making any HTTP call', async () => {
    const fetchImpl = vi.fn()
    const result = await sendEmail(
      { to: 'alice@example.com', subject: 'hi', text: 'hello', html: '<p>hello</p>' },
      { config: consoleConfig, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('console')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('falls back to console when resend is selected but no key is set', async () => {
    const fetchImpl = vi.fn()
    const result = await sendEmail(
      { to: 'alice@example.com', subject: 'hi', text: 'hello' },
      {
        config: { provider: 'resend', from: 'noreply@example.com' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('console')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts to resend when API key is set', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'email_abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const result = await sendEmail(
      { to: 'alice@example.com', subject: 'hi', text: 'hello' },
      {
        config: { provider: 'resend', from: 'noreply@example.com', resendApiKey: 're_test' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )
    expect(result.ok).toBe(true)
    expect(result.provider).toBe('resend')
    expect(result.messageId).toBe('email_abc')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('https://api.resend.com/emails')
    const init = call[1]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test')
    const parsed = JSON.parse(init.body as string) as { from: string; to: string; subject: string; text: string }
    expect(parsed.from).toBe('noreply@example.com')
    expect(parsed.to).toBe('alice@example.com')
    expect(parsed.subject).toBe('hi')
    expect(parsed.text).toBe('hello')
  })

  it('throws EmailError on non-2xx resend responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    await expect(
      sendEmail(
        { to: 'alice@example.com', subject: 'hi', text: 'hello' },
        {
          config: { provider: 'resend', from: 'noreply@example.com', resendApiKey: 're_test' },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/resend http 500/)
  })
})
