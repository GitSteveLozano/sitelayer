import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@sitelayer/logger'
import {
  ConsoleChannel,
  DEFAULT_PREFERENCES,
  DefaultNotificationDispatcher,
  EmailChannel,
  TwilioSMSChannel,
  WebPushChannel,
  decideChannel,
  isRoutableKind,
  loadTwilioConfig,
  loadVapidConfig,
  synthesizeSmsBody,
  type ChannelAvailability,
  type ChannelTarget,
  type DispatchableRow,
  type DispatcherDbClient,
  type NotificationPreferences,
  type PushSubscriptionRow,
  type WebPushClient,
} from './notification-channels.js'

const logger = createLogger('chan-test', { level: 'silent' })

const FULL_AVAIL: ChannelAvailability = { push: true, sms: true, email: true, console: true }
const PUSH_ONLY: ChannelAvailability = { push: true, sms: false, email: false, console: true }

function withTarget(p: Partial<ChannelTarget> = {}): ChannelTarget {
  return { pushSubscriptionCount: 0, smsPhone: null, email: null, ...p }
}

function withPrefs(p: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return { ...DEFAULT_PREFERENCES, ...p }
}

describe('isRoutableKind', () => {
  it('accepts the four channel-routable kinds', () => {
    expect(isRoutableKind('assignment_change')).toBe(true)
    expect(isRoutableKind('time_review_ready')).toBe(true)
    expect(isRoutableKind('daily_log_reminder')).toBe(true)
    expect(isRoutableKind('clock_anomaly')).toBe(true)
  })
  it('rejects legacy and unknown kinds', () => {
    expect(isRoutableKind('sync_failure')).toBe(false)
    expect(isRoutableKind('rental_billing.posted')).toBe(false)
    expect(isRoutableKind('')).toBe(false)
  })
})

describe('decideChannel — pure router', () => {
  it('no recipient → broadcast', () => {
    const decision = decideChannel('assignment_change', false, DEFAULT_PREFERENCES, withTarget(), FULL_AVAIL)
    expect(decision).toEqual({ kind: 'broadcast' })
  })

  it('non-routable kind → email when configured + recipient has email', () => {
    const decision = decideChannel(
      'sync_failure',
      true,
      DEFAULT_PREFERENCES,
      withTarget({ email: 'admin@example.com' }),
      FULL_AVAIL,
    )
    expect(decision).toEqual({ kind: 'send', channel: 'email', target: withTarget({ email: 'admin@example.com' }) })
  })

  it('non-routable kind without recipient email → defer (no provider known)', () => {
    const decision = decideChannel('sync_failure', true, DEFAULT_PREFERENCES, withTarget(), FULL_AVAIL)
    expect(decision).toEqual({ kind: 'defer', reason: 'no_recipient_email' })
  })

  it('non-routable kind without email provider → defer', () => {
    const decision = decideChannel(
      'sync_failure',
      true,
      DEFAULT_PREFERENCES,
      withTarget({ email: 'admin@example.com' }),
      { ...FULL_AVAIL, email: false },
    )
    expect(decision).toEqual({ kind: 'defer', reason: 'no_email_provider_configured' })
  })

  it('preference=off → silent', () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      withPrefs({ channel_assignment_change: 'off' }),
      withTarget({ email: 'a@b.c', pushSubscriptionCount: 1 }),
      FULL_AVAIL,
    )
    expect(decision).toEqual({ kind: 'silent', reason: 'preference_off' })
  })

  it('preference=push with subscriptions → push', () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      DEFAULT_PREFERENCES,
      withTarget({ pushSubscriptionCount: 2, email: 'a@b.c' }),
      FULL_AVAIL,
    )
    expect(decision.kind).toBe('send')
    if (decision.kind === 'send') expect(decision.channel).toBe('push')
  })

  it('preference=push with zero subscriptions → fall back to email', () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      DEFAULT_PREFERENCES,
      withTarget({ pushSubscriptionCount: 0, email: 'a@b.c' }),
      FULL_AVAIL,
    )
    expect(decision.kind).toBe('send')
    if (decision.kind === 'send') expect(decision.channel).toBe('email')
  })

  it('preference=push, no subs, no email → defer', () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      DEFAULT_PREFERENCES,
      withTarget({ pushSubscriptionCount: 0, email: null }),
      FULL_AVAIL,
    )
    expect(decision).toEqual({ kind: 'defer', reason: 'push_unavailable_no_email_fallback' })
  })

  it('preference=sms with phone → sms', () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      withPrefs({ channel_assignment_change: 'sms', sms_phone: '+15555550123' }),
      withTarget({ smsPhone: '+15555550123', email: 'a@b.c' }),
      FULL_AVAIL,
    )
    expect(decision.kind).toBe('send')
    if (decision.kind === 'send') expect(decision.channel).toBe('sms')
  })

  it('preference=sms without phone → fall back to email', () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      withPrefs({ channel_assignment_change: 'sms', sms_phone: null }),
      withTarget({ smsPhone: null, email: 'a@b.c' }),
      FULL_AVAIL,
    )
    expect(decision.kind).toBe('send')
    if (decision.kind === 'send') expect(decision.channel).toBe('email')
  })

  it('preference=email + email available → email', () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      withPrefs({ channel_assignment_change: 'email', email: 'a@b.c' }),
      withTarget({ email: 'a@b.c' }),
      FULL_AVAIL,
    )
    expect(decision.kind).toBe('send')
    if (decision.kind === 'send') expect(decision.channel).toBe('email')
  })

  it("preference=email but email unconfigured → defer (don't silently downgrade)", () => {
    const decision = decideChannel(
      'assignment_change',
      true,
      withPrefs({ channel_assignment_change: 'email', email: 'a@b.c' }),
      withTarget({ email: 'a@b.c' }),
      { push: false, sms: false, email: false, console: true },
    )
    expect(decision).toEqual({ kind: 'defer', reason: 'email_unavailable' })
  })

  it('per-event channel selection: only changes the specific event', () => {
    const prefs = withPrefs({ channel_assignment_change: 'sms', sms_phone: '+1' })
    expect(
      decideChannel('time_review_ready', true, prefs, withTarget({ pushSubscriptionCount: 1 }), PUSH_ONLY).kind,
    ).toBe('send')
    expect(
      (
        decideChannel('time_review_ready', true, prefs, withTarget({ pushSubscriptionCount: 1 }), PUSH_ONLY) as {
          channel?: string
        }
      ).channel,
    ).toBe('push')
  })
})

describe('synthesizeSmsBody', () => {
  it('prefixes subject when body does not already start with it', () => {
    const out = synthesizeSmsBody({
      subject: 'New assignment',
      bodyText: 'Tomorrow 7am, Hillcrest',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(out).toBe('New assignment\nTomorrow 7am, Hillcrest')
  })
  it('does not duplicate when subject already opens body', () => {
    const out = synthesizeSmsBody({
      subject: 'Heads up',
      bodyText: 'Heads up — schedule slipped',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(out).toBe('Heads up — schedule slipped')
  })
  it('truncates long messages with ellipsis under the 320-char cap', () => {
    const out = synthesizeSmsBody({
      subject: 'X',
      bodyText: 'a'.repeat(500),
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(out.length).toBeLessThanOrEqual(320)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('loadVapidConfig / loadTwilioConfig', () => {
  it('returns null when any required key missing', () => {
    expect(loadVapidConfig({})).toBeNull()
    expect(loadVapidConfig({ VAPID_PUBLIC_KEY: 'x' })).toBeNull()
    expect(loadTwilioConfig({})).toBeNull()
    expect(loadTwilioConfig({ TWILIO_ACCOUNT_SID: 'x' })).toBeNull()
  })
  it('returns config when all keys present', () => {
    expect(
      loadVapidConfig({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: 'mailto:x@y.z',
      }),
    ).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@y.z' })
    expect(
      loadTwilioConfig({
        TWILIO_ACCOUNT_SID: 'AC',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_FROM_NUMBER: '+15555550100',
      }),
    ).toEqual({ accountSid: 'AC', authToken: 'tok', fromNumber: '+15555550100' })
  })
})

describe('ConsoleChannel', () => {
  it('logs and reports ok=true', async () => {
    const channel = new ConsoleChannel({ logger })
    const result = await channel.send(withTarget(), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'k',
      payload: {},
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.channel).toBe('console')
      expect(result.delivered).toBe(1)
    }
  })
})

describe('EmailChannel', () => {
  it('returns permanent failure when target.email is null', async () => {
    const sendEmail = vi.fn()
    const channel = new EmailChannel({
      emailConfig: { provider: 'console', from: 'x@y.z' },
      sendEmail: sendEmail as never,
    })
    const result = await channel.send(withTarget({ email: null }), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'k',
      payload: {},
    })
    expect(result).toEqual({ ok: false, channel: 'email', error: 'no_recipient_email', permanent: true })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('delegates to sendEmail when target has an address', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ provider: 'console', ok: true, messageId: 'mid-1' })
    const channel = new EmailChannel({
      emailConfig: { provider: 'console', from: 'x@y.z' },
      sendEmail: sendEmail as never,
    })
    const result = await channel.send(withTarget({ email: 'a@b.c' }), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: '<p>b</p>',
      kind: 'k',
      payload: {},
    })
    expect(result).toEqual({ ok: true, channel: 'email', messageId: 'mid-1', delivered: 1 })
    expect(sendEmail).toHaveBeenCalledWith(
      { to: 'a@b.c', subject: 's', text: 'b', html: '<p>b</p>' },
      { config: expect.any(Object) },
    )
  })
})

describe('TwilioSMSChannel', () => {
  it('reports unconfigured when config is null', async () => {
    const channel = new TwilioSMSChannel({ config: null, logger })
    expect(channel.isConfigured()).toBe(false)
    const result = await channel.send(withTarget({ smsPhone: '+1' }), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, channel: 'sms', error: 'twilio_not_configured', permanent: false })
  })

  it('refuses send when target lacks a phone number', async () => {
    const channel = new TwilioSMSChannel({
      config: { accountSid: 'AC', authToken: 't', fromNumber: '+10000000000' },
      logger,
    })
    const result = await channel.send(withTarget({ smsPhone: null }), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, channel: 'sms', error: 'no_recipient_phone', permanent: true })
  })

  it('POSTs to Twilio with form-encoded body and basic auth on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sid: 'SM123' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const channel = new TwilioSMSChannel({
      config: { accountSid: 'AC123', authToken: 'tok', fromNumber: '+15555550100' },
      logger,
      fetchImpl: fetchImpl as never,
    })
    const result = await channel.send(withTarget({ smsPhone: '+15555550999' }), {
      subject: 'New assignment',
      bodyText: 'Tomorrow 7am, Hillcrest',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toEqual({ ok: true, channel: 'sms', delivered: 1, messageId: 'SM123' })
    const call = fetchImpl.mock.calls[0]!
    expect(call[0]).toContain('AC123')
    expect(call[1].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(call[1].headers.authorization).toMatch(/^Basic /)
    expect(call[1].body).toContain('From=%2B15555550100')
    expect(call[1].body).toContain('To=%2B15555550999')
    expect(call[1].body).toMatch(/Body=New\+assignment/)
  })

  it('treats 4xx (non-429) as permanent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad number', { status: 400 }))
    const channel = new TwilioSMSChannel({
      config: { accountSid: 'AC', authToken: 't', fromNumber: '+1' },
      logger,
      fetchImpl: fetchImpl as never,
    })
    const result = await channel.send(withTarget({ smsPhone: '+1' }), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, channel: 'sms', permanent: true })
  })

  it('treats 429 as transient', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }))
    const channel = new TwilioSMSChannel({
      config: { accountSid: 'AC', authToken: 't', fromNumber: '+1' },
      logger,
      fetchImpl: fetchImpl as never,
    })
    const result = await channel.send(withTarget({ smsPhone: '+1' }), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, channel: 'sms', permanent: false })
  })
})

describe('WebPushChannel', () => {
  function makeWebPushFake(responses: Array<number | Error>): WebPushClient & { calls: number } {
    let i = 0
    const fake = {
      calls: 0,
      setVapidDetails: vi.fn(),
      sendNotification: vi.fn(async () => {
        const next = responses[i++] ?? 200
        ;(fake as { calls: number }).calls = i
        if (next instanceof Error) throw next
        return { statusCode: next }
      }),
    }
    return fake as unknown as WebPushClient & { calls: number }
  }

  function makeSubs(n: number): PushSubscriptionRow[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `sub-${i + 1}`,
      endpoint: `https://push.example/${i + 1}`,
      p256dh: `p${i}`,
      auth: `a${i}`,
    }))
  }

  it('reports unconfigured when vapid is missing', async () => {
    const channel = new WebPushChannel(
      {
        vapid: null,
        webpush: null,
        loadSubscriptions: async () => [],
        pruneSubscription: async () => {},
        logger,
      },
      'co',
      'user',
    )
    expect(channel.isConfigured()).toBe(false)
    const result = await channel.send(withTarget(), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, error: 'web_push_not_configured', permanent: false })
  })

  it('returns permanent failure when no subscriptions are registered', async () => {
    const webpush = makeWebPushFake([])
    const channel = new WebPushChannel(
      {
        vapid: { publicKey: 'p', privateKey: 'pr', subject: 'mailto:a@b.c' },
        webpush,
        loadSubscriptions: async () => [],
        pruneSubscription: async () => {},
        logger,
      },
      'co',
      'user',
    )
    const result = await channel.send(withTarget(), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, error: 'no_push_subscriptions', permanent: true })
  })

  it('fans out to N subscriptions, prunes 410s, succeeds when at least one delivers', async () => {
    const subs = makeSubs(3)
    const pruned: string[] = []
    const webpush = makeWebPushFake([201, 410, 201])
    const channel = new WebPushChannel(
      {
        vapid: { publicKey: 'p', privateKey: 'pr', subject: 'mailto:a@b.c' },
        webpush,
        loadSubscriptions: async () => subs,
        pruneSubscription: async (id) => {
          pruned.push(id)
        },
        logger,
      },
      'co',
      'user',
    )
    const result = await channel.send(withTarget(), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: { project_id: 'p1' },
    })
    expect(result).toMatchObject({ ok: true, channel: 'push', delivered: 2 })
    expect(pruned).toEqual(['sub-2'])
  })

  it('all subscriptions stale → permanent failure (no live endpoints left)', async () => {
    const subs = makeSubs(2)
    const pruned: string[] = []
    const webpush = makeWebPushFake([410, 404])
    const channel = new WebPushChannel(
      {
        vapid: { publicKey: 'p', privateKey: 'pr', subject: 'mailto:a@b.c' },
        webpush,
        loadSubscriptions: async () => subs,
        pruneSubscription: async (id) => {
          pruned.push(id)
        },
        logger,
      },
      'co',
      'user',
    )
    const result = await channel.send(withTarget(), {
      subject: 's',
      bodyText: 'b',
      bodyHtml: null,
      kind: 'assignment_change',
      payload: {},
    })
    expect(result).toMatchObject({ ok: false, channel: 'push', permanent: true })
    expect(pruned).toEqual(['sub-1', 'sub-2'])
  })
})

describe('DefaultNotificationDispatcher — integration of decision + send', () => {
  function fakeClient(rows: Array<Record<string, unknown>>): DispatcherDbClient {
    let i = 0
    return {
      async query() {
        return { rows: [rows[i++] ?? {}] as never }
      },
    }
  }

  function row(over: Partial<DispatchableRow> = {}): DispatchableRow {
    return {
      id: 'r1',
      company_id: 'co',
      kind: 'assignment_change',
      subject: 'New assignment',
      body_text: 'Tomorrow 7am',
      body_html: null,
      payload: {},
      recipient_email: null,
      recipient_clerk_user_id: 'u1',
      ...over,
    }
  }

  it('routes to email when prefs say email and target has address', async () => {
    const client = fakeClient([
      // notification_preferences row
      { ...DEFAULT_PREFERENCES, channel_assignment_change: 'email', email: 'a@b.c' },
      // push_subscription count
      { n: '0' },
    ])
    const sendEmail = vi.fn().mockResolvedValue({ ok: true, provider: 'console' })
    const email = new EmailChannel({
      emailConfig: { provider: 'console', from: 'x@y.z' },
      sendEmail: sendEmail as never,
    })
    const dispatcher = new DefaultNotificationDispatcher({
      channels: { push: null, sms: null, email, console: new ConsoleChannel({ logger }) },
      buildPushChannel: null,
      hydrateEmail: null,
      logger,
    })
    const outcome = await dispatcher.dispatch(row(), client)
    expect(outcome).toMatchObject({ kind: 'sent', channel: 'email' })
    expect(sendEmail).toHaveBeenCalled()
  })

  it('off preference → silent (no send call)', async () => {
    const client = fakeClient([{ ...DEFAULT_PREFERENCES, channel_assignment_change: 'off' }, { n: '0' }])
    const sendEmail = vi.fn()
    const dispatcher = new DefaultNotificationDispatcher({
      channels: {
        push: null,
        sms: null,
        email: new EmailChannel({ emailConfig: { provider: 'console', from: 'x' }, sendEmail: sendEmail as never }),
        console: new ConsoleChannel({ logger }),
      },
      buildPushChannel: null,
      hydrateEmail: null,
      logger,
    })
    const outcome = await dispatcher.dispatch(row(), client)
    expect(outcome).toEqual({ kind: 'silent', reason: 'preference_off' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('broadcast: row with no recipient short-circuits to broadcast', async () => {
    const dispatcher = new DefaultNotificationDispatcher({
      channels: {
        push: null,
        sms: null,
        email: new EmailChannel({ emailConfig: { provider: 'console', from: 'x' }, sendEmail: vi.fn() as never }),
        console: new ConsoleChannel({ logger }),
      },
      buildPushChannel: null,
      hydrateEmail: null,
      logger,
    })
    const outcome = await dispatcher.dispatch(
      row({ recipient_clerk_user_id: null, recipient_email: null }),
      fakeClient([]),
    )
    expect(outcome).toEqual({ kind: 'broadcast' })
  })

  it('hydrates email via Clerk when chosen channel is email but target has none', async () => {
    const client = fakeClient([{ ...DEFAULT_PREFERENCES, channel_assignment_change: 'email' }, { n: '0' }])
    const hydrateEmail = vi.fn().mockResolvedValue('hydrated@example.com')
    const sendEmail = vi.fn().mockResolvedValue({ ok: true, provider: 'console' })
    const email = new EmailChannel({
      emailConfig: { provider: 'console', from: 'x' },
      sendEmail: sendEmail as never,
    })
    const dispatcher = new DefaultNotificationDispatcher({
      channels: { push: null, sms: null, email, console: new ConsoleChannel({ logger }) },
      buildPushChannel: null,
      hydrateEmail,
      logger,
    })
    const outcome = await dispatcher.dispatch(row(), client)
    expect(outcome).toMatchObject({ kind: 'sent', channel: 'email' })
    expect(hydrateEmail).toHaveBeenCalledWith('u1')
  })
})
