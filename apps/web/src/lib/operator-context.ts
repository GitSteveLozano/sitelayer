// Per-site operator-context handshake — sitelayer side.
//
// The control-plane browser-bridge content script
// (control-plane/browser-bridge/src/content/operator-context.ts) sets
// `window.__operatorContext` on operator-owned sites and dispatches an
// `operator-context-ready` CustomEvent on every refresh. Non-operator
// visitors never have the global set (the extension's profile gate keeps
// it scoped to the operator's personal Chrome profile).
//
// This module is the sitelayer-side consumer: a typed view of the packet
// + a React hook that re-renders on refresh + a "wait for it to arrive"
// helper for non-React entry points. The shape mirrors the gateway route
// at `console/gateway/routes/operator-context.js`; if the gateway adds
// fields, extend `OperatorContextPacket` here.
//
// Design doc: digital-ontology/operator-context-handshake-design.md.

import { useEffect, useState } from 'react'

export interface OperatorContextActivity {
  ts: string | null
  kind: string
  summary: string
  evidence_ref?: string
}

export interface OperatorContextOriginContext {
  project: string
  label: string
  repo_branch?: string | null
  repo_dirty?: boolean
  recent_commits?: Array<{ sha: string; ts: string; summary: string }>
}

export interface OperatorContextActiveProject {
  name: string
  last_touched?: string | null
  signal?: number
}

export interface OperatorContextPacket {
  subject: string
  generated_at: string
  origin: string
  current_focus: {
    label: string
    confidence: number
    started?: string | null
    evidence_ref?: string | null
  }
  recent_activity: OperatorContextActivity[]
  active_projects: OperatorContextActiveProject[]
  origin_context: OperatorContextOriginContext
  attestations?: string[]
  meta: {
    budget: 'tight' | 'normal' | 'deep' | string
    mesh_available: boolean
    schema_version: number
  }
}

/**
 * Stable string passed in CustomEvent type. The content script dispatches
 * this on every successful refresh; consumers can subscribe directly.
 */
export const OPERATOR_CONTEXT_READY_EVENT = 'operator-context-ready'

/**
 * Tag this surface uses when broadcasting an explicit refresh request.
 * Pages can dispatch a `${EVENT}-refresh` event to force the content
 * script to re-fetch from the gateway (e.g. after a route change).
 */
export const OPERATOR_CONTEXT_REFRESH_EVENT = `${OPERATOR_CONTEXT_READY_EVENT}-refresh`

declare global {
  interface Window {
    __operatorContext?: OperatorContextPacket | { error: string; generated_at: string; origin?: string }
  }
}

function readGlobalPacket(): OperatorContextPacket | null {
  if (typeof window === 'undefined') return null
  const raw = window.__operatorContext
  if (!raw) return null
  if ('error' in raw) return null
  return raw
}

/**
 * Returns the latest operator-context packet, or `null` for non-operator
 * visitors / failed handshakes. Re-renders when the content script
 * publishes a new packet via the `operator-context-ready` event.
 */
export function useOperatorContext(): OperatorContextPacket | null {
  const [packet, setPacket] = useState<OperatorContextPacket | null>(() => readGlobalPacket())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onReady = (ev: Event) => {
      const detail = (ev as CustomEvent).detail
      if (!detail || typeof detail !== 'object') return
      if ('error' in detail) {
        setPacket(null)
        return
      }
      setPacket(detail as OperatorContextPacket)
    }
    window.addEventListener(OPERATOR_CONTEXT_READY_EVENT, onReady)
    // The script may have published before this effect mounted; sync once.
    setPacket((current) => current ?? readGlobalPacket())
    return () => window.removeEventListener(OPERATOR_CONTEXT_READY_EVENT, onReady)
  }, [])

  return packet
}

/**
 * Imperative await-for-packet helper for non-React code. Resolves with
 * the packet (or null if it doesn't arrive within `maxMs`).
 */
export function whenOperatorContextReady(maxMs = 3000): Promise<OperatorContextPacket | null> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(null)
      return
    }
    const existing = readGlobalPacket()
    if (existing) {
      resolve(existing)
      return
    }
    const timer = setTimeout(() => {
      window.removeEventListener(OPERATOR_CONTEXT_READY_EVENT, onReady)
      resolve(readGlobalPacket())
    }, maxMs)
    function onReady(ev: Event) {
      const detail = (ev as CustomEvent).detail
      if (detail && typeof detail === 'object' && !('error' in detail)) {
        clearTimeout(timer)
        window.removeEventListener(OPERATOR_CONTEXT_READY_EVENT, onReady)
        resolve(detail as OperatorContextPacket)
      }
    }
    window.addEventListener(OPERATOR_CONTEXT_READY_EVENT, onReady)
  })
}

/**
 * Dispatch a refresh-request event so the content script re-fetches
 * the packet from the gateway. Useful after a SPA route change that
 * shouldn't wait for the script's own 60s heartbeat.
 */
export function requestOperatorContextRefresh(): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new Event(OPERATOR_CONTEXT_REFRESH_EVENT))
  } catch {
    // CustomEvent constructor isn't available in some test environments.
  }
}
