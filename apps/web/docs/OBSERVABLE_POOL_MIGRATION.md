# Sitelayer Observable Pool Migration — Plan

**Status:** Plan only — no code changes, no infrastructure changes. For operator review.
**Date:** 2026-05-21

---

## 1. TL;DR

Replace **per-component `useQuery` cache + IndexedDB replay-via-HTTP** with a **single in-memory MobX observable pool** that:

1. Loads from IndexedDB on boot (resumes the offline queue and last-known server snapshot).
2. Applies local mutations to the pool immediately (Linear-style optimistic).
3. Sends the original request — server responds with a **JSON Patch (RFC 6902)** that describes the authoritative delta.
4. Merges the patch into the pool.

This is a **large refactor**. The estimate below is honest, not aspirational: **~10–14 weeks** for the full migration of the seven resources listed in §2, with a meaningful **2-week pilot** that proves the pattern on one resource (`takeoff_measurements`) before any other resource is touched.

Field crews on spotty connectivity are the **primary user-facing constraint**. Every design choice below is justified against that — not against Linear-aesthetic.

---

## 2. Scope

### 2.1 In the pool

Resources that satisfy **all four** of: (a) field-edit-heavy, (b) currently routed through the offline queue OR have aggressive `invalidateQueries`, (c) have a stable per-row identity, (d) fit in IndexedDB quota for a typical project:

| Resource                | Volume estimate (per active project) | Why it's in the pool                                                                                                  |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `projects`              | 10–200 active rows / company         | Read every screen; current `invalidateQueries({queryKey: ['projects']})` is the worst offender for refetch storms.    |
| `takeoff_measurements`  | 50–2000 / project                    | High write volume, polygon canvas, **already offline-queued** (`takeoff_measurement_create`). The pilot.              |
| `daily_logs` (rows)     | 1 / project / day                    | Field-edit, photos, multiple kinds in offline queue (`daily_log_*`).                                                  |
| `daily_log_photos`      | 10–50 / log                          | Metadata only — photo blobs stay in Spaces; pool holds the row.                                                       |
| `clock_events`          | ~5 / worker / day                    | Geofence-triggered, already offline-queued (`clock_in`, `clock_out`, `clock_void`, `clock_event_photo_upload`).       |
| `labor_entries`         | ~5 / worker / day                    | Derived from clock_out; show on review screens.                                                                       |
| `time_review_runs`      | ~50 pending / company                | Approval-queue screen reads/updates every refresh; XState workflow already exposes a clean `state_version` for OCC.   |

### 2.2 Stays on TanStack Query

Anything one-shot, derived/aggregated, or admin-only:

- `bootstrap` (one fetch / session)
- `analytics`, `labor-burden`, `labor-variance`, `bid-accuracy`, `closeout-summary` — derived views, server is the source.
- `billing-runs`, `labor-payroll-runs`, `estimate-pushes` — **deterministic workflows**. They already have a `WorkflowSnapshot` contract (see `docs/DETERMINISTIC_WORKFLOWS.md`); their UI is "render snapshot, dispatch event". The cost of porting them is high and the benefit (no `invalidateQueries`) is small. Leave them.
- `rentals`, `inventory-items`, `inventory-locations`, `inventory-movements` — large reference catalogs; not field-edit hot. Reassess in a future phase.
- `qbo/*`, `audit-events`, `companies`, `customers`, `divisions`, `service-items`, `pricing-profiles`, `bonus-rules`, `assemblies`, `workers` — reference / admin data. Office-side, stable connections.
- `ai/*`, `support-packets`, `notifications`, `prefs`, `push` — one-shot.

The bar for moving a resource into the pool later is: **"are field crews editing it on bad connections?"** If no, it stays on TanStack Query.

---

## 3. Pool Architecture

### 3.1 Files (proposed)

```
apps/web/src/lib/pool/
  ├── store.ts              # Pool<T>, ObservableModelStore<T>
  ├── root.ts               # RootStore singleton, hook (useStore)
  ├── persist.ts            # IndexedDB hydration / writeback
  ├── jsonpatch.ts          # RFC 6902 apply (~150 LOC, copy from fast-json-patch ideas — avoid the dep if possible)
  ├── queue.ts              # Replaces lib/offline/queue.ts long-term; bridges short-term
  ├── replay.ts             # Replaces lib/offline/replay.ts long-term
  └── resources/
      ├── takeoff-measurements.ts   # Per-resource store + delta wire types
      ├── daily-logs.ts
      ├── clock-events.ts
      ├── labor-entries.ts
      ├── time-review-runs.ts
      ├── projects.ts
      └── daily-log-photos.ts
```

### 3.2 `ObservableModelStore<T>` shape (sketch)

```ts
// Conceptual; not for committing.
class ObservableModelStore<T extends { id: string; version: number; updated_at: string }> {
  // observable map; iteration order = insertion order (MobX preserves)
  private byId = observable.map<string, T>()
  // observable, write-through to IndexedDB
  private pendingMutations = observable.array<PendingMutation>([])
  private lastSyncedAt: string | null = null

  // 1. boot: pull from IndexedDB → populate byId + pendingMutations
  async loadFromIndexedDB(): Promise<void> { ... }

  // 2. selector — returns a MobX computed view (cached + auto-tracked)
  list(predicate?: (row: T) => boolean): T[] { ... }
  get(id: string): T | undefined { ... }

  // 3. local mutation — applies optimistic row + enqueues for sync
  enqueueLocalMutation(delta: LocalDelta<T>): MutationHandle { ... }

  // 4. server delta — merges authoritative JSON Patch in one transaction
  applyDelta(patch: JsonPatchOp[]): void { ... }

  // 5. server hydration — full snapshot replace (used after long offline)
  hydrateFromServer(rows: T[]): void { ... }
}
```

**Observability choice.** MobX with `makeAutoObservable` per row. Use a **separate observable for each row** (not a single observable holding a Map of plain objects) so that a screen rendering one polygon doesn't re-render when an unrelated polygon mutates. Linear's pattern.

**React glue.** Use `mobx-react-lite` (functional components only) — no decorators, no class components, no `@observer` decorator. Components opt in with `observer(MyComponent)`.

**Single root store.** `apps/web/src/lib/pool/root.ts` exposes a `RootStore` with one `ObservableModelStore` per resource type. Provided via React context (`StoreProvider`); hook is `useStore()`. No global mutable singleton — easier to test, easier to dispose between tests.

### 3.3 Persistence layer

IndexedDB v2 schema (current is v1 — `sitelayer-offline`, one store `mutations`):

```
DB: sitelayer-pool   (new DB; cohabits with sitelayer-offline during Phase 1-2)
  Stores:
    - rows           keyPath=[resourceType, id]; index: by_resourceType
    - mutations      keyPath=id; index: by_enqueued_at  (mirrors current shape; replaces sitelayer-offline.mutations in Phase 4)
    - meta           keyPath=key  (lastSyncedAt per resource, schemaVersion)
```

Write-through: every `applyDelta`/`enqueueLocalMutation` writes its delta to IndexedDB in the **same MobX action** that mutates memory, so an unexpected reload never loses data. Use a single `transaction(['rows', 'mutations'], 'readwrite')` per mutation to keep memory and disk atomic.

**Photo blobs stay in IndexedDB the way they do today** — the pool only holds the metadata row. Photo upload mutations still carry the `File` in `payload.file`, identical to the existing `BLOB_SLOTS` whitelist.

### 3.4 Quota strategy

Per-origin IndexedDB quota assumption: **~50 MB on the conservative path** (Safari) and up to several hundred MB elsewhere. Sitelayer field crews are issued iPads — so design for Safari.

Photo blobs are the only realistic risk. A 12-photo daily log ≈ 12 × 3 MB = 36 MB. That alone almost blows the quota.

- Photos uploaded successfully → row dropped from `mutations` store; metadata row (without blob) stays in `rows`. Memory + IndexedDB usage collapses.
- Photos pending upload → blob persists in `mutations` store until upload succeeds. If quota exceeded on enqueue, the call **fails loud** rather than dropping silently. UI surfaces "Storage full — connect to upload" toast.
- Add `navigator.storage.estimate()` health-check on boot; surface a banner at 80% usage.

### 3.5 What replaces `useQueryClient.invalidateQueries`?

Nothing. After Phase 3 for a given resource, components subscribe to the observable store; the store applies server deltas as they arrive; React re-renders the rows that changed. **Zero refetches.**

For the 108 `invalidateQueries` calls in `apps/web/src/lib/api/`: they fall into three buckets after migration —

1. **Removed**: when both source mutation and reader are in the pool.
2. **Kept**: when the mutation lives in the pool but the reader is on TanStack Query (e.g. derived analytics).
3. **Replaced by store subscription**: when a workflow snapshot from TanStack Query needs to re-fetch after an event dispatch. (No change in this case.)

A scripted migration check counts calls in each bucket per resource as the work proceeds.

---

## 4. Delta Protocol

### 4.1 Wire format

**RFC 6902 JSON Patch**, embedded in the response body alongside (Phase 2) or instead of (Phase 4) the current `{ measurement: {...} }`-style envelope.

Phase 2 envelope (expand — both shapes returned):

```json
{
  "measurement": { "id": "uuid", "project_id": "...", "version": 7, ... },
  "delta": {
    "resource": "takeoff_measurements",
    "applied_at": "2026-05-21T17:42:11.124Z",
    "ops": [
      { "op": "add", "path": "/byId/01HXYZ.../", "value": { "id": "01HXYZ...", "version": 1, ... } }
    ]
  }
}
```

Phase 4 envelope (contract — delta only):

```json
{
  "delta": {
    "resource": "takeoff_measurements",
    "applied_at": "2026-05-21T17:42:11.124Z",
    "ops": [ ... ]
  }
}
```

### 4.2 Path convention

`/byId/<row-id>` is the canonical mount point. Field-level patches drill in: `/byId/01HXYZ/quantity`, `/byId/01HXYZ/notes`. Deletes are `{ "op": "remove", "path": "/byId/01HXYZ" }`. Cross-row effects (recomputing an estimate after a measurement creates) emit **multiple ops in one delta** so the client merges atomically.

### 4.3 OCC and conflict semantics

Every patched row carries the new `version` field, so the existing `expected_version` 409 path keeps working. The pool tracks per-row `version`; outgoing mutations attach `expected_version`. On 409, the response includes both the authoritative server row AND a delta describing the difference from the client's optimistic row — the pool reverts the optimistic local change and applies the server delta. Toast surfaces "your edit was overwritten" identically to the current LWW path.

### 4.4 Replay safety

JSON Patch is **not idempotent** by default (`{op:add, path:/byId/X}` fails if X already exists). Each delta envelope therefore carries a `mutation_id` UUID (echoed from the client request's `Idempotency-Key`). Pool tracks seen `mutation_id`s in a small ring buffer; duplicate deltas (from a server retry or worker re-dispatch) are dropped.

### 4.5 Example flows

**Local create, then sync** (takeoff_measurement):

```
1. User taps "save polygon". Pool.enqueueLocalMutation generates row id (uuid),
   inserts optimistic row into byId, appends mutation to pendingMutations,
   persists both to IndexedDB.
2. Polygon canvas re-renders immediately. No network involved.
3. Replay loop fires POST /api/projects/:id/takeoff/measurement.
4. Server responds 201 { measurement, delta: { ops: [{ op: 'replace', path: '/byId/<client-uuid>', value: serverRow }] } }
   — note the server preserves the client-supplied id.
5. Pool.applyDelta swaps the optimistic row for the server-blessed row. UI
   re-renders only if any field changed; usually no visible flicker.
```

**Cross-row delta** (POST `/api/projects/:id/takeoff/measurement` recomputes the estimate):

```json
{ "delta": { "resource": "takeoff_measurements", "ops": [
  { "op": "replace", "path": "/byId/01HM.../version", "value": 8 },
  { "op": "replace", "path": "/byId/01HM.../quantity", "value": "143.5" }
] } }
```

Plus, if the estimate also moves, a **second envelope** on `estimate_lines` flows in the same response. (See §5.4.)

### 4.6 Multi-resource responses

Server response shape (Phase 2+):

```json
{
  "measurement": {...},
  "deltas": [
    { "resource": "takeoff_measurements", "ops": [...] },
    { "resource": "estimate_lines", "ops": [...] }
  ]
}
```

`deltas` is an array so one endpoint can update multiple stores atomically (takeoff create → estimate line recompute). RootStore.applyDeltas iterates and routes by `resource`.

---

## 5. Server Changes Required

These are the endpoints whose response bodies need to grow a `deltas` field. **All changes are additive in Phase 2.** Old clients keep working.

### 5.1 Pilot (Phase 2 — `takeoff_measurements`)

| Endpoint                                                         | Route file                                                      | Notes                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `POST /api/projects/:id/takeoff/measurement`                     | `apps/api/src/routes/takeoff-write.ts`                          | Return delta for both measurement + estimate.  |
| `POST /api/projects/:id/takeoff/measurements`                    | `apps/api/src/routes/takeoff-write.ts`                          | Bulk replace — single big delta for the set.   |
| `PATCH /api/takeoff/measurements/:id`                            | `apps/api/src/routes/takeoff-measurements.ts`                   | Already does LWW 412 — return delta on success. |
| `DELETE /api/takeoff/measurements/:id`                           | `apps/api/src/routes/takeoff-measurements.ts`                   | `{op: 'remove'}`.                              |
| `GET /api/projects/:id/takeoff/measurements` (list — hydration)  | same                                                            | No change — pool hydrates from this on boot.   |

### 5.2 Phase 3 (next resource — pick one of `clock_events` or `daily_logs`)

| Endpoint                                                  | Route file                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /api/clock/in`, `/out`, `/events/:id/void`          | `apps/api/src/routes/clock.ts`                                                          |
| `POST /api/clock/events/:id/photo`                        | `apps/api/src/clock-event-photo-upload.ts`                                              |
| `POST /api/daily-logs`, `PATCH /api/daily-logs/:id`       | `apps/api/src/routes/daily-logs.ts`                                                     |
| `POST /api/daily-logs/:id/submit`                         | same                                                                                    |
| `POST/DELETE /api/daily-logs/:id/photos`                  | same + `apps/api/src/daily-log-photo-upload.ts`                                         |
| `POST /api/clock/out` (also writes labor_entry)            | `apps/api/src/routes/clock.ts` — emit **two** deltas (`clock_events` + `labor_entries`) |

### 5.3 Phase 4 (`projects`, `labor_entries`, `time_review_runs`)

| Endpoint                                              | Route file                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST/PATCH /api/projects`, `/api/projects/:id`       | `apps/api/src/routes/projects.ts`                                        |
| `POST/PATCH /api/labor-entries`                       | `apps/api/src/routes/labor-entries.ts`                                   |
| `POST /api/time-review-runs/:id/events`               | `apps/api/src/routes/time-review-runs.ts`                                |

### 5.4 Shared API-side plumbing

A small `apps/api/src/lib/jsonpatch.ts` helper:

```
buildDelta(resource: string, before: Row | null, after: Row | null): JsonPatchDelta
buildBulkDelta(resource: string, before: Row[], after: Row[]): JsonPatchDelta  // diff by id
```

Per-route, after the existing `RETURNING` query, the handler computes the delta and attaches it to the response. Server is the **source of truth for delta generation**; the client never invents what the delta should look like (only what the optimistic in-memory row should look like).

**Why server-computed deltas, not client-diff:** A naive client diff against an outdated cache produces a wrong delta on conflict, and the LWW path needs server authority anyway. Server computation also makes worker-driven side effects (`workflow_event_log` → fan-out → notifications row update) emit the same delta shape to a future WebSocket push.

### 5.5 Not required for Phase 1–4, but a likely follow-on

**Push channel for asynchronous deltas.** Currently every delta is response-coupled to a request. For the Linear-style pattern to shine, server-pushed deltas (another crew member's edit lands while you're online) would flow over WebSocket / SSE. This is **explicitly out of scope for this migration** — call it Phase 5 (future). Note the existing chat-widget SSE work on the current branch is the pattern to follow if/when this happens.

---

## 6. Migration Phases (expand → migrate → contract)

### Phase 0 — Foundations (1 week)

- Add deps: `mobx`, `mobx-react-lite`. (Do NOT add `fast-json-patch` — write the ~150 LOC RFC 6902 applier in-tree to keep the dep floor low. The applier subset we need is: `add`, `remove`, `replace`. We don't need `move`, `copy`, `test`.)
- Scaffold `apps/web/src/lib/pool/` per §3.1 — empty store classes, type definitions, no resources wired.
- Write `pool/jsonpatch.ts` + unit tests.
- Write `pool/store.ts` + unit tests (no React; pure observable logic).
- Write `pool/persist.ts` + unit tests (jsdom + fake-indexeddb).
- Verify MobX + React 19 + Vite 7 compatibility on a throwaway page.

**Exit criterion:** Pool can hold rows in memory, hydrate from IndexedDB, apply RFC 6902 patches. No screens wired yet. Zero risk to production.

### Phase 1 — Hydration alongside TanStack Query (1 week)

- Wire `RootStore` provider in `App.tsx`.
- Take **one resource** (takeoff_measurements) and add a `useTakeoffMeasurementStore()` hook that:
  - Hydrates from IndexedDB on mount.
  - Listens to TanStack Query results via a small bridge (`onSuccess: data => store.hydrateFromServer(data.measurements)`).
  - Exposes the same shape of data the screen reads today.
- Components **still read from TanStack Query.** The pool is shadow-populated; we verify it stays in sync.
- Add Sentry breadcrumb on every drift between pool and TanStack Query (rows present in one but not the other).

**Exit criterion:** Polygon canvas renders identically. Pool and TanStack Query agree 100% of the time over 1 week of dogfooding. Zero user-visible change.

### Phase 2 — Server returns delta; pool becomes write target for pilot resource (3 weeks)

- Server-side: `apps/api/src/lib/jsonpatch.ts` + the 4 takeoff endpoints listed in §5.1 add `deltas` to their response.
- Client-side: `useCreateMeasurement` calls `store.enqueueLocalMutation` first, sends the HTTP request, then `store.applyDelta(response.deltas)`. Same for PATCH/DELETE.
- Polygon canvas switches to `observer(PolygonCanvas)` reading from the pool.
- Other measurement readers (`useProjectMeasurements`) stay on TanStack Query for safety. Drift detection still on.
- Offline queue bridge: `pool/queue.ts` reads from the existing `sitelayer-offline.mutations` IndexedDB store so in-flight queued mutations from before the upgrade still replay. After 2 weeks of zero queued legacy rows, switch off the bridge.

**Exit criterion:** Polygon canvas runs purely from pool. `invalidateQueries({queryKey: ['takeoff']})` calls in `apps/web/src/lib/api/takeoff.ts` no longer cause a refetch because no component subscribes — but they stay in place as belt-and-suspenders until Phase 4.

### Phase 3 — Migrate remaining readers off TanStack Query for pilot (1 week)

- `useProjectMeasurements`, all measurement tag/assembly readers move to pool subscriptions.
- Drift detection turned off.
- Remove the TanStack→pool hydration bridge for measurements.
- **Pool is now sole source of truth for takeoff_measurements.**

**Exit criterion:** No `useQuery` referencing `['takeoff', 'measurements', ...]` exists in the codebase. Manual smoke test on 4G/3G throttle: 50 polygons drawn while offline → reconnect → all sync, no duplicates, no UI flicker.

### Phase 4 — Contract: remove `invalidateQueries` for pilot, then repeat for each remaining resource (per resource: 1.5–2 weeks)

For each remaining resource in §2.1:

1. Add `ObservableModelStore<T>` instance + IndexedDB hydration. (~1 day)
2. Server endpoints add `deltas`. (~1–2 days)
3. Wire shadow-pool, verify drift = 0 for ≥3 days. (~3 days)
4. Migrate writers, then readers. (~3 days)
5. Remove `invalidateQueries` calls for that resource. (~0.5 day)
6. Update offline queue handlers in `apps/web/src/lib/pool/replay.ts` to enqueue into the pool instead of plain HTTP retry. (~1 day)

Recommended order (lowest cross-coupling first):

1. `takeoff_measurements` (pilot — already covered above)
2. `clock_events` (volume, already offline-queued, contained surface)
3. `labor_entries` (joins to clock_events; do them together effectively)
4. `daily_logs` (medium complexity, photos)
5. `daily_log_photos`
6. `time_review_runs` (last because it's an XState workflow with `state_version` plumbing — needs careful design)
7. `projects` (last because every screen reads it — small surface area but huge blast radius if wrong)

### Phase 5 — Remove the legacy offline queue (0.5 week)

- Delete `apps/web/src/lib/offline/queue.ts` and `replay.ts`.
- Drop the `sitelayer-offline` IndexedDB database (one-time client-side migration on boot — check both DBs, copy any stragglers, delete the old DB).
- Drop offline-related Sentry breadcrumbs that double-up with pool ones.

---

## 7. Risks (ranked by user-impact severity)

### 7.1 IndexedDB quota on iPads (HIGH)

Safari's per-origin quota is the binding constraint. 50 MB sounds large but a foreman with 12 photos × 3 MB pending = 36 MB **before** the pool itself adds rows.

Mitigations:

- Photos drop their blob from IndexedDB the moment upload succeeds.
- `navigator.storage.estimate()` poll at boot; surface usage in offline banner once we cross 70%.
- Pool keeps **only rows for the current company + last-touched project**. On project switch, evict rows for the previous project (still safe — they're on the server). Linear does the same thing.
- If a user is offline and the quota fills, the next `enqueueLocalMutation` **fails loud** with a "Storage full" error. The current queue fails silently on a Blob write-through — this is a strict improvement.

**OPERATOR DECISION:** Acceptable to evict rows for non-active projects when offline? (Risk: foreman flips projects mid-job, queued mutations for project A are now strange to reason about.)

### 7.2 Offline conflict resolution complexity grows (MEDIUM)

The current LWW + 412 toast path is narrow (only `takeoff_measurements`). Once 7 resources are in the pool with optimistic local mutations, every conflict path needs explicit decision: LWW, last-write-wins-per-field, or 409+toast. The current ADR (#4) covers measurements only.

Mitigations:

- Keep LWW for everything in the pilot. Only revisit if a specific resource has a known failure mode (e.g. concurrent daily-log edits by two crew members on the same log).
- Each resource gets a one-sentence conflict-policy line in the resource's pool config — explicit, code-reviewable.
- Server-computed deltas are reverted client-side on 409, then re-applied as authoritative — same toast UX as today.

**OPERATOR DECISION:** Should `daily_logs` (where two crew members editing the same log is plausible) use field-level LWW or whole-row LWW? Whole-row is simpler; field-level loses less.

### 7.3 Server-side delta generation correctness (MEDIUM)

Every mutation endpoint changes. Bugs in delta generation = silent data corruption on the client. The current state-of-the-world (return full row, client refetches) is robust against this exact class of bug.

Mitigations:

- Tests at the API level: round-trip property test — `applyDelta(initial, deltas) === serverFinalState`.
- Phase 1 drift detection (shadow pool vs TanStack Query) catches mismatches before they reach users.
- Roll out per-resource, not in a big bang.
- Sentry breadcrumb every time the pool detects a missing/malformed op; aggregate alert if rate exceeds 1/min.

### 7.4 QBO / workflow snapshot resources don't fit the pool model (LOW — already de-scoped)

Deterministic workflows (`rental_billing_runs`, `estimate_pushes`, `labor_payroll_runs`) have a different shape: `WorkflowSnapshot { state, state_version, context, next_events }`. They're not row-keyed. The operator-memory note about "QBO sync deferred to Phase 2 of PWA work" sits adjacent to this: workflows stay on TanStack Query for the duration. **No change.**

### 7.5 PWA + service-worker interaction (LOW)

The current SW (`apps/web/src/pwa/register.ts`) caches the SPA shell, not API responses. The pool sidesteps the SW entirely. No interaction risk if we don't touch the SW.

### 7.6 Test coverage and tooling (LOW–MEDIUM)

Existing tests (`queue.test.ts`, `replay.test.ts`) cover the current offline path. Pool tests would replace them. Two months of dev time across the migration means tests must come along **every commit**, not at the end. Plan budgets explicit time for this; the per-resource estimate above includes it.

---

## 8. Estimates

| Phase                                                                                   | Effort        |
| --------------------------------------------------------------------------------------- | ------------- |
| 0 — Foundations (mobx, store class, persist, jsonpatch, tests)                          | 1 week        |
| 1 — Shadow pool for `takeoff_measurements`                                              | 1 week        |
| 2 — Pilot writer + server delta for `takeoff_measurements`                              | 3 weeks       |
| 3 — Pilot readers migrate; pool is sole source for measurements                         | 1 week        |
| 4a — `clock_events` + `labor_entries`                                                   | 2 weeks       |
| 4b — `daily_logs` + `daily_log_photos`                                                  | 2 weeks       |
| 4c — `time_review_runs`                                                                 | 1.5 weeks     |
| 4d — `projects`                                                                         | 1.5 weeks     |
| 5 — Remove legacy queue                                                                 | 0.5 week      |
| **Total**                                                                               | **~13.5 weeks** |

These are working weeks for **one engineer familiar with the codebase**, not calendar weeks. Real calendar time will be longer with reviews, dogfood cycles, and pilot customer feedback windows.

**Minimum viable pilot:** Phases 0 + 1 + 2 + 3 = **6 weeks** to prove the pattern on `takeoff_measurements`. After that you have honest data on:

- Real IndexedDB quota usage from production foremen.
- Real server delta cost (CPU, bandwidth savings vs full-row).
- Real conflict rate from LWW.
- Real engineer-week cost per resource.

**Recommended decision gate after Phase 3:** stop and reassess. If the pilot says "this is great", continue with the rest. If the pilot says "marginal benefit at high cost", keep takeoff in the pool and **don't** migrate the others — TanStack Query is fine for them.

---

## 9. Open Questions / Operator Decisions

These are **required answers** before any work starts.

### OPERATOR DECISION 1: Bandwidth vs. simplicity trade-off

Linear-style optimistic + delta is most valuable when the server-payload reduction matters (mobile data, slow LTE). Sitelayer's current responses are mostly small (a takeoff measurement row is ~500 bytes; full project response is ~5 KB). Is the win primarily **(a)** UX smoothness (no refetch flicker) or **(b)** bandwidth saving on field tablets?

If (a) only: scope can be smaller — the pool gives smoothness even without server-computed deltas (client could refetch in the background). Simpler implementation, ~5 weeks total instead of 13.5.

If (b): server delta is load-bearing, full plan stands.

### OPERATOR DECISION 2: Quota policy for non-active projects

When IndexedDB usage crosses, say, 70%, should the pool:

- (a) Evict rows for projects the user hasn't touched in N days?
- (b) Refuse new mutations until the user reconnects and syncs?
- (c) Background-upload-and-evict aggressively?

(a) is Linear's approach. (b) is safer but worse UX. (c) is what we'd build for ideal field conditions.

### OPERATOR DECISION 3: Conflict policy per resource

Whole-row LWW is the simplest path. Daily logs have a plausible "two-crew-on-same-log" failure mode. Pick one for the pilot scope (`takeoff_measurements`):

- (a) Whole-row LWW (current, no change). Keep for all resources during migration.
- (b) Field-level LWW for daily logs only.
- (c) Defer to Phase 5 / never (just toast on 409, like today).

Recommend (a) for the duration of this migration. (b) and (c) are post-migration concerns.

### Additional non-blocking questions

- **OQ-A.** Should we keep `vite-plugin-pwa` and offline-shell caching exactly as-is during the migration? (Yes, recommended.)
- **OQ-B.** Do we want server-pushed deltas (WebSocket / SSE) added to the plan as Phase 5, or out-of-scope entirely? (Recommend out-of-scope; revisit after pilot.)
- **OQ-C.** Should `rentals` / `inventory_items` move into the pool eventually? (Read: no, they're office-side; not field-edit-hot.)

---

## 10. What's NOT proposed

To anchor the plan against scope creep:

- **Not** replacing XState. Machines (`bootstrap-refresh`, `offline-replay`, `project-selection`, `estimate-push`, `billing-review`, `time-review`, `project-lifecycle`, `crew-schedule`) stay. They orchestrate **UI state**; the pool holds **domain data**. Same separation as today.
- **Not** rewriting deterministic workflows. `WorkflowSnapshot` stays on TanStack Query.
- **Not** adding a WebSocket / SSE push channel in this migration (Phase 5, later).
- **Not** introducing Zustand / Jotai / Valtio / Redux. MobX is chosen because per-row observability is the unlock; the others would force re-renders on store-level changes (Jotai-atoms or hand-rolled selectors would also work but with more boilerplate).
- **Not** introducing a query builder, ORM, or new HTTP client on either side. `request<T>()` and the existing pg-string SQL stay.
