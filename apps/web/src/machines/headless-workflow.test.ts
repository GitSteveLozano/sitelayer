import { describe, expect, it, vi } from 'vitest'
import { createActor, type Actor, type AnyStateMachine } from 'xstate'
import { createHeadlessWorkflowMachine } from './headless-workflow.js'

/**
 * Direct unit coverage for the `createHeadlessWorkflowMachine` factory.
 * The three consumer machines (billing-review, estimate-push,
 * project-lifecycle) all funnel through this — so any wiring bug here
 * would be a single point of regression across the workflow UIs.
 *
 * Strategy: build a throwaway machine with fully-mocked `load` /
 * `submit` actor inputs, drive events on the actor, and assert on the
 * state value + context after each promise turn settles.
 */

type DemoSnapshot = { state_version: number; tag: string }
type DemoEvent = 'APPROVE' | 'VOID'

function buildMachine(
  overrides: {
    load?: (id: string, slug: string) => Promise<DemoSnapshot>
    submit?: (id: string, event: DemoEvent, version: number, slug: string) => Promise<DemoSnapshot>
  } = {},
) {
  const load = overrides.load ?? vi.fn(async () => ({ state_version: 1, tag: 'initial' }))
  const submit = overrides.submit ?? vi.fn(async () => ({ state_version: 2, tag: 'after-submit' }))
  const { machine } = createHeadlessWorkflowMachine<DemoSnapshot, DemoEvent>({
    id: 'demoWorkflow',
    load,
    submit,
  })
  return { machine, load, submit }
}

function startActor(
  machine: AnyStateMachine,
  input: { entityId: string; companySlug: string } = { entityId: 'e1', companySlug: 'acme' },
) {
  const actor = createActor(machine, { input })
  actor.start()
  return actor as Actor<typeof machine>
}

// Settle queued microtasks + actor callbacks. `Promise.resolve()` is not
// always enough because `fromPromise` invokes through an internal
// scheduler; awaiting two ticks is a reliable cheap settle.
async function settle() {
  // Walk multiple microtask turns so nested awaits (the conflict-reload
  // path awaits a second `load`) get a chance to flush before assertions.
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('createHeadlessWorkflowMachine', () => {
  describe('initial load', () => {
    it('starts in loading state', () => {
      const { machine } = buildMachine()
      const actor = startActor(machine)
      expect(actor.getSnapshot().value).toBe('loading')
    })

    it('LOAD → idle with snapshot in context once load resolves', async () => {
      const { machine, load } = buildMachine()
      const actor = startActor(machine)
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.snapshot).toEqual({ state_version: 1, tag: 'initial' })
      expect(snap.context.error).toBeNull()
      expect(snap.context.outOfSync).toBe(false)
      expect(load).toHaveBeenCalledWith('e1', 'acme')
    })

    it('load failure records error and lands in idle', async () => {
      const load = vi.fn(async () => {
        throw new Error('boom')
      })
      const { machine } = buildMachine({ load })
      const actor = startActor(machine)
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.error).toBe('boom')
      expect(snap.context.snapshot).toBeNull()
    })
  })

  describe('DISPATCH happy path', () => {
    it('moves to submitting then back to idle with updated snapshot', async () => {
      const submit = vi.fn(async () => ({ state_version: 2, tag: 'next' }))
      const { machine } = buildMachine({ submit })
      const actor = startActor(machine)
      await settle() // initial load
      actor.send({ type: 'DISPATCH', event: 'APPROVE' })
      // The DISPATCH event synchronously transitions to submitting before
      // the actor invocation resolves.
      expect(actor.getSnapshot().value).toBe('submitting')
      await settle()
      const final = actor.getSnapshot()
      expect(final.value).toBe('idle')
      expect(final.context.snapshot).toEqual({ state_version: 2, tag: 'next' })
      expect(final.context.outOfSync).toBe(false)
      expect(final.context.error).toBeNull()
      expect(submit).toHaveBeenCalledWith('e1', 'APPROVE', 1, 'acme')
    })

    it('DISPATCH is ignored when no snapshot is loaded', async () => {
      // Build a machine whose load never resolves, so we stay in `loading`.
      const load = vi.fn(() => new Promise<DemoSnapshot>(() => {}))
      const { machine, submit } = buildMachine({ load })
      const actor = startActor(machine)
      // `loading` does not handle DISPATCH; the send is a no-op.
      actor.send({ type: 'DISPATCH', event: 'APPROVE' })
      expect(actor.getSnapshot().value).toBe('loading')
      expect(submit).not.toHaveBeenCalled()
    })
  })

  describe('DISPATCH conflict (409)', () => {
    it('reloads snapshot and marks outOfSync', async () => {
      const fresh: DemoSnapshot = { state_version: 7, tag: 'fresh-from-server' }
      const load = vi
        .fn<(id: string, slug: string) => Promise<DemoSnapshot>>()
        .mockResolvedValueOnce({ state_version: 1, tag: 'initial' })
        .mockResolvedValueOnce(fresh)
      const submit = vi.fn(async () => {
        throw new Error('HTTP 409: state_version mismatch')
      })
      const { machine } = buildMachine({ load, submit })
      const actor = startActor(machine)
      await settle()
      actor.send({ type: 'DISPATCH', event: 'APPROVE' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.outOfSync).toBe(true)
      expect(snap.context.snapshot).toEqual(fresh)
      expect(snap.context.error).toMatch(/409/)
      // Conflict path reloaded the snapshot via the load callback.
      expect(load).toHaveBeenCalledTimes(2)
    })

    it('detects conflicts via state_version keyword too', async () => {
      const submit = vi.fn(async () => {
        throw new Error('state_version conflict')
      })
      const { machine } = buildMachine({ submit })
      const actor = startActor(machine)
      await settle()
      actor.send({ type: 'DISPATCH', event: 'APPROVE' })
      await settle()
      expect(actor.getSnapshot().context.outOfSync).toBe(true)
    })

    it('conflict reload that itself fails leaves snapshot null but outOfSync true', async () => {
      const load = vi
        .fn<(id: string, slug: string) => Promise<DemoSnapshot>>()
        .mockResolvedValueOnce({ state_version: 1, tag: 'initial' })
        .mockRejectedValueOnce(new Error('reload bombed'))
      const submit = vi.fn(async () => {
        throw new Error('409 stale')
      })
      const { machine } = buildMachine({ load, submit })
      const actor = startActor(machine)
      await settle()
      actor.send({ type: 'DISPATCH', event: 'APPROVE' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.context.outOfSync).toBe(true)
      expect(snap.context.snapshot).toBeNull()
    })
  })

  describe('non-409 submit failure', () => {
    it('preserves prior snapshot and records error', async () => {
      const submit = vi.fn(async () => {
        throw new Error('network down')
      })
      const { machine } = buildMachine({ submit })
      const actor = startActor(machine)
      await settle()
      actor.send({ type: 'DISPATCH', event: 'APPROVE' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('idle')
      expect(snap.context.error).toBe('network down')
      expect(snap.context.outOfSync).toBe(false)
      // Snapshot from the initial LOAD is still here.
      expect(snap.context.snapshot).toEqual({ state_version: 1, tag: 'initial' })
    })
  })

  describe('DISMISS_ERROR', () => {
    it('clears error + outOfSync flags from idle', async () => {
      const submit = vi.fn(async () => {
        throw new Error('409 stale')
      })
      const { machine } = buildMachine({ submit })
      const actor = startActor(machine)
      await settle()
      actor.send({ type: 'DISPATCH', event: 'APPROVE' })
      await settle()
      expect(actor.getSnapshot().context.outOfSync).toBe(true)
      actor.send({ type: 'DISMISS_ERROR' })
      const snap = actor.getSnapshot()
      expect(snap.context.error).toBeNull()
      expect(snap.context.outOfSync).toBe(false)
      // Stay in idle — DISMISS_ERROR is an action, not a transition.
      expect(snap.value).toBe('idle')
    })
  })

  describe('LOAD from idle', () => {
    it('returns to loading and re-invokes load', async () => {
      const load = vi
        .fn<(id: string, slug: string) => Promise<DemoSnapshot>>()
        .mockResolvedValue({ state_version: 1, tag: 'initial' })
      const { machine } = buildMachine({ load })
      const actor = startActor(machine)
      await settle()
      expect(actor.getSnapshot().value).toBe('idle')
      actor.send({ type: 'LOAD' })
      expect(actor.getSnapshot().value).toBe('loading')
      await settle()
      expect(actor.getSnapshot().value).toBe('idle')
      expect(load).toHaveBeenCalledTimes(2)
    })
  })
})
