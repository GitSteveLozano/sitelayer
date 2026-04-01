import { useState, useEffect, useCallback } from 'react'
import { projects, labor } from '../lib/db'
import { calcProject } from '../lib/calc'

export function useProjects(companyId) {
  const [data,    setData]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data: rows, error: err } = await projects.list(companyId)
    if (err) { setError(err); setLoading(false); return }

    // Attach computed metrics to each project
    const enriched = await Promise.all((rows || []).map(async p => {
      const { data: entries } = await labor.aggregateByItem(p.id)
      return { ...p, _metrics: calcProject(p, entries || []) }
    }))

    setData(enriched)
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  return { projects: data, loading, error, refresh: load }
}

export function useProject(projectId) {
  const [project, setProject] = useState(null)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)

    const [{ data: p }, { data: e }] = await Promise.all([
      projects.get(projectId),
      labor.listByProject(projectId),
    ])

    setProject(p ? { ...p, _metrics: calcProject(p, e || []) } : null)
    setEntries(e || [])
    setLoading(false)
  }, [projectId])

  useEffect(() => { load() }, [load])

  return { project, entries, loading, refresh: load }
}
