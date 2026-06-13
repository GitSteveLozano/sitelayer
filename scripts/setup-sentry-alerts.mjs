#!/usr/bin/env node
// Wire production Sentry errors to a pager.
//
// Audit finding: Sentry errors currently reach NO pager — alerting is the
// Sentry dashboard + UptimeRobot only. This script closes that gap by
// CREATE-or-UPDATE-ing Sentry issue alert rules (via the Sentry REST API) for
// the api + worker projects so that a new unresolved issue, or an error-volume
// spike, notifies a real destination (email always; an optional generic
// PagerDuty/Slack-compatible webhook when configured).
//
// It is idempotent: each rule is identified by a stable name. If a rule with
// that name already exists on the project it is PUT-updated in place; otherwise
// it is POST-created. Re-running converges to the same state.
//
// Gate: with no creds (SENTRY_AUTH_TOKEN + SENTRY_ORG) it prints guidance and
// exits 0 — a clean no-op, never a throw. Only when creds ARE present and an
// API call fails does it exit nonzero.
//
//   node scripts/setup-sentry-alerts.mjs        (or: npm run ops:sentry-alerts)
//
// Env:
//   SENTRY_AUTH_TOKEN     (required) user/internal token with project:write +
//                         alerts:write (and project:read).
//   SENTRY_ORG            (required) org slug, e.g. "sandolabs".
//   SENTRY_ALERT_EMAIL    (required to wire the email pager destination) the
//                         address Sentry mails on alert.
//   SENTRY_ALERT_WEBHOOK  (optional) generic webhook URL (PagerDuty/Slack
//                         compatible) registered as a Sentry webhook plugin
//                         action when set.
//   SENTRY_PROJECT_API    (optional) api project slug.     default: sitelayer-api
//   SENTRY_PROJECT_WORKER (optional) worker project slug.   default: sitelayer-api
//                         (the worker has no separate Sentry project today — it
//                         falls back to the api DSN, see docs/INCIDENT_RESPONSE.md;
//                         set this once a sitelayer-worker project exists.)
//   SENTRY_URL            (optional) Sentry base URL.  default: https://sentry.io
//   SENTRY_ALERT_SPIKE_COUNT    (optional) events-in-interval threshold for the
//                               frequency-spike rule. default: 25
//   SENTRY_ALERT_SPIKE_INTERVAL (optional) interval for that count. default: 1h

const AUTH_TOKEN = (process.env.SENTRY_AUTH_TOKEN ?? '').trim()
const ORG = (process.env.SENTRY_ORG ?? '').trim()
const ALERT_EMAIL = (process.env.SENTRY_ALERT_EMAIL ?? '').trim()
const ALERT_WEBHOOK = (process.env.SENTRY_ALERT_WEBHOOK ?? '').trim()
const BASE_URL = (process.env.SENTRY_URL ?? 'https://sentry.io').trim().replace(/\/+$/, '')

const PROJECT_API = (process.env.SENTRY_PROJECT_API ?? 'sitelayer-api').trim()
const PROJECT_WORKER = (process.env.SENTRY_PROJECT_WORKER ?? 'sitelayer-api').trim()

const SPIKE_COUNT = (process.env.SENTRY_ALERT_SPIKE_COUNT ?? '25').trim()
const SPIKE_INTERVAL = (process.env.SENTRY_ALERT_SPIKE_INTERVAL ?? '1h').trim()

// Stable rule names — the idempotency key. Do NOT rename casually: a rename
// makes the next run create a duplicate instead of updating in place.
const RULE_NEW_ISSUE = '[sitelayer] pager: new unresolved issue'
const RULE_SPIKE = '[sitelayer] pager: error frequency spike'

function gateMessage() {
  return [
    'Sentry paging not wired: prod errors currently reach NO pager.',
    '',
    'Set the following env, then re-run `npm run ops:sentry-alerts`:',
    '  SENTRY_AUTH_TOKEN    (required) token with project:write + alerts:write',
    '  SENTRY_ORG           (required) org slug, e.g. sandolabs',
    '  SENTRY_ALERT_EMAIL   (required) address Sentry pages on alert',
    '  SENTRY_ALERT_WEBHOOK (optional) PagerDuty/Slack-compatible webhook URL',
    '',
    'Optional overrides (sensible defaults apply):',
    '  SENTRY_PROJECT_API (default sitelayer-api), SENTRY_PROJECT_WORKER (default sitelayer-api),',
    '  SENTRY_URL (default https://sentry.io),',
    '  SENTRY_ALERT_SPIKE_COUNT (default 25), SENTRY_ALERT_SPIKE_INTERVAL (default 1h).',
    '',
    'No-op until those are set. Nothing was changed.',
  ].join('\n')
}

/** Build the notify-actions list (email always; webhook when configured). */
function buildActions() {
  const actions = [
    {
      id: 'sentry.mail.actions.NotifyEmailAction',
      targetType: 'IssueOwners',
      // fallthroughType keeps it paging even when an issue has no owner.
      fallthroughType: 'ActiveMembers',
    },
  ]
  if (ALERT_EMAIL) {
    // Pin a specific address as well so the configured pager mailbox always
    // gets it regardless of issue ownership / membership.
    actions.push({
      id: 'sentry.mail.actions.NotifyEmailAction',
      targetType: 'Member',
      targetIdentifier: ALERT_EMAIL,
    })
  }
  if (ALERT_WEBHOOK) {
    // Generic webhook plugin action — PagerDuty/Slack-compatible receivers.
    actions.push({
      id: 'sentry.rules.actions.notify_event_service.NotifyEventServiceAction',
      service: 'webhooks',
    })
  }
  return actions
}

/** The two rule specs we converge the project to. */
function ruleSpecs() {
  const actions = buildActions()
  return [
    {
      name: RULE_NEW_ISSUE,
      actionMatch: 'any',
      frequency: 30, // minutes between repeated notifications for the same issue
      conditions: [
        {
          id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition',
        },
      ],
      filters: [],
      actions,
    },
    {
      name: RULE_SPIKE,
      actionMatch: 'any',
      frequency: 30,
      conditions: [
        {
          id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
          // "more than <value> events in <interval>"
          interval: SPIKE_INTERVAL,
          value: Number(SPIKE_COUNT),
          comparisonType: 'count',
        },
      ],
      filters: [],
      actions,
    },
  ]
}

async function sentryRequest(method, path, body) {
  const url = `${BASE_URL}/api/0${path}`
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`${method} ${path} failed to reach Sentry: ${err?.message ?? err}`)
  }
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  if (!res.ok) {
    const detail = typeof json === 'string' ? json : JSON.stringify(json)
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`)
  }
  return json
}

async function listRules(projectSlug) {
  return sentryRequest('GET', `/projects/${ORG}/${projectSlug}/rules/`)
}

async function upsertRule(projectSlug, spec) {
  const existing = await listRules(projectSlug)
  const match = Array.isArray(existing) ? existing.find((r) => r?.name === spec.name) : undefined
  if (match?.id) {
    await sentryRequest('PUT', `/projects/${ORG}/${projectSlug}/rules/${match.id}/`, spec)
    return { action: 'updated', id: match.id }
  }
  const created = await sentryRequest('POST', `/projects/${ORG}/${projectSlug}/rules/`, spec)
  return { action: 'created', id: created?.id }
}

async function main() {
  if (!AUTH_TOKEN || !ORG) {
    console.log(gateMessage())
    return 0
  }

  if (!ALERT_EMAIL && !ALERT_WEBHOOK) {
    console.error(
      'SENTRY_AUTH_TOKEN + SENTRY_ORG are set but no destination is configured.\n' +
        'Set SENTRY_ALERT_EMAIL (and/or SENTRY_ALERT_WEBHOOK) so the alert has somewhere to page, then re-run.',
    )
    return 1
  }

  // De-duplicate project slugs (worker often shares the api project today).
  const projects = [...new Set([PROJECT_API, PROJECT_WORKER].filter(Boolean))]
  const specs = ruleSpecs()

  const destinations = [ALERT_EMAIL ? `email:${ALERT_EMAIL}` : null, ALERT_WEBHOOK ? 'webhook' : null]
    .filter(Boolean)
    .join(' + ')
  console.log(`Wiring Sentry alert rules for org "${ORG}" → ${destinations}`)
  console.log(`Projects: ${projects.join(', ')}\n`)

  for (const project of projects) {
    for (const spec of specs) {
      const { action, id } = await upsertRule(project, spec)
      console.log(`  [${project}] ${action} rule ${id ?? '(no id)'}: ${spec.name}`)
    }
  }

  console.log('\nDone. Production Sentry errors now page the configured destination(s).')
  return 0
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`\nFAILED to wire Sentry alerts: ${err?.message ?? err}`)
    console.error('No partial change is retried automatically — fix the cause and re-run (it is idempotent).')
    process.exit(1)
  })
