import { useEffect, useState } from 'react'
import { requestBlob } from './client'

export interface AuthenticatedObjectUrlState {
  url: string | null
  loading: boolean
  error: Error | null
}

/**
 * Fetch a protected API asset with normal Sitelayer auth headers, then expose
 * it as a browser-owned object URL for <img>, canvas, or WebGL texture loaders.
 * The object URL is revoked on path change and unmount.
 */
export function useAuthenticatedObjectUrl(path: string | null | undefined): AuthenticatedObjectUrlState {
  const [state, setState] = useState<AuthenticatedObjectUrlState>({ url: null, loading: false, error: null })

  useEffect(() => {
    if (!path) {
      setState({ url: null, loading: false, error: null })
      return
    }

    let cancelled = false
    let objectUrl: string | null = null
    setState({ url: null, loading: true, error: null })

    void requestBlob(path)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ url: objectUrl, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ url: null, loading: false, error: err instanceof Error ? err : new Error(String(err)) })
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  return state
}
