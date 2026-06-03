# Testing the takeoff canvas — seed once, jump anywhere

The takeoff canvas is built on the `takeoff-session` XState statechart (the single
state owner). That makes every canvas state reachable deterministically, so you can
exercise the full surface — desktop and phone — without click-pathing each scenario
by hand. Testability has **two composable layers**:

| Layer                                     | What it seeds                                                                               | How                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **DB scenario** (`@sitelayer/scenario`)   | _Data_ states — projects, blueprints + calibrated pages, drawn measurements, AI result_json | `scenarios/*.yaml` → seeder / `/admin`        |
| **`?seed=<name>`** (machine seed catalog) | _UI_ states — mid-draw, calibrating, selecting, AI-review                                   | URL query on the canvas route (dev/test only) |

They compose: seed the DB data, then `?seed=` the UI posture on top.

---

## 1. `?seed=<name>` — boot the canvas into any UI state

Open the canvas route with a `seed` query param. **Dev/test only** — it is hard-gated
off in production (`import.meta.env.MODE === 'production'` → ignored) and only accepts
names in the catalog.

- **Desktop route:** `/desktop/canvas/<projectId>?seed=<name>`
- **Mobile route:** `/projects/<projectId>/takeoff-mobile?seed=<name>`

Both routes mount the same responsive `TakeoffCanvas`; the body (desktop command-center
vs phone) is chosen by `useIsDesktop()` (reactive `min-width:1024px` — resize to flip it
live). `<projectId>` can be any id; the seeded _draft_ renders from the machine even with
no blueprint (you'll see "grid only").

### The catalog (`TAKEOFF_SEED_NAMES`)

| `?seed=`            | Lands you in                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| `empty`             | idle, nothing drawn                                                                |
| `drawing-empty`     | draw mode, polygon tool, 0 points                                                  |
| `drawing-polygon`   | mid-polygon, 3 points placed, scope set → commit-ready (shows live sqft)           |
| `drawing-lineal`    | mid-lineal run, 2 points                                                           |
| `drawing-count`     | count mode, 2 marks placed                                                         |
| `calibrating`       | scale mode, 1 of 2 reference points placed                                         |
| `calibrating-ready` | 2 points + a typed length → Apply enabled                                          |
| `calibrated-idle`   | idle on a verified-scale page (true sqft/lf path)                                  |
| `selecting`         | a committed measurement selected                                                   |
| `editing-vertex`    | vertex-drag edit engaged                                                           |
| `ai-configuring`    | AI capture setup                                                                   |
| `ai-reviewing`      | the editable AI-review overlay with HIGH/MED/LOW proposals + Accept/Reject/Promote |

Source of truth: `apps/web/src/machines/takeoff-session-seeds.ts`. In unit/component
tests, `seedTakeoffSessionActor(machine, name, base)` boots an actor straight into the
state — no clicks (`takeoff-session-seeds.test.ts`).

---

## 2. DB scenarios — seed _renderable_ takeoffs

`scenarios/takeoff-canvas-states.yaml` is one tenant (`takeoff-lab`) whose four projects
each land the canvas in a distinct **data** posture (real board-space geometry, calibrated
pages, conditions):

- `manual` — blueprint + scale-verified page + manual draft (polygon area + window-cutout deduction + lineal run + count)
- `uncal` — same geometry, page **not** calibrated → the degraded board-space path
- `ai` — a `blueprint_vision` draft, `review_required`, mixed-confidence quantities + geometry
- `empty` — blueprint uploaded, calibrated, zero measurements (cold-start)

Seed it (dev/demo only — refuses `APP_TIER=prod`):

```bash
npx tsx scripts/seed-scenario.ts scenarios/takeoff-canvas-states.yaml
```

It also appears in the in-app **`/admin` → Scenarios** picker (Apply / Reset, platform-admin).
`scenarios/takeoff-bulk.yaml` is the 500-measurement perf fixture.

---

## 3. Local / dev auth (act-as)

When Clerk isn't configured (local) the dev **RoleSwitcher** writes
`localStorage['sitelayer.act-as'] = e2e-<role>` and every API call carries
`x-sitelayer-act-as`. The dev tier (`dev.sitelayer.sandolab.xyz`) runs this — pick a role
bottom-right, then open a canvas route with `?seed=`.

---

## 4. Quick recipes

```
# UI states on a throwaway project (desktop), no data needed:
/desktop/canvas/00000000-0000-0000-0000-000000000001?seed=drawing-polygon
/desktop/canvas/00000000-0000-0000-0000-000000000001?seed=ai-reviewing

# Real drawn measurements + calibration (seed the DB first):
npx tsx scripts/seed-scenario.ts scenarios/takeoff-canvas-states.yaml
# → open the `manual` / `ai` / `uncal` / `empty` takeoff-lab project's canvas

# Phone body: same URL, narrow the window below 1024px (the gate is reactive).
```
