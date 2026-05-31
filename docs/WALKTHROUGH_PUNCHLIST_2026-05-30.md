# Sitelayer Walkthrough Punch List (2026-05-30 founder review)

Date compiled: 2026-05-31
Branch reviewed: `dev-np`
Source: founder live walkthrough of the dev build (screen-by-screen).

Status legend:
- WIRED            - works as intended
- WIRED-INCONSISTENT - works but desktop/mobile differ or IA is off
- STUBBED          - UI exists, handler is a no-op / placeholder
- MISSING          - no UI and/or no API
- NEEDS-ENV        - code is wired; fails because a prod env var / credential is unset
- DATA-MISMATCH    - write succeeds but a different read query doesn't reflect it
- MISPLACED        - works, wrong place in the IA
- WORKS-AS-DESIGNED - reported as broken but is intentional; may still need UX clarity
- NEEDS-REPRO      - cannot pin down from code alone; needs a live reproduction

Every file path below was verified against the repo on `dev-np`. Where the
founder's on-call diagnosis differs from what the code shows, that is called out.

---

## P0 - Pilot-blocking (a pilot user hits a wall)

### P0.1 Add team members / invite users - MISSING
- Complaint: "I have no way to add people to the crew or to add more users... there's no like add button here... there's just no way to add people right now. There's no way to invite new team members."
- Reality:
  - Mobile crew screen `apps/web/src/screens/mobile/foreman-crew.tsx:75` renders an `MTopBar` with an "Add" (+) action **but passes no handler** - the button is decorative.
  - Desktop team screen `apps/web/src/screens/desktop/owner-team.tsx` is a data table with **no add button**.
  - No invite API exists. `grep invite apps/api/src/routes` returns only `project-assignments.ts`, `project-briefs.ts`, `customer-portal-links.ts` (unrelated). There is no `/api/team-invites` / `/api/invitations`.
  - The only membership-add path is `POST /api/companies/:id/memberships` (takes a `clerk_user_id` + preset role) - usable today only inside the onboarding wizard, not post-onboarding.
- Verdict: MISSING (both UI and a self-serve invite API).
- Fix sketch: build a post-onboarding "Invite teammate" flow (email -> Clerk invitation -> membership row) + an "Add" handler on both crew and team screens. This blocks any multi-person pilot.

### P0.2 New assignment doesn't appear as an active job - DATA-MISMATCH
- Complaint: "I just created a new assignment... it says there's no active jobs."
- Reality:
  - Create: `POST /api/schedules` (`apps/api/src/routes/schedules.ts`) inserts a `crew_schedules` row with `status='draft'` and a `crew` array; it does **not** create labor entries.
  - The "today / active jobs" view reads from the bootstrap schedules payload (`apps/api/src/routes/system.ts`), and the mobile "today" screen filters by date/confirmed state.
  - A `draft` assignment is stored but not surfaced as "active" until it is **confirmed** (the `crew_schedule` workflow `draft -> confirmed`).
- Verdict: DATA-MISMATCH (create path and active-jobs read path disagree on `draft` vs `confirmed`).
- Fix sketch: either surface `draft` assignments in the active-jobs list, or auto-advance/confirm on create, or add a visible "confirm" step. Decide product intent first.

### P0.3 AI auto-takeoff returns 404 in production - NEEDS-ENV / NEEDS-REPRO
- Complaint: "I'm getting a 404 error when trying to do the AI takeoff stuff." On-call guess: "I don't think it uploaded the credentials for Gemini on the production."
- Reality (correcting the on-call guess):
  - The desktop screen `apps/web/src/screens/desktop/est-ai-takeoff.tsx:63,81` calls `POST /api/projects/:id/takeoff-drafts/capture` then `.../promote`.
  - Both routes ARE registered: `apps/api/src/routes/dispatch.ts:262` (capture) and `:264` (promote). So this is **not** a missing route in source.
  - The capture pipeline is `blueprint_vision`, which uses **Claude Opus / `ANTHROPIC_API_KEY`** (+ `BLUEPRINT_VISION_MODE=live`), per the screen header doc and root CLAUDE.md - **not Gemini**. Without the key it falls back to a deterministic dry-run **stub that returns 200**, not 404.
  - Therefore a real 404 in prod means the request is not reaching the route at all: most likely a prod build/deploy that predates these routes, a reverse-proxy/path issue, OR a different (mobile) entry point hitting a different path. The dry-run stub would not 404.
- Verdict: NEEDS-ENV (for the AI result to be real) + NEEDS-REPRO (to pin the 404 specifically). The "Gemini creds" theory is likely a red herring.
- Fix sketch: reproduce on prod with devtools network tab, capture the exact failing URL + status; check the deployed build SHA includes dispatch.ts:262-264; then set `BLUEPRINT_VISION_MODE=live` + `ANTHROPIC_API_KEY` in the GitHub `production` environment for real detection.

---

## P1 - High (visible dead controls / wrong placement on core flows)

### P1.1 "Verify Scale" button does nothing - STUBBED
- Complaint: "Verify scale... this button doesn't do anything. It's not even giving me an error message."
- Reality: `apps/web/src/screens/desktop/est-scale-verify.tsx`. The sheet rows ARE real (mapped from `useProjectBlueprints` at lines 56-59 - not demo data). But the per-row Verify action `handleVerify` at line 75 is an explicit `/* no-op placeholder */`; header comment lines 6-10 say confidence/status are *derived* from existing `sheet_scale`/calibration fields because "there is no dedicated scale-verify API yet." So the row data is real; the button does nothing and shows no error.
- Verdict: STUBBED (no backend endpoint; the action is a no-op, the list itself is wired).
- Fix sketch: wire `POST /api/blueprints/:id/scale-verify` (or fold scale-verify into the existing two-point picker in the takeoff canvas) and give the Verify action real behavior + feedback.

### P1.2 Job costs lives at top level, should be a Money tab - MISPLACED
- Complaint: "job costs... I feel like this goes in a project -> budget. books / cash flow / invoice - maybe put this job cost thing in the money section as a tab."
- Reality: job costs is its own desktop route (`apps/web/src/screens/desktop/desktop-workspace.tsx` has `path="job-costs"` -> `OwnerJobCosts` / `est-actuals.tsx`). The Money screen `apps/web/src/screens/desktop/owner-money.tsx` has only two tabs: `cashflow` and `books`. The screen itself works (bid vs actual from `useAnalytics()`); it is simply in the wrong place.
- Verdict: MISPLACED.
- Fix sketch: add a third tab ("Job costs") under `owner-money.tsx` and route the existing `est-actuals.tsx` content into it; keep/redirect the old route.

### P1.3 Rentals desktop "Add asset" does nothing - STUBBED
- Complaint: "the rental UI... add asset and nothing works."
- Reality: `apps/web/src/screens/desktop/owner-rentals.tsx:179` renders `<button className="d-rentals__add" type="button">` with **no onClick**. The desktop rentals table itself IS wired (live utilization via `useInventoryItems()` / `useInventoryUtilization()`), so "desktop view is non-existent" is not accurate - but the create affordance is dead. (`useCreateInventoryItem` exists in the API layer, just not connected to this button.)
- Verdict: STUBBED (add-asset only; the list is WIRED).
- Fix sketch: open an inline add-asset modal/editor on click and call `useCreateInventoryItem`.

### P1.4 Roles & permissions are read-only; no custom roles - STUBBED / MISSING
- Complaint: "I need a way to be able to edit this roles and permissions... be able to create a custom role."
- Reality: `apps/web/src/screens/desktop/owner-settings.tsx` (RolesSection) renders a **static** capability matrix for the 5 canonical roles. The role set is a hardcoded enum (`admin|foreman|office|member|bookkeeper`) in `apps/api/src/routes/companies.ts` and `packages/domain/src/roles.ts`. There is no custom-role table, no create/edit endpoint.
- Verdict: STUBBED (matrix is presentational) + MISSING (custom-role create/edit). This was an explicit meeting commitment (custom roles, e.g. a PM who can view P&L).
- Fix sketch: needs a schema addition (custom role definitions + capability set) + CRUD API + an editable matrix. Larger than the other P1s; scope separately.

### P1.5 Desktop "Start a job" opens the mobile view - WIRED-INCONSISTENT (routing)
- Complaint: "when I click on start a job from [desktop clients], it opens up the mobile view."
- Reality: a desktop new-project route exists - `desktop-workspace.tsx:569` `path="projects/new"` -> `OwnerNewProject` (`owner-new-project.tsx`, the proper desktop "Start a job." form), reached via `/desktop/projects/new`. The mobile single-step form is `apps/web/src/screens/mobile/project-new.tsx` at `/projects/new`. The exact bug: `apps/web/src/screens/desktop/est-client-profile.tsx:172` navigates to `/projects/new?customer_id=${customer.id}` - **missing the `/desktop` prefix** - so from the desktop client profile, "Start a job" lands on the mobile form. (The desktop dashboard's own "New project" button at `desktop-workspace.tsx:434` correctly uses `/desktop/projects/new`.)
- Verdict: WIRED-INCONSISTENT (one navigation target missing the `/desktop` prefix).
- Fix sketch: change `est-client-profile.tsx:172` to `/desktop/projects/new?customer_id=...` (and grep for any other bare `/projects/new` nav from desktop screens).

---

## P2 - Medium (mobile layout / nav / new-project-modal polish)

### P2.1 New-project modal can't upload a blueprint; copy says "takeoff" - STUBBED
- Complaint: "there's like none of this from a blueprint... it should say blueprint on here instead of takeoff... I can't upload anything here."
- Reality: `apps/web/src/screens/mobile/project-new.tsx` collects name/customer/division/bid/labor-rate/notes only - **no file input**. Blueprint upload happens after creation via the Files tab (`useUploadBlueprint`). The founder expects "create project + upload blueprint" in one step, and the wording to say "from a blueprint."
- Verdict: STUBBED (no upload in the create flow).
- Fix sketch: add an optional blueprint upload to the new-project form (POST to `/api/projects/:id/blueprints` after create) and adjust copy.

### P2.2 Mobile "More" menu removes the bottom bar / can't scroll - NEEDS-REPRO (likely CSS)
- Complaint: "if I click on more, it removes the bottom and I can't scroll."
- Reality: `.m-bottombar` in `apps/web/src/styles/m.css` is `position: relative` (not `fixed`). Tall nested `/more/*` content can push the bar off-screen / break scroll.
- Verdict: NEEDS-REPRO, likely-CSS.
- Fix sketch: pin `.m-bottombar` to `position: fixed; bottom: 0` (with iOS safe-area) and/or constrain nested route height to `calc(100dvh - 88px)`.

### P2.3 Mobile bottom bar "jumps up" on schedule/new-assignment - WORKS-AS-DESIGNED (UX gap)
- Complaint: "if I click on schedule, it brings up new assignment... the bottom bar doesn't keep it at the bottom, it just jumps up."
- Reality: the new-assignment `Sheet` (`apps/web/src/components/mobile/Sheet.tsx`) is `fixed inset-0` and overlays the viewport; combined with the relative bottom bar this reads as the bar moving.
- Verdict: WORKS-AS-DESIGNED but poor UX; same root cause as P2.2.
- Fix sketch: fix the bottom-bar positioning (P2.2) so it stays put under/around sheets.

### P2.4 Scheduling nav is inconsistent across sub-screens - WIRED-INCONSISTENT
- Complaint: "the nav is different on today / crew / schedule / time / confirm / day log / settings... simplify this nav and select between them."
- Reality: `apps/web/src/screens/mobile-shell.tsx` defines different bottom-tab sets per role (ADMIN_TABS vs FOREMAN_TABS), and `/schedule/*` sub-screens render full-screen, hiding the tab bar. So a person who is both admin and foreman sees different navs in different places.
- Verdict: WIRED-INCONSISTENT.
- Fix sketch: unify the field/schedule sub-navigation; the founder explicitly wants a single nav that switches context rather than every item always present.

---

## P3 - Low (clarity / by-design / needs definition)

### P3.1 Takeoff re-prompts to upload a blueprint already uploaded - WORKS-AS-DESIGNED
- Reality: Files tab / takeoff canvas always offer "Upload blueprint" because multiple docs per project are supported. Not a bug; just unclear.
- Fix sketch: when a blueprint exists, de-emphasize the upload CTA and show the current doc prominently.

### P3.2 "Assign item" in takeoff does nothing / unclear - MISSING (as a control)
- Reality: no "Assign item" button exists in the takeoff canvas. Linking a measurement to a service item happens via the `service_item_code` field on `PATCH /api/takeoff/measurements/:id`, not a dedicated control.
- Fix sketch: add an explicit "Assign item" affordance on a selected measurement.

### P3.3 No delete for drawn shapes in the canvas - STUBBED (canvas) / WIRED (detail)
- Reality: delete exists only on the measurement detail screen (`takeoff-detail.tsx`) -> `DELETE /api/takeoff/measurements/:id`. The canvas has no delete affordance for a freshly drawn shape.
- Fix sketch: add delete/undo to the canvas selection.

### P3.4 "Measurement geometry must be polygon" error - WIRED (UX gap)
- Reality: backend validation in `apps/api/src/routes/takeoff-measurements.ts` (normalizeGeometry) correctly rejects malformed geometry. The message is correct; the canvas just surfaces it poorly.
- Fix sketch: catch the 4xx and show an inline canvas hint.

### P3.5 "Add target" does nothing - STUBBED (dead button)
- Complaint: "22 sheets add target. This add target thing doesn't do anything either."
- Reality (corrected): the control DOES exist. `apps/web/src/screens/desktop/est-ai-takeoff.tsx:219-236` renders a `+ ADD TARGET` button with **no onClick** - presentational only. It sits on the desktop AI auto-takeoff *setup* panel, right below the symbol->item target list and above the "ALL VERIFIED - 22 SHEETS" scope box (line 247) - which is exactly the "22 sheets / add target" the founder was looking at. The symbol->item target toggles above it are also presentational (the capture endpoint takes no per-target selection - noted as a GAP in the file header). So this is the same screen as P0.3.
- Verdict: STUBBED (dead button; the whole target/sheet-scope selector is presentational and doesn't feed the capture call).
- Fix sketch: either wire per-target/per-sheet selection into the capture payload (the real fix) or remove the dead affordances until the endpoint accepts them.

### P3.6 Settings dead buttons (profile, help) - MIXED
- Reality: Notifications settings ARE wired (`useNotificationPreferences` + update). Profile is read-only by design (Clerk owns identity). Help "Open" button has an empty `onClick` (TODO).
- Fix sketch: wire the Help link; leave Profile as Clerk-owned (or add a Clerk-hosted profile link).

### P3.7 Project search - WIRED (clarify scope)
- Reality: `apps/web/src/screens/mobile/projects-list.tsx` filters client-side on name/customer/division. It works for the loaded project set; it is not a server-side search. The founder's "it's not searching anything" may be a data/empty-state issue rather than a broken filter.
- Fix sketch: confirm with a populated project list; add server-side search only if needed.

### P3.8 Onboarding wizard is minimal vs the designed flow - PARTIAL
- Reality: `apps/web/src/screens/onboarding/wizard.tsx` is a 3-step happy path (company -> optional team invite -> seed). The designed flow (SSO choice, trade selection, connect QuickBooks/Gusto/Stripe, create first project, add clients) is largely not built. QBO connect is intentionally deferred.
- Fix sketch: stage the additional steps; tie "team invite" step to the P0.1 invite work.

---

## QBO integration - the keystone (founder: "this is a big one")

Founder's requirement: bidirectional sync. On connect, QBO should populate clients,
jobs, projects, job costs, materials; and Sitelayer changes should push to QBO and
vice versa. "customers, estimates, invoices, time, activities - that all lives in
QuickBooks Online."

Verified current state:
- OAuth connect: WIRED. `apps/api/src/routes/qbo.ts` + `qbo-oauth-state.ts`; callback persists an `integration_connections` row (`status='connected'`); worker refreshes tokens (`apps/worker/src/qbo-token-refresh.ts`).
- PUSH (Sitelayer -> QBO): partially WIRED behind flags. `estimate_push` (`apps/worker/src/qbo-estimate-push.ts`, `QBO_LIVE_ESTIMATE_PUSH=1`), rental invoice (`qbo-invoice-push.ts`, `QBO_LIVE_RENTAL_INVOICE=1`), labor TimeActivity (`QBO_LIVE_LABOR_PAYROLL=1`). All default to stub (synthetic ids) in prod.
- PULL (QBO -> Sitelayer): STUBBED. Mapping helpers exist (`apps/api/src/qbo-integration-mapping.ts` for customer/service_item/division/project) but the actual QBO read that backfills the local UI (populate clients/jobs/items/costs on connect) is **not implemented**. `POST /api/integrations/qbo/sync/material-bills` exists but is stubbed.
- Verdict: PUSH partial-behind-flags; PULL missing. The "vice versa" half (the part the founder leaned on) is the biggest gap.
- Note: per root CLAUDE.md, QBO sandbox OAuth has never been validated end-to-end (`scripts/qbo-sandbox-smoke.sh` exists, needs real creds), and all `QBO_LIVE_*` flag flips require a worker restart + sandbox smoke first.
- Fix sketch (scope as its own track): (1) validate sandbox OAuth end-to-end; (2) implement the pull/backfill (Intuit Query API -> integration_mappings + local reference tables) following the mutation_outbox / sync_events discipline; (3) flip push flags one entity at a time after sandbox smoke.

---

## Suggested sequencing (cheap, high-visibility first)

1. Dead-control quick wins (P1.1 verify-scale, P1.3 add-asset onClick, P3.6 help link, P1.5 start-a-job route) - small diffs, immediately visible.
2. Job costs -> Money tab (P1.2) - pure IA move, founder explicitly asked.
3. P0.1 invites + P0.2 active-jobs - the two that actually block a multi-person pilot; need a small product decision each.
4. P2 mobile nav/layout pass (P2.1-P2.4) - one coordinated mobile-shell + m.css pass.
5. Roles/custom roles (P1.4) and QBO pull (keystone) - each its own track; schema + API work.

All findings are file-verified on `dev-np`; the QBO live state and the AI-takeoff
404 still want a live reproduction before any flag flip.
