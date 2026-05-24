import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetProbePublish,
  getProbePublishMetadata,
  readProbePublishRegistry,
  useControlPlaneProbePublish,
} from './control-plane-probe-pub.js'

type TestTraceBridge = {
  active?: () => { trace_id?: string } | null
  emit?: (event: Record<string, unknown>) => unknown
}

describe('useControlPlaneProbePublish', () => {
  afterEach(() => {
    __resetProbePublish()
    delete (window as Window & { __controlPlaneTrace?: TestTraceBridge }).__controlPlaneTrace
  })

  it('publishes the snapshot on mount', () => {
    renderHook(() => useControlPlaneProbePublish('projectState', 'estimating'))
    expect(readProbePublishRegistry()).toEqual({ projectState: 'estimating' })
    const meta = getProbePublishMetadata('projectState')
    expect(meta).not.toBeNull()
    expect(meta?.ageMs).toBeGreaterThanOrEqual(0)
  })

  it('clears the key on unmount', () => {
    const { unmount } = renderHook(() => useControlPlaneProbePublish('projectState', 'estimating'))
    expect(readProbePublishRegistry()).toEqual({ projectState: 'estimating' })
    unmount()
    expect(readProbePublishRegistry()).toEqual({})
    expect(getProbePublishMetadata('projectState')).toBeNull()
  })

  it('updates the published value when the snapshot changes', () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: string }) => useControlPlaneProbePublish('projectState', snapshot),
      { initialProps: { snapshot: 'estimating' } },
    )
    expect(readProbePublishRegistry().projectState).toBe('estimating')
    rerender({ snapshot: 'sent' })
    expect(readProbePublishRegistry().projectState).toBe('sent')
  })

  it('last-write-wins on key collision between two publishers', () => {
    const { unmount: unmountA } = renderHook(() => useControlPlaneProbePublish('billingReviewState', 'generated'))
    const { unmount: unmountB } = renderHook(() => useControlPlaneProbePublish('billingReviewState', 'approved'))
    expect(readProbePublishRegistry().billingReviewState).toBe('approved')
    unmountA()
    expect(readProbePublishRegistry().billingReviewState).toBe('approved')
    unmountB()
    expect(readProbePublishRegistry().billingReviewState).toBeUndefined()
  })

  it('ignores null and undefined snapshots', () => {
    renderHook(() => useControlPlaneProbePublish('timeReviewState', null))
    expect(readProbePublishRegistry()).toEqual({})
    renderHook(() => useControlPlaneProbePublish('timeReviewState', undefined))
    expect(readProbePublishRegistry()).toEqual({})
  })

  it('emits compact probe state when an operator trace is active', () => {
    const emit = vi.fn()
    const globalWindow = window as Window & { __controlPlaneTrace?: TestTraceBridge }
    globalWindow.__controlPlaneTrace = { active: () => ({ trace_id: 'trace-1' }), emit }

    renderHook(() => useControlPlaneProbePublish('projectState', 'estimating'))

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'trace-1',
        event_type: 'sitelayer.probe.state',
        payload: {
          route_path: '/',
          key: 'projectState',
          value: 'estimating',
        },
      }),
    )
  })
})
