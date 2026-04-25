# Project Sitelayer: App Requirements & Implementation Plan

> **🚫 OBSOLETE — DO NOT USE FOR PLANNING (archived 2026-04-25).**
>
> This file describes a Supabase-schema + Edge-Functions + multi-agent workstream plan that was **never built**. The shipped architecture is plain Postgres on DigitalOcean (raw `pg` driver, no RLS, no Edge Functions), a plain Node.js HTTP server (`apps/api/src/server.ts`), a React 19 SPA, and a Postgres-leased queue worker.
>
> Authoritative current state: `CLAUDE.md`, `CRITICAL_PATH.md`, `INFRASTRUCTURE_READY.md`, `DEPLOYMENT.md`.
>
> Original content preserved below for historical context only.

---

## Executive Summary

**Sitelayer** is a centralized operations platform designed for **L&A Operations** to bridge the gap between estimating, project management, and financial analysis.

Following the **"Glue Thesis,"** Sitelayer is a read-only insight layer. It pulls data from disconnected systems (QuickBooks Online, QB Time/ClockShark, and PlanSwift) to derive insights that none of these tools provide individually—such as live division margins, actual labor rates vs. estimated, and bonus pool calculations.

**Critical Constraint:** Sitelayer does not duplicate state or act as a primary system of record for daily operational tasks (e.g., it does not build its own time-tracking UI). It normalizes and surfaces data.

---

## 1. Core Requirements

### R1: Centralized Project Normalization (The "Mapping Layer")

- **Normalized Job IDs:** Map and link disparate Job IDs across QBO (Accounting), QB Time (Labor), and STACK/PlanSwift (Estimating).
- **Service Taxonomy:** Standardized categorization for work types (D1-D9: Stucco, Masonry, Siding, etc.) mapped to QBO Classes.

### R2: Real-Time Performance Monitoring (Derived Insights)

- **Unified Job Margin View:** Compare actual labor hours (from field tracking) and actual costs (QBO Bills) against the estimated budget/takeoff data.
- **Division Margin Rollup:** Calculate gross margin and labor costs per division (Class) to support L&A's bonus pool calculations.
- **Daily Burn-Rate Alert:** Monitor committed costs and accrued labor against the budget to detect profit leaks before completion.

### R3: Integration Stack

- **Accounting:** QuickBooks Online (QBO) for invoices, bills, estimates, and classes.
- **Time/Labor:** QB Time (or ClockShark) for raw labor hours by job and cost code.
- **Estimating:** Takeoff data ingestion (via CSV upload for PlanSwift, or API for STACK).

---

## 2. Multi-Agent Execution Strategy

The implementation is broken down into four parallel workstreams, executed by specialized agents in the Sitelayer workspace.

### Workstream 1: Database & API Architecture

- **Agent Focus:** Supabase schema and Edge Functions.
- **Tasks:**
  - Create the "Mapping Layer" tables (`job_mappings`, `cost_code_mappings`).
  - Set up secure integration token storage and lifecycle management.
  - Implement the Division/Class margin rollup materialized views or functions.

### Workstream 2: Integration Engineering (QBO & Time)

- **Agent Focus:** Node.js/TypeScript backend services.
- **Tasks:**
  - Implement QBO OAuth, CDC sync, and webhook handlers for Invoices, Bills, and Classes.
  - Implement QB Time (or generic time tool) polling for timesheets and job code assignments.
  - Build the reconciliation logic to match time entries to QBO jobs.

### Workstream 3: Frontend Dashboard Development

- **Agent Focus:** React, Vite, shadcn-ui, Tailwind CSS.
- **Tasks:**
  - Build the "Unified Job Margin View" dashboard.
  - Create the "Bonus Pool Calculator" UI for L&A Operations.
  - Develop the mapping UI allowing users to link STACK/PlanSwift assemblies to QBO cost codes.

### Workstream 4: Taxonomy & Data Seeding

- **Agent Focus:** Data scripting and ingestion.
- **Tasks:**
  - Parse the transcribed `IMG-20260403-WA012.md` through `WA018.md` files.
  - Seed the Supabase database with the canonical D1-D9 classes and granular Service Items.
  - Create mock QBO and Time data to unblock frontend development.
