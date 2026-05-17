import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createActor } from 'xstate'

/**
 * Tests for the projectSetup XState machine.
 *
 * The machine wraps `request<T>(...)` from `@/lib/api/client` for the
 * PATCH call. We mock that one symbol so the tests stay pure-state-
 * machine and don't touch fetch / IndexedDB / TanStack.
 */

const requestMock = vi.fn<(path: string, options?: unknown) => Promise<unknown>>()

vi.mock('@/lib/api/client', () => ({
  request: (path: string, options?: unknown) => requestMock(path, options),
}))

// Avoid importing the hook (which would pull in TanStack + React).
// We import the bare machine and `formFromProject` is exercised
// indirectly via the LOAD event.
import { projectSetupMachine } from './project-setup.js'
import type { ProjectDetail } from '@/lib/api/projects'

const baseProject: ProjectDetail = {
  id: 'p-1',
  name: 'Main St rebuild',
  status: 'active',
  division_code: null,
  customer_name: 'ACME',
  customer_id: 'c-1',
  bid_total: '0',
  closed_at: null,
  created_at: '2026-05-01T00:00:00.000Z',
  updated_at: '2026-05-01T00:00:00.000Z',
  site_lat: '34.0522',
  site_lng: '-118.2437',
  site_radius_m: 150,
  labor_rate: '50',
  target_sqft_per_hr: null,
  bonus_pool: '0',
  summary_locked_at: null,
  auto_clock_in_enabled: true,
  auto_clock_out_grace_seconds: 300,
  auto_clock_correction_window_seconds: 120,
  daily_budget_cents: 250000,
  version: 3,
}

function newActor() {
  const actor = createActor(projectSetupMachine, { input: { projectId: 'p-1' } })
  actor.start()
  return actor
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  requestMock.mockReset()
})

describe('projectSetupMachine', () => {
  describe('initial / LOAD', () => {
    it('starts in loading with an empty form', () => {
      const actor = newActor()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('loading')
      expect(snap.context.project).toBeNull()
      expect(snap.context.form.name).toBe('')
    })

    it('LOAD hydrates the form from a project and lands in clean', () => {
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('clean')
      expect(snap.context.project).toEqual(baseProject)
      expect(snap.context.form.name).toBe('Main St rebuild')
      expect(snap.context.form.siteLat).toBe('34.0522')
      expect(snap.context.form.siteLng).toBe('-118.2437')
      expect(snap.context.form.siteRadius).toBe(150)
      expect(snap.context.form.budgetDollars).toBe('2500')
      expect(snap.context.form.autoEnabled).toBe(true)
      expect(snap.context.error).toBeNull()
    })
  })

  describe('EDIT', () => {
    it('clean → dirty on first EDIT and updates the field', () => {
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: 'Renamed' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('dirty')
      expect(snap.context.form.name).toBe('Renamed')
    })

    it('EDIT in dirty stays in dirty', () => {
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: 'Renamed' })
      actor.send({ type: 'EDIT', field: 'siteRadius', value: 200 })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('dirty')
      expect(snap.context.form.siteRadius).toBe(200)
    })
  })

  describe('SUBMIT — validation failure', () => {
    it('empty name → stays in dirty with error, no request made', async () => {
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: '   ' })
      actor.send({ type: 'SUBMIT' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('dirty')
      expect(snap.context.error).toMatch(/required/i)
      expect(requestMock).not.toHaveBeenCalled()
    })

    it('out-of-range lat → stays in dirty with error', async () => {
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'siteLat', value: '999' })
      actor.send({ type: 'SUBMIT' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('dirty')
      expect(snap.context.error).toMatch(/lat \/ lng/i)
      expect(requestMock).not.toHaveBeenCalled()
    })

    it('negative budget → stays in dirty with error', async () => {
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'budgetDollars', value: '-5' })
      actor.send({ type: 'SUBMIT' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('dirty')
      expect(snap.context.error).toMatch(/budget/i)
    })
  })

  describe('SUBMIT — happy path', () => {
    it('moves dirty → submitting → clean on success', async () => {
      requestMock.mockResolvedValueOnce(undefined)
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: 'Renamed' })
      actor.send({ type: 'SUBMIT' })
      expect(actor.getSnapshot().value).toBe('submitting')
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('clean')
      expect(snap.context.error).toBeNull()
      expect(snap.context.outOfSync).toBe(false)
      expect(requestMock).toHaveBeenCalledTimes(1)
      const [path, options] = requestMock.mock.calls[0]!
      expect(path).toBe('/api/projects/p-1')
      const opts = options as { method: string; json: Record<string, unknown> }
      expect(opts.method).toBe('PATCH')
      expect(opts.json.name).toBe('Renamed')
      expect(opts.json.expected_version).toBe(3)
      expect(opts.json.daily_budget_cents).toBe(250000)
    })
  })

  describe('SUBMIT — 409 conflict', () => {
    it('moves submitting → outOfSync with error preserved', async () => {
      requestMock.mockRejectedValueOnce(new Error('HTTP 409: expected_version mismatch'))
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: 'Renamed' })
      actor.send({ type: 'SUBMIT' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('outOfSync')
      expect(snap.context.outOfSync).toBe(true)
      expect(snap.context.error).toMatch(/409/)
    })

    it('outOfSync → DISMISS_ERROR lands back in dirty', async () => {
      requestMock.mockRejectedValueOnce(new Error('409 stale'))
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: 'Renamed' })
      actor.send({ type: 'SUBMIT' })
      await settle()
      expect(actor.getSnapshot().value).toBe('outOfSync')
      actor.send({ type: 'DISMISS_ERROR' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('dirty')
      expect(snap.context.outOfSync).toBe(false)
      expect(snap.context.error).toBeNull()
    })
  })

  describe('SUBMIT — non-409 failure', () => {
    it('moves submitting → error with the message', async () => {
      requestMock.mockRejectedValueOnce(new Error('network down'))
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: 'Renamed' })
      actor.send({ type: 'SUBMIT' })
      await settle()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('error')
      expect(snap.context.error).toBe('network down')
    })

    it('error → SUBMIT retries (re-enters submitting)', async () => {
      requestMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(undefined)
      const actor = newActor()
      actor.send({ type: 'LOAD', project: baseProject })
      actor.send({ type: 'EDIT', field: 'name', value: 'Renamed' })
      actor.send({ type: 'SUBMIT' })
      await settle()
      expect(actor.getSnapshot().value).toBe('error')
      actor.send({ type: 'SUBMIT' })
      expect(actor.getSnapshot().value).toBe('submitting')
      await settle()
      expect(actor.getSnapshot().value).toBe('clean')
      expect(requestMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('SUBMIT guard', () => {
    it('SUBMIT with no loaded project is a no-op (still dirty has no project so it never reaches dirty)', () => {
      const actor = newActor()
      // From `loading` SUBMIT is not handled; the actor stays put.
      actor.send({ type: 'SUBMIT' })
      expect(actor.getSnapshot().value).toBe('loading')
      expect(requestMock).not.toHaveBeenCalled()
    })
  })
})
