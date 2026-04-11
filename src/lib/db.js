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
      .select('*, worker:workers(name)')
      .eq('project_id', projectId)
      .order('logged_at', { ascending: false }),

  listByDateRange: (companyId, start, end) =>
    supabase
      .from('labor_entries')
      .select('*, project:projects(name)')
      .eq('company_id', companyId)
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending: false }),

  create: (entry) =>
    supabase.from('labor_entries').insert(entry).select().single(),

  createBatch: (entries) =>
    supabase.from('labor_entries').insert(entries).select(),

  update: (id, updates) =>
    supabase.from('labor_entries').update(updates).eq('id', id).select().single(),

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

// ── CREW SCHEDULES ────────────────────────────────────────────────────────────

export const schedules = {
  // Get schedule for a week (Mon-Sun)
  getWeek: (companyId, weekStart) => {
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekEnd.getDate() + 6)
    return supabase
      .from('crew_schedules')
      .select('*, project:projects(id, name, division)')
      .eq('company_id', companyId)
      .gte('work_date', weekStart)
      .lte('work_date', weekEnd.toISOString().split('T')[0])
      .order('work_date', { ascending: true })
  },

  // Get schedule for a specific date
  getByDate: (companyId, date) =>
    supabase
      .from('crew_schedules')
      .select('*, project:projects(id, name, division)')
      .eq('company_id', companyId)
      .eq('work_date', date)
      .order('created_at', { ascending: true }),

  // Create or update schedule entry
  upsert: (schedule) =>
    supabase.from('crew_schedules').upsert(schedule).select().single(),

  // Delete schedule entry
  delete: (id) =>
    supabase.from('crew_schedules').delete().eq('id', id),

  // Copy previous week's schedule to current week
  copyWeek: async (companyId, fromWeekStart, toWeekStart) => {
    const { data: existing } = await supabase
      .from('crew_schedules')
      .select('project_id, work_date, scheduled_workers, notes')
      .eq('company_id', companyId)
      .gte('work_date', fromWeekStart)
      .lte('work_date', new Date(new Date(fromWeekStart).getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])

    if (!existing?.length) return { data: [], error: null }

    const newEntries = existing.map(e => {
      const oldDate = new Date(e.work_date)
      const dayOffset = oldDate.getDay() === 0 ? 6 : oldDate.getDay() - 1 // Mon=0, Sun=6
      const newDate = new Date(toWeekStart)
      newDate.setDate(newDate.getDate() + dayOffset)
      return {
        company_id: companyId,
        project_id: e.project_id,
        work_date: newDate.toISOString().split('T')[0],
        scheduled_workers: e.scheduled_workers || [],
        notes: e.notes || null,
      }
    })

    return supabase
      .from('crew_schedules')
      .upsert(newEntries, { onConflict: 'company_id,project_id,work_date' })
      .select()
  },
}

// ── WORKERS ───────────────────────────────────────────────────────────────────

export const workers = {
  list: (companyId) =>
    supabase
      .from('workers')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('name', { ascending: true }),

  listAll: (companyId) =>
    supabase
      .from('workers')
      .select('*')
      .eq('company_id', companyId)
      .order('is_active', { ascending: false })
      .order('name', { ascending: true }),

  create: (worker) =>
    supabase.from('workers').insert(worker).select().single(),

  update: (id, updates) =>
    supabase.from('workers').update(updates).eq('id', id).select().single(),

  delete: (id) =>
    supabase.from('workers').delete().eq('id', id),
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
