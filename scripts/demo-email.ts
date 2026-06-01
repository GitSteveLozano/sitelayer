#!/usr/bin/env -S npx tsx

type DemoRole = 'owner' | 'estimator' | 'foreman' | 'crew'

const ROLES: DemoRole[] = ['owner', 'estimator', 'foreman', 'crew']
const DEFAULT_ORIGIN = 'https://demo.preview.sitelayer.sandolab.xyz'

type Args = {
  role: DemoRole
  name: string | null
  accessCode: string | null
  origin: string
}

function usage(): string {
  return `Usage:
  npm run demo:email -- --access-code <code> [--role owner|estimator|foreman|crew] [--name Steve]

Environment:
  DEMO_ACCESS_CODE        Access code to mint the link when --access-code is omitted.
  DEMO_APP_ORIGIN         Demo origin. Defaults to ${DEFAULT_ORIGIN}.

Examples:
  npm run demo:email -- --access-code stucco-demo --name Steve
  DEMO_ACCESS_CODE=stucco-demo npm run demo:email -- --role estimator --name "Alex"\n`
}

function parseArgs(argv: string[]): Args {
  let role: DemoRole = 'owner'
  let name: string | null = null
  let accessCode = process.env.DEMO_ACCESS_CODE?.trim() || null
  let origin = process.env.DEMO_APP_ORIGIN?.trim() || DEFAULT_ORIGIN

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--role':
        if (!ROLES.includes(next as DemoRole)) {
          throw new Error(`--role must be one of ${ROLES.join(', ')}`)
        }
        role = next as DemoRole
        i++
        break
      case '--name':
        name = next ?? null
        i++
        break
      case '--access-code':
        accessCode = next ?? null
        i++
        break
      case '--origin':
        origin = next ?? origin
        i++
        break
      case '-h':
      case '--help':
        process.stdout.write(usage())
        process.exit(0)
        break
      default:
        throw new Error(`unknown arg: ${arg}`)
    }
  }

  origin = origin.replace(/\/$/, '')
  if (!accessCode?.trim()) throw new Error('Missing access code. Pass --access-code or set DEMO_ACCESS_CODE.')
  return { role, name, accessCode: accessCode.trim(), origin }
}

async function mintDemoLink(args: Args): Promise<{ redirectUrl: string; expiresInSeconds: number }> {
  const res = await fetch(`${args.origin}/api/demo/sign-in-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: args.role, accessCode: args.accessCode }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    redirect_url?: unknown
    expires_in_seconds?: unknown
    error?: unknown
  }
  if (!res.ok) {
    throw new Error(`demo link mint failed (${res.status}): ${String(body.error ?? 'unknown error')}`)
  }
  if (typeof body.redirect_url !== 'string' || !body.redirect_url) {
    throw new Error('demo link mint response missing redirect_url')
  }
  if (typeof body.expires_in_seconds !== 'number' || !Number.isFinite(body.expires_in_seconds)) {
    throw new Error('demo link mint response missing expires_in_seconds; redeploy the demo API before sending links')
  }
  const expiresInSeconds = Math.floor(body.expires_in_seconds)
  return { redirectUrl: body.redirect_url, expiresInSeconds }
}

function roleLabel(role: DemoRole): string {
  switch (role) {
    case 'owner':
      return 'Owner'
    case 'estimator':
      return 'Estimator'
    case 'foreman':
      return 'Foreman'
    case 'crew':
      return 'Crew'
  }
}

function renderEmail(args: Args, link: { redirectUrl: string; expiresInSeconds: number }): string {
  const label = roleLabel(args.role)
  const expiresAt = new Date(Date.now() + link.expiresInSeconds * 1000)
  const greeting = args.name ? `Hi ${args.name},` : 'Hi,'
  const hours = Math.round(link.expiresInSeconds / 3600)

  return `Subject: Sitelayer demo link

${greeting}

Here is a one-click Sitelayer demo link as ${label}:
${link.redirectUrl}

It is valid for about ${hours} hours, until ${expiresAt.toLocaleString()}.

This is the demo environment with sample data only. Anything you change is disposable.

If the one-click link expires, use this fallback:
${args.origin}/demo
Access code: ${args.accessCode}
Choose: ${label}
`
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2))
    const link = await mintDemoLink(args)
    process.stdout.write(`${renderEmail(args, link)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
    process.exitCode = 1
  }
}

void main()
