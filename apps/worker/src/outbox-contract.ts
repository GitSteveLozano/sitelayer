// Outbox contract — worker-side dedicated-runner registry.
//
// Maps every mutation_type that a dedicated runner claims to the module that
// actually drains it. This is the worker's half of the inverted outbox
// contract (see packages/queue/src/index.ts):
//
//   - GENERIC_APPLY_MUTATION_TYPES  → generic apply-with-no-work drain
//   - DEDICATED_HANDLER_MUTATION_TYPES (queue pkg) → must equal the keys of
//     this registry — the conformance test (outbox-conformance.test.ts)
//     enforces the lockstep in both directions.
//   - anything else → quarantined as 'failed' by quarantineUnroutableOutbox.
//
// Adding a new dedicated runner? Add the mutation_type HERE (pointing at the
// module whose claim/drain references the literal) AND to
// DEDICATED_HANDLER_MUTATION_TYPES in packages/queue/src/index.ts. The
// conformance test fails until both are in place and the handler module
// really contains the literal.

/** repo-relative path of the module that claims/drains each mutation_type. */
export const DEDICATED_RUNNER_REGISTRY: Readonly<Record<string, string>> = {
  // QBO pushes (workflow side effects) — two-phase pushers in @sitelayer/queue.
  post_qbo_invoice: 'packages/queue/src/pushers/rental-billing-invoice.ts',
  post_rental_invoice: 'packages/queue/src/pushers/rental-cadence-invoice.ts',
  post_qbo_estimate: 'packages/queue/src/pushers/estimate-push.ts',
  pull_qbo_reference: 'packages/queue/src/pushers/qbo-pull.ts',
  lock_labor_entries: 'packages/queue/src/pushers/lock-labor-entries.ts',
  assemble_debug_bundle: 'packages/queue/src/pushers/debug-bundle.ts',
  // Worker-local drains.
  post_qbo_time_activities: 'apps/worker/src/labor-payroll-push.ts',
  notify_worker_resolution: 'apps/worker/src/field-event-notifier.ts',
  notify_estimator_escalation: 'apps/worker/src/field-event-notifier.ts',
  notify_foreman_assignment: 'apps/worker/src/field-event-notifier.ts',
  materialize_labor_entries: 'apps/worker/src/crew-schedule-confirm-processor.ts',
  notify_foreman_decline: 'apps/worker/src/crew-schedule-confirm-processor.ts',
  delete_blueprint_storage_object: 'apps/worker/src/runners/blueprint-storage-gc.ts',
  dispatch_mesh_work_request: 'apps/worker/src/runners/context-work-dispatch.ts',
  // drainAgentMutations-based runners.
  takeoff_to_bid: 'apps/worker/src/runners/takeoff-to-bid.ts',
  voice_to_log: 'apps/worker/src/runners/voice-to-log.ts',
  welcome_email: 'apps/worker/src/runners/welcome-email.ts',
  damage_charge_invoice_push: 'apps/worker/src/runners/damage-charges.ts',
  send_estimate_share: 'apps/worker/src/runners/estimate-share-email.ts',
}

export const WORKER_DEDICATED_MUTATION_TYPES: readonly string[] = Object.keys(DEDICATED_RUNNER_REGISTRY)
