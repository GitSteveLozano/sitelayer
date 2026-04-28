import { useEffect, useState } from 'react'
import type { OfflineMutation, SyncStatusResponse } from '../api.js'

type Props = {
  syncStatus: SyncStatusResponse | null
  offlineQueue: OfflineMutation[]
}

type Network = 'online' | 'offline'

function readNetwork(): Network {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return 'online'
  return navigator.onLine ? 'online' : 'offline'
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return null
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Always-visible badge in the bottom-right showing whether the SPA's pending
 * mutations have reached the server. Construction crews work offline; this
 * gives them confidence that work isn't being silently dropped.
 *
 * States (precedence order):
 *   • offline      — navigator.onLine === false; mutations queue locally
 *   • {N} pending  — IndexedDB queue or server-side sync_events/outbox have rows
 *   • synced       — queue empty; latest sync_event timestamp shown when known
 */
export function SyncStatusBadge({ syncStatus, offlineQueue }: Props) {
  const [network, setNetwork] = useState<Network>(readNetwork)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onChange = () => setNetwork(readNetwork())
    window.addEventListener('online', onChange)
    window.addEventListener('offline', onChange)
    // Re-render every 30s so the relative timestamp updates without needing
    // the parent to rerun.
    const interval = window.setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => {
      window.removeEventListener('online', onChange)
      window.removeEventListener('offline', onChange)
      window.clearInterval(interval)
    }
  }, [])

  const pendingLocal = offlineQueue.length
  const pendingOutbox = syncStatus?.pendingOutboxCount ?? 0
  const pendingSyncEvents = syncStatus?.pendingSyncEventCount ?? 0
  const totalPending = pendingLocal + pendingOutbox + pendingSyncEvents
  const lastSyncedAt = syncStatus?.latestSyncEvent?.created_at ?? null
  const lastSyncedRel = relativeTime(lastSyncedAt)

  type Tone = 'ok' | 'pending' | 'offline'
  let tone: Tone
  let label: string
  if (network === 'offline') {
    tone = 'offline'
    label = totalPending > 0 ? `offline · ${totalPending} pending` : 'offline'
  } else if (totalPending > 0) {
    tone = 'pending'
    label = `${totalPending} pending`
  } else {
    tone = 'ok'
    label = lastSyncedRel ? `synced · ${lastSyncedRel}` : 'synced'
  }

  const palette: Record<Tone, { bg: string; fg: string; dot: string }> = {
    ok: { bg: '#064e3b', fg: '#ecfdf5', dot: '#34d399' },
    pending: { bg: '#78350f', fg: '#fff7ed', dot: '#fbbf24' },
    offline: { bg: '#7f1d1d', fg: '#fef2f2', dot: '#f87171' },
  }
  const colors = palette[tone]

  const tooltipParts: string[] = []
  if (pendingLocal > 0) tooltipParts.push(`${pendingLocal} queued locally`)
  if (pendingOutbox > 0) tooltipParts.push(`${pendingOutbox} server outbox`)
  if (pendingSyncEvents > 0) tooltipParts.push(`${pendingSyncEvents} sync events`)
  if (lastSyncedAt) tooltipParts.push(`last sync ${new Date(lastSyncedAt).toLocaleString()}`)
  const tooltip = tooltipParts.join(' · ') || (tone === 'ok' ? 'all changes saved' : 'no recent activity')

  return (
    <div
      role="status"
      aria-live="polite"
      title={tooltip}
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 50,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        minHeight: 36,
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        pointerEvents: 'auto',
        userSelect: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: colors.dot,
          boxShadow: tone === 'pending' ? `0 0 0 0 ${colors.dot}` : 'none',
          animation: tone === 'pending' ? 'sitelayer-sync-pulse 1.6s ease-out infinite' : 'none',
        }}
      />
      <span>{label}</span>
      <style>{`
        @keyframes sitelayer-sync-pulse {
          0% { box-shadow: 0 0 0 0 rgba(251,191,36,0.6); }
          70% { box-shadow: 0 0 0 8px rgba(251,191,36,0); }
          100% { box-shadow: 0 0 0 0 rgba(251,191,36,0); }
        }
      `}</style>
    </div>
  )
}
