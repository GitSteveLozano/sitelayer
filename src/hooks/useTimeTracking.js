import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toDateStr } from '../lib/calc'

// Week overview — fetches all schedules + confirmed entries for the Sun-Sat week
export function useWeekOverview(companyId, anyDate) {
  const [state, setState] = useState({ days: [], loading: true })

  const weekRange = useMemo(() => {
    if (!anyDate) return { start: null, end: null, dates: [] }
    const [y, m, d] = anyDate.split('-').map(Number)
    const dt = new Date(y, m - 1, d, 12)
    const dayOfWeek = dt.getDay() // 0=Sun
    const sun = new Date(dt)
    sun.setDate(dt.getDate() - dayOfWeek)
    const dates = Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(sun)
      dd.setDate(sun.getDate() + i)
      return toDateStr(dd)
    })
    return { start: dates[0], end: dates[6], dates }
  }, [anyDate])

  const fetchData = useCallback(async () => {
    if (!companyId || !weekRange.start) {
      setState({ days: [], loading: false })
      return
    }
    setState(prev => ({ ...prev, loading: true }))

    const [schedRes, laborRes] = await Promise.all([
      supabase
        .from('crew_schedules')
        .select('work_date, scheduled_workers, project:projects(name)')
        .eq('company_id', companyId)
        .gte('work_date', weekRange.start)
        .lte('work_date', weekRange.end),
      supabase
        .from('labor_entries')
        .select('work_date, worker_id')
        .eq('company_id', companyId)
        .eq('status', 'confirmed')
        .gte('work_date', weekRange.start)
        .lte('work_date', weekRange.end),
    ])

    const schedByDate = {}
    ;(schedRes.data || []).forEach(s => {
      if (!schedByDate[s.work_date]) schedByDate[s.work_date] = { workers: new Set(), projects: [] }
      ;(s.scheduled_workers || []).forEach(w => schedByDate[s.work_date].workers.add(w))
      if (s.project?.name) schedByDate[s.work_date].projects.push(s.project.name)
    })

    const confirmedByDate = {}
    ;(laborRes.data || []).forEach(e => {
      if (!confirmedByDate[e.work_date]) confirmedByDate[e.work_date] = new Set()
      confirmedByDate[e.work_date].add(e.worker_id)
    })

    const todayStr = toDateStr(new Date())
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    const days = weekRange.dates.map((date, i) => {
      const sched = schedByDate[date]
      const confirmed = confirmedByDate[date]
      return {
        date,
        label: dayLabels[i],
        shortDate: date.slice(5), // "04-09"
        isToday: date === todayStr,
        scheduledWorkers: sched?.workers.size || 0,
        projects: sched?.projects || [],
        confirmedWorkers: confirmed?.size || 0,
        hasSchedule: !!sched,
        isConfirmed: confirmed && sched && confirmed.size >= sched.workers.size && sched.workers.size > 0,
      }
    })

    setState({ days, loading: false })
  }, [companyId, weekRange.start, weekRange.end])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { ...state, refetch: fetchData }
}

// Get today's crew schedules for auto-population (supports multiple projects per day)
export function useCrewSchedule(companyId, date) {
  const [state, setState] = useState({ schedules: [], workers: [], loading: true, error: null })

  const fetchData = useCallback(async () => {
    if (!companyId) {
      setState({ schedules: [], workers: [], loading: false, error: null })
      return
    }
    setState(prev => ({ ...prev, loading: true }))
    const [schedRes, workerRes] = await Promise.all([
      supabase
        .from('crew_schedules')
        .select('*, project:projects(id, name, division)')
        .eq('company_id', companyId)
        .eq('work_date', date),
      supabase.from('workers').select('*').eq('company_id', companyId).eq('is_active', true),
    ])

    setState({
      schedules: schedRes.data || [],
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
    const toUpdate = entries.filter(e => e.id)
    const toInsert = entries.filter(e => !e.id)

    let submitErr = null

    // Update existing entries (have IDs from previous confirmation)
    if (toUpdate.length > 0) {
      const { error: upErr } = await supabase.from('labor_entries').upsert(toUpdate)
      if (upErr) submitErr = upErr
    }

    // Insert new entries (first-time confirmation)
    if (!submitErr && toInsert.length > 0) {
      const { error: inErr } = await supabase.from('labor_entries').insert(toInsert)
      if (inErr) submitErr = inErr
    }

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
    const [y, m, dy] = date.split('-').map(Number)
    const d = new Date(y, m - 1, dy, 12)
    const day = d.getDay()
    const mon = new Date(d)
    mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    const sun = new Date(mon)
    sun.setDate(mon.getDate() + 6)
    return {
      start: toDateStr(mon),
      end: toDateStr(sun),
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
      .select('*, project:projects(name, division)')
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
