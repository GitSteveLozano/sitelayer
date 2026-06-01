# Rolldown Migration Analysis — `apps/web` (Sitelayer)

**Audience:** operator/engineer running Sitelayer as a production revenue app.
**Question:** "Comprehensive analysis of how things will change if we move Sitelayer to Rolldown."
**Date of analysis:** 2026-06-01.
**Repo root analyzed:** `/home/taylorsando/projects/worktrees/sitelayer-rolldown-analysis` (worktree of sitelayer).

---

## 0. DECISION & RESULTS (2026-06-01, updated) — Path B / Vite 8 ADOPTED

Operator directive: **be on the newest Vite.** A registry check settled the Path A vs B question decisively: **`vite@8.0.16` depends directly on `rolldown@1.0.3` (stable) and has NO `rollup` dependency — Vite 8 _is_ Rolldown.** So "newest Vite" and "Rolldown 1.0 going forward" are the _same_ upgrade, and Path A (`rolldown-vite@7.3.1`, which vendors `rolldown@1.0.0-beta.53`) would have meant an _older_ Vite + a _beta_ Rolldown. **Chose Path B (Vite 8).** The §1 "Path A" recommendation below is **superseded**.

Measured spike (this worktree, before→after, full `npm run build`):

- **Bump = one line:** `apps/web` `vite: ^7.3.0 → ^8.0.0`. All three build plugins already declare `^8` peer (plugin-react 5.2.0, vite-plugin-pwa 1.3.0, vitest 4.1.5) — no plugin churn. The function-form `manualChunks` is still honored.
- **R1 (chunk ⟷ workbox coupling): CLEAN.** `vendor-three`/`vendor-pdf`/`vendor-react` stay single named chunks; the 201-entry precache manifest excludes `vendor-three`/`vendor-pdf` (PWA precache intact).
- **R2 (budget): one real regression, FIXED.** Vite 8 / Rolldown's entry `modulepreload` graph eagerly preloaded ~13 route-level util chunks (`cn`, `auth`, `queue`, `daily-logs`, `crud-factory`, `keys`, …) that Rollup kept lazy → initial eager JS `138750 → 178817` gzip, blowing the 160 KB budget. Fix (one config block): `build.modulePreload.resolveDependencies` filtered to `vendor-*` → 16 preload links → 4, eager back to **155696 gzip (under budget)**; the route utils load on-demand again. _Not_ Oxc minify — `vendor-react` grew only ~2 KB, and the `desktop-workspace` lazy chunk actually **shrank** `112156 → 107945`.
- **R4:** Rolldown emits one `rolldown-runtime-*` chunk; after the preload trim it is no longer eager, and the budget script already exempts the prefix.
- **R3 (Clerk): static check PASS** — `@clerk` + `react-dom` + `scheduler` + `Activity` co-located in `vendor-react`. The real-browser Clerk-init smoke is the **one remaining gate before prod** (runtime-only).
- **typecheck / test (vitest 4) / lint / format: all green on Vite 8.**

**The only Vite-8-specific source change beyond the version bump is the `modulePreload` trim in `apps/web/vite.config.ts`.**

---

## 1. TL;DR + recommendation

**Verdict: worth doing now, low structural risk, one mandatory empirical gate.** The migration touches exactly **one workspace** (`apps/web`), the repo is unusually clean for this swap (npm workspaces, single hoisted `vite@7.3.2`, zero nested copies, no decorators, no CJS interop, no unsupported Rollup hooks, no Yarn-PnP), and all three Vite plugins already declare Vite 8 peer support. Most of the scary clauses in the Rolldown 1.0 doc are **inert or overstated** for this repo.

**Recommendation — Path A: adopt `rolldown-vite` now as a single root npm `overrides` alias under Vite 7. Do NOT wait for Vite 8 (Path B).**

> One-liner: _Add `"overrides": { "vite": "npm:rolldown-vite@<pin>" }` to the root `package.json`, validate on the `dev` env first with a build/budget measurement spike + a real-browser Clerk-init smoke, gate on a green `Quality` run, ship, and keep one-revert rollback ready. Defer Vite 8 (Lightning CSS + `oxc._` config renames) until rolldown-vite has baked.\*

Path A isolates the bundler swap to a single reversible lockfile stanza; Path B couples the bundler swap to a major Vite bump (CSS minifier → Lightning CSS, `optimizeDeps.esbuildOptions`→`optimizeDeps.rolldownOptions`, `esbuild.*`→`oxc.*`, ~15MB install footprint) that you would debug all at once against a revenue-path deploy gate. Strictly worse for isolation.

### Risk table

| #   | Risk                                                                                                                                                  | Where                                           | Severity   | Mitigable?                                                 | Catches in CI?                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------- | ---------------------------------------------------------- | -------------------------------------------- |
| R1  | Chunk-name → filename coupling: Rolldown renames/splits `vendor-three`/`vendor-pdf`, silently re-baking ~538KB 3D + PDFium WASM into the PWA precache | `apps/web/vite.config.ts:113,133,146` (workbox) | **HIGH**   | Yes (pin `chunkFileNames` / `advancedChunks`; widen globs) | **No — silent**. Needs explicit dist/SW diff |
| R2  | Oxc minify size vs the 112KB lazy-app-chunk budget; desktop-workspace chunk last measured **~108.4KB gzip** (~3.3% headroom)                          | `scripts/check-web-bundle-budget.mjs:57`        | **MEDIUM** | Yes (force Terser, or re-baseline)                         | **Yes — red `Quality`**                      |
| R3  | Clerk + React 19 `Activity` chunk-ordering invariant breaks at runtime after re-split/reorder                                                         | `apps/web/vite.config.ts:9-25`                  | **MEDIUM** | Yes (force grouping)                                       | **No — runtime only**. Needs browser smoke   |
| R4  | Bundle-budget script mis-gates if Rolldown runtime/assets dir/prefix differs from expectation                                                         | `scripts/check-web-bundle-budget.mjs:58,78`     | LOW        | Yes                                                        | Yes                                          |
| R5  | Plugin API compat (`@vitejs/plugin-react` 5.2.0, `vite-plugin-pwa` 1.3.0, `vitest` 4.1.5)                                                             | `apps/web/package.json`                         | LOW        | n/a (already declare ^8 peer)                              | Yes                                          |
| —   | Decorators / CJS interop / unsupported hooks / Yarn-PnP                                                                                               | (none in repo)                                  | **NONE**   | —                                                          | —                                            |

**Net:** R1 + R3 are the two failure modes a fully-green pipeline can still ship broken — both are _verification gates_, not blockers, and both are addressed by the acceptance checklist in §6.

---

## 2. Migration surface

### What IS touched — exactly one workspace: `apps/web`

`apps/web` is the **only** workspace whose build is a bundler: `apps/web/package.json:8` → `"build": "vite build"`. Verified the build-stack versions in `package-lock.json` match the brief: `vite@7.3.2` (single hoisted copy, **zero nested**), `rollup@4.60.2` (prod bundler), `esbuild@0.27.7` (transform/deps), plus `vite-plugin-pwa@1.3.0` (note: brief said 1.2.0; `package.json` pins `^1.2.0`, lockfile resolves **1.3.0**), `@vitejs/plugin-react@5.2.0`, `terser@5.46.2`, `workbox-build@7.4.1`. `rolldown` / `rolldown-vite` are **not** installed yet; the only `rolldown` token in the tree is the transitive `@rolldown/pluginutils@1.0.0-rc.3` dependency of `plugin-react` (which is already Rolldown-aware).

Files that change under Path A:

- **`package.json` (root)** — add `overrides` stanza + regenerated `package-lock.json`. **That's the entire required change.**
- `apps/web/vite.config.ts` — stays **byte-identical** for Path A (only `manualChunks`/`define`/`resolve.alias`/`build.sourcemap` are used; none of the renamed-under-Vite-8 keys are present).
- Verification-coupled artifacts (may need edits _if_ the dist diff shows drift): the two workbox config blocks in `vite.config.ts` and `scripts/check-web-bundle-budget.mjs`.

### What is NOT touched — `apps/api`, `apps/worker`, all 14 `packages/*`

Every other workspace builds with plain `tsc -p tsconfig.build.json` and has **no** `vite`/`rollup`/`esbuild` dependency: `apps/api`, `apps/worker`, and `packages/{config,domain,logger,workflows,queue,scenario,capture-schema,capture-catalog,formula-evaluator,pipe-blueprint,pipe-roomplan,pipe-photogrammetry,pipe-drone}`. They emit type-checked `dist/` that the runtime loads directly (`node dist/*.js`; the Dockerfile COPYs `packages/*/dist`). A `vite`→`rolldown-vite` override **cannot** change their build output.

**One subtlety:** the root override swaps the single hoisted `vite`, which the six packages' `vitest@3.2.4` and web's `vitest@4.1.5` also resolve. That only changes how their **tests transform/run**, never their `tsc`-built `dist`. Their unit tests are part of `npm run test` in `ci:quality`, so they ride the same acceptance gate (treat the api/worker/scenario/queue suites — alias-only `vitest.config.ts`, no plugins — as a bundler-agnostic control group).

**Deploy boundary:** the Dockerfile is a thin packaging image (header: _"No npm ci / tsc / vite runs in here"_) that only COPYs prebuilt `dist`. The real `vite build` runs (a) in CI via `.github/workflows/quality.yml` and (b) on the fleet host in `scripts/deploy-production-local.sh:201` (which then **deletes** `*.map` — prod ships no sourcemaps). The CI dist cache key hashes `**/vite.config.ts`, so editing the config correctly busts the cache.

### Out-of-scope opportunity (do NOT do now)

The 16 tsc-built workspaces _could_ later adopt **tsdown** (Rolldown + Oxc for libraries). Payoff is marginal: they're small TS libs (not a perf bottleneck), `tsc` is still needed as the typecheck gate (tsdown would be _additional_, not a replacement), and CLAUDE.md favors a lightweight toolchain (no Nx/Turbo). Keep the web migration fully decoupled from any backend build change.

---

## 3. Dimension-by-dimension change analysis

### 3.1 Surface inventory — **Risk: NONE (scoping) / MEDIUM (chunk coupling)**

Scoping is confirmed correct (§2). The single hard coupling is chunk filenames: `manualChunks` names → `assets/[name]-[hash].js` (Vite default, no `chunkFileNames` override anywhere in repo) → consumed by (a) workbox globs/regexes, (b) the bundle-budget prefix exemptions. The pre-seeded `rolldown-runtime-` prefix at `check-web-bundle-budget.mjs:58` shows someone anticipated a Rolldown runtime chunk — **unverified** whether it actually emits with that exact name.

### 3.2 Plugin compatibility — **Risk: LOW**

- `@vitejs/plugin-react@5.2.0`: peer `vite: ...||^8.0.0`, depends on `@babel/core` + `@rolldown/pluginutils@1.0.0-rc.3`. JSX transform runs through **Babel**, not Oxc — so the "Oxc can't lower decorators" caveat is doubly moot. **Keep it; do NOT swap to `@vitejs/plugin-react-oxc` during the migration** (that would change the transform engine simultaneously with the bundler and drop the Babel fast-refresh path React 19 + Clerk rely on).
- `vite-plugin-pwa@1.3.0`: peer `vite: ...||^8.0.0`, wraps `workbox-build@7.4.1` as a **post-build** step over the emitted asset list — no custom Rollup transform/render hooks for Rolldown to reject. Plugin API is compatible; the risk is in the **filename-coupled config**, not the plugin.
- `vitest@4.1.5`: peer `^6||^7||^8`. Web tests `mergeConfig` the full `vite.config.ts`, so a plugin/chunk incompat surfaces in tests first (useful early signal). Pre-existing `vitest` 3.x/4.x skew across packages is unrelated — address separately.

### 3.3 Code-splitting + bundle budget — **Risk: HIGH (this is the dominant dimension)**

See §4 in depth. Two pressure points: the chunk-name coupling (R1) and the ~3.3% headroom on the 112KB lazy budget under Oxc minify (R2). Under `rolldown-vite` (Vite 7), `output.manualChunks` (function form) and the default filename template are **preserved**, so the LOW-MEDIUM case holds. Under **Vite 8**, `output.manualChunks` is deprecated in favor of `build.rolldownOptions.output.advancedChunks` (different shape) and a default `minSize` re-splits — this is the real hazard and the main reason to defer Path B.

### 3.4 CSS / WASM / assets — **Risk: LOW**

- **CSS:** Tailwind 3.4.17 + autoprefixer via `apps/web/postcss.config.cjs` runs through Vite's CSS pipeline, **independent of the JS bundler** — untouched by `rolldown-vite`. Vite 8's switch to **Lightning CSS** affects only the CSS _minifier_ (not PostCSS authoring). The repo uses only well-supported CSS (@layer/@import/100dvh/env-safe-area; no nesting/color-mix/oklch/@container), so expect cosmetic-only diffs. Caveat: Lightning CSS prefixes by `build.cssTarget` not the autoprefixer browserslist — for Path B, either keep `build.cssMinify: 'esbuild'` to defer, or pin `build.cssTarget` and visual-diff.
- **WASM:** `embedpdf.ts` imports `pdfium.wasm?url` (asset-as-URL) → `resolveFileUrl`/`renderDynamicImport` do not apply. The `.wasm` is a separate asset **not** matched by the `vendor-pdf` regex. PDFium is the chosen render engine (PDFium WASM, not pdfjs).
- **Sourcemaps:** `build.sourcemap` is Sentry-env-gated; Rolldown emits standard v3 maps; `scripts/sentry-upload-sourcemaps.sh` uses `@sentry/cli` (bundler-agnostic, no Vite/Rollup plugin). Prod path deletes `*.map`, so this only matters for the separate Sentry-release lane.

### 3.5 Syntax / CJS / decorators — **Risk: NONE**

Fully inert here, confirmed by grep:

- **Decorators:** the two `@`-line greps are false positives — a CSS `@keyframes` in a `<style>` template literal (`post-install-splash.tsx:123`) and a `@sitelayer/pipe-*` mention inside a JSX comment (`takeoff-canvas.tsx:541`). **Zero** real decorators; **no** tsconfig sets `experimentalDecorators`/`emitDecoratorMetadata`. **Do not add `@rolldown/plugin-babel` / `@rollup/plugin-swc`.**
- **CJS:** `apps/web` is `"type": "module"`; **zero** `require(`/`module.exports`/`__dirname`/`createRequire` in `src`; the two `.cjs` files are PostCSS/Tailwind configs loaded natively (outside the bundler graph). The web build externalizes nothing and uses no `require()`.
- **Default-imports:** only `clsx` (prod, ESM-native 2.1.1) and `fast-check` (test-only, ESM-native). **Zero** `import React from 'react'` — fully on the automatic JSX runtime. `three` uses `import * as THREE`. `legacy.inconsistentCjsInterop` is not needed.
- **Unsupported hooks:** repo-wide grep for `resolveImportMeta`/`resolveFileUrl`/`renderDynamicImport`/`shouldTransformCachedModule`/`output.format 'system'|'amd'` → **zero** hits. Only `output.manualChunks` (supported) + first-party plugins.

### 3.6 Migration rollout — **Risk: MEDIUM**

Path A via root `overrides` is the recommended mechanism (§5). Confirmed: **no** existing `overrides`/`resolutions` block; single hoisted `vite@7.3.2`, zero nested copies → one override swaps the bundler everywhere reversibly. The dominant rollout risks are the repo-specific R1/R3 verification gates, not the doc's hype. Stage on `dev` first (never straight to prod; rolldown-vite is a technical preview).

---

## 4. The single biggest risk, in depth — chunking ⟷ workbox ⟷ bundle-budget coupling

### The load-bearing chain

The entire mechanism depends on the string returned by `manualChunks()` appearing **verbatim** at the start of the output filename:

```
manualChunks() returns 'vendor-three'   (vite.config.ts:26)
   → Vite default chunkFileNames = assets/[name]-[hash].js  (NO override exists in repo)
   → emitted file: assets/vendor-three-<hash>.js
```

Three independent consumers hard-depend on that literal `vendor-three*` / `vendor-pdf*` prefix under `assets/`:

1. **workbox `globIgnores`** — `['**/vendor-three*.js', '**/vendor-pdf*.js']` (`vite.config.ts:113`). `globPatterns` precaches **everything** (`**/*.{js,css,html,svg,woff2}`) unless explicitly ignored. These two globs are the only thing keeping the ~538KB 3D chunk + the PDFium engine **out of the install-time precache**.
2. **workbox `runtimeCaching` urlPatterns** — `/\/assets\/vendor-three[^/]*\.js$/` (`:133`) and `/\/assets\/vendor-pdf[^/]*\.js$/` (`:146`) — the CacheFirst on-demand caching for those heavy chunks.
3. **budget script `nonAppPrefixes`** — `['vendor-', 'web-vitals-', 'rolldown-runtime-', 'workbox-']` (`check-web-bundle-budget.mjs:58`) exempts vendor chunks from the gzip budget.

### What Rolldown could do to break it

The doc's KEY RISK: Rolldown creates **more granular** chunks and sometimes ignores `minSize` / over-aggregates. Two failure modes:

- **Rename/no-prefix:** if `vendor-three` is emitted under a different name (e.g. a hash-only name because `advancedChunks` wasn't ported under Vite 8), all three consumers stop matching.
- **Split:** if `three`'s deps split into a sibling chunk (e.g. `vendor-three-2-*.js` or an un-prefixed sibling), that sibling **slips past** the globIgnore.

### Concrete pass/fail predictions

| Scenario                                                 | workbox precache                               | budget gate                                                        | net effect                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Path A, names preserved** (expected)                   | vendor-three/-pdf excluded ✅                  | vendor-\* exempt ✅                                                | **PASS** — no change                                                                                     |
| **R1a: chunk renamed**                                   | heavy chunk re-baked into precache ❌          | now an over-budget _app_ chunk → **red Quality** ⚠️                | **partly loud** (budget catches the rename for the renamed file, but the precache regression is silent)  |
| **R1b: chunk split, sibling un-prefixed**                | sibling re-baked into precache ❌ (**silent**) | sibling counts as lazy app chunk → maybe red, maybe under 112KB ⚠️ | **SILENT regression possible** — every PWA install downloads 3D/PDFium they never use                    |
| **R2: Oxc minify pushes desktop-workspace chunk >112KB** | n/a                                            | **red Quality** ✅                                                 | **loud** — deploy hard-blocked, fix is mechanical                                                        |
| **R3: Clerk re-split out of vendor-react**               | n/a                                            | n/a (vendor-exempt)                                                | **SILENT until runtime** — `Cannot set properties of undefined (setting 'Activity')` at first Clerk init |

The two **silent** modes (R1b, R3) are why a green pipeline is **not** proof of safety. They are caught only by an explicit dist/SW-manifest diff (R1b) and a real-browser Clerk-init smoke (R3) — both in the acceptance checklist.

### Why R2 is real but bounded

`lazyAppChunkGzipBudget = 112*1024` and the desktop-workspace lazy chunk was last measured **~108.4KB gzip** (`check-web-bundle-budget.mjs:50-57`) — **~3.6KB / ~3.3% headroom**. The doc's "Oxc minify ~20-27% larger than Terser" is a **raw-size, early-beta** figure; the budget is **gzip**, which compresses away most minifier verbosity (longer identifiers, weaker mangling), so the effective delta is materially smaller. But at ~3.3% headroom even a ~5-8% gzip regression fails. **This is unverified — no dist exists in the worktree — so a measurement spike is mandatory.** If it trips, the fix is mechanical: force `build.minify: 'terser'` (or `@rollup/plugin-swc`) until Oxc minify matures, or re-baseline with the file's documented changelog convention. **Do not silently bump the budget — the 112KB ceiling is doing real work.**

---

## 5. Step-by-step migration + A/B verification + rollback + acceptance

### Mechanism (Path A)

Add to **root** `package.json` (there is no existing `overrides`):

```jsonc
"overrides": {
  "vite": "npm:rolldown-vite@<pin matching vite 7.3.x — see Open Questions>"
}
```

Then `npm install` → regenerate + commit `package-lock.json`. `vite.config.ts` and `import { defineConfig } from 'vite'` need **no** change (rolldown-vite is a drop-in under the same `vite` specifier). Verify `npm ls vite` resolves to the rolldown alias and **no** second real `vite` got pulled in.

### A/B harness (the existing `ci:quality` IS the gate)

`ci:quality` = `bash -n scripts/*.sh && lint && format && typecheck && test && build && web:bundle-budget && check:dockerfile-imports`. Capture a baseline on current Vite 7 **before** the override:

```bash
# BEFORE (current Rollup build)
npm run build
ls -la apps/web/dist/assets/*.js > /tmp/before-assets.txt
node scripts/check-web-bundle-budget.mjs web > /tmp/before-budget.txt
cp apps/web/dist/sw.js /tmp/before-sw.js   # or the workbox precache manifest

# apply override, npm install, then:
npm run build
ls -la apps/web/dist/assets/*.js > /tmp/after-assets.txt
node scripts/check-web-bundle-budget.mjs web > /tmp/after-budget.txt
diff /tmp/before-assets.txt /tmp/after-assets.txt    # chunk filename stems
diff /tmp/before-budget.txt /tmp/after-budget.txt     # gzip deltas + eager/lazy markers
grep -E 'vendor-(three|pdf)' apps/web/dist/sw.js      # MUST be empty (not precached)
```

### Rollback

Revert the `overrides` stanza + `package-lock.json`, `npm install`, rebuild → back to `vite@7.3.2` with **no residue** (no config/source changed). Independent of the app-level lever (`scripts/rollback-droplet.sh` + `.last_previous_deployed_sha`). Staging on `dev` first means a bad build never reaches the prod droplet. After any prod deploy, confirm `GET /api/version` `build_sha` matches the deployed SHA.

### Acceptance checklist (gate prod on ALL of these)

- [ ] `npm ls vite` → resolves to `rolldown-vite` alias; no second `vite`.
- [ ] `npm run ci:quality` green (lint, **prettier --check** — run `npm run format` on any config edit first, known footgun — typecheck, test, build, bundle-budget, dockerfile-imports).
- [ ] **R2:** `node scripts/check-web-bundle-budget.mjs web` passes; desktop-workspace lazy chunk gzip recorded vs 112KB. If over, decide Terser vs documented re-baseline.
- [ ] **R1:** exactly one `vendor-three-*.js` and one `vendor-pdf-*.js` exist under `dist/assets/`; both still match the two runtimeCaching regexes; **`dist/sw.js` precache manifest contains NO `vendor-three`/`vendor-pdf` entry.**
- [ ] **R4:** confirm the Rolldown runtime chunk (if any) actually starts with `rolldown-runtime-` and lands under `assets/`; if eager (in index.html modulepreload), confirm it's counted against the 160KB initial budget correctly.
- [ ] **R3 (runtime, gating):** serve the built `dist` (or `dev`/preview env with `VITE_CLERK_PUBLISHABLE_KEY`), sign in with **real Clerk init** (not the e2e act-as bypass), confirm **no** `Cannot set properties of undefined (setting 'Activity')` console error; grep the emitted `vendor-react-*.js` to confirm `@clerk` + `react`/`react-dom` + `scheduler` are co-located.
- [ ] Runtime smokes on `dev`: 3D takeoff scene, PDF (PDFium) load, rrweb recording.
- [ ] Sourcemaps (lower urgency): one `SENTRY_SOURCEMAPS=1 npm run build -w @sitelayer/web`, confirm `.map` emitted, dry-run `@sentry/cli sourcemaps inject apps/web/dist`.
- [ ] Spot-check `apps/{api,worker}/dist` + `packages/*/dist` are byte-identical before/after (they must be — nothing there reads vite).
- [ ] Deploy to `dev` → soak → PR to main → green `Quality` for the SHA → prod deploy → `GET /api/version` build_sha matches.

---

## 6. What the pasted doc overstates (honest hype filter)

- **"10-30x faster builds"** — vendor/marketing benchmark, irrelevant to this workload. `apps/web` is a single moderately-sized SPA whose build is not a measured bottleneck. Speedup will be real but nowhere near 10-30x here.
- **"Oxc minify ~20-27% larger than Terser"** — raw-size, early-beta. Budgets are **gzip** (compresses most of the delta away). Rolldown 1.0 is now stable, so the "early-beta" premise may already be outdated. Still must measure given the ~3.3% headroom, but the quoted number overstates the risk against a gzip budget.
- **"minSize ignored / over-aggregates into one giant chunk"** — stated as a general doc risk with **no repo evidence**. `manualChunks` here only assigns `/node_modules/` modules and returns `undefined` for app code, so app-chunk shape is already splitter-controlled today under Rollup. Plausible, a thing to **diff**, not a documented fact about Sitelayer.
- **"Oxc cannot lower native decorators → need a babel/swc plugin"** — **entirely inert.** Zero decorators, no tsconfig flag. Adding the plugin would be a mistake.
- **"require() preserved / CJS interop matrix changes / `legacy.inconsistentCjsInterop`"** — **inert.** Pure ESM, no `require()`, no `import React from 'react'`, externalizes nothing.
- **"Unsupported Rollup hooks (resolveImportMeta/resolveFileUrl/renderDynamicImport/shouldTransformCachedModule, output.format system/amd)"** — **zero** hits in repo.
- **"Catastrophic Yarn-PnP-on-Windows regression"** — **N/A.** Confirmed npm workspaces (`package-lock.json`, no resolutions).
- **Timeline framed as speculative** — _the opposite of overhype._ Per current sources, Vite 8 stable shipped ~March 2026 (Rolldown default) and Rolldown 1.0 ~May 2026, both **before** today. Availability is real; only the exact `rolldown-vite` pin matching `vite@7.3.2` needs confirming.

### One correction to the operator's own priors (and CLAUDE.md / MEMORY.md)

The repeated **"prod droplet deploy SILENTLY SKIPS if Quality fails"** lore is **STALE for the prod path.** `scripts/deploy-production-local.sh:63-107` now has a fail-closed green-`Quality` CI gate: if the Quality workflow for the SHA is not completed+success — or `gh` is missing/unauthenticated — the script prints an error and **`exit 1`** (only `FORCE_DEPLOY_UNCHECKED=1` skips it, with a loud warning). So a Rolldown-induced red budget/build **HARD-BLOCKS** the prod deploy with a clear message, not a silent skip. The risk is **louder and safer** than previously assumed. (The "silent skip" likely described the older GitHub-Actions deploy path, removed per commit `70b9584b`.)

---

## 7. Open questions / verify before starting

1. **Exact `rolldown-vite` pin for `vite@7.3.2`.** Run `npm view rolldown-vite versions` and check the changelog — the technical-preview package tracks specific Vite minors; pick the one whose declared vite-compat matches 7.3.x. (Releases are real/available; only the pin needs confirming.)
2. **Does Rolldown emit a `rolldown-runtime-*` chunk under this exact config, to `assets/`, and is it eager or lazy?** The budget script pre-exempts that prefix (`:58`) but it's unverified. If a runtime chunk lands **eager** (index.html modulepreload) it counts against the 160KB initial budget, not the exemption.
3. **Does Rolldown preserve single-file `vendor-three`/`vendor-pdf` under `assets/`** so the globIgnores + two runtimeCaching regexes still match — or does finer chunking rename/split them? (R1 — the highest-value diff.)
4. **Does Rolldown's chunking keep `@clerk` + `react`/`react-dom` + `scheduler` in one `vendor-react` chunk**, and does a real Clerk init succeed without the `Activity` crash under Rolldown's isolated-output-thread ordering? (R3 — runtime-only.)
5. **Does Oxc minify push the desktop-workspace lazy chunk past 112KB gzip?** No dist exists in the worktree — the measurement spike is mandatory before merge.
6. **Function-form `manualChunks` under the rolldown-vite preview** — does it honor `id => name` identically to Rollup (the repo uses the function form, the higher-risk variant for the drop-in)?
7. **(Path B only)** the exact `advancedChunks` config that reproduces the current 8-way vendor split with identical names + specific-first ordering, since Vite 8 deprecates `output.manualChunks`.
8. **(Path B only)** Lightning CSS vs esbuild for CSS minify, and whether to pin `build.cssTarget` to the autoprefixer browserslist.

---

_Prepared from a 6-dimension analysis (surface-inventory, plugin-compat, codesplit-budget, css-wasm-assets, syntax-cjs-decorators, migration-rollout) plus an adversarial reconciliation, with repo facts re-verified against `apps/web/vite.config.ts`, `scripts/check-web-bundle-budget.mjs`, `scripts/deploy-production-local.sh`, and `package.json`/`package-lock.json` on 2026-06-01._
