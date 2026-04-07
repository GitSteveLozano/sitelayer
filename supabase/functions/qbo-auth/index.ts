// QBO OAuth — Step 1: Redirect user to Intuit authorization page
// Called from the frontend when user clicks "Connect QuickBooks"

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const QBO_CLIENT_ID     = Deno.env.get('QBO_CLIENT_ID')!
const QBO_REDIRECT_URI  = Deno.env.get('QBO_REDIRECT_URI')!
const QBO_SCOPE         = 'com.intuit.quickbooks.accounting'
const QBO_AUTH_URL      = 'https://appcenter.intuit.com/connect/oauth2'

serve(async (req) => {
  const body = await req.json().catch(() => ({}))
  const { company_id, sandbox = true } = body

  if (!company_id) {
    return new Response(JSON.stringify({ error: 'company_id required' }), { status: 400 })
  }

  // state = base64(company_id + sandbox flag) — passed through OAuth flow
  const state = btoa(JSON.stringify({ company_id, sandbox }))

  const params = new URLSearchParams({
    client_id:     QBO_CLIENT_ID,
    redirect_uri:  QBO_REDIRECT_URI,
    response_type: 'code',
    scope:         QBO_SCOPE,
    state,
  })

  // Add sandbox param for test environment
  if (sandbox) {
    params.append('environment', 'sandbox')
  }

  const authUrl = `${QBO_AUTH_URL}?${params.toString()}`

  return new Response(JSON.stringify({ url: authUrl, sandbox }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
