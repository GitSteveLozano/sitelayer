# Sitelayer Product Direction

## Current Milestone

Build the local pilot workflow first:

1. project setup
2. blueprint upload
3. calibrated takeoff measurements
4. estimate lines
5. daily labor capture
6. material/sub-cost capture
7. margin and bonus summary
8. QBO mapping and simulated sync

This keeps the app useful while production infrastructure is live and the remaining pilot risk is narrowed to large-blueprint handling plus live QBO validation.

## Product Boundary

Sitelayer is a construction operations and derived-insight layer. It is not a replacement ERP or accounting system.

QBO remains authoritative for accounting taxonomy and accounting references. Sitelayer is authoritative for takeoff snapshots, field workflow, local operational history, and derived job-costing analytics.

## Write-Back Policy

Default behavior is pull-first and reconciliation-first.

Write-back is allowed only for explicit pilot actions, such as pushing an estimate after a user review step. Background sync should not silently mutate external accounting data.

## Native Takeoff vs Glue Product

The next milestone is native takeoff plus field workflow because that is the clearest pilot loop for L&A.

The broader "glue product" direction remains valid after the pilot loop works. Integration-only workflows should not displace the core local pilot until blueprint-to-margin is usable end to end.

## External-Validation Work

These are no longer blocked by missing infrastructure, but they still require real service exercises before pilot use:

- live QBO OAuth testing and production token refresh
- large blueprint upload/download behavior against DigitalOcean Spaces
- Sentry/UptimeRobot signal review during a realistic pilot smoke
- final Clerk organization/member mapping for the first customer

## Local-Only Work To Keep Moving

- schema and migration discipline
- API validation, transactions, and tenant constraints
- frontend workflow decomposition
- local file-storage safety
- simulated QBO mapping and sync behavior
- domain fixtures for sample blueprints
- tests that run without live external services
