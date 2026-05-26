# Handoff Screen Accounting — every v3.3.0 screen vs. code

**As of:** 2026-05-26 · **Design source:** `docs/handoff/v3.3.0/` (61 screenshots) · Verified by reading each screenshot + opening the implementing file.

## Bottom line

**61 of 61 built ✅** — the two remaining gaps were closed 2026-05-26 and runtime-verified with seeded data:

- ✅ **`prj-create-qb`** — QuickBooks-style customer dedup is now inline in project creation: typing a customer surfaces fuzzy-matched existing customers (with IN ROSTER / IN QUICKBOOKS pills + match %) to link instead of duplicating. `mobile/customer-dedup-picker.tsx` + `mobile/project-new.tsx` (uses existing `/api/customers` + QBO mappings; client-side fuzzy match).
- ✅ **`fm-map`** — dedicated foreman "Crew on site" map screen with geofence rings, project anchors, worker pins by status, in-fence stat strip, and live roster. `mobile/foreman-map.tsx` (reuses `ForemanCrewMap` from `foreman-crew.tsx`), routed at `/map`.

Everything else was implemented and runtime-verified with seeded data.

---

## Worker (6/6 ✅)

| design     | screen                                       | file                        |
| ---------- | -------------------------------------------- | --------------------------- |
| wk-today   | running clock / scope / crew / flag-issue    | `mobile/worker-today.tsx`   |
| wk-clockin | auto clock-in confirm (geofence map)         | `mobile/worker-clockin.tsx` |
| wk-scope   | today's scope + progress bar + steps         | `mobile/worker-scope.tsx`   |
| wk-issue   | flag a problem (category grid + voice/photo) | `mobile/worker-issue.tsx`   |
| wk-hours   | my week (HH:MM, bars, pay summary)           | `mobile/worker-hours.tsx`   |
| wk-log     | camera viewfinder + note                     | `mobile/worker-log.tsx`     |

## System states (5/5 ✅) — all in `components/m-states/index.tsx`

| design     | symbol                           |
| ---------- | -------------------------------- |
| st-offline | `MOfflineHeader`                 |
| st-error   | `MErrorState`                    |
| st-empty   | `MEmptyState`                    |
| st-loading | `MSkeletonRow` / `MSkeletonList` |
| st-perm    | `MPermissionState`               |

## Foreman (10/10 ✅)

| design                     | screen                                | file                                 | status |
| -------------------------- | ------------------------------------- | ------------------------------------ | ------ |
| fm-today                   | multi-site stacked home               | `mobile/foreman-today.tsx`           | ✅     |
| fm-brief                   | morning brief composer                | `mobile/foreman-brief.tsx`           | ✅     |
| fm-crew                    | live crew roster (by site/person/map) | `mobile/foreman-crew.tsx`            | ✅     |
| fm-field                   | field-events inbox                    | `mobile/foreman-field.tsx`           | ✅     |
| fm-blocker-detail          | blocker resolution picker             | `mobile/foreman-blocker-detail.tsx`  | ✅     |
| fm-log                     | end-of-day report builder             | `mobile/foreman-log.tsx`             | ✅     |
| fm-sched                   | foreman schedule lookahead            | `mobile/schedule.tsx`                | ✅     |
| t-foreman / fm-time-review | approve hours                         | `mobile/time-review.tsx`             | ✅     |
| prj-crew-foreman           | project crew tab (foreman)            | `mobile/project-detail/crew-tab.tsx` | ✅     |
| **fm-map**                 | dedicated crew-on-site map            | `mobile/foreman-map.tsx`             | ✅     |

## Estimator — dashboard / nav / projects / pwa (27/27 ✅)

| design            | screen                           | file                                  | status |
| ----------------- | -------------------------------- | ------------------------------------- | ------ |
| db-calm-default   | calm dashboard                   | `mobile/admin-home.tsx`               | ✅     |
| db-calm-filtered  | dashboard + state filters        | `mobile/admin-home.tsx`               | ✅     |
| db-pm             | PM busy-day dashboard            | `owner/today.tsx` (+ today/)          | ✅     |
| nav-drawer        | bottom role tabs                 | `components/m/bottom-tabs.tsx`        | ✅     |
| nav-ios           | iOS safe-area top bar            | `components/m/topbar.tsx`             | ✅     |
| nav-more          | more / settings menu             | `routes/more.tsx`                     | ✅     |
| nav-switch        | role-mode switcher               | `mobile-shell.tsx:RoleModeSwitcher`   | ✅     |
| nav-top           | desktop top bar / company switch | `routes/workspace.tsx`                | ✅     |
| prj-list          | projects index + filters         | `mobile/projects-list.tsx`            | ✅     |
| prj-create-entry  | create entry point               | `mobile/project-new.tsx`              | ✅     |
| prj-create-sheet  | create sheet                     | `mobile/project-new.tsx`              | ✅     |
| **prj-create-qb** | QBO customer dedup on create     | `mobile/customer-dedup-picker.tsx`    | ✅     |
| prj-drafting      | detail (draft)                   | `mobile/project-detail.tsx`           | ✅     |
| prj-progress      | detail (in-progress)             | `mobile/project-detail.tsx`           | ✅     |
| prj-sent          | detail (sent)                    | `mobile/project-detail.tsx`           | ✅     |
| prj-accepted      | detail (accepted)                | `mobile/project-detail.tsx`           | ✅     |
| prj-done          | detail (done)                    | `mobile/project-detail.tsx`           | ✅     |
| prj-archive       | detail (archived)                | `mobile/project-detail.tsx`           | ✅     |
| prj-blueprint     | takeoff canvas                   | `projects/takeoff-canvas.tsx`         | ✅     |
| prj-geofence      | location permission gate         | `onboarding/location-prime.tsx`       | ✅     |
| prj-crew-owner    | project crew tab (owner)         | `mobile/project-detail/crew-tab.tsx`  | ✅     |
| prj-share         | estimate share sheet             | `projects/estimate-share-sheet.tsx`   | ✅     |
| pwa-splash        | post-install splash              | `onboarding/post-install-splash.tsx`  | ✅     |
| pwa-sheet         | install prompt sheet             | `onboarding/install-prompt-sheet.tsx` | ✅     |
| pwa-notif         | notifications prime              | `onboarding/notifications-prime.tsx`  | ✅     |
| pwa-loc           | location prime                   | `onboarding/location-prime.tsx`       | ✅     |
| pwa-safari        | safari add-to-home guide         | `onboarding/safari-landing.tsx`       | ✅     |

## Estimator — rentals / schedule / settings / time (14/14 ✅)

| design        | screen                       | file                                            |
| ------------- | ---------------------------- | ----------------------------------------------- |
| rent-cat      | rentals catalog              | `mobile/rentals.tsx`                            |
| rent-dispatch | dispatch equipment           | `mobile/rentals-dispatch.tsx`                   |
| rent-return   | return check-in              | `rentals/rental-return-sheet.tsx`               |
| rent-scan     | QR scan deliver/return       | `mobile/rentals-scan.tsx`                       |
| rent-util     | utilization dashboard        | `mobile/rentals-utilization.tsx`                |
| sch-day       | day schedule                 | `projects/schedule/day-view.tsx`                |
| sch-week      | week / 4-week grid           | `projects/schedule.tsx`                         |
| sch-create    | new assignment sheet         | `projects/schedule/create-assignment-sheet.tsx` |
| set-home      | settings home + integrations | `settings/settings-home.tsx`                    |
| set-pricing   | pricing book                 | `settings/catalog-pricing-profiles.tsx`         |
| set-team      | team roster                  | `settings/catalog-workers.tsx`                  |
| t-burden      | labor cost / burden          | `owner/labor-burden.tsx`                        |
| t-cross       | time anomalies               | `owner/time-anomalies.tsx`                      |
| t-vs          | live vs budget               | `owner/live-vs-budget.tsx`                      |

---

## To close the 2 gaps

- **prj-create-qb**: add a QBO customer-dedup step to `project-new.tsx` (search existing QBO customers, link/create). Needs the QBO customer-list API surfaced to the SPA.
- **fm-map**: build a dedicated crew map screen (real cartography) — or accept the existing `foreman-crew` Map mode for the pilot.
