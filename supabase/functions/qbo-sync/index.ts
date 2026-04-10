// QBO Sync — pulls Bills and Time Activities from QuickBooks
// Can be triggered manually or on a schedule
// Maps QBO data → SiteLayer projects + labor_entries

import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SL_SERVICE_ROLE_KEY')!
const QBO_CLIENT_ID        = Deno.env.get('QBO_CLIENT_ID')!
const QBO_CLIENT_SECRET    = Deno.env.get('QBO_CLIENT_SECRET')!
const QBO_BASE_PROD        = 'https://quickbooks.api.intuit.com/v3/company'
const QBO_BASE_SANDBOX     = 'https://sandbox-quickbooks.api.intuit.com/v3/company'

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

  const { company_id, realm_id } = await req.json()

  if (!company_id || !realm_id) {
    return new Response(JSON.stringify({ error: 'company_id and realm_id required' }), { 
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Get integration record
  const { data: integration } = await supabase
    .from('integrations')
    .select('*')
    .eq('company_id', company_id)
    .eq('provider', 'qbo')
    .single()

  if (!integration) {
    return new Response(JSON.stringify({ error: 'QBO not connected' }), { 
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  }

  // Refresh token if expired
  const token = await getValidToken(integration, supabase, company_id)
  if (!token) {
    return new Response(JSON.stringify({ error: 'Token refresh failed' }), { 
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    })
  }

  const useSandbox = integration.metadata?.sandbox ?? false
  const QBO_BASE = useSandbox ? QBO_BASE_SANDBOX : QBO_BASE_PROD

  const results = { bills: 0, timeEntries: 0, projects: 0, errors: [] as string[] }

  // ── Sync Bills → material_cost on projects ────────────────────────────────
  try {
    const billsRes = await qboQuery(
      realm_id, token, QBO_BASE,
      `SELECT * FROM Bill WHERE MetaData.LastUpdatedTime > '2020-01-01'`
    )

    for (const bill of billsRes?.QueryResponse?.Bill || []) {
      // Bills linked to a customer/job via CustomerRef
      const jobRef = bill.CustomerRef?.value
      if (!jobRef) continue

      // Find matching project by QBO customer ref stored in metadata
      const { data: project } = await supabase
        .from('projects')
        .select('id, material_cost')
        .eq('company_id', company_id)
        .contains('metadata', { qbo_customer_ref: jobRef })
        .single()

      if (!project) continue

      // Sum line amounts
      const billTotal = bill.Line?.reduce((s: number, l: any) => s + (l.Amount || 0), 0) || 0

      await supabase
        .from('projects')
        .update({ material_cost: billTotal })
        .eq('id', project.id)

      results.bills++
    }
  } catch (e: any) {
    results.errors.push(`Bills: ${e.message}`)
  }

  // ── Sync Time Activities → labor_entries ─────────────────────────────────
  try {
    const timeRes = await qboQuery(
      realm_id, token, QBO_BASE,
      `SELECT * FROM TimeActivity WHERE MetaData.LastUpdatedTime > '2020-01-01'`
    )

    for (const entry of timeRes?.QueryResponse?.TimeActivity || []) {
      const jobRef      = entry.CustomerRef?.value
      const serviceItem = entry.ItemRef?.name || 'General'
      const hours       = (entry.Hours || 0) + (entry.Minutes || 0) / 60

      if (!jobRef || hours === 0) continue

      const { data: project } = await supabase
        .from('projects')
        .select('id')
        .eq('company_id', company_id)
        .contains('metadata', { qbo_customer_ref: jobRef })
        .single()

      if (!project) continue

      // Check if entry already exists by QBO ID
      const { data: existing } = await supabase
        .from('labor_entries')
        .select('id')
        .eq('company_id', company_id)
        .contains('metadata', { qbo_id: entry.Id })
        .maybeSingle()

      const entryData = {
        company_id,
        project_id:   project.id,
        service_item: serviceItem,
        hours,
        work_date:    entry.TxnDate || new Date().toISOString().split('T')[0],
        sqft_done:    0, // QBO doesn't track sqft — filled manually
        notes:        `Synced from QBO — ${entry.EmployeeRef?.name || 'Unknown'}`,
        logged_at:    entry.TxnDate || new Date().toISOString(),
        metadata:     { qbo_id: entry.Id, source: 'qbo' },
      }

      if (existing) {
        await supabase.from('labor_entries').update(entryData).eq('id', existing.id)
      } else {
        await supabase.from('labor_entries').insert(entryData)
      }

      results.timeEntries++
    }
  } catch (e: any) {
    results.errors.push(`Time: ${e.message}`)
  }

  // ── Sync Estimates → create/update projects ───────────────────────────────
  try {
    const estRes = await qboQuery(
      realm_id, token, QBO_BASE,
      `SELECT * FROM Estimate WHERE TxnStatus = 'Accepted'`
    )

    for (const est of estRes?.QueryResponse?.Estimate || []) {
      const customerRef = est.CustomerRef?.value
      const jobName     = est.CustomerRef?.name || 'Unnamed Job'
      const bidTotal    = est.TotalAmt || 0

      if (!customerRef) continue

      // Check if project already exists
      const { data: existing } = await supabase
        .from('projects')
        .select('id')
        .eq('company_id', company_id)
        .contains('metadata', { qbo_customer_ref: customerRef })
        .single()

      if (existing) continue // Don't overwrite manually created projects

      // Create project from estimate
      await supabase.from('projects').insert({
        company_id,
        name:         jobName,
        status:       'active',
        sqft:         0, // Must be set manually or via PlanSwift import
        bid_psf:      0, // Calculated when sqft is known
        labor_rate:   38,
        material_cost: 0,
        sub_cost:     0,
        metadata:     {
          qbo_customer_ref: customerRef,
          qbo_estimate_id:  est.Id,
          qbo_bid_total:    bidTotal,
          source:           'qbo',
        },
      })

      results.projects++
    }
  } catch (e: any) {
    results.errors.push(`Estimates: ${e.message}`)
  }

  // Update integration record with sync results
  await supabase.from('integrations').update({
    last_sync_at: new Date().toISOString(),
    metadata: {
      ...integration.metadata,
      last_sync_results: results,
    },
  }).eq('company_id', company_id).eq('provider', 'qbo')

  return new Response(JSON.stringify({ success: true, results }), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
})

// ── Token refresh helper ───────────────────────────────────────────────────

async function getValidToken(integration: any, supabase: any, companyId: string): Promise<string | null> {
  const now = new Date()
  const exp = new Date(integration.expires_at)

  // If token expires in less than 5 minutes, refresh
  if (exp.getTime() - now.getTime() > 5 * 60 * 1000) {
    return integration.access_token
  }

  try {
    const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: integration.refresh_token,
      }),
    })

    if (!res.ok) return null

    const tokens    = await res.json()
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    await supabase.from('integrations').update({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || integration.refresh_token,
      expires_at:    expiresAt,
    }).eq('company_id', companyId).eq('provider', 'qbo')

    return tokens.access_token
  } catch {
    return null
  }
}

// ── QBO query helper ───────────────────────────────────────────────────────

async function qboQuery(realmId: string, token: string, baseUrl: string, query: string) {
  const res = await fetch(
    `${baseUrl}/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    }
  )

  if (!res.ok) {
    throw new Error(`QBO query failed: ${res.status} ${await res.text()}`)
  }

  return res.json()
}
