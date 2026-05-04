# Screen Index

Every screen across all three personas, with a pointer to where it's documented.

## Worker (mobile, dark theme)

| Screen ID | Name | Doc | Screenshot |
|---|---|---|---|
| `wk-today` | Today (clocked-in state) | `worker/README.md` | `worker/screenshots/wk-today.png` |
| `wk-clockin` | Auto clock-in success | `worker/README.md` | `worker/screenshots/wk-clockin.png` |
| `wk-scope` | Today's scope | `worker/README.md` | `worker/screenshots/wk-scope.png` |
| `wk-issue` | Flag a problem | `worker/README.md` | `worker/screenshots/wk-issue.png` |
| `wk-hours` | My week | `worker/README.md` | `worker/screenshots/wk-hours.png` |
| `wk-log` | Photo + note | `worker/README.md` | `worker/screenshots/wk-log.png` |

## Foreman (mobile, light theme)

| Screen ID | Name | Doc | Screenshot |
|---|---|---|---|
| `fm-today` | Today (stacked sites) | `foreman/README.md` | `foreman/screenshots/fm-today.png` |
| `fm-brief` | Brief the crew | `foreman/README.md` | `foreman/screenshots/fm-brief.png` |
| `fm-crew` | Live crew | `foreman/README.md` | `foreman/screenshots/fm-crew.png` |
| `fm-field` | Field events inbox | `foreman/README.md` | `foreman/screenshots/fm-field.png` |
| `fm-blocker-detail` | Resolve a blocker | `foreman/README.md` | `foreman/screenshots/fm-blocker-detail.png` |
| `fm-log` | Daily log builder | `foreman/README.md` | `foreman/screenshots/fm-log.png` |
| `fm-time-review` | Approve hours | `foreman/README.md` | `foreman/screenshots/fm-time-review.png` |

## Estimator — Desktop

| Screen ID | Name | Doc | Screenshot |
|---|---|---|---|
| `home-dashboard` | Calm dashboard | `estimator/README.md` | `estimator/screenshots/home-dashboard.png` |
| `projects-list` | Projects index | `estimator/README.md` | `estimator/screenshots/projects-list.png` |
| `prj-detail` | Project detail (multi-tab) | `estimator/README.md` | `estimator/screenshots/prj-detail.png` |
| `prj-create-sheet` | New project sheet | `estimator/README.md` | `estimator/screenshots/prj-create-sheet.png` |
| `takeoff-canvas` | Takeoff canvas | `estimator/README.md` | `estimator/screenshots/takeoff-canvas.png` |
| `estimate-builder` | Estimate builder | `estimator/README.md` | `estimator/screenshots/estimate-builder.png` |
| `schedule-ahead` | 4-week schedule | `estimator/README.md` | `estimator/screenshots/schedule-ahead.png` |
| `time-queue` | Time approval queue | `estimator/README.md` | `estimator/screenshots/time-queue.png` |
| `rentals-home` | Rental yard home | `estimator/README.md` | `estimator/screenshots/rentals-home.png` |
| `rentals-catalog` | Catalog | `estimator/README.md` | `estimator/screenshots/rentals-catalog.png` |
| `rentals-dispatch` | Dispatch | `estimator/README.md` | `estimator/screenshots/rentals-dispatch.png` |
| `rentals-returns` | Returns | `estimator/README.md` | `estimator/screenshots/rentals-returns.png` |
| `rentals-utilization` | Utilization | `estimator/README.md` | `estimator/screenshots/rentals-utilization.png` |
| `rentals-portal` | Customer portal | `estimator/README.md` | `estimator/screenshots/rentals-portal.png` |
| `invoice-create` | Invoice | `estimator/README.md` | `estimator/screenshots/invoice-create.png` |
| `settings-integrations` | Integrations | `estimator/README.md` | `estimator/screenshots/settings-integrations.png` |

## Estimator — Mobile companion

| Screen ID | Name | Doc | Screenshot |
|---|---|---|---|
| `mb-home` | Mobile home | `estimator/mobile-screens.md` | `estimator/screenshots/mb-home.png` |
| `mb-projects` | Mobile project list | `estimator/mobile-screens.md` | `estimator/screenshots/mb-projects.png` |
| `mb-prj-detail` | Mobile project detail | `estimator/mobile-screens.md` | `estimator/screenshots/mb-prj-detail.png` |
| `mb-takeoff` | Mobile takeoff | `estimator/mobile-screens.md` | `estimator/screenshots/mb-takeoff.png` |
| `mb-estimate` | Mobile estimate review | `estimator/mobile-screens.md` | `estimator/screenshots/mb-estimate.png` |
| `mb-schedule-day` | Mobile day schedule | `estimator/mobile-screens.md` | `estimator/screenshots/mb-schedule-day.png` |
| `mb-time-queue` | Mobile time queue | `estimator/mobile-screens.md` | `estimator/screenshots/mb-time-queue.png` |
| `mb-rentals-catalog` | Mobile rental catalog | `estimator/mobile-screens.md` | `estimator/screenshots/mb-rentals-catalog.png` |
| `mb-rentals-dispatch` | Mobile dispatch | `estimator/mobile-screens.md` | `estimator/screenshots/mb-rentals-dispatch.png` |
| `mb-invoice-quick` | Mobile quick invoice | `estimator/mobile-screens.md` | `estimator/screenshots/mb-invoice-quick.png` |
| `mb-settings` | Mobile settings | `estimator/mobile-screens.md` | `estimator/screenshots/mb-settings.png` |
| `mb-pwa-install` | PWA install + permissions | `estimator/mobile-screens.md` | `estimator/screenshots/mb-pwa-install.png` |

## System states (apply across all personas)

| Screen ID | Name | Doc | Screenshot |
|---|---|---|---|
| `st-offline` | Offline + queued mutations | `design_system/README.md` | `design_system/screenshots/st-offline.png` |
| `st-error` | Error (integration failure) | `design_system/README.md` | `design_system/screenshots/st-error.png` |
| `st-empty` | Empty (first-run) | `design_system/README.md` | `design_system/screenshots/st-empty.png` |
| `st-loading` | Loading skeleton | `design_system/README.md` | `design_system/screenshots/st-loading.png` |
| `st-perm` | Permission denied | `design_system/README.md` | `design_system/screenshots/st-perm.png` |

## Cross-persona flows (no screens — sequence diagrams)

See `cross_persona/README.md`:

1. **Loop 1 — Morning brief** (estimator → foreman → worker)
2. **Loop 2 — Field event escalation** (worker → foreman → estimator)
3. **Loop 3 — Time → payroll** (worker → foreman → estimator → payroll)
4. **Loop 4 — Daily log** (worker + foreman → estimator)
5. **Loop 5 — Sales loop** (estimator ↔ client)
