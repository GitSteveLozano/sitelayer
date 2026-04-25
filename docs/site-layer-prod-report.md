# Sitelayer Tech Stack Report

> **🟡 RESEARCH ARTIFACT — preserved for historical context (banner added 2026-04-25).**
>
> Pre-build research. Some recommendations were taken (DigitalOcean managed Postgres, Spaces, Sentry, UptimeRobot) and some were *not*: shipped worker is a **bespoke Postgres-leased queue** (`packages/queue`), **not Hatchet**. Annotation is **inline SVG**, **not Konva.js**. Frontend is a **Vite SPA**, not Next.js. Read for decision history; do not use as a stack reference.
>
> Canonical stack: `CLAUDE.md`. Live infra: `INFRASTRUCTURE_READY.md`.

**Construction SaaS — Blueprint Takeoff, QBO-Integrated, Multi-Tenant B2B**
**April 2026 — Decision-Ready Reference (Pricing Verified April 23, 2026)**

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architectural Principles](#2-architectural-principles)
3. [Layer-by-Layer Recommendations](#3-layer-by-layer-recommendations)
4. [Pricing Walkthrough at 3 Scale Points](#4-pricing-walkthrough-at-3-scale-points)
5. [Scale Path — What Changes When](#5-scale-path--what-changes-when)
6. [Critical Decisions Ranked](#6-critical-decisions-ranked)
7. [Honest Risks and Pushback](#7-honest-risks-and-pushback)
8. [Recommended Build Order (First 6 Months)](#8-recommended-build-order-first-6-months)
9. [Appendix: Things the Research Uncovered](#9-appendix-things-the-research-uncovered)

---

## 1. Executive Summary

### The Final Recommended Stack

| Layer                        | Pick                                       | Monthly Cost (1 customer) | Monthly Cost (200 customers) |
| ---------------------------- | ------------------------------------------ | :-----------------------: | :--------------------------: |
| VPS (Premium Intel)          | DigitalOcean TOR1 (4 vCPU / 8 GB)          |            $48            |           $96–$192           |
| Droplet Backups (20% add-on) | DO Weekly Backups                          |           $9.60           |        $19.20–$38.40         |
| Managed Postgres             | DO Managed Postgres (1 GB start → 4 GB HA) |          $15.23           |             $122             |
| Managed Valkey (Redis)       | DO Managed Valkey 1 GB                     |        $0 (on-VPS)        |             $30              |
| Object Storage               | DigitalOcean Spaces TOR1                   |            $5             |           $60–$130           |
| Auth                         | Clerk (free tier — see note on ambiguity)  |            $0             |            $0–$25            |
| Background Jobs              | Hatchet (self-hosted Lite)                 |            $0             |              $0              |
| Email                        | Postmark Basic (10K emails)                |            $15            |           $15–$69            |
| Error Tracking               | Sentry Team                                |            $26            |             $26              |
| Logs + Metrics               | Grafana Cloud free → paid                  |            $0             |            $0–$70            |
| Uptime                       | UptimeRobot free                           |            $0             |              $0              |
| Deploy Orchestration         | Coolify (self-hosted)                      |            $0             |              $0              |
| Source Control / CI          | GitHub Team ($4/user × 2) + Actions        |            $8             |            $8–$15            |
| Frontend                     | Next.js 15 (standalone)                    |         $0 (OSS)          |           $0 (OSS)           |
| PDF + Canvas                 | PDF.js 5.x + Konva.js                      |         $0 (OSS)          |           $0 (OSS)           |
| ORM                          | Drizzle ORM + postgres.js                  |         $0 (OSS)          |           $0 (OSS)           |
| UI Components                | shadcn/ui + Mantine + Tremor               |         $0 (OSS)          |           $0 (OSS)           |
| QBO SDK                      | intuit-oauth + @apigrate/quickbooks        |            $0             |              $0              |
| Analytics                    | PostHog Cloud (free tier)                  |            $0             |              $0              |
| BI (internal)                | Metabase OSS (self-hosted)                 |            ~$5            |             ~$5              |
| Domain (.com, amortized)     | Registrar (Cloudflare/Porkbun)             |            ~$1            |             ~$1              |
| **TOTAL (1 customer)**       |                                            |       **~$102/mo**        |              —               |
| **TOTAL (200 customers)**    |                                            |             —             |     **~$762–$1,075/mo**      |

All prices USD, verified against live vendor pricing pages on April 23, 2026. DigitalOcean is the single-provider anchor. Clerk, Postmark, Sentry, GitHub, and Grafana Cloud are the justified exceptions to that anchor — each one plugs a gap DigitalOcean cannot fill at comparable price or quality.

**Pricing changes from the prior draft of this report:**

1. **DO weekly backups are 20% of the Droplet price, not a flat $5** — on a $48 Droplet this is $9.60/mo, not $5. The prior draft understated this by ~$4.60/mo.
2. **Postmark Basic verified at $15/mo for 10K emails** (prior draft said $16.50–$17). Postmark Pro at $17/mo is a separate, higher tier; for transactional-only volume at Phase 1, Basic is the correct pick.
3. **Clerk free tier is currently ambiguous.** [Clerk's own pricing page](https://clerk.com/pricing) shows **10,000 MAU free** as of April 23, 2026. Third-party aggregators (saasprices.net) claim a 50,000 MAU free tier from a February 2026 pricing overhaul, but this is not reflected on Clerk's live page. **Assume 10K MAU until verified on Clerk's page directly.** For a B2B product with 5–10 users per customer, 10K MAU still covers 1,000 construction companies — the free tier remains a non-issue at any realistic early-stage scale.
4. **GitHub Actions pricing shift (March 1, 2026):** GitHub reduced hosted runner prices by 39% effective Jan 1, 2026, but introduced a **$0.002/minute fee on self-hosted runners** effective March 1, 2026. If you planned to run self-hosted CI runners on your Droplet to save money, that math changed. For typical CI volume (~500–2,000 minutes/mo) the self-hosted fee is ~$1–4/mo — still negligible, but no longer zero.
5. **DO per-second billing became effective January 1, 2026** — this helps short-lived ephemeral Droplets (CI, staging previews) but does not change steady-state monthly pricing.

---

### Total Monthly Cost at 3 Scale Points (verified April 23, 2026)

| Line Item                               |      1 Customer      |   20 Customers    |     200 Customers     |
| --------------------------------------- | :------------------: | :---------------: | :-------------------: |
| VPS — app server(s) (Premium Intel)     |   $48 (4vCPU/8GB)    |   $96 (2× 8 GB)   |    $192 (4× 8 GB)     |
| Droplet weekly backups (20% of Droplet) |        $9.60         |      $19.20       |        $38.40         |
| Managed Postgres                        | $15.23 (1 GB shared) |  $61 (4 GB ded.)  | $122 (4 GB + standby) |
| Managed Valkey/Redis                    |     $0 (on VPS)      |   $15 (1 GB DO)   |     $30 (2 GB DO)     |
| Object Storage (DO Spaces TOR1)         |          $5          |        $20        |       $60–$130        |
| Auth (Clerk free tier)                  |  $0 (under 10K MAU)  |        $0         |        $0–$25         |
| Email (Postmark Basic 10K)              |         $15          |        $15        |    $69 (Pro @ 50K)    |
| Error Tracking (Sentry Team)            |         $26          |        $26        |          $26          |
| Logs/Metrics (Grafana Cloud)            |          $0          |        $0         |        $0–$70         |
| Background Jobs (Hatchet Lite)          |          $0          |        $0         |          $0           |
| Deploy Tool (Coolify)                   |          $0          |        $0         |    $18 (mgmt VPS)     |
| Uptime (UptimeRobot)                    |          $0          |     $7 (Pro)      |          $7           |
| GitHub Team (2 users) + Actions         |        $8–$10        |      $8–$12       |        $8–$15         |
| Analytics (PostHog free)                |          $0          |        $0         |          $0           |
| BI (Metabase OSS VPS share)             |   $0 (on app VPS)    |        $10        |          $10          |
| Load Balancer (DO)                      |          $0          |        $0         |          $12          |
| Domain (amortized)                      |          $1          |        $1         |          $1           |
| **Total**                               |     **~$102/mo**     | **~$283–$289/mo** |  **~$762–$1,075/mo**  |

The 200-customer scenario does not require a dramatic infrastructure rebuild. You double your app server count, upgrade Postgres to HA, and add a managed Redis. That's it. The stack at 1 customer is architecturally the same stack at 200 customers.

**Reading the ranges:** At 1 customer, ~$102/mo reflects the minimum viable production stack (DO Droplet + backups + 1 GB shared Postgres + Postmark Basic + GitHub Team for 2 users). The $283–$289/mo figure at 20 customers reflects the jump to a dedicated 4 GB Postgres, managed Valkey, Sentry Team, and Coolify on a dedicated management VPS. The $762–$1,075/mo range at 200 customers is driven by (a) object storage egress ($60–$130 depending on blueprint download patterns), (b) Grafana Cloud Pro ($0–$70 depending on log volume), and (c) QBO CorePlus overage ($0–$300 depending on read-heavy feature use).

---

### Vendor Count

The full stack uses **11 distinct vendors**: DigitalOcean (compute + storage + DB), Clerk, Postmark, Sentry, Grafana Cloud, UptimeRobot, PostHog, GitHub, Hatchet (self-hosted, so really just "you"), QBO (Intuit), and Metabase OSS. If you drop UptimeRobot (free, near-zero friction) and include QBO as a business integration rather than infrastructure, you're at 9.

This is not sprawl. Sprawl is five different compute providers, three databases, two queues, and a CDN vendor that changes pricing every 6 months. This is a consolidated set of purpose-specific tools, most of which you will never touch once configured.

---

### The 5 Decisions That Matter Most

**1. Multi-tenant data model discipline — from commit one.** Every table that holds tenant data gets a `company_id`. Row-Level Security (RLS) as a backstop. This decision compounds: get it wrong at 5 customers and you're doing a data migration at 50. The column is free; the refactor is not.

**2. Durable job queue for QBO, not a raw queue.** BullMQ is the wrong tool for a 5-step OAuth-refresh/paginate/reconcile QBO sync that runs for 90 seconds. If step 3 fails, you need to retry from step 3, not from scratch. Hatchet's step-level workflows are built for exactly this. Installing Hatchet Lite is one Docker image.

**3. Store PDF coordinates in PDF space, not canvas pixels.** This is so important it belongs in the critical decisions list alongside the business architecture. One line of bad coordinate handling — persisting canvas pixels instead of PDF points — and your annotations drift on every zoom. The fix requires a data migration. The research section covers the exact API call: `viewport.convertToPdfPoint(canvasX, canvasY)`.

**4. Auth org/tenancy configured before the first line of application code.** Clerk's organization model is set up once; changing it later when you have 50 customers requires re-mapping every user. The JWT claims shape, the org metadata schema, and the role hierarchy should be designed before you write a single protected route.

**5. Accounting adapter interface, not direct QBO calls.** Don't scatter `qboRequest(realmId, ...)` calls throughout your codebase. Define an interface: `accountingAdapter.createEstimate(tenantId, data)`. QBO is the first implementation. When someone asks for Xero (common in Canada/Australia), you add an implementation, not a refactor.

---

### Honest Pushback on the Founder's Own Premises

**"Single VPS, consolidate everything" has real tradeoffs.**
The anti-sprawl instinct is correct for Phase 1. Running Postgres on the same box as your app saves $30–61/mo and is fine at 1–5 customers. But if that box has an incident at 2am and you're both the on-call engineer and the only developer, you want a managed DB that never needs your intervention. The cost of DigitalOcean Managed Postgres ($30/mo) is not the cost of the service — it's the insurance against Saturday night page alerts about disk space, replication lag, or a corrupt index.

**Canadian data residency probably does not matter to your customers.**
PIPEDA does not require data to reside in Canada. Quebec Law 25 (the most aggressive Canadian privacy law) has data governance requirements but does not mandate Canadian hosting. Your typical 10-person general contractor customer does not know where their data lives and does not care. If a future enterprise customer requires Canadian residency, it becomes relevant. For the "prove with one" phase, it is not a technical constraint — it is a preference. This does not mean you should store data in Germany; DigitalOcean TOR1 is easy and costs nothing extra. But don't let it become a constraint that disqualifies cheaper or better options.

**"Rolling your own" for email will hurt you on the first invoice that goes to spam.**
Self-hosted transactional email is not viable in 2026 for SaaS product email. Port 25 is blocked by most VPS providers. IP reputation takes months to build. Postmark at $17/mo is not sprawl — it is the cheapest way to guarantee invoices and auth emails reach inboxes. This is one external service that earns its place.

**Hetzner would be cheaper, but it breaks the consolidation goal.**
At face value, Hetzner CPX31 ($25/mo, 4 vCPU, 8 GB, post-April-2026 pricing) is half the cost of a DigitalOcean 8 GB droplet ($48). But Hetzner has no managed Postgres, no managed Redis, no Canadian datacenter, and no Canadian object storage. You would add Neon ($19/mo) for Postgres, Upstash (~$10/mo) for Redis, and Backblaze B2 (~$7/mo) for storage — and now you have four providers, four billing cycles, four support tickets when something breaks. The total is similar to DigitalOcean with more operational surface area.

---

## 2. Architectural Principles

### Single-Provider Bias Justified With Numbers

DigitalOcean TOR1 offers compute, managed Postgres, managed Redis (Valkey), S3-compatible object storage with Canadian residency, load balancers, block storage, and Kubernetes — all in one region, one dashboard, one billing account, and one support ticket queue. The managed Postgres entry tier is $15/mo (1 GB shared) or $30/mo (2 GB dedicated), which is the cheapest managed Postgres available from a serious provider with a Canadian datacenter.

Compare the all-DigitalOcean bill at 1 customer (~$131/mo) against a theoretical "best price for each service" bill:

- Hetzner CPX21 (compute): $14
- Neon (Postgres): $19
- Upstash (Redis): $10–20
- Backblaze B2 + Cloudflare (storage): $3–7
- Subtotal: ~$46–60 + the ops time of maintaining four providers, four dashboards, four sets of network peering configuration, and four points of failure

The savings evaporate under any honest accounting of time.

### When to Break That Rule

**Email.** DigitalOcean does not offer transactional email. Postmark is the best-in-class deliverability option at $17/mo. The alternative — running your own SMTP relay — is not a realistic option (see Section 7).

**Auth.** DigitalOcean has no auth product. Building auth yourself in 2026 is a month of work to produce an inferior version of Clerk's B2B organizations, MFA, impersonation, and SAML readiness. The exception is legitimate.

**Error tracking.** DigitalOcean has no error tracking product. Sentry Team at $26/mo is the industry standard and the DX is irreplaceable during early debugging. Switch to GlitchTip (self-hosted) when Sentry costs compound.

**Observability.** Grafana Cloud's free tier (10K metric series, 50 GB logs/mo, 3 users) covers you until serious scale. DigitalOcean's native monitoring is a status page, not an observability tool.

### Build-vs-Buy Heuristics for This Product

Build it if:

- It is your core product (PDF canvas, takeoff logic, QBO sync)
- The vendor would price you out by the time you have real revenue
- The build is a one-time investment with low ongoing maintenance

Buy it if:

- Failure of this component at 2am means customer impact
- The vendor's code surface area is larger than you want to own (auth, email deliverability, error aggregation)
- The cost is below your hourly rate multiplied by the hours to build and maintain

The PDF canvas is your core product. Build it. Auth is not your core product. Buy it.

### The "Design for 20, Don't Build for 200" Principle

At 1 customer, your Postgres has near-zero query load. At 200 customers with daily QBO syncs, you will have millions of rows and real query patterns. The discipline is:

- Design the schema as if 200 customers exist (proper indexes, `company_id` on every table, no cross-tenant shortcuts)
- Build only the features the first customer needs
- Do not prematurely add read replicas, sharding, or distributed caches until query times actually degrade

Premature optimization at this stage is wasted time. Late schema design — `company_id` added as an afterthought at 30 customers — is a crisis.

---

## 3. Layer-by-Layer Recommendations

### Layer 1: VPS Provider

**The Pick: DigitalOcean (Toronto, TOR1)**

Start with a Basic 8 GB Droplet ($48/mo, 4 vCPU, 160 GB SSD, 5 TB bandwidth). Run your Next.js app, Hatchet worker, and Redis all on this box at 1–10 customers. At 20+ customers, split into separate app and worker droplets.

| Tier    | Plan          | vCPU | RAM   | Bandwidth | Price/mo |
| ------- | ------------- | ---- | ----- | --------- | -------- |
| Start   | Basic 4 GB    | 2    | 4 GB  | 4 TB      | $24      |
| Default | Basic 8 GB    | 4    | 8 GB  | 5 TB      | $48      |
| Scaled  | CPU-Opt 16 GB | 8    | 16 GB | 6 TB      | $168     |

Why DigitalOcean:

- The only VPS provider with managed Postgres, managed Redis, AND object storage all in a Canadian datacenter (TOR1)
- 99.99% SLA on Droplets
- Best developer dashboard of any non-hyperscaler
- Spaces CDN PoPs in Toronto, Montreal, Calgary, Vancouver
- Established support channel (not Hetzner's email-only model)

**Runner-Up: OVHcloud (Beauharnois, QC)**

OVHcloud's VPS tiers in Beauharnois are aggressively priced (~$6–20/mo for 4–8 vCPU), and their object storage has zero egress charges. If you ever need bare metal at scale, their Advance series starts at $160/mo in Beauharnois — unbeatable for a Canadian-resident bare metal server.

When to pick OVH instead: You've validated product-market fit, you have 50+ customers generating real revenue, and you're doing a full infrastructure cost review. At that stage, OVH's unlimited-bandwidth Public Cloud and cheap bare metal become genuinely compelling. Not at Phase 1.

**Alternatives Rejected**

| Provider      | Reason Rejected                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Hetzner       | No managed DB, no Canadian datacenter, no Canadian object storage — breaks consolidation entirely |
| Vultr         | Managed Postgres starts at $90/mo (6× DO's entry tier); object storage $18/mo minimum             |
| Linode/Akamai | No Canadian object storage cluster despite Toronto compute DC; managed DB starts at $82/mo        |
| Scaleway      | EU-only, no North American presence                                                               |
| Contabo       | No managed services, CPU oversubscription, 99.6% SLA, no load balancer product                    |

**Pushback:** DigitalOcean has had incidents. Their January 2026 Kubernetes networking event and October 2025 DOKS incident are real. Individual Droplets have historically been very stable, but if you're running everything on one droplet and DigitalOcean has a bad day in TOR1, you're down. The mitigation is: separate managed DB (survives compute incidents), object storage on a different failure domain, and Coolify/Kamal for rapid redeploy if a Droplet needs replacement.

---

### Layer 2: Managed Postgres

**The Pick: DigitalOcean Managed Postgres (TOR1)**

| Tier  | vCPU             | RAM  | Storage | Price/mo | When                       |
| ----- | ---------------- | ---- | ------- | -------- | -------------------------- |
| Entry | 1 shared         | 2 GB | 30 GB   | $30      | 1–30 customers             |
| Mid   | 2 ded.           | 4 GB | 60 GB   | $61      | 30–100 customers           |
| HA    | 2 ded. + standby | 4 GB | 60 GB   | $122     | When MRR commitments exist |
| Scale | 4 ded. + standby | 8 GB | 140 GB  | $244     | 100–200+ customers         |

Why: same VPC as your droplets (sub-1ms latency, zero egress charges), automatic daily backups, PITR, one-click standby replica, PG16/17 support, `pg_stat_statements` enabled by default.

**Runner-Up: Crunchy Data Bridge (Hobby-2, $35/mo on AWS)**

Crunchy employs more Postgres core contributors than any other company. Their Hobby-2 tier ($35/mo) gives you a full-extension catalog including pgvector, PostGIS, and pg_partman on dedicated hardware. If your data model evolves to need serious Postgres extensions, Crunchy is worth the cross-provider complexity. At Phase 1, it is unnecessary overhead.

**Alternatives Rejected**

| Option                 | Reason Rejected                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Self-hosted on VPS     | Saves $30/mo, costs you every backup, upgrade, and disk-full incident                                                 |
| Neon (serverless)      | Cold starts on always-on multi-tenant app; per-CU-hour billing unpredictable; Databricks acquisition adds uncertainty |
| Vultr Managed Postgres | $90/mo minimum — 3× DigitalOcean for the same hardware                                                                |
| OVH Managed Postgres   | $87/mo minimum in US — similar problem                                                                                |

**Dev/CI: Neon Free Tier**

Use Neon's free tier (5 GB, branching) for development environments and CI preview databases. Branch from a production snapshot in <1 second. Keep production strictly on DigitalOcean.

**Pushback:** DigitalOcean's managed Postgres is not Crunchy. It runs standard Postgres without specialized tuning, and the $15/mo entry tier is shared compute that can have noisy-neighbor effects. The $30/mo tier is dedicated. For a construction SaaS with real customers, budget $30/mo from day one and don't fight the shared tier.

---

### Layer 3: Object Storage

**The Pick: DigitalOcean Spaces TOR1**

$5/mo includes 250 GiB storage and 1 TiB outbound. Additional storage at $0.02/GiB, additional egress at $0.01/GiB. Built-in CDN with PoPs in Toronto, Montreal, Calgary, and Vancouver. Full S3-compatible API, presigned URL support for blueprint delivery.

Why over R2 or B2: Canadian data residency, zero configuration complexity, one bill. At 100 GB stored and 500 GB egress (early-stage), the bill is $5. At 500 GB stored and 2 TB egress (20 customers), it's ~$20. At 2 TB stored and 10 TB egress (200 customers), it's ~$130. That $130 at 200 customers is the cost of simplicity — R2 would be ~$30, a saving of $100/mo, which is real money at scale.

| Provider                      | 100GB/500GB egress | 500GB/2TB | 2TB/10TB |  Canadian Region  |
| ----------------------------- | :----------------: | :-------: | :------: | :---------------: |
| Cloudflare R2                 |         $1         |    $7     |   $30    | No (global edge)  |
| Backblaze B2 + Cloudflare CDN |         $3         |    $8     |   $14    |   No (US-West)    |
| OVHcloud (BHS/TOR)            |         $3         |    $15    |   $59    |        Yes        |
| **DigitalOcean Spaces TOR1**  |       **$5**       |  **$20**  | **$130** | **Yes (Toronto)** |
| Wasabi Toronto                |        $7\*        |   $7\*    |  $14\*   |        Yes        |
| AWS S3 ca-central-1           |        $47         |   $193    |   $951   |        Yes        |

\*Wasabi numbers are storage-only. Their 1:1 egress-to-storage ratio limit means a construction SaaS that actively serves blueprints will be throttled or suspended. See Appendix.

**Runner-Up: OVHcloud Object Storage (Beauharnois or Toronto)**

At 2 TB stored with 10 TB egress, OVHcloud costs ~$59/mo vs DO's $130/mo because OVHcloud has zero egress charges on object storage. If you're growing fast and storage egress becomes significant, migrating from DO Spaces to OVH's S3-compatible API is straightforward with rclone. Both have Canadian data residency.

**Alternatives Considered**

| Option                 | Status                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Cloudflare R2          | Best cost option, but no dedicated Canadian region without Enterprise tier          |
| Backblaze B2           | Price increase to $6.95/TB effective May 2026; no Canadian region                   |
| Wasabi                 | Do not use — egress ratio rule will throttle a serving-heavy SaaS                   |
| Self-hosted (MinIO CE) | Archived February 2026 — no longer an option. AIStor is commercial                  |
| AWS S3 ca-central-1    | $951/mo at scale vs $130 DO or $59 OVH — unjustifiable without enterprise contracts |

**Pushback:** The consolidation rationale for DO Spaces is entirely valid at Phase 1. At 200 customers with 2 TB of blueprints and heavy download patterns, you're spending $130/mo on storage when OVHcloud or Cloudflare R2 would cost $30–59/mo. That is worth a migration conversation — especially since it's an S3 API swap and a rclone sync. Don't let consolidation dogma cost you $70–100/mo at scale.

---

### Layer 4: Auth

**The Pick: Clerk (free tier, upgrade to Pro $25/mo when needed)**

**April 23, 2026 verification note — the free tier is currently ambiguous.** [Clerk's own pricing page](https://clerk.com/pricing) shows **10,000 MAU free**. Third-party aggregators (saasprices.net, F6S) have published conflicting numbers claiming a February 2026 overhaul raised the free tier to 50K MAU, but Clerk's live page does not reflect this. **Assume 10K MAU until you verify on Clerk's own page directly.** For a B2B SaaS scaling to 200 customers with 5–10 users each (1,000–2,000 MAU total), even the conservative 10K limit is a non-issue — the free tier remains free until ~1,000 construction companies. The Pro tier at $25/mo activates custom domains and advanced features, but even that is optional until you have paying enterprise customers.

What Clerk buys you: multi-organization support, impersonation (critical for support), MFA, branded emails, SAML/SSO readiness (metered when needed), and Next.js components that are better than anything you'd build in a month. The organization model maps directly to Sitelayer's tenant model.

| Auth Option           | B2B Org Model | Impersonation | Next.js Native |     Cost at 2K MAU     |
| --------------------- | :-----------: | :-----------: | :------------: | :--------------------: |
| **Clerk**             |      ✅       |      ✅       |    ✅ Best     |           $0           |
| Kinde                 |      ✅       |    Unclear    |      Good      |  $0 (10.5K MAU free)   |
| WorkOS/AuthKit        |      ✅       |      ✅       |      Good      |    $0 (1M MAU free)    |
| Better Auth (library) | ✅ (build it) |   Build it    |     Native     |     $0 (no vendor)     |
| Auth0                 |      ✅       |      ✅       |      Good      | ❌ 5-org limit on free |

**Runner-Up: Kinde**

Kinde's $75/mo flat rate for unlimited SSO connections is better than Clerk's per-SAML-connection model if you expect to onboard enterprise customers that require SAML in the near term. At early stage, Clerk's free tier wins. Revisit Kinde when you add your first SAML enterprise customer.

**Alternatives Rejected**

| Option                | Reason Rejected                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0                 | 5-organization limit on free tier — immediately insufficient for a multi-tenant SaaS                                                                                                   |
| Better Auth (library) | Legitimate option, but: build vs. buy analysis favors Clerk when impersonation, org management, and SAML are all needed; budget 3–4 weeks of engineering to match Clerk's B2B features |
| WorkOS                | Excellent product but the $125/SSO-connection model is expensive when you're adding construction company customers one by one; better fit for enterprise-first products                |
| Lucia Auth            | Deprecated — see Appendix                                                                                                                                                              |
| AWS Cognito           | DX is genuinely bad; building multi-tenant org model on Cognito requires Lambda triggers and custom attribute mapping; not worth the cost savings at this scale                        |

**Pushback:** Clerk is a hosted service that holds your user data. At 200 customers it's still likely free, but a Clerk outage is an authentication outage. The mitigation is a well-designed session token strategy (JWTs with 15-minute expiry, refresh in background) so that a 5-minute Clerk outage doesn't log everyone out. Better Auth is a real option if data sovereignty ever becomes a requirement — it's a library that runs on your VPS with your Postgres.

---

### Layer 5: Background Jobs

**The Pick: Hatchet (self-hosted Lite)**

Hatchet Lite is a single Docker image: `docker run -e DATABASE_URL=... -p 8080:8080 ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest`. It uses your existing Postgres, adds an optional RabbitMQ for high-throughput (unnecessary at early scale), and provides a built-in dashboard showing workflow step execution, failures, and durations. The TypeScript SDK is first-class. Step-level durability means a 5-step QBO sync can fail at step 3 and retry from step 3 — not from scratch.

License: MIT. Cost: $0. Operational overhead: one Docker container that uses your existing DB.

Why step-level workflows matter for QBO: A complete sync involves (1) check token expiry/refresh, (2) fetch QBO webhook events, (3) call CDC for changed entities, (4) reconcile against local DB, (5) write results and update `last_synced_at`. If the CDC call on step 3 hits a rate limit after you've already refreshed tokens, BullMQ restarts from step 1. With Hatchet, step 1 is already persisted and you retry from step 3.

| Option                    | Step Durability |      Dashboard       |     Infra Added      |   Cost   |
| ------------------------- | :-------------: | :------------------: | :------------------: | :------: |
| **Hatchet (self-hosted)** |       ✅        |          ✅          |  1 Docker container  |    $0    |
| Trigger.dev Cloud (Pro)   |       ✅        |          ✅          |    None (managed)    |  $50/mo  |
| Graphile Worker           |       ❌        |          ❌          | None (Postgres only) |    $0    |
| BullMQ (OSS)              |       ❌        | Requires third-party |    Redis required    |    $0    |
| Temporal Cloud            |       ✅        |          ✅          |    None (managed)    | $100+/mo |

**Runner-Up: Graphile Worker + manual state machine**

If Hatchet feels like unnecessary overhead, Graphile Worker (pure Postgres, LISTEN/NOTIFY, near-instant pickup) with a `qbo_sync_jobs` state table is a valid path. You implement the state machine yourself: each step writes its result to the DB, and each subsequent step reads the previous step's output. It requires more code but zero new infrastructure. The gap is observability — you're querying your DB to understand what's happening, not viewing a dashboard.

**Alternatives Rejected**

| Option            | Reason Rejected                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| BullMQ Pro        | $139/mo per deployment for step durability you get free from Hatchet; wrong tool for long-running workflows |
| Inngest Cloud     | $75/mo for Pro; HTTP-callback architecture is a different model from VPS queues                             |
| Temporal          | Cassandra + Elasticsearch self-hosting is SRE-level overhead; $100+/mo cloud minimum; overkill              |
| Defer.run         | Dead since May 2024                                                                                         |
| Cloudflare Queues | Requires Cloudflare Workers runtime; incompatible with Node.js VPS stack                                    |

**Pushback:** Hatchet v1 launched April 2025 — it is younger than BullMQ by years. For a system as critical as QBO sync, younger projects carry real risk. If the project stalls or a major bug appears, you're running unpatched MIT software on your critical background job infrastructure. The mitigation: Hatchet is MIT, so you can fork it. The alternative mitigation: Trigger.dev Cloud Pro at $50/mo is the managed version of the same concept with an established team behind it.

---

### Layer 6: Email

**The Pick: Postmark Basic ($15/mo base for 10K emails), upgrade to Pro for advanced features**

At 10,000 emails/month on Basic: $15 (verified on [Postmark's pricing page](https://postmarkapp.com/pricing), April 23, 2026). At 50,000/month on Pro: ~$69. At 200,000/month: ~$259. Basic includes transactional sending, SPF/DKIM authentication, webhooks, and dedicated IP at higher tiers. Pro adds broadcast streams, message streams isolation, and advanced analytics — not needed for Phase 1 where you're only sending transactional.

Postmark is the industry benchmark for transactional email deliverability. They run separate sending infrastructure for transactional vs. broadcast, which means their transactional IP reputation is never polluted by marketing sends. For a SaaS where missing an invoice email creates a customer support ticket and potentially a disputed payment, Postmark's deliverability premium is worth $16.50/mo.

**Runner-Up: Resend Pro ($20/mo)**

Resend's React Email integration (build templates as TypeScript components) is the best developer experience in this category. At 50K emails/month, it's $20 vs Postmark's $69 — a real $49/mo difference. If your team is TypeScript-first and template maintenance matters, Resend is the right call. If critical financial emails must land in inboxes and you never want to think about deliverability again, pay the Postmark premium.

**Email Volume Reality Check**

If Clerk handles auth emails (magic links, password resets), your actual email volume is lower than it looks. You're sending: estimate notifications, invoice emails, sync error alerts, and weekly reports. For 200 customers with 5 active users each, that might be 5,000–20,000 emails/month — well within Postmark's $16.50 base tier.

**Alternatives Rejected**

| Option      | Reason Rejected                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS SES     | $1/mo at 10K emails, but requires sandbox exit process, manual bounce/complaint handling, SPF/DKIM setup; saves $15/mo, costs 4–8 hours setup |
| SendGrid    | Removed free tier May 2025; deliverability issues on shared IPs; declining developer experience post-Twilio acquisition                       |
| Mailgun     | 100% Flex plan price increase December 2025; now $2/1K for legacy users                                                                       |
| Self-hosted | Not viable — port 25 blocked by DO; IP reputation building takes months                                                                       |
| Mailtrap    | Better for dev sandbox than production deliverability                                                                                         |

**Pushback:** If cost at scale matters more than deliverability premium, AWS SES at $20/mo for 200K emails vs Postmark's $259/mo is a $239/mo difference. That is real money at 200 customers. The setup investment (4–8 hours) pays back in 1 month. If you have the operational discipline to configure SPF/DKIM/DMARC correctly and build a bounce handler webhook, SES is the honest cost-optimized choice. Most founders don't, and then they wonder why their invoices are in spam.

---

### Layer 7: Error Tracking

**The Pick: Sentry Team ($26/mo)**

50,000 errors/month, 5M performance spans, 50 session replays. Best-in-class error grouping, source map integration, and Node.js/Next.js SDK. The multi-tenant filtering via tags (add `tenant_id` to every Sentry scope) is workable and well-documented.

At early scale: the Sentry free Developer tier (5,000 errors/month) may cover Phase 1. Upgrade to Team when error volume or performance monitoring becomes relevant.

**Runner-Up: GlitchTip (self-hosted)**

GlitchTip is a Sentry-compatible error tracker — the Sentry SDK sends to GlitchTip by changing one DSN URL. Self-hosted on a $15/mo VPS. MIT-licensed. Significantly lighter than self-hosted Sentry (no Kafka, no ClickHouse). The trade: no session replay, less sophisticated grouping, smaller community. When your Sentry error volume pushes costs toward $50–100/mo, migrating to self-hosted GlitchTip is a 2-hour job.

**Alternatives Rejected**

| Option             | Reason Rejected                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Highlight.io       | Dead since February 2026 (acquired by LaunchDarkly, standalone service discontinued)                                                   |
| Datadog            | $15/host + $31/host APM + log indexing charges = budget trap; enterprise sales motion; 14-day trial only                               |
| Self-hosted Sentry | Requires Kafka + ClickHouse + Postgres + Redis; needs 8 GB RAM dedicated server; $40–60/mo infrastructure for a $26/mo SaaS equivalent |
| Rollbar            | Less feature-rich than Sentry; $15.83/mo for 25K events compares poorly to Sentry's 50K at $26                                         |

**Pushback:** Sentry's pricing model has a history of escalation. The Team plan at $26/mo is fine now. When you add session replays, performance monitoring, and cron monitoring, the overage billing on spans and errors kicks in quickly. Set budget alerts, configure spike protection, and monitor your monthly usage. At 100K+ errors/month, GlitchTip becomes compelling.

---

### Layer 8: Logs + Metrics

**The Pick: Grafana Cloud (free tier, then Pro)**

The free tier is permanent and no credit card required: 10,000 active metric series, 50 GB logs/month, 50 GB traces/month, 3 users, 13-month metric retention, 30-day log retention. For a Phase 1–2 SaaS, this covers everything.

When you outgrow the free tier, Grafana Cloud Pro billing is usage-based: $0.50/GB logs, $6.50/1,000 metric series, $0.50/GB traces. At moderate scale (5 GB logs/mo, 20K metric series), the bill is ~$70–90/mo.

The PLG stack (Prometheus + Loki + Grafana + Tempo) is the self-hosted equivalent. Run it on your existing VPS for ~$0 added cost if you have spare capacity, or on a dedicated $20/mo VPS. The trade: 2–4 hours/month maintenance (Docker Compose upgrades for Loki/Prometheus/Grafana move independently and occasionally have breaking config changes).

**Runner-Up: Better Stack ($29/responder/mo)**

Better Stack consolidates logs, metrics, uptime monitoring, error tracking, and on-call scheduling in one subscription. For a two-person team where both people are on-call, it's $29–58/mo for everything. The error tracking is Sentry-compatible (same SDK, change the DSN) at 1/6th the price per exception. If consolidation is paramount, Better Stack is the most consolidated option available.

**Alternatives Rejected**

| Option             | Reason Rejected                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Datadog            | See Layer 7 notes; the per-host + APM host + log index triple-billing structure creates surprise invoices    |
| New Relic          | $99/user/month for Standard plan; user-based pricing punishes small teams                                    |
| Self-hosted SigNoz | Apache 2.0, excellent Datadog alternative, but ClickHouse requires 8 GB RAM dedicated; solid option at scale |
| Axiom              | $25/mo base is fine; SaaS-only (no self-host for production); SAML/RBAC as $100/mo add-ons                   |

**Pushback:** Grafana Cloud's free tier sounds like a good deal — and it is — but the moment you need multi-tenant log filtering at scale, Loki's label-based model requires careful planning. Designing your log schema (`{service="qbo-sync", tenant_id="acme"}`) from day one avoids re-indexing pain later. Set this up before you go to production, not after you're debugging a multi-tenant data leak.

---

### Layer 9: Uptime Monitoring

**The Pick: UptimeRobot (free tier)**

50 monitors, 5-minute check intervals, email alerts, status page. Free forever. This covers your app, API, QBO webhook endpoint, and Hatchet dashboard.

When to upgrade: When you have paying customers with SLAs and need 1-minute check intervals or on-call escalation. At that point, Better Stack ($29/responder/mo) adds uptime monitoring plus all of Layer 8 under one subscription.

**Pushback:** 5-minute intervals mean a 4-minute 59-second outage looks like zero downtime. For a B2B SaaS where users might be working in the app during business hours, you want 1-minute intervals at minimum. Budget $7/mo for UptimeRobot Pro (1-minute checks) when you have 5+ paying customers. Do not wait until a customer asks "your app was down this morning, was it?"

---

### Layer 10: Deploy Orchestration

**The Pick: Coolify (self-hosted)**

Coolify installs on a separate 2 GB VPS ($18/mo DO or free if you use a subdirectory of your main server). It provides: git-push deploys from GitHub, automatic HTTPS via Let's Encrypt through Traefik, environment variable management UI, Docker Compose support, database management, automated backups, and one-click service templates. 50,000+ GitHub stars. Active community.

Setup: Deploy Coolify on a management droplet. Add your application droplets as target servers. Connect your GitHub repo. Done.

**Runner-Up: Kamal 2**

Kamal 2 is a CLI tool from 37signals (Basecamp, HEY). Zero web dashboard. SSH-based. `kamal deploy` from GitHub Actions. No additional running processes on your server — it's pure Docker + SSH. Battle-tested at 37signals scale. If you prefer CLI workflows and don't need a GUI, Kamal 2 is architecturally simpler with lower failure surface area than Coolify's Traefik-backed dashboard.

**Alternatives Rejected**

| Option    | Reason Rejected                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dokploy   | Newer codebase (2024 launch), five update failures in six months per mid-2026 reviews; good PR preview environments but instability concern for production |
| CapRover  | Showing its age; UI dated; no preview environments; licensing controversy in 2024                                                                          |
| Dokku     | Git-push Heroku clone; excellent for solo devs; less suited when Docker Compose is your standard artifact                                                  |
| Portainer | Management UI, not a deploy tool; use alongside Kamal 2, not as a deploy solution                                                                          |

**Pushback:** Coolify is still in beta (v4.0.0-beta.437 as of October 2025). The encryption key handling has a documented footgun — a double-click can destroy it, and if the key is lost, you lose access to all environment variables stored in Coolify. Back up the encryption key. Run Coolify on a separate management server from your application servers, so a Coolify issue does not take your app down.

---

### Layer 11: Frontend Framework

**The Pick: Next.js 15 (App Router, standalone output mode)**

Production-stable since October 2024. React 19 support. Turbopack stable in dev. The App Router's Server Components handle the data tables, project list, and estimating views. The canvas takeoff view is entirely a Client Component — no tension with RSC. `output: 'standalone'` for VPS Docker deployment reduces image size 80–90%.

Key: WebSocket works on a VPS (attach a `WebSocketServer` to the same `http.createServer`). Does not work on Vercel — but you're not on Vercel.

Avoid Parallel Routes and Intercepting Routes — thousands of open GitHub issues confirm they're rough edges in 2026.

**Runner-Up: React Router v7 (formerly Remix)**

Zero vendor lock-in, loaders/actions mental model simpler than RSC + Server Actions, identical self-hosting story. The ecosystem is smaller, which matters for a small team. Defensible choice if the RSC mental model bothers you.

**Alternatives Rejected**

| Option         | Reason Rejected                                                                     |
| -------------- | ----------------------------------------------------------------------------------- |
| TanStack Start | RC status as of January 2026; don't start a production SaaS on RC software          |
| SvelteKit      | Different language; react-konva has no Svelte equivalent at the same maturity level |
| Astro          | Content-site framework; wrong tool for complex interactive SaaS                     |
| SolidStart     | Dev server instability reported through November 2025; ecosystem too small          |

**Pushback:** Next.js is Vercel's product. The self-hosting story is fine, but major features are designed with Vercel's edge infrastructure in mind. ISR, edge middleware, and Image Optimization all have VPS workarounds that add friction. None of these are blockers for Sitelayer, but be aware that the framework's main development path is Vercel-optimized.

---

### Layer 12: PDF + Canvas

**The Pick: PDF.js v5.x + Konva.js (react-konva)**

PDF.js (Mozilla) renders blueprints to a `<canvas>` element via a Web Worker. Konva.js (react-konva) provides a declarative React canvas layer for polygon drawing, selection handles, and annotation management. Two canvas elements stacked in the same container div, z-index layered.

The critical rule: store all annotation coordinates in PDF point space, never in canvas pixel space. Use `viewport.convertToPdfPoint(canvasX, canvasY)` before persisting. On load, use `viewport.convertToViewportPoint(pdfX, pdfY)` to render. This is not optional — get it wrong and annotations drift on every zoom change.

The critical footgun: PDF rotation. Construction drawings often have a non-zero `/Rotate` header. When `viewport.rotation !== 0`, you must clone the viewport with `rotation: 0` before calling `convertToPdfPoint`. See [GitHub issue #12003](https://github.com/mozilla/pdf.js/issues/12003).

For blueprints >20 MB: use HTTP Range Requests (PDF.js handles this automatically with correct `Accept-Ranges`/`Content-Range` server headers) and virtualize page rendering (render only 2–3 pages around the current view).

**Commercial Alternative: Apryse WebViewer**

When to seriously consider it:

- You have paying customers and $25K+/year budget
- CAD-generated PDFs are common in your customer base (PDF.js handles ~97–99% of standard PDFs; CAD edge cases are Apryse's specific advantage)
- Mobile field access is a day-1 requirement (Apryse's touch support is better than what you'll build)
- Legal/compliance measurement accuracy matters contractually

Apryse WebViewer: [~$27,590/year median buyer cost (Vendr data, 37 purchases)](https://www.vendr.com/marketplace/apryse), range $6,824–$96,616. The bootstrapped path is PDF.js + Konva. When you have revenue, price Apryse seriously.

**Alternatives Rejected**

| Option            | Reason Rejected                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Fabric.js         | No native React bindings; SVG-based rendering slower than Konva's canvas for annotation scenes |
| Pixi.js           | WebGL overhead; no built-in selection/transformer; overkill for annotation overlays            |
| PSPDFKit/Nutrient | $33,443/year median Vendr cost; more expensive than Apryse                                     |
| Custom Canvas API | 4–6 weeks to rebuild what react-konva provides; wrong tradeoff for a small team                |

**Pushback:** The PDF.js + Konva integration is the hardest part of this stack. Coordinate system management at zoom-to-pointer level, HiDPI handling, touch event normalization, and the rotation edge case are each a half-day of debugging. Budget 3–5 weeks for a production-quality canvas implementation, not 3–5 days. The research documents specific production failures: 35-second load times on dense 5 MB CAD drawings, PDF rotation coordinate drift, mobile pinch-zoom requiring full custom touch event handling. These are not edge cases in construction blueprints.

---

### Layer 13: ORM

**The Pick: Drizzle ORM + postgres.js**

Drizzle passed Prisma in weekly npm downloads in late 2025 (~5.1M vs ~4.3M). SQL-first, TypeScript-native, no binary engines, edge-compatible, human-readable migration SQL. Schema is defined in TypeScript and the generated SQL is reviewable in code review. The `postgres.js` driver is the recommended underlying connection.

For multi-tenant queries: wrap all tenant-scoped queries in a typed helper that enforces `company_id` — never query tenant tables without it.

**Runner-Up: Prisma 7**

Prisma 7 (November 2025) removed the Rust engine entirely — pure TypeScript, 3× faster, 90% smaller bundle. It has recovered significantly from its performance reputation issues. If your team is already Prisma-native, Prisma 7 is a legitimate modern ORM.

**Alternatives Rejected**

| Option  | Reason Rejected                                                                     |
| ------- | ----------------------------------------------------------------------------------- |
| Kysely  | Query builder, not ORM — no schema/migration management; requires more boilerplate  |
| TypeORM | Active-record pattern causes N+1 issues at scale; less TypeScript-safe than Drizzle |
| raw SQL | Maximum control; not worth the boilerplate for a standard CRUD-heavy app            |

**Pushback:** Drizzle's relational query API syntax is idiosyncratic compared to Prisma's `.findMany({ include: {...} })`. For developers coming from Prisma or a traditional ORM, the Drizzle mental model takes a few days to internalize. This is not a reason to avoid it — just budget onboarding time.

---

### Layer 14: UI Components

**The Pick: shadcn/ui + Mantine + Tremor**

shadcn/ui is not a component library you install — it is a CLI that copies unstyled Radix UI components into your project with Tailwind CSS classes. You own the code, so you modify it without fighting a library's override system. For standard UI primitives (dialogs, dropdowns, buttons, forms), shadcn is the correct default.

Mantine provides complex interactive components that shadcn does not: DatePicker, rich DataTable with sorting/pagination/filtering, multi-select, and Spotlight (command palette). Mantine v7 is Tailwind-compatible. For Sitelayer's data tables (estimate line items, material lists, QBO sync status), Mantine's table component saves significant engineering time.

Tremor provides chart primitives (bar charts, line charts, area charts) built on Recharts with Tailwind styling. For internal dashboards and metrics views, Tremor saves the time of building chart components from scratch.

**Pushback:** Three UI libraries is three APIs to understand and three upgrade paths to track. The practical answer: use shadcn for everything first, add Mantine's DataTable when you need it (you will), add Tremor when you need charts. Don't install all three on day one.

---

### Layer 15: QBO SDK

**The Pick: intuit-oauth (OAuth flow) + @apigrate/quickbooks (API calls)**

`intuit-oauth` is Intuit's official library for the OAuth 2.0 flow: authorization URL construction, code-for-token exchange, token refresh, token revocation. Narrow scope, official maintenance.

`@apigrate/quickbooks` ([last published March 2026](https://www.npmjs.com/@apigrate/quickbooks)) is the most TypeScript-friendly QBO API client: Promise-based, automatic OAuth2 token refresh with event handler, full Accounting API coverage. The auto-refresh event fires when tokens are refreshed, allowing you to persist new tokens per realm. This is the key feature for multi-tenant: you get a callback with the new token so you can write it to Postgres.

**Critical multi-tenant concern:** Serialize token refreshes per realm using a Redis `SET NX` lock. If two background workers race to refresh the same realm's token, the second refresh call invalidates the first refresh token, and your customer is effectively logged out of QBO.

**Alternative: Roll your own with native fetch**

3–5 engineer-days produces a cleaner TypeScript implementation with exactly the entities you need (Estimate, Bill, TimeActivity, Class, Customer, Item). Worth it if `node-quickbooks`'s callback API frustrates you or if `@apigrate/quickbooks` has a coverage gap for a specific entity. The pattern:

```typescript
async function qboRequest(realmId: string, method: string, path: string, body?: object) {
  const accessToken = await getValidAccessToken(realmId) // refresh + lock logic here
  const base =
    process.env.QBO_SANDBOX === 'true'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com'
  return fetch(`${base}/v3/company/${realmId}${path}?minorversion=75`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}
```

**Third-party connectors (Merge.dev, Codat, Rutter) are not recommended.** At 200 customers, [Merge.dev costs $650 + (200 × $65) = $13,650/month](https://www.merge.dev/pricing). That is $164K/year. You are not building for Xero or NetSuite yet. Build the QBO adapter interface cleanly and add a Xero implementation directly if/when customers ask.

---

### Layer 16: Analytics

**The Pick: PostHog Cloud (free tier)**

[PostHog's free tier](https://posthog.com/pricing): 1M events/month, 5K session recordings, 1M feature flag requests. Permanent, no credit card. Group Analytics for company-level analysis (which GC uses which features). 1-year data retention on free tier.

At 200 customers with modest event volume (~50K events/month total), you'll stay free indefinitely. The moment you need company-level cohorts or session replay at scale, the usage-based pricing is $0.00005/event — roughly $2.50/month at 50K events.

Do not self-host PostHog. The infrastructure minimum (ClickHouse + Kafka + Postgres + Redis, 4 vCPU, 16 GB RAM) costs more than the cloud product for any reasonable event volume. The PostHog team confirms >90% of cloud users pay $0.

**For marketing site analytics:** [Plausible Community Edition](https://plausible.io) self-hosted (free, AGPL-3.0, lightweight). Runs on any VPS. Zero event-tracking overhead. Completely separate from PostHog.

---

### Layer 17: BI for Internal Reporting

**The Pick: Metabase OSS (self-hosted)**

Zero licensing cost. Non-technical L&A staff can build dashboards without SQL. Connects directly to your Postgres. Runs on a $20/mo VPS (share it with your observability stack or Plausible).

Use Metabase for: margin by division, project P&L, QBO sync status dashboards, bonus calculations. The no-code query builder handles 90% of what you need.

[Metabase OSS infrastructure cost](https://www.metabase.com/docs/latest/cloud/cloud-vs-self-hosting): ~$20/mo VPS. Metabase Cloud Starter is $100/mo for 5 users — not worth it when self-hosted is free.

For customer-facing analytics at scale (Phase 3+): build a Cube.dev semantic layer in front of your Postgres and a custom Next.js dashboard. Do not expose raw Postgres to a BI tool for customer-facing use.

---

## 4. Pricing Walkthrough at 3 Scale Points

### 1 Customer — Learning & Validation Phase

| Item                                | Service                                               |      Monthly Cost       |
| ----------------------------------- | ----------------------------------------------------- | :---------------------: |
| App server                          | DO TOR1 Premium Intel 4vCPU/8GB (160 GB SSD, 5 TB BW) |         $48.00          |
| Droplet weekly backups (20% add-on) | DO Backups                                            |          $9.60          |
| Managed Postgres                    | DO Managed Postgres 1 GB (shared, start tier)         |         $15.23          |
| Redis/Valkey                        | On-VPS (Docker, no managed needed yet)                |           $0            |
| Object storage                      | DO Spaces TOR1 (250 GB + 1 TB included)               |          $5.00          |
| Auth                                | Clerk free tier (under 10K MAU confirmed)             |           $0            |
| Background jobs                     | Hatchet Lite (self-hosted, Postgres-backed)           |           $0            |
| Email                               | Postmark Basic (10K emails/mo)                        |         $15.00          |
| Error tracking                      | Sentry Developer (5K errors/mo free)                  |           $0            |
| Logs + metrics                      | Grafana Cloud free tier                               |           $0            |
| Uptime                              | UptimeRobot free (50 monitors)                        |           $0            |
| Deploy tool                         | Coolify (self-hosted, shared on app VPS)              |           $0            |
| Source control + CI                 | GitHub Team ($4/user × 2) + Actions usage             |         $8–$10          |
| Product analytics                   | PostHog Cloud free                                    |           $0            |
| BI dashboards                       | Metabase OSS (shared on app VPS)                      |           $0            |
| Domain (.com, amortized)            | Registrar                                             |           ~$1           |
| QBO API                             | Builder tier (0–500K CorePlus calls/mo)               |           $0            |
| **Total**                           |                                                       | **~$101.83–$103.83/mo** |

At 1 customer you are near $100/mo for the entire stack. The forced spending: compute ($48), backups ($9.60), managed DB ($15.23), email ($15), GitHub ($8–10). Everything else is free until you need more capacity.

**Upgrade Postgres to the $30/mo 2 GB dedicated tier when you sign your first paying contract** — the $15.23 shared tier is fine for validation work, but the noisy-neighbor risk is real once a customer depends on the app.

**On backups:** The $9.60/mo weekly backup cost is DigitalOcean's 20%-of-Droplet pricing. If you want daily backups, the add-on is 30% of the Droplet price ($14.40/mo on a $48 Droplet). Managed Postgres comes with its own daily backups + 7-day PITR included in the tier price, so you only pay backup cost on the Droplet itself (which holds your Next.js app and, at this scale, Redis/Hatchet).

Note on Sentry: the free Developer tier (5,000 errors/month) may be sufficient in early validation. If you're tracking 5K+ errors/month at 1 customer, fix the bugs first.

---

### 20 Customers — Post-Proof, Early Growth

| Item                              | Service                                           |   Monthly Cost    |
| --------------------------------- | ------------------------------------------------- | :---------------: |
| App servers                       | 2× DO Premium Intel 4vCPU/8GB (app + worker)      |      $96.00       |
| Droplet weekly backups (2× $9.60) | DO Backups                                        |      $19.20       |
| Managed Postgres                  | DO Managed Postgres 4 GB (dedicated)              |      $61.00       |
| Managed Redis/Valkey              | DO Managed Valkey 1 GB                            |      $15.00       |
| Object storage                    | DO Spaces TOR1 (~200 GB stored, ~1 TB egress)     |       $7.00       |
| Auth                              | Clerk free (still under 10K MAU at 100–200 users) |        $0         |
| Background jobs                   | Hatchet Lite (self-hosted)                        |        $0         |
| Email                             | Postmark Basic → Pro tier (15–20K emails/mo)      |      $15–$17      |
| Error tracking                    | Sentry Team                                       |      $26.00       |
| Logs + metrics                    | Grafana Cloud free tier                           |        $0         |
| Uptime                            | UptimeRobot Pro (1-minute checks)                 |       $7.00       |
| Deploy tool                       | Coolify (self-hosted, dedicated 2 GB VPS)         |      $18.00       |
| Source control + CI               | GitHub Team + Actions                             |      $8–$12       |
| Product analytics                 | PostHog Cloud free                                |        $0         |
| BI dashboards                     | Metabase OSS ($20 VPS shared with observability)  |      $10.00       |
| Domain                            | Registrar                                         |        ~$1        |
| QBO API                           | Builder tier                                      |        $0         |
| **Total**                         |                                                   | **~$283–$289/mo** |

At 20 customers you add a managed Redis ($15), upgrade to a dedicated Postgres ($61), pay for real uptime monitoring ($7), and split your application and worker processes onto separate droplets ($96 vs $48). The stack roughly doubles in infrastructure cost but remains under $300/mo.

At 20 customers generating meaningful MRR, $283/mo infrastructure is a rounding error.

---

### 200 Customers — Scaled, Revenue is Real

| Item                              | Service                                                 |    Monthly Cost     |
| --------------------------------- | ------------------------------------------------------- | :-----------------: |
| App servers                       | 3× DO Premium Intel 8 GB + 1× worker (4 droplets)       |       $192.00       |
| Droplet weekly backups (4× $9.60) | DO Backups                                              |       $38.40        |
| Managed Postgres                  | DO Managed Postgres 4 GB + HA standby                   |       $122.00       |
| Managed Redis/Valkey              | DO Managed Valkey 2 GB                                  |       $30.00        |
| Object storage                    | DO Spaces TOR1 (~2 TB stored, ~10 TB egress)            |       $130.00       |
| Auth                              | Clerk Pro (custom domain; MAU likely still under limit) |       $25.00        |
| Background jobs                   | Hatchet Lite (self-hosted, upgraded VPS)                |         $0          |
| Email                             | Postmark Pro (50K emails/mo)                            |       $69.00        |
| Error tracking                    | Sentry Team                                             |       $26.00        |
| Logs + metrics                    | Grafana Cloud Pro (~$70 at moderate volume)             |       $70.00        |
| Uptime                            | UptimeRobot Pro                                         |        $7.00        |
| Deploy tool                       | Coolify (self-hosted, dedicated management server)      |       $18.00        |
| Load balancer                     | DO Load Balancer                                        |       $12.00        |
| Source control + CI               | GitHub Team (~3 users) + Actions                        |       $12–$15       |
| Product analytics                 | PostHog Cloud (likely still free or ~$10)               |       $0–$10        |
| BI dashboards                     | Metabase OSS                                            |       $10.00        |
| Domain                            | Registrar                                               |         ~$1         |
| QBO API                           | Builder tier (model carefully at 200 customers)         |       $0–$300       |
| **Total**                         |                                                         | **~$762–$1,075/mo** |

At 200 customers: object storage egress ($130) becomes the largest single line item after compute. This is the point where OVHcloud (free egress, Canadian residency) or Cloudflare R2 (zero egress) become worth a migration conversation.

QBO CorePlus costs are modeled at zero (Builder tier, 500K free CorePlus credits/month). With 200 customers doing daily syncs, model your GET call volume before you hit Silver ($300/mo). Heavy report-reading features burn through CorePlus credits faster than pure data-write workflows.

---

## 5. Scale Path — What Changes When

### When to Split App and Worker Processes

When background job CPU begins competing with HTTP request CPU — typically at 20–30 customers with daily QBO syncs running. Signs: HTTP response times increasing during batch sync windows; Hatchet step timeouts correlating with traffic spikes. The fix is one additional droplet and two separate Docker Compose services with different entry points.

### When to Move DB to Its Own Box / HA

Move to a dedicated (non-shared) Postgres tier when you have 10+ active customers or your first paying contract. Budget: $61/mo (4 GB dedicated DO). This is not about performance — it is about shared-compute noisy-neighbor risk.

Enable HA (standby replica) when you have MRR commitments and a customer who will notice a 15-minute outage. DigitalOcean standby replica doubles the primary node cost ($61 → $122 for the 4 GB tier). Do this before you announce SLAs, not after an incident.

### When to Add a Read Replica

When analytics queries (Metabase, PostHog data exports, QBO reconciliation reporting) begin causing lock contention or query time degradation on the primary. A read replica runs analytical queries without touching the primary write path. Typically relevant at 100+ customers with complex reporting. DigitalOcean read replicas are available on all managed Postgres tiers at the same node cost as the primary.

### When to Switch from Self-Hosted Observability to Paid

Grafana Cloud free tier covers you until you exceed 10K active metric series or 50 GB logs/month. For a 200-customer SaaS with moderate instrumentation, this is likely 12–18 months of operation. At that point: upgrade to Grafana Cloud Pro (usage-based, typically $70–90/mo at moderate scale) or switch to Better Stack ($29/responder/mo for the full consolidated observability platform).

### When to Add a CDN

Spaces TOR1 includes a built-in CDN (Cloudflare-backed PoPs). Enable it on your bucket from day one — zero additional cost. For large blueprint files that are static after upload, CDN caching eliminates repeat egress charges. If you migrate to Cloudflare R2 later, the CDN is built in with zero egress.

### When to Hire an Ops Person

When: (a) your infrastructure has more than 4 VPS nodes, (b) you have a managed Postgres HA pair that requires failover testing, and (c) you're spending more than 5 hours/week on infrastructure versus product. At 200 customers with the stack described here, you should not be spending 5 hours/week on infrastructure. If you are, Coolify or Kamal are not doing their job, or technical debt has accumulated.

At 200 customers, a part-time ops/DevOps contractor (not a full hire) for a monthly infra audit and quarterly disaster recovery test is the appropriate level of ops investment.

---

## 6. Critical Decisions Ranked

### 1. Multi-Tenant Data Model Discipline

Every table that holds tenant-scoped data must have `company_id NOT NULL`. This includes: projects, blueprints, annotations, QBO sync state, invoices, estimates, team members, and settings. Build a typed Drizzle helper that enforces this at the TypeScript level, not just the SQL level:

```typescript
function tenantQuery(db: DrizzleDB, companyId: string) {
  return {
    projects: db.select().from(projects).where(eq(projects.companyId, companyId)),
    // ...
  }
}
```

Enable Postgres Row-Level Security as a backstop — it catches any query that forgets the `WHERE company_id = ?` clause. Set the tenant context in a transaction-local variable via `set_config('app.company_id', companyId)` before executing queries. This adds a layer of defense-in-depth that does not require application-level discipline on every query.

The cost of doing this right at commit #1: 2 hours. The cost of adding it retroactively at 50 customers: a full-day migration with production risk.

### 2. Durable Job Queue Early (for QBO)

Install Hatchet Lite before you write a single QBO sync line. The QBO sync workflow is multi-step by nature: OAuth validation, rate-limit-aware pagination, reconciliation, write-back. Designing it as a Hatchet workflow from the start means each step has its own retry policy and durability guarantee. Retrofitting step durability onto a BullMQ implementation at 50 customers is a full rewrite.

The specific Hatchet pattern for QBO sync:

```typescript
const qboSyncWorkflow = hatchet.workflow({ name: 'qbo-sync' })
qboSyncWorkflow.step('validate-token', validateToken) // retries: 3, backoff: exponential
qboSyncWorkflow.step('fetch-webhooks', fetchWebhooks, ['validate-token'])
qboSyncWorkflow.step('cdc-sweep', cdcSweep, ['fetch-webhooks'])
qboSyncWorkflow.step('reconcile', reconcile, ['cdc-sweep'])
qboSyncWorkflow.step('write-results', writeResults, ['reconcile'])
```

If `cdc-sweep` fails, Hatchet retries from `cdc-sweep`. Your token was already validated. Your webhook events were already fetched. No wasted API calls.

### 3. Accounting Adapter Interface

Define an interface before writing QBO calls:

```typescript
interface AccountingAdapter {
  createEstimate(tenantId: string, data: EstimateInput): Promise<EstimateResult>;
  updateInvoice(tenantId: string, externalId: string, data: InvoiceInput): Promise<InvoiceResult>;
  syncTimeActivities(tenantId: string, activities: TimeActivity[]): Promise<SyncResult>;
  // ...
}

class QBOAdapter implements AccountingAdapter { ... }
```

Every QBO API call lives inside `QBOAdapter`. Your application code calls `accountingAdapter.createEstimate(...)` and has no idea whether QBO, Xero, or Sage is the backend. This is not premature abstraction — it is the minimum viable seam that makes a future Xero integration a new class, not a refactor.

### 4. Canvas Architecture — Coordinate Discipline

All annotation coordinates are stored in PDF point space. The `annotations` table schema:

```sql
CREATE TABLE annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  blueprint_id UUID NOT NULL,
  page_number INTEGER NOT NULL,
  annotation_type TEXT NOT NULL,  -- 'polygon', 'measurement', etc.
  -- PDF-space coordinates: scale-independent, rotation-normalized
  points NUMERIC[] NOT NULL,      -- [pdfX1, pdfY1, pdfX2, pdfY2, ...]
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Never store canvas pixels. On every coordinate save: call `viewport.convertToPdfPoint(canvasX, canvasY)`. On every coordinate load: call `viewport.convertToViewportPoint(pdfX, pdfY)`. This is 4 lines of code that you will thank yourself for at 6 months.

### 5. Auth Org/Tenancy from Commit #1

Configure Clerk's Organization model before any other application code. The decisions:

- One Clerk Organization = one construction company (tenant)
- Roles: `owner`, `admin`, `estimator`, `field` — define these before building routes
- JWT claims shape: include `orgId`, `orgRole` in every JWT so API routes can authorize without an extra DB query
- User metadata schema: what do you store on the Clerk user vs. your DB?

Once Clerk orgs are created in production with 50 tenants, changing the role schema or claims shape requires coordinated migration. Define it once, correctly.

---

## 7. Honest Risks and Pushback

### Where Anti-Sprawl Bias Will Hurt

**Observability.** Running Grafana + Loki + Prometheus on your application VPS will compete for RAM with your actual application. At 4 GB RAM, you cannot run the full PLG stack and a Next.js app comfortably. Either use Grafana Cloud's free tier (correct choice at Phase 1) or provision a dedicated $20/mo VPS for observability. Grafana alone consumes 200–400 MB RAM; Loki + Prometheus adds another 500 MB–1 GB under load.

**Database operations.** The anti-sprawl bias tempts you toward self-hosted Postgres on your app VPS. Do not do this. The $30/mo DigitalOcean managed Postgres buys you daily backups, PITR, automated failover provisioning, and version upgrades without your involvement. The one scenario where the self-hosting impulse is legitimate: you've validated product-market fit at 30 customers, you're comfortable with Postgres administration, and you want to reclaim $30/mo. Even then, the managed DB is insurance, not bloat.

**Error tracking at scale.** Sentry Team is $26/mo until your error volume and span usage pushes you into overages. At 100K+ errors/month with performance monitoring, Sentry can reach $50–200/mo. At that point, the anti-sprawl founder correctly migrates to GlitchTip self-hosted. The SDK swap is 2 hours. Plan for it.

### QBO Is Structural Risk — Concentration on Intuit

Your product's most differentiating integration is a dependency on one company's API: Intuit QuickBooks Online. Risks:

- **CorePlus metering.** Intuit introduced pay-per-call billing on read/query operations in 2024–2025. At 200 customers with aggressive reporting features, you could hit $300/mo in CorePlus fees on the Silver tier. Design your sync to minimize GET calls: webhooks as primary trigger, CDC as backstop, no polling loops.

- **API breaking changes.** QBO pins `minorversion` but Intuit has made breaking changes in the past. Subscribe to the Intuit developer changelog. Pin `?minorversion=75` and test against sandbox before each deployment.

- **Refresh token expiry.** If a customer doesn't use Sitelayer for 100 days, their QBO refresh token expires and they must reauthorize. For construction companies that are seasonal (summer-heavy), this is a real support burden. Send email reminders at 90 days, 95 days if no API activity has occurred.

- **Partner program changes.** Intuit can change the CorePlus pricing model, the rate limits, or the partner tier costs with limited notice. There is no contractual protection for a Builder-tier integration. This is the price of building on a closed-ecosystem accounting product.

The mitigation is the accounting adapter interface (Section 6.3). When Intuit does something unreasonable, adding a Xero integration is an engineering project, not a business crisis.

### Construction SaaS Market Realities

[Procore](https://www.procore.com) processes $1.7 trillion in construction annually. [Buildertrend](https://buildertrend.com) targets residential builders and remodelers. [STACK](https://www.stackct.com) is a direct takeoff competitor. [PlanSwift](https://www.planswift.com) is another legacy desktop-to-web competitor.

The "prove with one customer" strategy is correct, but the customer you prove it with determines everything. A general contractor who is also your pilot customer will have specific workflow assumptions baked in. Building features around one customer's workflow risks creating L&A-specific code that does not generalize.

The antidote: maintain a hard separation between your core primitives (blueprint storage, polygon annotation, quantity calculation) and customer-specific workflow features (approval flows, specific cost code structures, reports). Every feature that touches the core should have a design document that asks: "would a different GC with a different workflow still benefit from this?"

### The Canvas Is Harder Than Infrastructure

The PDF canvas is not a weekend project. Production-quality issues you will encounter:

- **Dense CAD-generated blueprints:** [Apryse's own testing found 1–3% of CAD-based PDFs crash or freeze PDF.js](https://apryse.com/blog/pdf-js/guide-to-evaluating-pdf-js). Pre-processing with Ghostscript on upload (`gs -dBATCH -dNOPAUSE -sDEVICE=pdfwrite ...`) flattens most CAD artifacts.
- **Memory pressure:** Large PDF.js renders can spike client-side memory. Implement page virtualization — render only the current page and 1 page in each direction.
- **Mobile field use:** If estimators use tablets on job sites, you need custom touch event handling for pinch-zoom and pan. react-konva does not handle touch events for you.
- **Blueprint revision management:** When a GC uploads a revised drawing, existing annotations on the old drawing must be addressable. Design a blueprint versioning model early — it is harder to add retroactively than the `company_id` problem.
- **PDF coordinate drift at scale:** A single wrong coordinate conversion creates bugs that only appear when users scroll to the bottom of a large blueprint. Test with real construction drawings from day one.

Budget 3–5 weeks for a production-quality canvas. If you find yourself spending 8 weeks on it, price Apryse WebViewer.

### The "Prove With One Customer" Trap

Proving with one customer is a strategy, not a product model. The trap: you ship features specifically designed around your pilot customer's workflow, using their specific QBO chart of accounts, their specific job cost structure, and their specific approval flow. At customer #2, they have a different chart of accounts, no approval flow, and want a feature your pilot customer never requested.

The protection: define what is "product" (works for any GC doing takeoff with QBO) versus "configuration" (how one GC's workflow is expressed in that product). Build the product. Expose the configuration. Don't hard-code the configuration.

---

## 8. Recommended Build Order (First 6 Months)

### Month 1: Foundation

**Goal:** One real user can log in, upload a blueprint, and see it rendered.

- [ ] DigitalOcean TOR1 VPS provisioned (Basic 8 GB, $48/mo)
- [ ] Managed Postgres 2 GB provisioned ($30/mo)
- [ ] Coolify installed on management VPS (or Kamal 2 configured if CLI-preferred)
- [ ] Next.js 15 app skeleton: App Router, `output: 'standalone'`, Docker multi-stage build
- [ ] Clerk organizations configured: roles defined, JWT claims shape locked, middleware protecting routes
- [ ] Drizzle schema: `companies`, `users`, `blueprints` — `company_id` on every tenant table, RLS enabled
- [ ] DigitalOcean Spaces TOR1 bucket configured, signed URL generation working
- [ ] PDF.js v5 rendering a blueprint in the browser
- [ ] Coordinate system documented and enforced: `viewport.convertToPdfPoint` on every save
- [ ] Postmark configured: transactional sending domain authenticated
- [ ] Sentry free tier configured on the Next.js app
- [ ] Basic uptime monitor on UptimeRobot

**Do not build this month:** QBO integration, Konva annotations, Hatchet, analytics.

---

### Month 2: Core Canvas

**Goal:** A user can draw a polygon on a blueprint, label it, and save it.

- [ ] Konva.js integrated as annotation layer over PDF.js canvas
- [ ] Polygon drawing tool: click-to-add-points, close polygon on first-point click
- [ ] Annotation persistence: coordinates stored in PDF point space in Postgres
- [ ] Annotation reload: polygons render correctly on page reload and zoom change
- [ ] Blueprint rotation handling: `viewport.rotation` check and viewport clone
- [ ] HiDPI handling: `window.devicePixelRatio` applied to both canvas layers
- [ ] Basic measurement: area calculation from polygon coordinates (scale calibration = Phase 3)

---

### Month 3: QBO Integration (Phase 1)

**Goal:** A real QBO company is connected and estimates can be pushed.

- [ ] Hatchet Lite deployed (Docker container on existing VPS or worker droplet)
- [ ] QBO OAuth flow: `intuit-oauth` for auth, tokens stored encrypted in Postgres, per-realm refresh lock in Redis
- [ ] `AccountingAdapter` interface defined with QBO implementation
- [ ] `createEstimate` working: polygon annotation → line items → QBO Estimate created
- [ ] Webhook endpoint registered and returning 200 immediately with async processing
- [ ] QBO sandbox fully tested before production OAuth goes live
- [ ] `minorversion=75` pinned on all QBO API calls
- [ ] CorePlus call volume instrumented from day one (add `qbo_api_calls` metrics to Grafana)

---

### Month 4: Polish and First Real Customer

**Goal:** The pilot customer is using it weekly.

- [ ] Scale calibration UI: user sets scale from a known dimension on the blueprint
- [ ] Estimate line item editing: material quantities, unit costs, markup
- [ ] Mantine DataTable for estimate line items (replaces custom table)
- [ ] Email notifications: estimate sent, QBO sync errors, weekly digest (Postmark)
- [ ] Upgrade Sentry to Team tier ($26/mo) — error volume is real now
- [ ] UptimeRobot upgraded to Pro ($7/mo, 1-minute checks)
- [ ] Grafana Cloud configured: log shipping from Next.js app via Loki, basic dashboards

---

### Month 5: Multi-Tenant Hardening

**Goal:** Architecture is ready for customers 2–10.

- [ ] Worker droplet separated from app droplet: Hatchet workers on dedicated VPS
- [ ] Managed Valkey (Redis) provisioned on DO ($15/mo): session storage, Hatchet, QBO token refresh locks
- [ ] DO Managed Postgres upgraded to 4 GB dedicated tier ($61/mo)
- [ ] PostHog events instrumented: blueprint upload, annotation created, estimate pushed to QBO
- [ ] Metabase OSS deployed on $20/mo VPS: internal dashboards (sync status, customer activity)
- [ ] Load testing simulation: run 20 concurrent QBO syncs through Hatchet, observe Postgres and Redis under load
- [ ] RLS policies tested: confirm cross-tenant queries are blocked at the database level
- [ ] Token expiry email notifications implemented (90-day QBO refresh token warning)

---

### Month 6: Readiness for Selling

**Goal:** Architecture supports 20 customers without manual intervention.

- [ ] Coolify CI/CD pipeline: git push to main triggers deploy via webhook
- [ ] Backup verification: DO managed Postgres PITR tested, Spaces cross-region copy verified
- [ ] Disaster recovery runbook: documented procedure for VPS replacement, DB failover, DNS cutover
- [ ] Sentry alerts: configured for regression detection on core routes (blueprint upload, QBO sync)
- [ ] Cost review: actual vs. projected spending at Month 6 scale; decision point for object storage provider
- [ ] QBO CorePlus usage modeled at 20-customer scale
- [ ] Customer onboarding flow: self-serve QBO connection, blueprint upload, first estimate creation

**Defer to Month 6+**

- HA Postgres standby replica (add when MRR justifies it)
- Apryse WebViewer evaluation (revisit when customer is paying and CAD edge cases appear)
- Read replicas (revisit when query time degrades on primary)
- Xero adapter (revisit when 5+ customers ask for it)
- Sage 300 CRE / Intacct integration (revisit at 50+ customers with enterprise inquiries)
- Kubernetes / DOKS (revisit at 200+ customers if Docker Compose orchestration becomes limiting)

---

## 9. Appendix: Things the Research Uncovered

These are findings that are not widely known and could cause real problems if missed.

### Highlight.io Is Dead (February 28, 2026)

[Highlight.io was acquired by LaunchDarkly in April 2025 and shut down its standalone service on February 28, 2026.](https://www.highlight.io/blog/launchdarkly-migration) The self-hosted repo remains but development has stalled. Any integration or documentation pointing to Highlight.io as an observability option is outdated. Do not build on it. LaunchDarkly has a Developer plan with similar capabilities but a different pricing model.

### MinIO Community Edition Archived (February 2026)

[MinIO CE (Community Edition) was archived in February 2026.](https://rilavek.com/resources/self-hosted-s3-compatible-object-storage-2026) No new releases, no security patches from MinIO Inc. The commercial replacement is MinIO AIStor, which is licensed at $10K+/year for Enterprise Lite. The AGPL-3.0 legacy CE code technically still works but is unsupported.

If you were planning to self-host MinIO for object storage, use Garage (AGPL-3.0, Rust, geo-distributed, actively maintained) or SeaweedFS (Apache 2.0, Go, more features but more complex) as open-source alternatives. For a SaaS at this scale, the operational cost of self-hosted object storage exceeds the savings — use DO Spaces or R2.

### Wasabi's 1:1 Egress Rule

[Wasabi's policy](https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work): your total monthly egress (downloads) must not exceed your total stored volume. A construction SaaS that actively serves blueprints will exceed this ratio at almost any meaningful scale. Wasabi does not charge for the overage — they throttle or suspend the account. This makes Wasabi unsuitable for a serving-heavy workload regardless of its attractive pricing ($6.99/TB, Toronto region available).

Additionally: the 90-day minimum storage duration means deleted objects are billed for the remaining days. For a SaaS with customer churn, this creates phantom charges.

### Backblaze B2 Price Increase (May 1, 2026)

[Storage price increased from $6.00/TB to $6.95/TB on May 1, 2026](https://www.reddit.com/r/DataHoarder/comments/1rwccct/backblaze_b2_price_increase_effective_may_1st/). API calls were made free simultaneously. Net effect: slightly more expensive storage, slightly cheaper API costs. Still the second cheapest managed object storage option after Cloudflare R2 when combined with the Cloudflare Bandwidth Alliance (free egress when Cloudflare CDN fronts B2).

### Lucia Auth Deprecated

[Lucia Auth, a popular TypeScript auth library, has been deprecated.](https://github.com/lucia-auth/lucia) If any existing documentation, tutorials, or team members reference Lucia as the auth solution, that path is closed. Use Better Auth (actively maintained, similar library philosophy) or Clerk (hosted service).

### CloudFront Flat-Rate Plans (November 2025)

[AWS launched flat-rate CloudFront plans in November 2025](https://inventivehq.com/blog/cloud-pricing-models-compared-cloudflare-aws-azure-gcp-total-cost): Pro ($15/mo for 50 TB + 10M requests), Business ($200/mo), Premium ($1,000/mo). This changes the calculus for AWS S3 users: S3→CloudFront egress is free, and the flat $15/mo Pro plan offloads CDN egress billing entirely. If you are already on AWS S3 for compliance reasons, the S3 + CloudFront flat plan is now competitive with DO Spaces.

### Neon Acquired by Databricks (May 2025)

[Databricks acquired Neon for approximately $1 billion in May 2025.](https://www.cnbc.com/2025/05/14/databricks-is-buying-database-startup-neon-for-about-1-billion.html) Post-acquisition, Neon's pricing improved (storage dropped 80%, free tier doubled). The acquisition creates a different kind of risk than startup failure: Neon is now a product line of a large data company with its own priorities. Neon remains recommended for development/CI environments and preview databases — not for production primary DB on a VPS-first architecture.

### QBO CorePlus API Metering

Intuit introduced pay-per-call billing on read/query operations (CorePlus API) in 2024–2025. Core API (data-in: creating invoices, estimates, bills) remains free and unmetered. CorePlus (data-out: reading accounts, reports, company info) is metered above 500,000 calls/month on the Builder tier ($0/mo). At 200 customers with daily report-reading features, you could reach the Silver tier ($300/mo) quickly. Design your sync to push writes and use webhooks + CDC for reads — do not poll. Instrument your CorePlus call volume from the first QBO integration line.

### Hetzner 30–40% Price Increase (April 2026)

[Hetzner implemented a 30–40% price increase across all cloud products effective April 1, 2026.](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) Their US datacenter CPX21 (3 vCPU/4 GB) went from ~$10 to ~$14/mo. Their CCX13 (2 dedicated vCPU/8 GB) went from ~$15 to ~$20/mo. Hetzner remains price-competitive in the EU (where their full product catalog is available) but the advantage over DO/Vultr in the US is now marginal, and Hetzner still has no managed DB or Canadian datacenter.

Any pricing comparison to Hetzner made before April 2026 is outdated. The post-increase numbers are in this document.

### MotherDuck Pricing Change (Early 2026)

[MotherDuck eliminated their $25 Lite plan and raised the Business tier from $100/mo to $250/mo in early 2026.](https://motherduck.com/docs/about-motherduck/billing/pricing/) If you were planning to use MotherDuck as a shared DuckDB analytics layer for Sitelayer's internal reporting, the entry cost is now $250/mo. At this scale, plain DuckDB embedded in a Node.js process querying your Postgres is the right answer. MotherDuck is a Phase 3+ consideration.

---

_All prices verified against live vendor pricing pages on April 23, 2026. VPS pricing reflects Hetzner's post-April-2026 increase. Backblaze pricing reflects May 2026 increase. Verify current pricing before making procurement decisions._

### Verification Delta From Prior Draft

| Component                          | Prior Draft            | Verified April 23, 2026                                 | Delta          |
| ---------------------------------- | ---------------------- | ------------------------------------------------------- | -------------- |
| DO Droplet Premium Intel 4vCPU/8GB | $48/mo                 | $48/mo                                                  | ✓              |
| DO Managed PG (1 GB shared)        | $15/mo                 | $15.23/mo                                               | +$0.23         |
| DO Managed Valkey 1 GB             | $15/mo                 | $15/mo                                                  | ✓              |
| DO Spaces (250GB + 1TB egress)     | $5/mo                  | $5/mo                                                   | ✓              |
| DO Droplet weekly backups          | $5/mo (flat)           | 20% of Droplet = $9.60/mo                               | **+$4.60**     |
| Postmark Basic (10K emails)        | $16.50/mo              | $15/mo                                                  | −$1.50         |
| Sentry Team                        | $26/mo                 | $26/mo (50K errors)                                     | ✓              |
| Clerk free tier                    | "50K MAU" (unverified) | 10K MAU on Clerk's own page; 50K claimed by aggregators | **Assume 10K** |
| GitHub Team                        | $4/user/mo             | $4/user/mo                                              | ✓              |
| GitHub Actions self-hosted runners | Free                   | $0.002/min starting March 1, 2026                       | **New fee**    |
| Coolify self-hosted                | Free                   | Free, Apache 2.0, v4 (52K+ GH stars)                    | ✓              |
| Hatchet self-hosted Lite           | Free                   | Free, single Docker image                               | ✓              |
| .com domain                        | ~$1/mo                 | $10–$20/year                                            | ✓              |

**Net impact at 1 customer:** +$3.10/mo (backups $+4.60, Postmark $−1.50). Revised total is ~$102/mo vs. $100/mo previously quoted.

**Primary sources:**

- DigitalOcean Droplet pricing: https://www.digitalocean.com/pricing/droplets
- DigitalOcean Managed Databases: https://www.digitalocean.com/pricing/managed-databases
- DigitalOcean Spaces: https://www.digitalocean.com/pricing/spaces-object-storage
- DigitalOcean Backups: https://docs.digitalocean.com/products/droplets/details/backups/
- Hetzner price adjustment: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Backblaze B2 pricing change: https://www.backblaze.com/b2/cloud-storage-pricing.html
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Wasabi retention policy: https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work
- Clerk pricing page (live): https://clerk.com/pricing
- Hatchet self-hosting docs: https://docs.hatchet.run/self-hosting
- Coolify: https://coolify.io
- Neon/Databricks acquisition: https://www.cnbc.com/2025/05/14/databricks-is-buying-database-startup-neon-for-about-1-billion.html
- Highlight.io migration: https://www.highlight.io/blog/launchdarkly-migration
- MinIO archived CE: https://rilavek.com/resources/self-hosted-s3-compatible-object-storage-2026
- Apryse pricing: https://www.vendr.com/marketplace/apryse
- Postmark pricing: https://postmarkapp.com/pricing
- Sentry pricing: https://sentry.io/pricing/
- Grafana Cloud free tier: https://grafana.com/products/cloud/free-tier/
- GitHub pricing (Team + Actions): https://github.com/pricing
- GitHub Actions 2026 pricing changes: https://github.blog/changelog/
- QBO CorePlus metering: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/partner-platform
- CloudFront flat-rate: https://aws.amazon.com/cloudfront/pricing/
- OVHcloud Canadian pricing: https://www.ovhcloud.com/en-ca/public-cloud/prices/
- MotherDuck pricing: https://motherduck.com/docs/about-motherduck/billing/pricing/
