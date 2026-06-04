import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ACT_AS_STORAGE_KEY, ACTIVE_COMPANY_STORAGE_KEY } from '@/lib/api/client'
import {
  AUTH_FEEDBACK_AUDIO_STORAGE_KEY,
  AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY,
  AUTH_FEEDBACK_ENABLED_STORAGE_KEY,
  AUTH_FEEDBACK_REPLAY_STORAGE_KEY,
  STEVE_COLLAB_MODE_STORAGE_KEY,
  STEVE_COLLAB_MODE_VALUE,
} from '@/lib/steve-collab'

const DEFAULT_TARGET = '/desktop'
const DEFAULT_COMPANY_SLUG = 'la-operations'
const VALID_ROLES = new Set(['admin', 'foreman', 'office', 'member', 'bookkeeper'])

function safeTarget(raw: string | null): string {
  if (!raw) return DEFAULT_TARGET
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return DEFAULT_TARGET
  if (trimmed.startsWith('/collab/steve')) return DEFAULT_TARGET
  return trimmed
}

function roleToActAs(raw: string | null): string {
  const role = raw && VALID_ROLES.has(raw) ? raw : 'admin'
  return `e2e-${role}`
}

function targetWithCaptureFlags(target: string): string {
  const url = new URL(target, window.location.origin)
  url.searchParams.set('capture_feedback', '1')
  url.searchParams.set('capture_replay', '1')
  url.searchParams.set('capture_audio', '0')
  url.searchParams.set('collab', 'steve')
  url.searchParams.set('feedback_open', '1')
  return `${url.pathname}${url.search}${url.hash}`
}

export function SteveCollabEntry() {
  const [storageBlocked, setStorageBlocked] = useState(false)
  const destination = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return targetWithCaptureFlags(safeTarget(params.get('target')))
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    try {
      window.localStorage.setItem(ACT_AS_STORAGE_KEY, roleToActAs(params.get('role')))
      window.localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, params.get('company')?.trim() || DEFAULT_COMPANY_SLUG)
      window.localStorage.setItem(STEVE_COLLAB_MODE_STORAGE_KEY, STEVE_COLLAB_MODE_VALUE)
      window.localStorage.setItem(AUTH_FEEDBACK_ENABLED_STORAGE_KEY, '1')
      window.localStorage.setItem(AUTH_FEEDBACK_REPLAY_STORAGE_KEY, '1')
      window.localStorage.setItem(AUTH_FEEDBACK_AUDIO_STORAGE_KEY, '0')
      window.localStorage.setItem(AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY, '1')
      window.location.replace(destination)
    } catch {
      setStorageBlocked(true)
    }
  }, [destination])

  if (storageBlocked) {
    return (
      <main style={shellStyle}>
        <section style={panelStyle}>
          <p style={eyebrowStyle}>Sitelayer review</p>
          <h1 style={titleStyle}>Browser storage is blocked.</h1>
          <p style={bodyStyle}>
            Open this link in a normal Chrome window. Private windows or locked-down profiles can block the review
            setup.
          </p>
        </section>
      </main>
    )
  }

  return (
    <main style={shellStyle}>
      <section style={panelStyle}>
        <p style={eyebrowStyle}>Sitelayer review</p>
        <h1 style={titleStyle}>Opening the review workspace.</h1>
        <p style={bodyStyle}>The issue button will be ready on the next screen.</p>
      </section>
    </main>
  )
}

const shellStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  background: '#f5f1e8',
  color: '#171411',
}

const panelStyle: CSSProperties = {
  width: 'min(420px, 100%)',
  border: '1px solid #2d2924',
  background: '#fffaf0',
  padding: 24,
  borderRadius: 8,
  boxShadow: '0 16px 40px rgba(23, 20, 17, 0.14)',
}

const eyebrowStyle: CSSProperties = {
  margin: '0 0 10px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  textTransform: 'uppercase',
  color: '#766b5f',
}

const titleStyle: CSSProperties = {
  margin: '0 0 10px',
  fontSize: 24,
  lineHeight: 1.15,
}

const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.5,
  color: '#4f463e',
}
