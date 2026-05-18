## Summary

<!-- One sentence: what changes and why. Link the issue or ADR if there is one. -->

## Test plan

- [ ] `npx tsc --noEmit` exits 0 on every touched workspace
- [ ] `npm run test` passes for every touched workspace (vitest)
- [ ] `npm run lint` clean (`eslint . --max-warnings=0`)
- [ ] `prettier --check` clean
- [ ] CI Quality workflow passes
- [ ] Preview deploy renders (post-push)

## Screenshots

<!-- Required only for UI-visible changes. Drag-drop a before/after pair. Delete this section otherwise. -->

## Migration notes

<!-- Required only if `docker/postgres/init/*.sql` is touched. Confirm the new file is additive (next sequential prefix) and that earlier migrations are unchanged — see CLAUDE.md "Migrations are immutable". Delete otherwise. -->

## Breaking changes

<!-- Required only if response shapes, route URLs, env-var names, workflow event grammar, or external contracts change. List the consumer surface that needs to update in lock-step. Delete otherwise. -->
