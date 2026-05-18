import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { onboardingWizardMachine } from './onboarding-wizard.js'

function newActor() {
  const actor = createActor(onboardingWizardMachine, { input: {} })
  actor.start()
  return actor
}

describe('onboardingWizardMachine', () => {
  describe('initial state', () => {
    it('starts in company_step with empty company form', () => {
      const actor = newActor()
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('company_step')
      expect(snap.context.companyForm.slug).toBe('')
      expect(snap.context.companyForm.name).toBe('')
      expect(snap.context.companyForm.seedDefaults).toBe(true)
      expect(snap.context.error).toBeNull()
    })

    it('starts with default team + seed forms', () => {
      const actor = newActor()
      const snap = actor.getSnapshot()
      expect(snap.context.teamForm.pendingRole).toBe('foreman')
      expect(snap.context.teamForm.invited).toEqual([])
      expect(snap.context.seedOptions.yardName).toBe('Main yard')
    })
  })

  describe('company_step', () => {
    it('NEXT is rejected when slug + name are both empty', () => {
      const actor = newActor()
      actor.send({ type: 'NEXT' })
      expect(actor.getSnapshot().value).toBe('company_step')
    })

    it('NEXT is rejected when only slug filled', () => {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'NEXT' })
      expect(actor.getSnapshot().value).toBe('company_step')
    })

    it('NEXT is rejected when only name filled', () => {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME' })
      actor.send({ type: 'NEXT' })
      expect(actor.getSnapshot().value).toBe('company_step')
    })

    it('NEXT advances to submitting once slug + name are non-empty', () => {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME Builders' })
      actor.send({ type: 'NEXT' })
      expect(actor.getSnapshot().value).toBe('submitting')
    })

    it('SUBMIT behaves identically to NEXT (both gated by companyFormValid)', () => {
      const actor = newActor()
      actor.send({ type: 'SUBMIT' })
      expect(actor.getSnapshot().value).toBe('company_step')
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME' })
      actor.send({ type: 'SUBMIT' })
      expect(actor.getSnapshot().value).toBe('submitting')
    })

    it('whitespace-only fields do not satisfy the validator', () => {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: '   ' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: '   ' })
      actor.send({ type: 'NEXT' })
      expect(actor.getSnapshot().value).toBe('company_step')
    })

    it('SET_COMPANY_FIELD updates the form even for boolean seedDefaults', () => {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'seedDefaults', value: false })
      expect(actor.getSnapshot().context.companyForm.seedDefaults).toBe(false)
    })
  })

  describe('submitting → team / error', () => {
    function reachSubmitting() {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME' })
      actor.send({ type: 'NEXT' })
      return actor
    }

    it('MARK_SUBMITTED transitions submitting → team_step and clears error', () => {
      const actor = reachSubmitting()
      actor.send({ type: 'MARK_SUBMITTED' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('team_step')
      expect(snap.context.error).toBeNull()
    })

    it('MARK_FAILED transitions submitting → error and preserves message + form', () => {
      const actor = reachSubmitting()
      actor.send({ type: 'MARK_FAILED', error: 'slug taken' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('error')
      expect(snap.context.error).toBe('slug taken')
      // Form preserved so the user can edit and retry.
      expect(snap.context.companyForm.slug).toBe('acme')
      expect(snap.context.companyForm.name).toBe('ACME')
    })
  })

  describe('slug suggestion (409 with suggested_slug)', () => {
    function reachSubmitting() {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME' })
      actor.send({ type: 'NEXT' })
      return actor
    }

    it('SLUG_SUGGESTION from submitting → company_step with slug pre-filled', () => {
      const actor = reachSubmitting()
      actor.send({ type: 'SLUG_SUGGESTION', suggestion: 'acme-2' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('company_step')
      expect(snap.context.companyForm.slug).toBe('acme-2')
      expect(snap.context.companyForm.name).toBe('ACME')
      expect(snap.context.slugHint).toBeTruthy()
      expect(snap.context.slugHint).toContain('acme-2')
      expect(snap.context.error).toBeNull()
    })

    it('SLUG_SUGGESTION from error state also applies the suggestion + clears error', () => {
      const actor = reachSubmitting()
      actor.send({ type: 'MARK_FAILED', error: 'slug already taken' })
      expect(actor.getSnapshot().value).toBe('error')
      actor.send({ type: 'SLUG_SUGGESTION', suggestion: 'acme-3' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('company_step')
      expect(snap.context.companyForm.slug).toBe('acme-3')
      expect(snap.context.error).toBeNull()
      expect(snap.context.slugHint).toBeTruthy()
    })

    it('editing the slug after a suggestion clears the hint', () => {
      const actor = reachSubmitting()
      actor.send({ type: 'SLUG_SUGGESTION', suggestion: 'acme-2' })
      expect(actor.getSnapshot().context.slugHint).toBeTruthy()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme-prime' })
      const snap = actor.getSnapshot()
      expect(snap.context.companyForm.slug).toBe('acme-prime')
      expect(snap.context.slugHint).toBeNull()
    })

    it('a successful submit clears any lingering slugHint', () => {
      const actor = reachSubmitting()
      actor.send({ type: 'SLUG_SUGGESTION', suggestion: 'acme-2' })
      expect(actor.getSnapshot().context.slugHint).toBeTruthy()
      actor.send({ type: 'NEXT' })
      actor.send({ type: 'MARK_SUBMITTED' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('team_step')
      expect(snap.context.slugHint).toBeNull()
    })

    it('uses a caller-supplied hint when provided', () => {
      const actor = reachSubmitting()
      actor.send({ type: 'SLUG_SUGGESTION', suggestion: 'acme-2', hint: 'Custom hint here' })
      expect(actor.getSnapshot().context.slugHint).toBe('Custom hint here')
    })
  })

  describe('error → recovery', () => {
    function reachError() {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME' })
      actor.send({ type: 'NEXT' })
      actor.send({ type: 'MARK_FAILED', error: 'slug taken' })
      return actor
    }

    it('RETRY returns to submitting and clears the error', () => {
      const actor = reachError()
      actor.send({ type: 'RETRY' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('submitting')
      expect(snap.context.error).toBeNull()
    })

    it('BACK from error returns to company_step', () => {
      const actor = reachError()
      actor.send({ type: 'BACK' })
      expect(actor.getSnapshot().value).toBe('company_step')
    })

    it('DISMISS_ERROR clears the banner without changing state', () => {
      const actor = reachError()
      actor.send({ type: 'DISMISS_ERROR' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('error')
      expect(snap.context.error).toBeNull()
    })
  })

  describe('team_step', () => {
    function reachTeamStep() {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME' })
      actor.send({ type: 'NEXT' })
      actor.send({ type: 'MARK_SUBMITTED' })
      return actor
    }

    it('NEXT advances to seed_step', () => {
      const actor = reachTeamStep()
      actor.send({ type: 'NEXT' })
      expect(actor.getSnapshot().value).toBe('seed_step')
    })

    it('BACK returns to company_step', () => {
      const actor = reachTeamStep()
      actor.send({ type: 'BACK' })
      expect(actor.getSnapshot().value).toBe('company_step')
    })

    it('APPEND_INVITED tracks invited members and clears pending id', () => {
      const actor = reachTeamStep()
      actor.send({ type: 'SET_TEAM_FIELD', field: 'pendingClerkUserId', value: 'user_123' })
      actor.send({ type: 'APPEND_INVITED', member: { clerkUserId: 'user_123', role: 'foreman' } })
      const snap = actor.getSnapshot()
      expect(snap.context.teamForm.invited).toEqual([{ clerkUserId: 'user_123', role: 'foreman' }])
      expect(snap.context.teamForm.pendingClerkUserId).toBe('')
    })
  })

  describe('seed_step', () => {
    function reachSeedStep() {
      const actor = newActor()
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'slug', value: 'acme' })
      actor.send({ type: 'SET_COMPANY_FIELD', field: 'name', value: 'ACME' })
      actor.send({ type: 'NEXT' })
      actor.send({ type: 'MARK_SUBMITTED' })
      actor.send({ type: 'NEXT' })
      return actor
    }

    it('SUBMIT advances to done (final state)', () => {
      const actor = reachSeedStep()
      actor.send({ type: 'SUBMIT' })
      const snap = actor.getSnapshot()
      expect(snap.value).toBe('done')
      expect(snap.status).toBe('done')
    })

    it('NEXT advances to done (skip seed)', () => {
      const actor = reachSeedStep()
      actor.send({ type: 'NEXT' })
      expect(actor.getSnapshot().value).toBe('done')
    })

    it('BACK returns to team_step', () => {
      const actor = reachSeedStep()
      actor.send({ type: 'BACK' })
      expect(actor.getSnapshot().value).toBe('team_step')
    })

    it('SET_SEED_FIELD updates options', () => {
      const actor = reachSeedStep()
      actor.send({ type: 'SET_SEED_FIELD', field: 'customerName', value: 'BigCo' })
      expect(actor.getSnapshot().context.seedOptions.customerName).toBe('BigCo')
    })
  })
})
