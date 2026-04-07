// QBO OAuth — Step 2: Handle callback from Intuit
// Exchanges auth code for access + refresh tokens, stores in integrations table

import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const QBO_CLIENT_ID      = Deno.env.get('QBO_CLIENT_ID')!
const QBO_CLIENT_SECRET  = Deno.env.get('QBO_CLIENT_SECRET')!
const QBO_REDIRECT_URI   = Deno.env.get('QBO_REDIRECT_URI')!
const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SL_SERVICE_ROLE_KEY')!
const APP_URL             = Deno.env.get('APP_URL') || 'https://gitstevelozano.github.io/sitelayer'

serve(async (req) => {
  const url   = new URL(req.url)
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error || !code || !state) {
    return Response.redirect(`${APP_URL}/settings?qbo=error`, 302)
  }

  // Decode state to get company_id and sandbox flag
  let companyId: string
  let sandbox: boolean
  try {
    const decoded = JSON.parse(atob(state))
    companyId = decoded.company_id
    sandbox = decoded.sandbox ?? true
  } catch {
    return Response.redirect(`${APP_URL}/settings?qbo=error`, 302)
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`)}`,
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: QBO_REDIRECT_URI,
    }),
  })

  if (!tokenRes.ok) {
    return Response.redirect(`${APP_URL}/settings?qbo=error`, 302)
  }

  const tokens = await tokenRes.json()
  const realmId = url.searchParams.get('realmId') // QBO company ID

  // Store tokens in Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  await supabase.from('integrations').upsert({
    company_id:    companyId,
    provider:      'qbo',
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
    metadata:      { realm_id: realmId, token_type: tokens.token_type, sandbox },
  }, { onConflict: 'company_id,provider' })

  // Trigger initial sync
  supabase.functions.invoke('qbo-sync', {
    body: { company_id: companyId, realm_id: realmId },
  })

  return Response.redirect(`${APP_URL}/settings?qbo=connected`, 302)
})
