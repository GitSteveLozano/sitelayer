import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetProbePublish,
  getProbePublishMetadata,
  readProbePublishRegistry,
  useControlPlaneProbePublish,
} from './control-plane-probe-pub.js'

describe('useControlPlaneProbePublish', () => {
  afterEach(() => {
    __resetProbePublish()
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
      ({ snapshot }: { snapshot: string }) =>
        useControlPlaneProbePublish('projectState', snapshot),
      { initialProps: { snapshot: 'estimating' } },
    )
    expect(readProbePublishRegistry().projectState).toBe('estimating')
    rerender({ snapshot: 'sent' })
    expect(readProbePublishRegistry().projectState).toBe('sent')
  })

  it('last-write-wins on key collision between two publishers', () => {
    const { unmount: unmountA } = renderHook(() =>
      useControlPlaneProbePublish('billingReviewState', 'generated'),
    )
    const { unmount: unmountB } = renderHook(() =>
      useControlPlaneProbePublish('billingReviewState', 'approved'),
    )
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
})
