# Responsive consolidation analysis — collapse desktop/mobile into one tree?

**Scope:** `apps/web/`. Should sitelayer's web app become one responsive tree (one shell, one route table, responsive screens, one primitive set) instead of the current two parallel desktop/mobile screen trees selected by a JS viewport gate?

All counts below are from `find`/`grep` over `apps/web/src/` on the current checkout, not estimates.

---

## 1. Verdict

**Collapse the primitives and the easy screen pairs — yes, do it; it's mostly low-risk and the token layer is already unified. Do NOT mechanically merge the two screen trees into identical responsive components across the board — keep the takeoff canvas capability-split and keep the desktop command-center IA as a deliberate wide layout, not a stretched phone.** The case for consolidation is the maintenance tax that Phase 0/1/2 kept paying: a feature is implemented twice (`screens/desktop/est-*` ↔ `screens/mobile/takeoff-*`, `desktop/fm-*` ↔ `mobile/foreman-*`, `desktop/owner-*` ↔ `mobile/*`), and because the two trees were built as separate passes (`ae84bd33 feat(desktop): port steve-desktop-3…`), **0 of the last ~60 screen commits touched both trees together** — so the cost shows up as silent drift / missed-mirror, not as visibly-coupled dual edits. The AI-takeoff badge is implemented **four times** (`desktop/est-ai-takeoff`, `desktop/est-ai-count`, `mobile/takeoff-ai-takeoff`, `mobile/takeoff-ai-count`); any pitch/confidence change touches all four. That is the footgun worth removing. But the duplication is concentrated in _layout/JSX_, not logic — the data layer (TanStack hooks under `lib/api/`), the `@sitelayer/domain` geometry, and the CSS token layer are **already shared** — which is exactly why a _targeted_ collapse is cheap and a _total_ collapse is the wrong target.

---

## 2. The split today (the numbers)

**Two parallel screen trees behind two URL roots, not one responsive tree:**

- `App.tsx:391` — `/desktop/*` → `screens/desktop/desktop-workspace.tsx` (851 lines, ~38 desktop-only screen imports, inline 40-route table at `:788-833`).
- `App.tsx:397` — `/*` → `routes/workspace.tsx` → `screens/mobile-shell.tsx` (561 lines, inline 50-route table at `:304-474`).
- `App.tsx:394` — `/m/*` → `routes/m.tsx` → same `MobileShell`, legacy alias.

**Tree totals (non-test):**

| Tree                             | Files | LOC    |
| -------------------------------- | ----- | ------ |
| `src/screens/desktop/`           | 44    | 24,337 |
| `src/screens/mobile/`            | 84    | 30,585 |
| `src/screens/projects/` (shared) | 32    | 10,030 |

**Duplicate feature pairs: 22** (estimator 7, foreman 6, owner 9) — same feature, one file per platform:

- Estimator/takeoff (7): `est-canvas` (2987) ↔ `takeoff-mobile` (1852); `est-ai-takeoff` (592) ↔ `takeoff-ai-takeoff` (416); `est-ai-count` (692) ↔ `takeoff-ai-count` (536); `est-plan-ingest` (561) ↔ `takeoff-ingest` (378); `est-scale-verify` (260) ↔ `takeoff-scale-manual` (352); `est-takeoff-projects` (178) ↔ `takeoff-list` (322); `est-ai-queue` (213) ↔ `takeoff-ai-chooser` (194).
- Foreman (6): `fm-today`↔`foreman-today`, `fm-brief`↔`foreman-brief`, `fm-crew`↔`foreman-crew`, `fm-log`↔`foreman-log`, `fm-blocker-detail`↔`foreman-blocker-detail`, `fm-time`↔`foreman-time-entry`.
- Owner (9): `owner-approvals`, `owner-money`, `owner-clients`↔`clients`, `owner-broadcast`↔`broadcast`, `owner-messages`↔`chat`, `owner-activity`↔`activity-log`, `owner-schedule`↔`schedule`, `owner-new-project`↔`project-new`, `owner-dashboard`↔`admin-home`.

**LOC duplicated: ~23,004** (desktop side 11,431 + mobile side 11,573) implementing 22 features twice — **~46% of the 54,922 combined non-test LOC** in the two trees (47% of the desktop tree, 38% of the mobile tree).

**Parallel primitive pairs: effectively ONE.** This is the surprise. `components/m/` is a 17-file (~60-export) mobile-first leaf kit (`MButton`, `MKpi`, `MBanner`, `MListRow`, `MPill`, `MBottomTabs`…); `components/d/` is **a single `index.tsx` (596 lines, ~25 exports)** of desktop _chrome_ (`DSidebar`, `DShell`, `DataTable`, `DDrawer`, `DModal`, `DCommandPalette`, `DNotifPanel`). They are **complementary, not duplicative** — only `MKpi`↔`DKpi` is a genuine duplicate. Proof: **43 of 44 desktop screens import `components/m`**, and `MBanner`/`DailyLogSubmittedBanner` are consumed by **6 desktop screens** with no `d/` twin (there is zero banner rule in `d.css`). Desktop already reuses mobile primitives inside the `DShell` frame.

**How platform is selected — one JS hook, not a CSS breakpoint:**

- `routes/workspace.tsx:212-213` — `useIsDesktop()` = `matchMedia('(min-width: 1024px)')`, the **only** viewport switch in the routing path (grep confirms `useIsDesktop`/`useIsMobile` defined+called in exactly one file).
- `workspace.tsx:127-130` — fires once, only at `location.pathname === '/'`, only for owner/foreman: `<Navigate to="/desktop" replace />`. Workers are phone-only by design (`workspace.tsx:126`).
- By default exactly **one** shell mounts (`MobileShell`); `DesktopWorkspace` mounts only after the URL becomes `/desktop/*`. Deep mobile routes are never redirected even on a wide viewport.

**Tokens are already one set.** `styles/tokens.css:16-18` mandates `--m-*` as the canonical prefix ("Don't add `--d-*` / `--desktop` variants — desktop is the same product, wider"); grep confirms **zero real `--d-*` tokens** (the one match is that prose warning). `d.css` (804 lines) consumes only `var(--m-*)`. The app barely uses responsive utilities: **14** total `sm:/md:/lg:/xl:` occurrences and 4 `@media` rules across `src/` — responsiveness today is "JS picks a whole screen," not "one tree reflows."

---

## 3. What "responsive" would mean structurally

One responsive tree means replacing the JS viewport fork with CSS/container-query reflow inside a single tree:

1. **One Routes table.** Merge `mobile-shell.tsx:304-474` (50 routes) and `desktop-workspace.tsx:788-833` (40 routes) into one route per logical screen; drop the `/desktop` prefix, the `/m` alias, and the `workspace.tsx:127-130` root redirect.
2. **One responsive shell.** Fold `MShell`/`MBottomTabs` (phone bottom-tabs IA) and `DShell`/`DSidebar`/`DTopbar` (sidebar + ⌘K command center) into one chrome that swaps bottom-tabs ↔ sidebar at the `1024px` breakpoint via CSS, instead of mounting a different component.
3. **Responsive screens.** Reconcile the 22 paired components into single screens that reflow. The data layer (`lib/api/*` hooks) and `@sitelayer/domain` geometry already span both, so that layer does **not** change — only JSX/layout and primitive imports merge.
4. **One primitive set.** Merge the lone `MKpi`/`DKpi` duplicate; drop `M`/`D` prefixes into a neutral `components/ui/`; keep the desktop-chrome primitives (`DSidebar`, `DataTable`, `DCommandPalette`, `DNotifPanel`) as a clearly-scoped desktop subset since a phone has no 232px sidebar (`d.css:8` `grid-template-columns: 232px 1fr`); promote `DEmptyState`/`DErrorState`/`DLoadingState` to shared so mobile stops hand-rolling them.
5. **Express persona as layout, not route fork.** "Worker = phone layout only" becomes a feature decision inside one shell rather than a separate route system.

The token layer (step toward this is already done) is what makes 2–4 cheap: a palette/font/radius change in `tokens.css` already propagates to both surfaces for free.

---

## 4. Easy vs hard

**EASY — pure CSS/Tailwind/chrome (the bulk).** The non-canvas pairs are `onClick`-driven list/form/review screens with identical hooks and zero gesture code. Measured on the AI pairs: `est-ai-count` 8 `onClick` / **0** pointer-capture/CTM, `takeoff-ai-count` 9 `onClick` / **0**; both import the exact same four hooks from `lib/api/takeoff-drafts` (`useCaptureTakeoffDraft`, `usePromoteCapturedQuantities`, `useTakeoffDraftResult`, `useTakeoffDrafts`) and run the same capture→poll→keep/reject→promote sequence. Their file-header docstrings are near-verbatim copies. The delta is `className` strings. The foreman and owner pairs are the same shape (lists/forms/detail panes). **These collapse trivially** — the difference is layout, nothing structural. This is ~20 of the 22 pairs.

**MEDIUM — layout differs more, still mechanical.** `est-plan-ingest`↔`takeoff-ingest`, `est-scale-verify`↔`takeoff-scale-manual`, the owner schedule/new-project pairs: more involved layout but still shared hooks and no input-model fork. Also the primitive merge of `MKpi`/`DKpi` (`m/kpi.tsx:16-31` vs `d/index.tsx:111-126` emit near-identical JSX; CSS delta is value `38px`→`40px`, a `grid 1fr 1fr` vs `grid-auto-flow: column` swap, and a desktop `data-tone="accent"` variant — all expressible as `text-[38px] lg:text-[40px]` + a container swap).

**HARD — the one genuine exception: the takeoff canvas (`est-canvas` 2987 ↔ `takeoff-mobile` 1852).** And the key finding is that **this is NOT a touch-vs-mouse / `onTouch`-vs-`onMouse` fork.** Both sides already use unified **Pointer Events**, and both compute the identical point-mapping (`getScreenCTM()` → `createSVGPoint` → `matrixTransform(ctm.inverse())` → clamp 0–100; confirmed present in both: `est-canvas.tsx:405` and `takeoff-mobile.tsx:230,235`). The desktop file's own header (`est-canvas.tsx:1-21`) states it is "the desktop **re-layout** of the working mobile takeoff surface… DATA + GEOMETRY are reused verbatim… **Only the CHROME changes.**" What actually diverges is a desktop-only **navigation layer** that mobile _deferred_, not reimplemented:

| Feature                                                             | est-canvas (desktop) | takeoff-mobile                              |
| ------------------------------------------------------------------- | -------------------- | ------------------------------------------- |
| wheel-zoom / pan / space-hold / hand-tool / marquee (combined grep) | 43 hits              | **0**                                       |
| pinch-zoom                                                          | n/a                  | **deferred** (`takeoff-mobile.tsx` comment) |

**Can it be one responsive component? Yes — capability-split, not input-split.** Extract the shared draw core (tap-to-add, vertex-drag, quantity math, save flow, blueprint/page state — already byte-for-byte identical logic) into one hook/component (LOW risk), then make the navigation layer a _capability_ — a `useCanvasViewport`/`enablePan`/`enableMarquee`/`wheelZoom` set of props that desktop turns on and mobile leaves off. When mobile eventually gets pinch-zoom, that is an **additive** `pointers.length === 2` branch in the _same_ pointer handlers, not a second event system. So the canvas becomes one responsive component with an optional desktop navigation layer; it does **not** stay permanently forked. (Note the accidental _triplication_: `screens/projects/takeoff-canvas.tsx` is a third v1-port variant with its own local `polygonArea`/`lineLength` math instead of the domain helpers — strong evidence the split is accidental duplication, not designed divergence.)

**HARD for a different reason — the desktop command-center IA.** Desktop-only screens with no mobile twin (`est-quantities` 765, `est-assemblies` 899, the pricing/assembly editors; `DataTable`/`DSidebar`/`DCommandPalette` chrome) are a deliberately _different information architecture_ (dense tables + persistent sidebar + ⌘K), not a reflow of a phone screen. Likewise mobile-only worker/field flows and the `project-detail/*` tab set. These do not "merge" — in one responsive tree they become breakpoint-gated sections (`hidden lg:block` / container queries), which is a design decision, not a mechanical edit. Forcing them into identical responsive components would fight the intentional "command-center for owners / phone for crew" product split in `workspace.tsx:118-130`.

---

## 5. Recommended approach (phased, low-risk)

**Phase A — unify primitives (first, smallest, highest leverage).** This is ~90% done already. (a) Merge `MKpi`/`DKpi` into one `Kpi` with a `dense` prop. (b) Promote `DEmptyState`/`DErrorState`/`DLoadingState` from `d/` into the shared kit (fills a mobile _gap_, removes a latent dup). (c) Fix the documented triple-copy token hazard — `tokens.css:11-14` warns the `:root` block is near-duplicated in `m.css` and font stacks are a third copy in `tailwind.config.cjs`; make one the source. Leave the desktop-chrome primitives (`DSidebar`, `DataTable`, `DDrawer`, `DModal`, `DCommandPalette`, `DNotifPanel`) as a labeled desktop subset. No screen changes, no route changes — safe.

**Phase B — fold the EASY pairs into responsive screens.** Start with the AI pairs (`est-ai-count`↔`takeoff-ai-count`, `est-ai-takeoff`↔`takeoff-ai-takeoff`) since they're `onClick`-only with identical hooks; kill the **4×** AI-badge duplication first. Then the foreman and owner list/form pairs. Each merged screen renders under one route, reflowing via Tailwind `lg:`. Retire the `/desktop/*` route for each screen as it's merged (incremental, not big-bang).

**Phase C — the canvas, last.** Extract the shared draw core into `useTakeoffCanvas` (logic is already identical), then add the `useCanvasViewport` capability layer (pan/zoom/marquee) gated by a prop. One responsive component, desktop nav on / mobile nav off. Fold `screens/projects/takeoff-canvas.tsx` (the v1 triplicate) into the same core or delete it.

**Phase D — collapse the shells + route tables.** Only after A–C land: merge `MShell`+`DShell` into one responsive chrome (bottom-tabs ↔ sidebar at 1024px), unify the two Routes tables, drop the `workspace.tsx:127-130` redirect and the `/m` alias. Keep the desktop-only command-center screens as breakpoint-gated sections.

**First PR-sized step:** Phase A(a)+(b) — merge `MKpi`/`DKpi` into one `Kpi` and promote the three state primitives to shared. One PR, no routing/screen risk, immediately proves the "one neutral primitive set" direction and removes the only real primitive duplicate.

---

## 6. Cost / payoff

**Effort (rough):**

- Phase A (primitives): ~1–2 days. Mostly already done; one true merge + three promotions + token-source dedup.
- Phase B (easy pairs, ~20 screens): the largest line-count but lowest-risk bucket. Most pairs are `className`-only deltas over identical hooks — call it ~0.5–1.5 days per pair family, parallelizable; ~1.5–2.5 weeks total to retire the ~23k duplicated LOC down toward ~12k.
- Phase C (canvas): ~3–5 days (extract core + capability layer + retire the triplicate). The only place real interaction logic moves.
- Phase D (shells/routes): ~3–5 days; touches `App.tsx`, both shells, both route tables. Highest blast radius — do last, behind verification.

**Payoff:**

- **Halve the screen surface** for the 22 paired features: ~23,004 duplicated LOC → ~one implementation each.
- **One edit per feature.** Today an AI-badge change touches 4 files across 2 trees + 2 primitive sets; a foreman/owner change touches 2. After: one responsive screen.
- **Kill the dup-pair footgun** — the silent-drift failure mode (0/60 commits touched both trees) that Phase 0/1/2 kept paying as missed mirrors.
- **Token system already prevents value-drift**, so the consolidated tree inherits free palette/font propagation rather than introducing a "change the color twice" tax.

---

## 7. Risks / what to verify

- **Offline-first / local-first data.** The merge is layout-only; the `lib/api/*` TanStack hooks and `@sitelayer/domain` geometry are untouched. Verify no merged screen accidentally drops a draft/offline code path that lived in only one twin (the trees drifted independently — a behavior may exist on one side only).
- **The mobile-shell catch-all routing.** `App.tsx:397` `/*` → `MobileShell` claims everything unmatched by the ~35 specialized routes above it; `mobile-shell.tsx:304-474` is the canonical catch-all table per the routing topology. When collapsing route tables (Phase D), preserve catch-all ordering and the `/m` legacy alias's external links until they're confirmed dead — a misordered merge silently 404s deep links.
- **The canvas input model.** Verify the shared core stays on **Pointer Events** (not raw `TouchEvent`/`touches[]`) so it works for mouse and touch; verify desktop's non-passive `wheel` listener with `preventDefault` (the "Steve's scrolling issues" fix in `est-canvas.tsx`) survives extraction, and that the deferred pinch-zoom branch is added additively (`pointers.length === 2`) without regressing the mobile tap-to-add path.
- **Persona gating.** "Workers = phone-only" (`workspace.tsx:126`, `desktop-workspace.tsx:602-616`) must survive as a layout/feature rule once the route fork is gone; verify a worker on a wide viewport never gets the owner command-center.
- **Bundle/budget.** The Quality gate enforces bundle budgets and `prettier --check` (a failing Quality run silently skips the droplet deploy). Watch: (a) a CSS `hidden lg:block` dual-render approach doubles DOM and could move bytes; prefer real reflow / single render per breakpoint. (b) `@embedpdf` must stay in the `vendor-pdf` budget-exempt chunk — don't let canvas refactors pull PDF code into a budgeted chunk. (c) Run `npm run format` before pushing and confirm `/api/version` build_sha advanced after merge.

---

## Key files

- `apps/web/src/App.tsx` — sibling routes: `/desktop/*` (`:391`), `/*`→workspace (`:397`), `/m/*` legacy (`:394`).
- `apps/web/src/routes/workspace.tsx` — the viewport gate: `useIsDesktop` (`:101`, `:212-213`), redirect (`:127-130`), always-renders `MobileShell` (`:156-161`).
- `apps/web/src/screens/mobile-shell.tsx` — canonical shell, inline 50-route table (`:304-474`).
- `apps/web/src/screens/desktop/desktop-workspace.tsx` — desktop shell, 40-route table (`:788-833`), ~38 desktop-only imports (`:68-106`).
- `apps/web/src/screens/desktop/est-canvas.tsx` (header `:1-21`, point-map `:405`) ↔ `apps/web/src/screens/mobile/takeoff-mobile.tsx` (point-map `:230,235`) — the canvas pair; `apps/web/src/screens/projects/takeoff-canvas.tsx` — the v1 triplicate.
- `apps/web/src/screens/desktop/est-ai-count.tsx` ↔ `apps/web/src/screens/mobile/takeoff-ai-count.tsx` — the EASY-pair exemplar (shared hooks, `onClick`-only).
- `apps/web/src/components/m/` (17 files, ~60 exports) ↔ `apps/web/src/components/d/index.tsx` (596 lines, ~25 exports); `apps/web/src/components/m/banner.tsx` + `daily-log-submitted-banner.tsx` (built once, reused on 6 desktop screens).
- `apps/web/src/styles/tokens.css` (`:16-18` no `--d-*`), `m.css` (1228), `d.css` (804, all `var(--m-*)`), `apps/web/tailwind.config.cjs`.
