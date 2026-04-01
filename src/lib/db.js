// Database access layer — all Supabase queries live here
// Components never call supabase directly

import { supabase } from './supabase'

// ── AUTH ──────────────────────────────────────────────────────────────────────

export const auth = {
  signInWithGoogle: () =>
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/sitelayer/` }
    }),

  signOut: () => supabase.auth.signOut(),

  getSession: () => supabase.auth.getSession(),

  onAuthChange: (cb) => supabase.auth.onAuthStateChange(cb),
}

// ── COMPANY ───────────────────────────────────────────────────────────────────

export const companies = {
  getOrCreate: async (userId, email) => {
    // Check if user already has a company
    let { data } = await supabase
      .from('company_users')
      .select('company:companies(*)')
      .eq('user_id', userId)
      .single()

    if (data?.company) return { data: data.company, error: null }

    // Create new company
    const { data: company, error } = await supabase
      .from('companies')
      .insert({ name: 'My Company', owner_id: userId })
      .select()
      .single()

    if (error) return { data: null, error }

    // Link user to company
    await supabase.from('company_users').insert({
      company_id: company.id,
      user_id: userId,
      role: 'admin'
    })

    return { data: company, error: null }
  },

  update: (id, updates) =>
    supabase.from('companies').update(updates).eq('id', id).select().single(),
}

// ── PROJECTS ──────────────────────────────────────────────────────────────────

export const projects = {
  list: (companyId) =>
    supabase
      .from('projects')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false }),

  get: (id) =>
    supabase.from('projects').select('*').eq('id', id).single(),

  create: (project) =>
    supabase.from('projects').insert(project).select().single(),

  update: (id, updates) =>
    supabase.from('projects').update(updates).eq('id', id).select().single(),

  delete: (id) =>
    supabase.from('projects').delete().eq('id', id),
}

// ── LABOR ENTRIES ─────────────────────────────────────────────────────────────

export const labor = {
  listByProject: (projectId) =>
    supabase
      .from('labor_entries')
      .select('*')
      .eq('project_id', projectId)
      .order('logged_at', { ascending: false }),

  create: (entry) =>
    supabase.from('labor_entries').insert(entry).select().single(),

  delete: (id) =>
    supabase.from('labor_entries').delete().eq('id', id),

  // Aggregate hours per service item for a project
  aggregateByItem: async (projectId) => {
    const { data, error } = await supabase
      .from('labor_entries')
      .select('service_item, hours, sqft_done')
      .eq('project_id', projectId)
    return { data, error }
  },
}

// ── INTEGRATIONS ─────────────────────────────────────────────────────────────

export const integrations = {
  list: (companyId) =>
    supabase.from('integrations').select('*').eq('company_id', companyId),

  upsert: (integration) =>
    supabase.from('integrations').upsert(integration).select().single(),

  delete: (id) =>
    supabase.from('integrations').delete().eq('id', id),
}
