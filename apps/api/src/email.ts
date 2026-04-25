import { createLogger } from '@sitelayer/logger'

const logger = createLogger('email')

export type EmailProvider = 'resend' | 'sendgrid' | 'console'

export interface EmailMessage {
  to: string
  subject: string
  html?: string
  text: string
}

export interface SendEmailResult {
  provider: EmailProvider
  messageId?: string
  ok: true
}

export interface EmailConfig {
  provider: EmailProvider
  from: string
  resendApiKey?: string
  sendgridApiKey?: string
}

export class EmailError extends Error {
  readonly provider: EmailProvider
  readonly status?: number
  constructor(message: string, opts: { provider: EmailProvider; status?: number; cause?: unknown }) {
    super(message)
    this.provider = opts.provider
    if (opts.status !== undefined) this.status = opts.status
    if (opts.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = opts.cause
    }
  }
}

function normalizeProvider(raw: string | undefined | null): EmailProvider {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'resend' || value === 'sendgrid' || value === 'console') return value
  return 'console'
}

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const resend = (env.RESEND_API_KEY ?? '').trim()
  const sendgrid = (env.SENDGRID_API_KEY ?? '').trim()
  const config: EmailConfig = {
    provider: normalizeProvider(env.EMAIL_PROVIDER),
    from: (env.EMAIL_FROM ?? '').trim() || 'noreply@sitelayer.sandolab.xyz',
  }
  if (resend) config.resendApiKey = resend
  if (sendgrid) config.sendgridApiKey = sendgrid
  return config
}

type FetchFn = typeof fetch

async function sendViaResend(msg: EmailMessage, config: EmailConfig, fetchImpl: FetchFn): Promise<SendEmailResult> {
  if (!config.resendApiKey) {
    logger.warn({ to: msg.to }, '[email] RESEND_API_KEY missing; falling back to console')
    return sendViaConsole(msg, 'resend')
  }
  const resendBody: Record<string, unknown> = {
    from: config.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
  }
  if (msg.html) resendBody.html = msg.html
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.resendApiKey}`,
    },
    body: JSON.stringify(resendBody),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new EmailError(`resend http ${res.status}: ${body.slice(0, 512)}`, {
      provider: 'resend',
      status: res.status,
    })
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string }
  const out: SendEmailResult = { provider: 'resend', ok: true }
  if (json.id) out.messageId = json.id
  return out
}

async function sendViaSendgrid(msg: EmailMessage, config: EmailConfig, fetchImpl: FetchFn): Promise<SendEmailResult> {
  if (!config.sendgridApiKey) {
    logger.warn({ to: msg.to }, '[email] SENDGRID_API_KEY missing; falling back to console')
    return sendViaConsole(msg, 'sendgrid')
  }
  const content: { type: string; value: string }[] = [{ type: 'text/plain', value: msg.text }]
  if (msg.html) content.push({ type: 'text/html', value: msg.html })
  const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.sendgridApiKey}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: config.from },
      subject: msg.subject,
      content,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new EmailError(`sendgrid http ${res.status}: ${body.slice(0, 512)}`, {
      provider: 'sendgrid',
      status: res.status,
    })
  }
  const messageId = res.headers.get('x-message-id')
  const out: SendEmailResult = { provider: 'sendgrid', ok: true }
  if (messageId) out.messageId = messageId
  return out
}

function sendViaConsole(msg: EmailMessage, routedFrom: EmailProvider = 'console'): SendEmailResult {
  logger.info(
    {
      to: msg.to,
      subject: msg.subject,
      body: msg.text,
      routed_from: routedFrom,
    },
    'email',
  )
  return { provider: 'console', ok: true }
}

/**
 * Provider-agnostic email send. Picks the backend from `EMAIL_PROVIDER` and
 * falls back to `console` when the selected provider's API key is missing.
 *
 * Pass `config` or `fetchImpl` to override for tests.
 */
export async function sendEmail(
  msg: EmailMessage,
  opts: { config?: EmailConfig; fetchImpl?: FetchFn } = {},
): Promise<SendEmailResult> {
  const config = opts.config ?? loadEmailConfig()
  const fetchImpl = opts.fetchImpl ?? fetch
  switch (config.provider) {
    case 'resend':
      return sendViaResend(msg, config, fetchImpl)
    case 'sendgrid':
      return sendViaSendgrid(msg, config, fetchImpl)
    case 'console':
    default:
      return sendViaConsole(msg)
  }
}
