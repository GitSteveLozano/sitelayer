import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'

// Get today's crew schedule for auto-population
export function useCrewSchedule(companyId, date) {
  const [state, setState] = useState({ schedule: null, workers: [], loading: true, error: null })

  const fetchData = useCallback(async () => {
    if (!companyId) {
      setState({ schedule: null, workers: [], loading: false, error: null })
      return
    }
    setState(prev => ({ ...prev, loading: true }))
    const [schedRes, workerRes] = await Promise.all([
      supabase
        .from('crew_schedules')
        .select('*, project:projects(id, name, division)')
        .eq('company_id', companyId)
        .eq('work_date', date)
        .maybeSingle(),
      supabase.from('workers').select('*').eq('company_id', companyId).eq('is_active', true),
    ])

    setState({
      schedule: schedRes.data,
      workers: workerRes.data || [],
      loading: false,
      error: schedRes.error || workerRes.error,
    })
  }, [companyId, date])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { ...state, refetch: fetchData }
}

// Create labor entries from schedule confirmation
export function useLaborEntry() {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const submit = useCallback(async (entries) => {
    setSaving(true)
    const { error: submitErr } = await supabase.from('labor_entries').upsert(entries)
    setError(submitErr?.message)
    setSaving(false)
    return { error: submitErr }
  }, [])

  return { saving, error, submit }
}

// Get confirmed entries for bonus calc (project-level)
export function useLaborStats(projectId, startDate, endDate) {
  const [state, setState] = useState({ entries: [], loading: true, error: null })

  const fetchData = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true }))
    const { data: rows, error: fetchErr } = await supabase
      .from('labor_entries')
      .select('*')
      .eq('project_id', projectId)
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .eq('status', 'confirmed')
    setState({ entries: rows || [], loading: false, error: fetchErr })
  }, [projectId, startDate, endDate])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { ...state, refetch: fetchData }
}

// Get confirmed entries for the week containing a given date (company-level)
export function useWeekEntries(companyId, date) {
  const [state, setState] = useState({ entries: [], loading: true, error: null })

  const weekRange = useMemo(() => {
    if (!date) return { start: null, end: null }
    const d = new Date(date)
    const day = d.getDay()
    const mon = new Date(d)
    mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    const sun = new Date(mon)
    sun.setDate(mon.getDate() + 6)
    return {
      start: mon.toISOString().split('T')[0],
      end: sun.toISOString().split('T')[0],
    }
  }, [date])

  const fetchData = useCallback(async () => {
    if (!companyId || !weekRange.start) {
      setState({ entries: [], loading: false, error: null })
      return
    }
    setState(prev => ({ ...prev, loading: true }))
    const { data: rows, error: fetchErr } = await supabase
      .from('labor_entries')
      .select('*, worker:workers(name)')
      .eq('company_id', companyId)
      .gte('work_date', weekRange.start)
      .lte('work_date', weekRange.end)
      .eq('status', 'confirmed')
      .order('work_date', { ascending: true })
    setState({ entries: rows || [], loading: false, error: fetchErr })
  }, [companyId, weekRange.start, weekRange.end])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { ...state, weekRange, refetch: fetchData }
}

// Get confirmed entries for a company on a specific date (company-level, for DailyConfirm)
export function useConfirmedByDate(companyId, date) {
  const [state, setState] = useState({ entries: [], loading: true, error: null })

  const fetchData = useCallback(async () => {
    if (!companyId || !date) {
      setState({ entries: [], loading: false, error: null })
      return
    }
    setState(prev => ({ ...prev, loading: true }))
    const { data: rows, error: fetchErr } = await supabase
      .from('labor_entries')
      .select('*')
      .eq('company_id', companyId)
      .eq('work_date', date)
      .eq('status', 'confirmed')
    setState({ entries: rows || [], loading: false, error: fetchErr })
  }, [companyId, date])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { ...state, refetch: fetchData }
}
