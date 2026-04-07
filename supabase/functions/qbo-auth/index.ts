// QBO OAuth — Step 1: Redirect user to Intuit authorization page
// Called from the frontend when user clicks "Connect QuickBooks"

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const QBO_CLIENT_ID     = Deno.env.get('QBO_CLIENT_ID')!
const QBO_REDIRECT_URI  = Deno.env.get('QBO_REDIRECT_URI')!
const QBO_SCOPE         = 'com.intuit.quickbooks.accounting'
const QBO_AUTH_URL      = 'https://appcenter.intuit.com/connect/oauth2'
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SL_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const body = await req.json().catch(() => ({}))
  const { company_id, sandbox = true } = body

  if (!company_id) {
    return new Response(JSON.stringify({ error: 'company_id required' }), { 
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  }

  // Verify company exists using service role
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('id')
    .eq('id', company_id)
    .single()

  if (companyErr || !company) {
    return new Response(JSON.stringify({ error: 'Company not found' }), { 
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
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
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
})
