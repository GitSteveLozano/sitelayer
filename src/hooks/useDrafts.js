import { useState, useEffect, useCallback } from 'react'
import { drafts } from '../lib/db'

export function useDrafts(projectId, type = 'measurement') {
  const [draftList, setDraftList] = useState([])
  const [activeDraft, setActiveDraft] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    const [{ data: list }, { data: active }] = await Promise.all([
      drafts.list(projectId, type),
      drafts.getActive(projectId, type),
    ])
    setDraftList(list || [])
    setActiveDraft(active || null)
    setLoading(false)
  }, [projectId, type])

  useEffect(() => { load() }, [load])

  return { draftList, activeDraft, loading, refresh: load }
}
