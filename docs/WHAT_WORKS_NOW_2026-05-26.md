# SiteLayer — What Works Right Now

> **STALE (2026-06-12):** This inventory is a 2026-05-26 snapshot; many status
> tags below no longer match the code (capture pipelines, takeoff canvas,
> deploy model, agent feed, …). Use [`CRITICAL_PATH.md`](../CRITICAL_PATH.md)
> and the 2026-06-12 audit (debt campaign) as the live source of truth.

**As of:** 2026-05-26 · **Live URL:** https://sitelayer.sandolab.xyz (verified up, sign-in/sign-up render, DB healthy)

This is a code-grounded inventory of what the platform actually does today — not the roadmap. It's meant as a checklist: read each line and mark whether it matches what you see. Where the code and reality might differ, that's exactly what we want flagged.

## How to read the status tags

| Tag                     | Meaning                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| ✅ **Works**            | Wired end-to-end (UI → API → DB), renders/acts on real data                  |
| 🟡 **Partial**          | Renders real data but some actions are read-only or stubbed                  |
| ⚙️ **Backend-only**     | API/workflow exists and works, but no UI front door yet                      |
| 🚩 **Flag-gated**       | Built, but turned OFF by default in production (needs an env flag + restart) |
| 🔴 **Stub / not wired** | Placeholder, "coming soon", or not connected                                 |

---

## 1. Access, sign-up, and roles

- ✅ **Sign-in / sign-up** via Clerk (hosted at `accounts.sandolab.xyz`, public sign-up enabled, email + password + email-code verification). Verified rendering with no errors.
- ✅ **Self-serve onboarding:** a new account with no company lands on a 3-step **onboarding wizard** (create company → optional team invite → optional seed data) → `POST /api/companies` auto-grants the creator **admin**, optionally seeds divisions/service items → dashboard.
- 🟡 **Pilot caveat:** for a real customer you'd more likely use the operator script `scripts/provision-pilot-company.sh` (invites need each member's Clerk user ID). Self-serve works, but team invites are clunky without those IDs.

### The five roles

Defined in `packages/domain/src/roles.ts`: **`admin`, `office`, `foreman`, `member`, `bookkeeper`**. (`office` is treated like `admin` for most permissions.)

### Which tabs each role sees (mobile shell)

| Persona (role)             | Bottom-nav tabs                                                         |
| -------------------------- | ----------------------------------------------------------------------- |
| **Admin / Office** (owner) | Today · Projects · Schedule · Rentals · More                            |
| **Foreman**                | Today · Crew · Field · Log · Time                                       |
| **Worker** (member)        | Today · Scope · Hours · Log                                             |
| **Bookkeeper**             | Finance/payroll-focused (limited; please confirm what you actually see) |

> In non-production builds there's a **RoleSwitcher** (bottom-right) to flip between `e2e-admin / foreman / office / member / bookkeeper` without re-auth. It's hard-blocked in prod.

---

## 2. Permission matrix — what each role is _allowed_ to do

Authorization is enforced server-side (`requireRole()` in `apps/api/src/server.ts`) plus Postgres row-level security isolating each company's data. Reads are generally open to any signed-in member of the company; writes are gated as below.

| Capability                                               | Admin | Office | Foreman | Member (worker) | Bookkeeper |
| -------------------------------------------------------- | :---: | :----: | :-----: | :-------------: | :--------: |
| View company data (projects, labor, rentals — read-only) |  ✅   |   ✅   |   ✅    |       ✅        |     ✅     |
| Clock in / out (self)                                    |  ✅   |   ✅   |   ✅    |       ✅        |     ❌     |
| Create / edit **projects**                               |  ✅   |   ✅   |   ✅    |       ❌        |     ❌     |
| Create / edit **takeoff & measurements**                 |  ✅   |   ✅   |   ✅    |       ❌        |     ❌     |
| Create / edit **estimates & pricing**                    |  ✅   |   ✅   |   ❌    |       ❌        |     ❌     |
| Enter **labor entries**                                  |  ✅   |   ✅   |   ✅    |       ❌        |     ❌     |
| **Schedule crews** / confirm schedule                    |  ✅   |   ✅   |   ✅    |       ❌        |     ❌     |
| Send daily **brief**, manage **daily logs**              |  ✅   |   ✅   |   ✅    |    view/own     |     ❌     |
| Flag a **field issue**                                   |  ✅   |   ✅   |   ✅    |       ✅        |     ❌     |
| **Resolve / triage** field issues                        |  ✅   |   ✅   |   ✅    |       ❌        |     ❌     |
| **Approve** time-review / payroll runs                   |  ✅   |   ✅   |   ✅    |       ❌        |     ❌     |
| Manage **rental contracts**, post **billing runs**       |  ✅   |   ✅   |   ❌    |       ❌        |     ❌     |
| Manage **inventory catalog** / locations                 |  ✅   |   ✅   |   ❌    |       ❌        |     ❌     |
| Create **customers**, **service items**, **divisions**   |  ✅   |   ✅   |   ❌    |       ❌        |     ❌     |
| **Export payroll** to QBO                                |  ✅   |   ✅   |   ❌    |       ❌        |     ✅     |
| Manage **QBO** connection / mappings / sync              |  ✅   |   ✅   |   ❌    |       ❌        |     ❌     |
| **Invite / manage members**                              |  ✅   |   ❌   |   ❌    |       ❌        |     ❌     |
| Configure **company settings / modules / bonus rules**   |  ✅   |   ❌   |   ❌    |       ❌        |     ❌     |
| View **audit logs**                                      |  ✅   |   ❌   |   ❌    |       ❌        |     ❌     |

---

## 3. Feature inventory (by area)

### Projects ✅

- Create project (name, address, customer, division, bid, labor rate, target sqft/hr), list with search/filter, detail view.
- Status lifecycle (bid → active → closed) and **closeout** (locks summary).
- Project detail tabs: **Overview ✅ · Crew ✅ · Materials ✅ · Budget ✅ · Estimate 🟡 (read-only on mobile) · Log 🟡 · Files 🟡 (list only)**.

### Blueprint takeoff & measurement 🟡

- ✅ PDF upload + storage (DigitalOcean Spaces, with local fallback), versioning, up to 200 MB.
- ✅ Interactive measurement canvas: polygons / lines / volumes, scale calibration, zoom/pan.
- ✅ Scope items (EPS, basecoat, finish, stone, etc.) with colors/units/rates.
- ✅ Multi-draft takeoff: multiple drafts per project, each with its own measurements + estimate; promote captured results → committed measurements.
- 🚩 **AI takeoff (`blueprint_vision`)**: real (Claude vision) but **opt-in only** — needs `BLUEPRINT_VISION_MODE=live` + `ANTHROPIC_API_KEY`. Off by default.
- 🔴 **Photogrammetry / drone / RoomPlan capture**: skeleton/stub only, not exercised end-to-end.

### Estimation & pricing ✅

- ✅ Auto-generated estimate line items from measured quantities × rates.
- ✅ Bid-vs-scope comparison (under/over bid, threshold bands).
- ✅ Pricing profiles + cascading rate overrides (project → customer → company → default).
- ✅ Estimate **PDF export**; hours forecasting.
- 🟡 In-app estimate **line editing** has incomplete plumbing (some "INTEGRATION TODO" markers); review/recompute is fuller on desktop than mobile.

### Crew scheduling ✅

- ✅ Day / week / 4-week grid, multiple crew per project/day, create assignment, foreman confirm/decline.
- 🔴 **"Copy week"** — not implemented (no route/UI found).

### Labor & time tracking ✅ (one gap)

- ✅ Clock in/out with GPS + geofence check; manual + foreman-override sources; auto-draft labor entry on clock-out.
- ✅ Labor entries (hours per worker/service/project), daily crew confirmation, **time-review approval** workflow (locks entries on approve), payroll-run generation.
- ✅ Productivity analytics (sqft/hr) — depends on workers entering `sqft_done`.
- 🟡 **Geofenced _auto_ clock-in/out**: server + schema ready, but the client-side geofence trigger and `auto_out_idle` timeout aren't wired. README oversells this — confirm whether auto clock-in actually fires on-site.

### Daily logs & field events ✅

- ✅ Daily log capture (scope progress, weather, notes, photos) with submit workflow.
- ✅ Field-issue flow: worker flags issue (materials out / crew short / safety / other) → foreman triage (resolve / escalate / dismiss) → worker gets notified. Auto-escalation after timeout for "stopped" severity.
- ✅ Photo logs (worker + daily log), uploaded to storage.

### Rentals & inventory ✅ (mostly)

- ✅ Inventory catalog CRUD, locations, movement ledger, stock availability/utilization.
- ✅ Rental contracts + line items; **billing-run state machine** (generated → approved → posting → posted/failed/void) with list + detail + approval UI.
- ✅ Returns / transfers via movement entries; **rental-request approval** queue (for customer-portal submissions).
- ⚙️ **CSV/Excel import**: API exists, **no UI button** to call it.
- 🔴 **Scan-driven dispatch** (scan equipment from the field): schema placeholders only, no field-scan app.

### Analytics & dashboards ✅

- ✅ Per-project margins (revenue vs labor + material cost), labor productivity, inventory utilization (idle-revenue/day), home-screen KPIs per persona, live-vs-budget.
- 🔴 **Anomaly detection**: the time-review screen shows an "N anomalies flagged" label but there's **no detection logic** behind it (always 0).

### QuickBooks Online (QBO) integration 🚩

- ✅ **OAuth connect**, entity **mappings** (customer/division/service-item/project), sync-run orchestration, queue inspection UI (`/api/sync/*`).
- 🚩 **All actual pushes are OFF by default and run as dry-run stubs:** estimate push (`QBO_LIVE_ESTIMATE_PUSH`), rental invoice (`QBO_LIVE_RENTAL_INVOICE`), labor payroll (`QBO_LIVE_LABOR_PAYROLL`). Going live needs the flags + sandbox credentials + worker restart, and a sandbox smoke test. **This is the #1 known pilot blocker.**

### Notifications ✅

- ✅ Deterministic notification workflow (email / SMS / web-push), push-subscription + preference endpoints, triggered by field-event resolution, escalations, schedule confirmations. (Confirm real email/SMS delivery in your environment.)

---

## 4. Known gaps & caveats (read before promising anything)

1. 🚩 **QBO writes are stubbed** until flags flipped + sandbox validated — no real invoices/estimates/payroll hit QuickBooks today.
2. 🟡 **Geofenced auto clock-in/out** isn't fully wired client-side; `auto_out_idle` doesn't exist despite README.
3. 🔴 **AI/advanced capture** beyond manual: `blueprint_vision` is opt-in; photogrammetry/drone/RoomPlan are stubs.
4. 🔴 **Anomaly detection** is a label only; **copy-week** missing; **CSV import** has no UI; **scan dispatch** not built.
5. 🟡 **Estimate line editing** in-app is partially plumbed (TODOs); fuller on desktop.
6. ⚙️ **Clerk → app webhook is a no-op** — deleting a user in Clerk doesn't revoke app access automatically; no auto user/org sync.
7. 🛠️ **Customer/team provisioning** leans on an operator script + Clerk user IDs (not smooth self-serve for crews).
8. 🧪 **Failing test:** the 3D takeoff WebGL preview e2e smoke fails (incomplete test mock for `/api/me/memberships`) — feature's real-world status unverified.
9. ⚠️ **Offline edits use last-write-wins** — a conflicting edit from another device is silently discarded (with a toast), no merge/picker.
10. 🏷️ **Clerk app is still named "My Application"** on the login screen (unbranded) — cosmetic but looks unfinished.

---

## 5. How to try it

- **Prod:** open https://sitelayer.sandolab.xyz → sign up → onboarding wizard → you become admin of a new company.
- **Local (dev):** the RoleSwitcher lets you jump between roles to see each persona's tabs.

---

## 6. Quick verification checklist (for Steve to mark up)

- [ ] Sign-up + email verification actually completes and lands me in the app
- [ ] Onboarding wizard creates a company and I can see the dashboard
- [ ] Create a project and open its detail tabs
- [ ] Upload a blueprint PDF and draw a measurement
- [ ] Generate an estimate from measurements; export the PDF
- [ ] Schedule a crew for a day; confirm as foreman
- [ ] Clock in/out as a worker; see hours roll up
- [ ] File a field issue as worker; resolve it as foreman
- [ ] Create an inventory item; run a rental billing run through approval
- [ ] Connect QBO (OAuth) — note: actual posting is stubbed/off
- [ ] Confirm which role you're testing as, and whether each tab matches Section 1

> For each item: ✅ works / 🟡 works-but-rough / 🔴 broken or missing — and a note on what you expected.
