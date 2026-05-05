# Design Handoff Artifacts

Version-stamped exports of the Sitelayer design system. **Not application code** — these are the design source-of-truth that screens in `apps/web/` are built from. Live screens are in `apps/web/src/screens/mobile/` and `apps/web/src/screens/`.

## Why these files exist in the repo

Steve runs the design pipeline in Claude Design / Figma and exports an HTML/JSX bundle when the design moves forward. Keeping that bundle checked in lets agents (Claude, Codex, Gemini) reference the canonical visual intent when implementing screens, instead of asking Steve every time.

Before 2026-05-05 these dirs lived at repo root. They moved here so the project tree only contains `apps/`, `packages/`, `docs/`, `scripts/`, etc. — nothing that looks like application code.

## Structure

Each subdirectory is one design version:

- `v3.3.0/Design Overview/` — design system + screen index across personas
- `v3.3.0/estimator/` — owner / PM screens (estimate, dashboard, projects)
- `v3.3.0/foreman/` — foreman field screens
- `v3.3.0/worker/` — worker today / clock-in / scope screens

Inside each subdirectory: `source/*.jsx`, `screenshots/*.png`, and a README with the Sitemap §X panel mappings.

## Working with these files

**Reading:** Open the `Sitemap.html` and `Mobile.html` referenced in the source bundle to see rendered designs. Each screen in `apps/web/src/screens/mobile/<name>.tsx` has a comment at the top citing its Sitemap source ID — that maps back to a panel in this directory.

**Updating:** Don't edit these files directly. Steve re-exports a fresh bundle when the design moves; that lands as `vX.Y.Z/`. Older versions stay as historical reference until they're stale enough to retire.

**CI:** `.prettierignore` excludes this whole directory; format-on-save and CI lint don't touch it. Files here are reference material, not formatted source.
