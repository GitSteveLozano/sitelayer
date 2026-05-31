import { describe, expect, it } from 'vitest'
import { createActor, type Actor } from 'xstate'
import fc from 'fast-check'
import { createSubmitFormMachine } from './submit-form.js'

/**
 * Unit + property coverage for the generic `submitForm` factory machine
 * (previously had NO test file). Owns only UI state: isSubmitting, error,
 * success (resets on next SUBMIT), last result.
 *
 *   idle ─SUBMIT▶ submitting ─run onDone▶ idle (success=true, result set)
 *                              ─run onError▶ idle (error set, success=false)
 *   idle ─RESET▶ idle (clear error/success/result)
 *
 * Invariant: `success` and `error` are never both truthy at the same time.
 */

type Payload = { v: number }
type Result = { ok: number }

function startActor(
  submitter: (p: Payload) => Promise<Result>,
): Actor<ReturnType<typeof createSubmitFormMachine<Payload, Result>>> {
  const machine = createSubmitFormMachine<Payload, Result>()
  const actor = createActor(machine, { input: { submitter } })
  actor.start()
  return actor
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('submitFormMachine — affordance golden map', () => {
  it('idle accepts SUBMIT + RESET; submitting accepts neither', async () => {
    const actor = startActor(async () => ({ ok: 1 }))
    const idle = actor.getSnapshot()
    const map = {
      idle: (['SUBMIT', 'RESET'] as const).filter((type) =>
        type === 'SUBMIT' ? idle.can({ type, payload: { v: 1 } }) : idle.can({ type }),
      ),
    }
    actor.send({ type: 'SUBMIT', payload: { v: 1 } })
    const submitting = actor.getSnapshot()
    expect(submitting.value).toBe('submitting')
    const submittingAccepts = (['SUBMIT', 'RESET'] as const).filter((type) =>
      type === 'SUBMIT' ? submitting.can({ type, payload: { v: 1 } }) : submitting.can({ type }),
    )
    expect(map.idle).toMatchInlineSnapshot(`
      [
        "SUBMIT",
        "RESET",
      ]
    `)
    expect(submittingAccepts).toEqual([])
  })
})

describe('submitFormMachine — lifecycle', () => {
  it('SUBMIT → onDone sets result + success, clears error', async () => {
    const actor = startActor(async (p) => ({ ok: p.v * 2 }))
    actor.send({ type: 'SUBMIT', payload: { v: 21 } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.success).toBe(true)
    expect(snap.context.result).toEqual({ ok: 42 })
    expect(snap.context.error).toBeNull()
  })

  it('SUBMIT → onError sets error, success=false', async () => {
    const actor = startActor(async () => {
      throw new Error('nope')
    })
    actor.send({ type: 'SUBMIT', payload: { v: 1 } })
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.error).toBe('nope')
    expect(snap.context.success).toBe(false)
  })

  it('success is overwritten by the next SUBMIT outcome (onError clears it)', async () => {
    let fail = false
    const actor = startActor(async () => {
      if (fail) throw new Error('boom')
      return { ok: 1 }
    })
    actor.send({ type: 'SUBMIT', payload: { v: 1 } })
    await settle()
    expect(actor.getSnapshot().context.success).toBe(true)
    // The reducer does NOT clear success on entering `submitting` — it
    // only flips on the next completion (onDone=true / onError=false).
    fail = true
    actor.send({ type: 'SUBMIT', payload: { v: 2 } })
    expect(actor.getSnapshot().value).toBe('submitting')
    await settle()
    const snap = actor.getSnapshot()
    expect(snap.context.success).toBe(false)
    expect(snap.context.error).toBe('boom')
  })

  it('RESET clears error/success/result', async () => {
    const actor = startActor(async () => ({ ok: 7 }))
    actor.send({ type: 'SUBMIT', payload: { v: 1 } })
    await settle()
    actor.send({ type: 'RESET' })
    const snap = actor.getSnapshot()
    expect(snap.context.success).toBe(false)
    expect(snap.context.error).toBeNull()
    expect(snap.context.result).toBeNull()
  })
})

describe('submitFormMachine — property: success and error never both truthy', () => {
  it('holds across random submit/reset sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constant({ kind: 'ok' as const }),
            fc.constant({ kind: 'err' as const }),
            fc.constant({ kind: 'reset' as const }),
          ),
          { maxLength: 25 },
        ),
        async (ops) => {
          for (const op of ops) {
            // Build a fresh actor whose submitter resolves or rejects
            // based on the op so we exercise both terminal branches.
            const actor = startActor(async () => {
              if (op.kind === 'err') throw new Error('x')
              return { ok: 1 }
            })
            if (op.kind === 'reset') actor.send({ type: 'RESET' })
            else actor.send({ type: 'SUBMIT', payload: { v: 1 } })
            await settle()
            const c = actor.getSnapshot().context
            expect(c.success && Boolean(c.error)).toBe(false)
            actor.stop()
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})
