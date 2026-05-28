# V2 Mobile Port Plan — Brutalist Reskin

**Status:** plan · **Date:** 2026-05-28 · **Scope:** view-layer only

## 0. Strategy (foundation-first)

Steve's v2 is a **brutalist** restyle of the same product: warm sand + near-black
ink, a single hi-vis yellow accent (`#FFD400`), **square corners everywhere**,
hard **2px ink borders**, **offset hard drop-shadows** (no blur, no alpha),
**JetBrains Mono** uppercase micro-labels, **Inter Tight** display headings, and
big-number KPI blocks. The worker surfaces flip to a genuinely inverted dark
theme (ink background, yellow as the only light source).

**The XState machines, temporal-style backend workflows, TanStack Query hooks,
and the event system are NOT touched.** This is a view-layer reskin + per-screen
layout pass + a handful of net-new flows. The leverage comes from the fact that
the design system is centralized:

- `apps/web/src/styles/tokens.css` — `--m-*` CSS custom properties (+ `.m-dark`).
- `apps/web/src/styles/m.css` — `.m-*` classes that all screens consume.
- `apps/web/src/components/m/*` — primitive components that emit a **stable class
  contract** (e.g. `MButton` always renders `button.m-btn[data-variant]`).

Because screens import primitives and primitives emit stable classes, **rewriting
token VALUES (keeping NAMES) cascades the new palette/fonts/radii everywhere with
zero screen edits.** Then we restyle the `.m-*` classes to brutalist shapes
(square, 2px borders, mono labels), repoint `.m-dark` to the v2 worker theme, and
only then do per-screen layout passes and net-new flows.

Order of operations:

1. **Foundation** — rewrite `tokens.css` values, mirror the 3 font stacks in
   `m.css :root` and `tailwind.config.cjs`, self-host the 3 webfonts.
2. **Class restyle** — brutalist pass over `m.css` (radii→0, 1px→2px ink borders,
   soft tints→full-fill state colors, sans micro-labels→mono uppercase, add the
   offset-shadow + big-number + full-yellow-active-tab treatments). Patch the two
   inline-styled primitives (`tap-card.tsx`, `ai.tsx`).
3. **Prove a vertical slice** — one light owner screen (admin-home) + one dark
   worker screen (worker-today) to validate the cascade end-to-end before fanning
   out.
4. **Per-workflow layout passes** — restructure screens that need the
   big-number / big-button / full-fill-state v2 layouts.
5. **Net-new flows** — change orders, guardrail/attention + recovery, lost-reason,
   approvals, broadcast, clients, settings expansion, role switcher, state screens.

## 1. Design-token mapping table

Keep every `--m-*` NAME; repoint VALUE to v2.

| `--m-*` token | current value | v2 value | v2 source |
| --- | --- | --- | --- |
| `--m-sand` | `#f5f1ec` | `#EDE7DA` | v2-sand (app bg) |
| `--m-sand-2` | `#ebe6df` | `#E0D8C5` | v2-sand-2 (dark border / dark offset shadow) |
| `--m-bg` | `#ffffff` | `#EDE7DA` | sand is the app bg now (no white) |
| `--m-card` | `#ffffff` | `#EDE7DA` | cards are sand w/ 2px ink border |
| `--m-card-soft` | `#f7f4ef` | `#F4EFE3` | v2-sand-soft (section bar / inset) |
| `--m-line` | `#e8e3db` | `#0F0E0C` | structural lines = ink |
| `--m-line-2` | `#d8d2c7` | `#C8C0AC` | v2-line-soft (in-card 1px dividers) |
| `--m-ink` | `#1c1816` | `#0F0E0C` | v2-ink |
| `--m-ink-2` | `#5b544c` | `#2E2A23` | v2-ink-2 |
| `--m-ink-3` | `#6d6358` (m.css) | `#5F584C` | v2-ink-3 (keep contrast intent) |
| `--m-ink-4` | `#aea69a` | `#8B8474` | v2-ink-4 |
| `--m-accent` | `#d9904a` | `#FFD400` | v2-accent (the single yellow) |
| `--m-accent-ink` | `#b46e2c` | `#1F1900` | text/icon ON yellow |
| `--m-accent-soft` | `rgba(217,144,74,.1)` | `#FFD400` | NO soft tints — full yellow |
| `--m-green` | `#2c8a55` | `#1A8A4C` | v2-good |
| `--m-red` | `#c0463d` | `#C7331E` | v2-bad |
| `--m-amber` | `#c98a2e` | `#C58A14` | v2-warn |
| `--m-blue` | `#2f6fb5` | `#2E2A23` | no blue in v2 → warm ink-2 |
| `--m-r-sm/r/r-lg/r-xl` | `8/12/18/24px` | `0` | square everywhere |
| `--m-shadow-1/2/card` | soft blurred | `6px 6px 0 var(--m-ink)` | hard offset, no blur/alpha |
| `--m-font` | system stack | `Inter, system-ui, sans-serif` | v2-font (body/button) |
| `--m-font-display` | system stack | `'Inter Tight', Inter, sans-serif` | v2-font-tight (headings/big-num) |
| `--m-num` | SF Mono stack | `'JetBrains Mono', ui-monospace, monospace` | v2-font-mono (mono micro-labels) |

**New tokens added** (no existing screen reads them, but the brutalist classes do):
`--m-shadow-offset`, `--m-shadow-offset-lg`, `--m-stop-hatch`.

**`.m-dark` rewrite (worker theme):** `--m-bg/card/card-soft → #0F0E0C / #0F0E0C /
#2E2A23`; borders flip to `--m-sand-2 #E0D8C5`; soft dividers `--m-ink-2 #2E2A23`;
text `--m-ink #EDE7DA`, quiet `--m-ink-4 #8B8474`; accent stays yellow; offset
shadow uses `--m-sand-2`.

## 2. Class restyle directives (m.css)

The full per-class directive set is in the structured plan (`mCssDirectives`).
Highlights:

- **`.m` shell** → `font: var(--m-font)`; `.num`/big-numbers use Inter Tight.
- **`.m-topbar`** → 2px ink bottom border, 18px/20px pad, title Inter Tight 700 22px,
  add mono eyebrow slot.
- **`.m-topbar-back/-action`** → 48px **square**, 2px ink border, sand bg (action =
  yellow accent square).
- **`.m-btn`** → 56px, radius 0, 2px ink border, Inter 700 18px UPPERCASE; primary =
  yellow; ghost = transparent ink/sand border; add `.m-btn-danger` (red/#fff).
- **`.m-card`** → radius 0, 2px ink border, no shadow; `.accent` = full yellow.
- **`.m-kpi` / `.m-kpi-val`** → big-number: Inter Tight 800, 38–96px, lh .85,
  -.035em, tabular-nums; KPI grid cells split by 2px ink dividers.
- **`.m-pill`** → square, 1.5px ink border, mono 11px uppercase, **square** dot;
  `.live/.good/.bad` full-fill.
- **`.m-bottombar` / `-tab`** → 64px, 2px top border, mono 10px uppercase, 1px-soft
  cell dividers, active = **full yellow cell**.
- **`.m-list-row`** → 64px min, 44px **square** lead slot, 1px-soft bottom divider.
- **`.m-section-h`** → wrap content in a `.m-section-bar` (2px top+bottom ink rule,
  sand-soft fill, mono eyebrow + mono count).
- **`.m-sheet`** → square top corners, 2px ink top rule, drop the grabber pill,
  add offset shadow.
- **`.m-progress`** → square; track soft/ink; fill yellow (or red at-risk).
- **`.m-banner`** → becomes the v2 attention card option: 3px ink border, full
  yellow, inverted ink pill + ink CTA (via `data-tone='attention'`).
- **`.m-qa`** → `.v2-tile`: 2px ink square, 110px min, left-aligned, color variants.
- **Eyebrows/micro-labels** everywhere → JetBrains Mono, uppercase, +letter-spacing.
- **Inline-styled primitives** (`tap-card.tsx`, `ai.tsx`) must be edited directly —
  they don't read the class contract.

## 3. Font plan

v2 uses **Inter Tight** (display), **Inter** (body/button), **JetBrains Mono**
(micro-labels). The current app is system-stack-only with **no webfonts** and a
handoff note (now superseded by v2) forbidding Inter. v2 explicitly requires these
faces, so we self-host.

- **Self-host woff2** (preferred — field workers are offline-first; a Google CDN
  import would FOUT/fail off-grid). Drop `Inter`, `InterTight`, `JetBrainsMono`
  `.woff2` (latin subset, the weights used: Inter 400/500/700/800; Inter Tight
  600/700/800/900; JetBrains Mono 500/700/800) into `apps/web/src/assets/fonts/`.
- Add an `@font-face` block at the top of `m.css` (or a new
  `apps/web/src/styles/fonts.css` imported before `m.css`) with
  `font-display: swap`.
- Repoint `--m-font / --m-font-display / --m-num` in **both** `tokens.css` and
  `m.css :root` (they must stay in sync), and mirror in `tailwind.config.cjs`
  `fontFamily.sans/display/mono`.
- Update the cold-start splash inline `<style>` in `apps/web/index.html` so the
  pre-React paint uses the same families (avoid FOUT before mount).

## 4. Per-screen port table

Port types: **TOKEN_ONLY** (no edit — inherits the cascade), **LAYOUT_PASS**
(restructure to big-number/big-button v2 layout), **NEW_FLOW** (net-new, may need
backend), **DARK** (worker dark theme). Full table is in the structured plan
(`screenMap`); summary:

- **TOKEN_ONLY** (just verify after cascade): customer-dedup-picker, estimate-tab,
  crew-tab, materials-tab, overview-tab, log-tab, foreman-map, rentals-portal,
  takeoff-import-sheet, foreman-time-entry.
- **LAYOUT_PASS** (big-number / full-fill / section-bar restructure): admin-home,
  projects-list, project-detail (+ budget/files tabs), estimates-sent, project-new,
  takeoff-list, takeoff-mobile, estimate-review, estimate-push, schedule,
  time-review, invoice-quick, work-requests, work-request-detail, rentals (+
  dispatch/utilization), scaffold-inspection, foreman-today, foreman-brief,
  foreman-crew, foreman-field, foreman-blocker-detail, foreman-log.
- **DARK** (worker dark theme + layout): worker-today, worker-clockin, worker-scope,
  worker-issue, worker-hours, worker-log, rentals-scan.

## 5. Net-new flows + the 3 new entities

The v2 catalog introduces flows with no current screen. Flag which need the 3 new
backend entities (**ChangeOrder**, **Guardrail**, **LostReason**):

- **Change orders** (`V2ChangeOrderNew/Detail`) → needs **ChangeOrder** entity +
  workflow (draft→sent→accepted/rejected, value delta, schedule impact).
- **At-risk / attention dashboard + recovery plan + snooze**
  (`V2OwnerDashboardAttention`, `V2RecoveryPlan`, `V2SnoozeSheet`) → needs
  **Guardrail** entity (threshold crossings: labor hot, margin at risk).
- **Project lost capture** (`V2ProjectLost`) → needs **LostReason** entity.
- **No new entity** (reuse existing data/workflows): owner approvals queue, money/
  cash-flow, team roster, clients list/profile, settings expansion (pricing book,
  burden, hours, integrations, roles matrix, notifications, profile, help, invite),
  broadcast, chat list/thread, notifications inboxes, activity log, role switcher,
  onboarding/invite-accept flows, rental return/service, post-mortem, lifecycle
  state cards, AI takeoff (count/auto) review surfaces, all the state screens
  (splash/loading/offline/error/empty/perm/stale/**safety stop-work**).

Full list in the structured plan (`newScreens`).

## 6. Ordered execution phases

1. **Foundation:** rewrite `tokens.css`; mirror fonts in `m.css :root` +
   `tailwind.config.cjs`; self-host woff2 + `@font-face`; update `index.html` splash.
2. **Class restyle:** brutalist pass over all `.m-*` classes; patch `tap-card.tsx`
   and `ai.tsx` inline styles; rewrite `.m-dark`.
3. **Proving slice:** admin-home (light) + worker-today (dark) end-to-end; visual
   regression baseline.
4. **Owner workflow:** admin-home, projects-list, project-detail + tabs, money,
   team, more.
5. **Estimator workflow:** estimate-review, estimate-push, takeoff-list/mobile,
   summary/price-and-send, AI takeoff review.
6. **Foreman workflow:** foreman-today/brief/crew/field/blocker/log + time approve.
7. **Worker workflow (dark):** worker-today/clockin/scope/issue/hours/log,
   clock-out, offline-dark.
8. **Rentals + schedule/time:** rentals home/dispatch/util/scan/return/service,
   schedule week, time approvals.
9. **Net-new flows:** change orders, guardrail/attention + recovery + snooze, lost
   reason, approvals, broadcast, clients, chat, notifications, activity, settings
   expansion, role switcher, onboarding/invite, lifecycle cards, state screens
   (incl. safety stop-work).

## 7. Risks

- `tokens.css` and `m.css` carry **near-duplicate `:root` blocks** that must stay
  in sync; `tailwind.config.cjs` is a **third copy** of the fonts that can drift.
- `m.css`'s contrast-tuned `--m-ink-3` differs from `tokens.css`; preserve the
  intent against the new sand surfaces (re-check WCAG on `#EDE7DA`).
- Two primitives (`tap-card.tsx`, `ai.tsx`) hardcode look via **inline styles** and
  won't inherit the class restyle — edit them by hand.
- `--m-accent-soft*` is consumed as a tinted background in several classes; the v2
  rule is full-fill yellow — every soft-tint usage (list-row tones, pills, avatars,
  qa) must be re-derived, not just recolored.
- The cascade can't move layout: big-number KPIs, full-yellow active tabs, the
  attention card, and the stop-work hazard screen are **LAYOUT_PASS / NEW_FLOW**,
  not token-only.
- Net-new flows are gated on the 3 backend entities (ChangeOrder / Guardrail /
  LostReason); UI can be built against stubs but won't be live until those land.
- New reachable routes MUST be added in `mobile-shell.tsx` **before** the
  `projects/:projectId/*`, `rentals/*`, and final `*` catchalls.
- `prefers-reduced-motion` + `:focus-visible` rules in `m.css` must survive the
  restyle (a11y baseline for gloved/external-keyboard field use).
