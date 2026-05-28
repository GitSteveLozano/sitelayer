# V2 Expanded Plan — Desktop v2 + remaining mobile net-new screens

_Authored 2026-05-28. Companion to `V2_MOBILE_PORT_PLAN.md` (the mobile port,
now ✅ done) and the 3 v2 entities (✅ schema + workflow + API + hooks shipped)._

## 0. Where we are

Shipped on branch `agent/claude/v2-mobile-port` (off `dev`):

- v2 brutalist **design foundation** (tokens, `m.css`, self-hosted fonts, dark worker theme) — cascades everywhere.
- **All 34 existing mobile screens** ported to v2.
- **3 net-new entities full-stack**: `change_orders` / `guardrails` / `project_lost_reasons` (migrations 097–099 + domain types + ChangeOrder reducer + API routes + web hooks).
- **Entity flows live**: Change-Order screen + Guardrail attention card on the owner dashboard.

Two bodies of work remain: **(A)** the rest of the mobile net-new screens, and **(B)** the brand-new **Desktop v2** surface (`Downloads/deskiop-steve.html` → "Sitelayer · Desktop v2 · 1440px").

---

## 1. The architecture decision (read first)

`deskiop-steve.html` is **a deliberately distinct desktop experience**, not "the mobile screens, wider":

- Dark **persistent left sidebar** (sectioned: WORK / MONEY+PEOPLE / ASSETS, nav badges, `WEARING ▾` role pill in the footer).
- **Top bar** with breadcrumb + global search + `NEW PROJECT` + notifications + avatar.
- **Dense data tables** (Projects, Files, Money, Approvals, Team, Clients, Item Library).
- **Split-pane project detail** with a budget aside + 6 tabs.
- **Full-bleed takeoff canvas** with floating tool/item palettes.
- Owner + Estimator only; a **light Foreman desk** view; **workers stay phone-only**.

This **supersedes the current rule** in `components/shell/AppShell.tsx` / `DesktopSideRail.tsx` ("desktop is the same product, wider, with a side rail. Don't invent a different IA"). Steve's v2 _does_ invent a richer IA. **Recommendation: adopt it** — build a dedicated desktop workspace that **shares the data layer** (XState machines, TanStack hooks, the entity APIs) and the **v2 tokens**, but has its **own shell + layout primitives + screen components**. Same brutalist language (sand · ink · hi-vis yellow, Inter Tight, hard edges), different composition.

**Shell selection:** in `routes/workspace.tsx`, mount `DesktopWorkspace` (new) for **owner/estimator at viewport ≥ 1024px**, else `MobileShell`. Workers and foreman-on-phone always get `MobileShell`; foreman ≥1024px gets the light desktop. Retire the "wider mobile" `DesktopSideRail`/`AppShell` desktop path once `DesktopWorkspace` covers a role's screens (keep it as the fallback until then so nothing regresses).

**Nothing in the data layer changes.** Desktop screens call the exact same hooks the mobile screens use (`useProjects`, `useTimeReviewRun`, `useProjectChangeOrders`, `useActiveGuardrails`, …). This is purely an additional view surface.

---

## 2. Desktop v2 workstream (B)

### Phase D0 — Desktop shell (foundation)

- `screens/desktop/desktop-shell.tsx` (`DesktopWorkspace`): grid of dark sidebar + topbar + scrollable content `<Outlet>`-style region with its own inline `<Routes>` (mirror the mobile-shell route discipline).
- `components/d/sidebar.tsx` — dark (`--m-ink`) rail, sectioned nav, yellow active item, badge counts (e.g. Approvals), `WEARING ▾` role pill footer (reuses `computeActiveContext` / role-mode switching already in `active-context.ts`).
- `components/d/topbar.tsx` — breadcrumb (mono), global search field, `NEW PROJECT` primary, notifications bell, avatar.
- Responsive gate + role gate in `routes/workspace.tsx`.
- **Verify:** renders for owner/estimator ≥1024px; mobile unaffected below; tsc + a routes-load smoke test.

### Phase D1 — Desktop primitives (`components/d/*`)

The dense building blocks (square, 2px ink borders, mono headers, big-number cells — all on the existing tokens):

- `DataTable` (sortable dense table: mono uppercase header row, hard column rules, row hover, status-pill + chip cells, right-aligned numeric `--m-num`). **Highest-leverage** — Projects/Files/Money/Approvals/Team/Clients/Item-Library all reuse it.
- `KpiStrip` (4-up big-number cards, one optionally full-yellow — desktop variant of `MKpiRow`).
- `SplitDetail` (main + right aside, e.g. project detail + budget aside).
- `DTabBar` (mono uppercase tabs, yellow active).
- `SearchPalette` (topbar search → command/jump).
- `FloatingPalette` (absolutely-positioned tool/item palette overlay for the canvas).
- **Verify:** a `/d-preview` showcase (desktop analog of `/m-preview`) rendering each primitive.

### Phase D2 — Owner desktop screens

Dashboard (hero + AT-RISK card + KpiStrip + "today on site" table) · Projects (dense table) · Project Detail (SplitDetail + 6 tabs: Overview/Budget/Crew/Logs/Files/Activity) · Money (cash-flow + table) · Approvals queue · Team · Schedule (week grid) · Rentals · Settings (pricing book) · Clients list · New Project kickoff. _All reuse existing hooks; guardrail/at-risk/recovery uses the new guardrail API._

### Phase D3 — Estimator desktop screens

Takeoff Projects · **Takeoff Canvas** (full-bleed + floating tool/item palettes — the marquee desktop screen; reuses takeoff geometry/measurement APIs) · Quantities + Price & Send · AI Queue (review drafts; over the capture/blueprint-vision pipeline) · Scale Verify · Client Profile · Item Library (dense table).

### Phase D4 — Foreman light-desktop

Today (multi-site) · Crew (cross-site) · Schedule (2-week lookahead) · Time (first-line approval) · Brief Crew (author + live preview). _Thin desk layer over the same foreman hooks; foreman on phone keeps the mobile screens._

---

## 3. Remaining mobile net-new screens (A)

Grouped; ⚠ = needs backend beyond the 3 shipped entities.

- **Guardrail flow finish:** project AT-RISK view, Recovery Plan, Snooze sheet (guardrail API ✅).
- **LostReason:** PROJECT · LOST capture screen (API ✅).
- **Lifecycle/project:** lifecycle state cards, Post-mortem (on PAID), Invoice-sent confirmation.
- **Owner:** Money (cash flow), Team, Approvals queue, Broadcast.
- **Clients:** list + profile.
- **Rentals:** return + condition, service log, asset detail.
- **Schedule/time:** new/edit assignment sheets, multi-anomaly time row.
- **Settings expansion (~13):** pricing book + item edit, loaded-labor burden + line edit, hours/holidays, integrations, roles + custom-role editor, notifications, profile, help, invite.
- **Auth/onboarding:** sign-in + magic link, owner onboarding 1–4, role-specific invite accepts (worker dark), `WEARING ▾` role switcher sheet.
- **System states (8):** splash/loading/offline(+worker dark)/error/empty/perm-denied/stale-build/**stop-work safety interrupt** (net-new full-screen hazard).
- **Cross-role comms ⚠:** project chat threads, role-tagged notification inboxes, activity log, owner broadcast (chat/broadcast need a light **messaging** backend; notifications inbox + activity log read existing ledgers).

---

## 4. Sequencing & estimate

1. **Finish mobile entity flow** (A: LostReason + at-risk/recovery/snooze) — small, unblocks nothing else. _~½ day._
2. **Desktop D0+D1** (shell + primitives) — the foundation everything desktop rides on. _Biggest single unlock; ~1–2 days._
3. **Desktop D2 (Owner)** then **D3 (Estimator)** then **D4 (Foreman)** — batched like the mobile port (one agent per screen, tsc+test+commit per group). _~3–5 days._
4. **Remaining mobile screens (A)** in parallel where independent; defer ⚠ comms until the messaging backend decision.

Pattern stays: small parallel agent batches (≤4), per-package tsc as the authoritative gate (ignore the diagnostics-tool `@/lib/api` false positives), commit per group on the `dev`-lane branch.

## 5. Risks / open decisions

- **Confirm the IA shift** (§1): adopt a distinct desktop surface vs. keep "mobile wider." (Recommend adopt.)
- **Breakpoint**: 1024 vs 1280 for the desktop switch; behavior for tablet (768–1024).
- **Foreman desktop scope**: full parity vs the 5 light screens Steve drew (recommend the 5).
- **Comms backend**: build messaging for chat/broadcast now, or ship notification-inbox + activity-log (read-only over existing ledgers) first and defer chat.
- **Canvas reuse**: desktop takeoff canvas should reuse the existing three.js/geometry stack (`takeoff-3d-scene`, `geometry-3d`, capture-schema) rather than a parallel renderer.
- Migrations 097–099 stay on the `dev` lane until a deliberate PR to `main`.
