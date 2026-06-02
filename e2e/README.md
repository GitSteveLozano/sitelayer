# E2E suite — area tags (Decomposition Seam 5)

The Playwright specs under `e2e/tests/` are tagged by **feature area** so a PR
lane can run only the area it touched instead of the whole serial suite. Tags
are attached with the Playwright `{ tag }` option (Playwright >= 1.42), e.g.:

```ts
runSpec('office user approves and requests a rental billing post', { tag: '@rental' }, async ({ officePage }) => {
  // ...
})
```

## Running a scoped subset

```bash
# Run one area
npm run test:e2e:tagged @rental

# Combine areas (Playwright OR-matches a regex over the tag string)
npm run test:e2e:tagged "@rental|@payroll"

# Full suite (no grep) — this is what push:main runs as the merge gate
npm run test:e2e
```

`test:e2e:tagged` is `playwright test --grep`; the tag pattern is the trailing
argument. `--grep` matches against the test title **plus** its tags, so a bare
`@rental` filters to the rental specs.

## Tags in use

| Tag         | Specs                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@rental`   | `office-rental-billing.spec.ts`                                                                                                     |
| `@takeoff`  | `takeoff-preview.smoke.spec.ts`                                                                                                     |
| `@payroll`  | `admin-time-review-then-payroll.spec.ts`, `admin-closeout-rollup.spec.ts`                                                           |
| `@estimate` | `admin-estimate-push.spec.ts`, `probe-estimate-push-capture.smoke.spec.ts`                                                          |
| `@project`  | `admin-project-lifecycle.spec.ts`                                                                                                   |
| `@foreman`  | `foreman-field-event.spec.ts`                                                                                                       |
| `@capture`  | `portal-feedback-capture.smoke.spec.ts`, `authenticated-feedback-capture.live.spec.ts`, `probe-estimate-push-capture.smoke.spec.ts` |

Some specs carry two tags (the estimate-push capture probe is both `@estimate`
and `@capture`) so they surface in either area's lane.

## Safety invariant

Tags **scope** runs; they never **skip** anything permanently. The untagged
full run is the source of truth and executes via the local gate's e2e step
(`scripts/verify-local.sh --full` / `npm run verify:full` — the opt-in e2e
level, run on a quiet box). Adding a tag to a spec must not remove it from the
full suite — the
`{ tag }` option does not filter the default run.

## Adding a new area tag

1. Pick or reuse an area token (lowercase, `@`-prefixed).
2. Pass it via the `{ tag }` option on the spec's `test(...)` / `runSpec(...)`.
3. Add a row to the table above.
4. The full untagged suite always runs in the local gate, so a new tag needs no
   extra wiring; use tags only to scope a faster local subset.
