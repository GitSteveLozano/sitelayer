import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Get today's crew schedule for auto-population
export function useCrewSchedule(companyId, date) {
  const [data, setData] = useState({ schedule: null, workers: [], loading: true, error: null })

  useEffect(() => {
    if (!companyId) { setData({ schedule: null, workers: [], loading: false, error: null }); return }
    fetchData()
  }, [companyId, date])

  async function fetchData() {
    setData({ ...data, loading: true })
    const [schedRes, workerRes] = await Promise.all([
      supabase
        .from('crew_schedules')
        .select('*, project:projects(id, name, division)')
        .eq('company_id', companyId)
        .eq('work_date', date)
        .single(),
      supabase.from('workers').select('*').eq('company_id', companyId).eq('is_active', true),
    ])

    setData({
      schedule: schedRes.data,
      workers: workerRes.data || [],
      loading: false,
      error: schedRes.error || workerRes.error,
    })
  }

  return { ...data, refetch: fetchData }
}

// Create labor entries from schedule confirmation
export function useLaborEntry() {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  return {
    saving,
    error,
    submit: async (entries) => {
      setSaving(true)
      const { error } = await supabase.from('labor_entries').insert(entries)
      setError(error?.message)
      setSaving(false)
      return { error }
    },
  }
}

// Get confirmed entries for bonus calc
export function useLaborStats(projectId, startDate, endDate) {
  const [data, setData] = useState({ entries: [], loading: true, error: null })

  useEffect(() => {
    fetchData()
  }, [projectId, startDate, endDate])

  async function fetchData() {
    setData({ ...data, loading: true })
    const { data, error } = await supabase
      .from('labor_entries')
      .select('*')
      .eq('project_id', projectId)
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .eq('status', 'confirmed')
    setData({ entries: data || [], loading: false, error })
  }

  return { ...data, refetch: fetchData }
}
