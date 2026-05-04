import { useEffect, useState } from 'react'
import { recordSupportEvent } from '../../support-recorder.js'

// Minimal in-memory pub/sub toast system. No external deps.
// Call showToast() from anywhere; <Toaster /> subscribes once and renders.

export type ToastVariant = 'success' | 'error' | 'info'

export type ToastPayload = {
  id: string
  variant: ToastVariant
  title: string
  description?: string
  ttlMs?: number
}

type ToastListener = (toast: ToastPayload) => void

const listeners = new Set<ToastListener>()

function emit(toast: ToastPayload) {
  for (const listener of listeners) listener(toast)
}

function nextId(): string {
  return `toast-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

export function showToast(input: Omit<ToastPayload, 'id'> & { id?: string }) {
  const payload: ToastPayload = {
    id: input.id ?? nextId(),
    variant: input.variant,
    title: input.title,
    ttlMs: input.ttlMs ?? 5000,
    ...(input.description !== undefined ? { description: input.description } : {}),
  }
  emit(payload)
  recordSupportEvent({
    category: 'toast',
    name: 'toast.shown',
    level: input.variant === 'error' ? 'error' : 'info',
    data: {
      variant: input.variant,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  })
  return payload.id
}

export function toastSuccess(title: string, description?: string) {
  return showToast({ variant: 'success', title, ...(description !== undefined ? { description } : {}) })
}

export function toastError(title: string, description?: string) {
  return showToast({ variant: 'error', title, ...(description !== undefined ? { description } : {}) })
}

export function toastInfo(title: string, description?: string) {
  return showToast({ variant: 'info', title, ...(description !== undefined ? { description } : {}) })
}

export function useToast() {
  return {
    success: toastSuccess,
    error: toastError,
    info: toastInfo,
    show: showToast,
  }
}

const VARIANT_STYLES: Record<ToastVariant, { bg: string; fg: string; border: string }> = {
  success: { bg: '#064e3b', fg: '#ecfdf5', border: '#10b981' },
  error: { bg: '#7f1d1d', fg: '#fef2f2', border: '#ef4444' },
  info: { bg: '#1e293b', fg: '#e2e8f0', border: '#64748b' },
}

export function Toaster() {
  const [toasts, setToasts] = useState<ToastPayload[]>([])

  useEffect(() => {
    const listener: ToastListener = (toast) => {
      setToasts((current) => [...current, toast])
      if (toast.ttlMs && toast.ttlMs > 0) {
        window.setTimeout(() => {
          setToasts((current) => current.filter((entry) => entry.id !== toast.id))
        }, toast.ttlMs)
      }
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  function dismiss(id: string) {
    setToasts((current) => current.filter((entry) => entry.id !== id))
  }

  if (!toasts.length) return null

  return (
    <div
      aria-live="polite"
      role="region"
      aria-label="Notifications"
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 360,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => {
        const palette = VARIANT_STYLES[toast.variant]
        return (
          <div
            key={toast.id}
            role={toast.variant === 'error' ? 'alert' : 'status'}
            onClick={() => dismiss(toast.id)}
            style={{
              pointerEvents: 'auto',
              cursor: 'pointer',
              background: palette.bg,
              color: palette.fg,
              border: `1px solid ${palette.border}`,
              borderRadius: 8,
              padding: '10px 12px',
              boxShadow: '0 10px 25px rgba(0, 0, 0, 0.25)',
              fontSize: 13,
              lineHeight: 1.35,
            }}
          >
            <div style={{ fontWeight: 600, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{toast.title}</span>
              <span aria-hidden="true" style={{ opacity: 0.7 }}>
                ×
              </span>
            </div>
            {toast.description ? <div style={{ marginTop: 4, opacity: 0.9 }}>{toast.description}</div> : null}
          </div>
        )
      })}
    </div>
  )
}
