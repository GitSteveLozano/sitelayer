# SITELAYER GLUE OPPORTUNITY MAP

> **🟡 STRATEGY DOC — partially superseded (banner added 2026-04-25).**
>
> The product thesis (glue product, derived insight from QBO/QB-Time/PlanSwift) is preserved as strategic context, but specific stack claims are stale: shipped stack is **Vite SPA + plain Node HTTP + Postgres + bespoke Postgres-leased queue**, not Next.js / Hatchet. `CLAUDE.md` is canonical for current architecture.

**Synthesized from API research — April 2026**
**Audience: Sitelayer founder. No softening. No fluff.**

---

## 1. The Glue Thesis

A glue product does one thing: it reads data from systems that already exist inside your customer's workflow, derives something neither system can see alone, and surfaces that derived insight without asking anyone to change tools.

What it is NOT: a data warehouse, a sync engine, a replacement product, or a platform that holds state indefinitely. The moment you start writing data back into multiple systems, you are in the state duplication business. The moment you start replicating raw data, you become a backup tool. Neither of those is defensible.

Why glue works for construction SMB specifically:

1. **Tool proliferation is real and permanent.** A 50-person stucco subcontractor runs QBO, QB Time, Workyard, STACK, DocuSign or PandaDoc, Google Drive, and maybe CompanyCam. None of these talk to each other in any meaningful analytic way. The contractor's PM lives in their head, not in any of these tools.

2. **The insight gap is the moat.** APIs let you pull data. But pulling data is table stakes — any developer can do it. The moat is what you _do_ with the data: normalized job IDs across systems, estimated vs. actual labor in the same view, division-level margin by pulling QBO classes and time data together. None of those tools will build this for you. They have no incentive to — cross-tool insight undermines each platform's stickiness.

3. **Benchmark data is the long-term moat.** Once Sitelayer has normalized job-cost and time data across 200 subcontractors, you can tell a stucco contractor in Calgary whether their $28/sqft labor cost for EIFS is high or low for their market segment. No individual tool can do this. AI cannot replicate it without the underlying data. This is the real play.

4. **One-way pull removes friction and risk.** Every write-back creates a support surface. One bad write and a customer is calling you because their books are wrong. Pull-only means you are a read-only observer. You cannot break anything. This is the right call for a small team at this stage.

---

## 2. Integration Difficulty Matrix

Sorted by highest Value / lowest Effort first. This is the prioritization lens.

| Tool                | Category           | API Quality (1–5) | Integration Effort (days)     | Data Freshness                  | Gotcha Level | Sitelayer Value (1–5) |
| ------------------- | ------------------ | ----------------- | ----------------------------- | ------------------------------- | ------------ | --------------------- |
| QuickBooks Online   | Accounting         | 5                 | 3–5                           | Webhooks + CDC (excellent)      | Low          | 5                     |
| Xero                | Accounting         | 5                 | 3–5                           | Webhooks + modified filter      | Low          | 5                     |
| QB Time (TSheets)   | Time tracking      | 4                 | 2–4                           | Polling (last_modified)         | Low          | 5                     |
| ClockShark          | Time tracking      | 3                 | 3–7                           | Polling                         | Low          | 4                     |
| Workyard            | Time tracking      | 4                 | 5–10                          | Polling (60 req/min limit)      | Low          | 4                     |
| CompanyCam          | Photos/docs        | 4                 | 3–7                           | Webhooks (via Make confirmed)   | Low          | 3                     |
| STACK               | Takeoff/estimating | 4                 | 3–5                           | Polling                         | Low          | 4                     |
| Procore             | PM platform        | 5                 | 5–10                          | Webhooks (full)                 | Low          | 4                     |
| Dropbox Sign        | E-signature        | 4                 | 1–2                           | Webhooks                        | Low          | 4                     |
| PandaDoc            | E-signature        | 4                 | 1–3                           | Webhooks                        | Low          | 4                     |
| HubSpot             | CRM                | 5                 | 1–2                           | Webhooks                        | Low          | 3                     |
| Pipedrive           | CRM                | 4                 | 1–2                           | Webhooks                        | Low          | 3                     |
| Samsara             | Fleet/GPS          | 5                 | 2–3                           | Webhooks (beta)                 | Low          | 3                     |
| Google Drive        | File storage       | 5                 | 1–2                           | Webhooks (files.watch)          | Low          | 3                     |
| Dropbox             | File storage       | 4                 | 1–2                           | Webhooks                        | Low          | 3                     |
| OneDrive/SharePoint | File storage       | 4                 | 2–3                           | Webhooks (delta)                | Low          | 3                     |
| Buildxact           | Estimating         | 4                 | 3–5                           | Polling (100 req/30s)           | Low          | 3                     |
| BILL (bill.com)     | AP/payments        | 4                 | 2–3                           | Polling                         | Low          | 3                     |
| Ramp                | Corporate card     | 4                 | 2–3                           | Polling                         | Low          | 3                     |
| SafetyCulture       | Safety             | 4                 | 5–10                          | Webhooks                        | Medium       | 2                     |
| Motive              | Fleet/GPS          | 4                 | 2–3                           | Webhooks                        | Low          | 3                     |
| Fleetio             | Fleet/equipment    | 4                 | 1–2                           | Webhooks (plan-dependent)       | Low          | 3                     |
| JobTread            | PM/CRM             | 3                 | 5–10                          | Webhooks (confirmed)            | Low          | 3                     |
| Raken               | Daily reports      | 3                 | 7–14                          | Polling (portal blocked)        | Medium       | 3                     |
| Bluebeam Studio     | Takeoff/docs       | 3                 | 7–14                          | Polling (no webhooks)           | Medium       | 3                     |
| Followup CRM        | CRM                | 3                 | 2–3                           | Polling (no webhooks confirmed) | Low          | 2                     |
| AccuLynx            | CRM                | 3                 | 2–3                           | Polling                         | Medium       | 2                     |
| DocuSign            | E-signature        | 3                 | 2–4                           | Webhooks (Business Pro req.)    | Medium       | 4                     |
| Adobe Sign          | E-signature        | 3                 | 2–3                           | Webhooks                        | Low          | 3                     |
| Gusto               | Payroll            | 3                 | 5–10 (after partner approval) | Webhooks                        | Medium       | 3                     |
| Sage Intacct        | Accounting         | 3                 | 7–14                          | Polling (no webhooks)           | Medium       | 3                     |
| Paychex Flex        | Payroll            | 3                 | 7–14                          | Polling/limited webhooks        | Medium       | 2                     |
| BuildingConnected   | Bid platform       | 3                 | 7–14                          | Webhooks (contacts nightly)     | Medium       | 2                     |
| Rippling            | HR/Payroll         | 3                 | 7–14                          | Webhooks                        | Medium       | 2                     |
| busybusy            | Time tracking      | 2                 | 10–20                         | Zapier only                     | High         | 3                     |
| SiteDocs            | Safety             | 2                 | 3–5 (token provisioning)      | Polling                         | Medium       | 2                     |
| Fieldwire           | Field mgmt         | 2                 | 7–14 (enterprise add-on req.) | Webhooks (once unlocked)        | High         | 2                     |
| Kreo                | Takeoff/AI         | 2                 | 3–5 (contact required)        | Polling                         | Medium       | 3                     |
| Verizon Connect     | Fleet              | 2                 | 3–5                           | Polling                         | Medium       | 2                     |
| NetSuite            | Accounting         | 3                 | 14–21                         | Polling (no webhooks)           | Medium       | 2                     |
| WorkMax             | Time tracking      | 2                 | 10–20                         | Polling                         | High         | 2                     |
| Sage 100 Contractor | Accounting         | 1                 | 10–15 (Ei Dynamics req.)      | Polling                         | High         | 2                     |
| ADP                 | Payroll            | 1                 | 20–30                         | Limited webhooks                | Blocker      | 2                     |
| Sage 300 CRE        | Accounting         | 1                 | 15–30+ (agent install req.)   | Polling                         | Blocker      | 2                     |
| Foundation Software | Accounting         | 1                 | 20–40 (partnership req.)      | None                            | Blocker      | 1                     |
| Buildertrend        | PM platform        | 1                 | Not feasible (no public API)  | None                            | Blocker      | 0                     |
| PlanSwift           | Takeoff            | 1                 | Export-only                   | None                            | Blocker      | 0                     |
| Melio               | Payments           | 1                 | Not feasible                  | None                            | Blocker      | 0                     |
| Stampli             | AP automation      | 1                 | Not feasible                  | None                            | Blocker      | 0                     |
| AvidXchange         | AP automation      | 1                 | Not feasible                  | None                            | Blocker      | 0                     |
| Siteline            | Billing            | 1                 | Not feasible                  | None                            | Blocker      | 0                     |
| Paycom              | Payroll            | 1                 | Not feasible                  | None                            | Blocker      | 0                     |
| eBacon              | Payroll            | 1                 | Not feasible                  | None                            | Blocker      | 0                     |
| Home Depot Pro      | Supply             | 1                 | Not feasible                  | None                            | Blocker      | 0                     |

---

## 3. The Tier 1 Starting Set

These are the 6 integrations Sitelayer builds first. The selection criterion is simple: independently valuable, fast to build, covers the core QBO/Xero + time tracking stack of the target customer.

### 1. QuickBooks Online (3–5 days)

**Why Day 1:** Covers approximately 60% of Canadian SMB contractors. Best API in the accounting category. Free sandbox, free developer tier, official Node.js SDK, comprehensive CDC for incremental sync, full webhook coverage. Classes (divisions/cost centers) are available on Plus/Advanced plans, which most 10–100 person contractors are on. Without QBO, you cannot build any margin view, any job cost rollup, or any invoice reconciliation.

**Derived insight it unlocks:** Job-level actuals (costs by class, outstanding invoices per job, AP by job), division margin, invoice aging. Everything downstream of accounting requires this source.

**Engineering estimate:** 3–5 days to authenticated pull of Invoices, Bills, Estimates, Classes, Time Activities, Customers, Vendors with CDC incremental sync and webhook handler.

**Customer action:** OAuth app install (QBO App Partner review, free, takes a few days). Customer clicks "Connect QBO" in Sitelayer — standard OAuth flow. Customer must be on QBO Plus or Advanced for Classes.

**Gotcha:** Refresh token expires after 100 days of non-use. Implement silent renewal and alert on inactive connections. Plan-gate gracefully — if customer is on Simple Start, Classes are absent; degrade to job-only view.

---

### 2. Xero (3–5 days)

**Why Day 1:** Strong Canadian market share, especially among newer or tech-forward contractors. API quality matches QBO. Tracking Categories (Xero's equivalent of Classes) are available on all plans. No approval required to start building — create a free developer app at developer.xero.com and go.

**Derived insight it unlocks:** Same set as QBO. Tracking Categories map to divisions. Full invoice, bill, estimate, and journal entry visibility.

**Engineering estimate:** 3–5 days. Share ~60% of code with the QBO integration.

**Customer action:** OAuth flow (no pre-approval needed). Customer must be on Xero Premium plan for multi-currency if they have CAD/USD mixed books.

**Gotcha:** 5,000 API calls/day per org is tight. Design for call efficiency from day one. Use modified-since filtering. The 30-minute access token expiry is aggressive — token refresh must be bulletproof in the auth layer.

---

### 3. QB Time / TSheets (2–4 days)

**Why Day 1:** The most common time tracking tool among QBO shops. Nearly free to build once you have a QBO OAuth integration — same developer account, same app review. Returns time entries with job code assignments, GPS geolocation breadcrumbs, and user data. No webhooks, but `last_modified_timestamps` endpoint makes incremental polling efficient.

**Derived insight it unlocks:** Raw labor hours by job and cost code. When joined with QBO job actuals, you get hours-to-cost mapping without requiring the contractor to manually enter time into QBO.

**Engineering estimate:** 2–4 days. Reuse QBO OAuth scaffolding.

**Customer action:** Same QBO OAuth app install. Customers must have QB Time Elite or Premium plan for API access.

**Gotcha:** Job codes in QB Time are not automatically mapped to QBO Classes or Customer:Job. You must build a mapping layer. This is the main engineering complexity — do it once cleanly and it unlocks most of the labor analytics.

---

### 4. ClockShark (3–7 days)

**Why Day 1:** Common alternative to QB Time, especially in shops NOT using QBO (Xero customers, FreshBooks customers). Public REST API, API key auth generated by the customer admin in settings — zero approval overhead on Sitelayer's side. Covers time entries, jobs, cost codes, GPS data.

**Derived insight it unlocks:** Same as QB Time — labor hours by job. Particularly valuable for Xero customers who do not have a native time tool.

**Engineering estimate:** 3–7 days.

**Customer action:** Admin generates API key in Admin → Integrations. Takes 2 minutes.

**Gotcha:** Rate limits are not documented. Build conservative polling with exponential backoff from the start.

---

### 5. STACK Estimating (3–5 days)

**Why Day 1 (conditional):** Among cloud-first estimating tools, STACK has the best REST API in the category. Returns structured takeoff data: line items, measurements (area, length, count), assemblies, and pricing. If your customer estimates in STACK, you can pull their estimate baseline and compare it to QBO actuals — this is the bid-vs.-actual workflow. The API requires an API-Enabled Subscription (premium tier), and customers get an Integration Account Manager assigned.

**Derived insight it unlocks:** Estimated quantities and costs per assembly, enabling variance analysis against job actuals without the customer doing a separate export.

**Engineering estimate:** 3–5 days (clean REST, good docs, sandbox).

**Customer action:** Customer must be on STACK's API-Enabled tier and request access via the portal (approved within 2 business days per research).

**Gotcha:** This is conditional on the customer using STACK. For Bluebeam shops, defer to the Bluebeam integration (Section 4). Build STACK first because it's faster.

---

### 6. Dropbox Sign or PandaDoc (1–3 days each)

**Why Day 1:** E-signature is the place change orders live. If you want to build the change order reconciliation workflow (executed CO from e-sig vs. invoiced amount in QBO), you need one e-sig integration. Dropbox Sign is the fastest build (1–2 days, clean API, no OAuth complexity, webhook support), but PandaDoc is more common among construction contractors for full proposal + e-signature workflows.

**Build Dropbox Sign first** (1–2 days), then PandaDoc (1–3 days) as the second e-sig. DocuSign is third — it requires Business Pro for webhooks and is more expensive at every tier.

**Derived insight it unlocks:** List of executed change orders (signed, dated, dollar amounts) against which you can check QBO invoices. Change orders that exist in DocuSign/PandaDoc but have no corresponding invoice in QBO are uncaptured revenue.

**Engineering estimate:** 1–3 days per e-sig tool.

**Customer action:** OAuth authorization. Customers need Business plan for PandaDoc API access; Standard plan ($25/mo) for Dropbox Sign.

---

## 4. Glue Workflow Catalog — Ranked by Ease x Value

---

### Workflow 1: Unified Job Margin View

**Sources:** QBO (or Xero) + QB Time (or ClockShark/Workyard)
**Derived output:** Per-job view showing: estimated amount (from QBO Estimate), billed-to-date (Invoices), costs incurred (Bills), and labor hours + imputed labor cost (time data × loaded labor rate). Net margin per job updated on a configurable schedule.

**Why it's genuinely glue:** QBO shows you the money side. QB Time shows you the hours. Neither shows you both. The contractor currently exports each separately and builds this in Excel — if they build it at all.

**Engineering effort:** S — 5–8 days (after both integrations are live). The work is the join logic: normalizing job identifiers across QBO Customers/Jobs and QB Time job codes. This is the hardest part and the most valuable part.

**Value rating:** 5/5 — This is the core product insight. A 50-person stucco contractor managing 9 divisions who can see per-job margin updated daily has a different conversation with their foremen.

**MVP:** Static dashboard showing estimated vs. billed vs. cost for open jobs, refreshed every 4 hours. No historical trend, no forecasting.

**Full version:** Historical trend per job, division rollup, alert when job margin drops below threshold, drill-down to individual cost line.

**Dependencies:** QBO + any time tool live and with job/cost code mapping established.

---

### Workflow 2: Division/Class-Based Margin Rollup

**Sources:** QBO or Xero (Classes/Tracking Categories required)
**Derived output:** Margin by division for the current period and trailing 12 months. Revenue, direct costs, indirect allocations, and gross margin % per division — the view a CFO would build in Excel from QBO class reports but with no manual work.

**Why it's genuinely glue:** QBO can generate a P&L by Class natively, but it requires someone to run it, format it, and distribute it. Sitelayer makes this a live view with period-over-period comparison. For L&A (9 divisions, bonus program), this is the bonus pool input data.

**Engineering effort:** S — 3–5 days once QBO integration is live. Mostly a query + normalization layer on top of existing data.

**Value rating:** 5/5 for any customer with divisions or multiple trades.

**MVP:** Division P&L table for current month vs. prior month vs. same month last year. Static, no drill-down.

**Full version:** Drill into any division to see the underlying jobs, variance attribution, and trend chart.

**Dependencies:** Customer must be on QBO Plus/Advanced (Classes) or Xero (Tracking Categories). Degrade gracefully for customers without class tracking.

---

### Workflow 3: Change Order Reconciliation

**Sources:** DocuSign / Dropbox Sign / PandaDoc + QBO or Xero
**Derived output:** A reconciliation table: executed change orders (from e-sig) matched against invoices (from accounting). Unmatched COs (executed but not yet invoiced) flagged as uncaptured revenue.

**Why it's genuinely glue:** The signed CO lives in e-sig. The invoice lives in QBO. No tool connects them. The contractor's PM mentally tracks which COs have been invoiced — this is a high-value error-prone manual process, especially on multi-job sites with multiple GCs.

**Engineering effort:** M — 8–12 days. The hard part is fuzzy matching: CO amounts may differ slightly from invoice amounts due to tax, retainage, etc. Build a confidence score with manual override, not a hard match.

**Value rating:** 4/5 — directly recoverable revenue for most contractors. Change orders are the #1 area of revenue leakage in construction.

**MVP:** List all executed COs in the trailing 90 days. Flag any CO with dollar amount that has no corresponding invoice within ±10% in QBO. Manual review by contractor.

**Full version:** Auto-match by job, amount, and date range. CO-to-invoice mapping stored in Sitelayer. Alert on aging unmatched COs.

**Dependencies:** E-sig integration live + QBO/Xero live + contractor actually uses the same e-sig for COs (not just for subcontracts).

---

### Workflow 4: Field Hours → Cost Code Reconciliation

**Sources:** Workyard / ClockShark / QB Time + QBO job list
**Derived output:** Time entries from the field tool, mapped to QBO job codes, ready to push to payroll. Shows hours by employee by job by cost code, with a flag on any entry that has no matching QBO job.

**Why it's genuinely glue:** The field app collects hours. QBO has the job list. They do not automatically agree. Mismatched job codes mean hours that cannot be allocated to jobs, which means job costing is wrong. This workflow normalizes them.

**Engineering effort:** S/M — 5–10 days. The core complexity is the mapping table — a semi-automatic job-code matching layer that the customer can review and confirm.

**Value rating:** 4/5 — reduces payroll processing friction and makes job costing trustworthy.

**MVP:** Pull all time entries for the trailing 7 days. Show a mapping review table: time entry job code → QBO job. Highlight missing/ambiguous mappings. Export-ready CSV for payroll.

**Full version:** Auto-approve mappings based on historical confirmation data. Weekly automated report emailed to payroll contact.

**Dependencies:** One time tool integration + QBO integration live.

---

### Workflow 5: Daily Burn-Rate Alert

**Sources:** QBO (or Xero) Bills + QB Time (or equivalent) hours
**Derived output:** For open jobs, a running cost burn rate (committed costs + accrued labor) vs. the estimated budget. Alert when burn rate implies overrun of >15% (configurable threshold).

**Why it's genuinely glue:** Accrued labor costs are not in QBO until payroll runs. QB Time has the hours. QBO has the approved budget (from Estimate). Combining them gives you a real-time cost signal, not a hindsight one.

**Engineering effort:** M — 8–12 days. Requires loading a labor rate by employee (entered once in Sitelayer), then multiplying current-period hours × rate to get accrued labor not yet in accounting.

**Value rating:** 4/5 — prevents end-of-job surprises. Contractors lose money on jobs they thought were fine because nobody checked until the last invoice.

**MVP:** Simple burn alert: (bills paid + accrued labor estimate) / job budget > threshold → email alert to PM.

**Full version:** Per-job burn dashboard, trend line, projected final cost extrapolated from current burn rate.

**Dependencies:** QBO + time tool + labor rate configuration in Sitelayer.

---

### Workflow 6: Bonus Pool Calculator

**Sources:** QBO Classes/Xero Tracking Categories + QB Time labor data
**Derived output:** Per-division gross margin and labor cost for the period. Apply a configurable bonus formula (e.g., 20% of net profit above threshold, split by labor hours contributed) to produce a bonus pool allocation per employee.

**Why it's genuinely glue:** This is exactly the L&A use case. Division margin from QBO. Labor hours per employee per division from QB Time. The bonus formula lives in Sitelayer. The output is a table the owner uses to cut bonus checks. No tool in their stack produces this.

**Engineering effort:** M — 10–14 days (configuration UI for the bonus formula is the main work).

**Value rating:** 5/5 for L&A-type customers. This alone justifies the product for a multi-division contractor with a performance bonus program.

**MVP:** Hardcoded formula: (division gross margin − target margin) × bonus rate = pool. Split by hours. Output as downloadable CSV.

**Full version:** Configurable formula per division, historical bonus history, per-employee detail view, PDF summary for the owner meeting.

**Dependencies:** QBO with Classes live + time tool with cost code/division mapping.

---

### Workflow 7: Assembly-Level Bid vs. Actual

**Sources:** STACK (or Bluebeam + BAX) + QBO actuals
**Derived output:** Takeoff line items (estimated quantities and costs per assembly/phase) matched against QBO job costs. Variance by assembly: e.g., "EIFS base coat — estimated $18,400, actual $22,100, +20% over."

**Why it's genuinely glue:** The estimate lives in STACK. The actual costs live in QBO. The contractor today compares these by hand — opening two windows, manually cross-referencing line items. Sitelayer normalizes the assembly names (which requires a one-time mapping by the customer) and shows the variance automatically.

**Engineering effort:** M/L — 12–20 days. The hard part is the assembly-to-cost-code mapping. Every customer will have different naming conventions. Build a flexible mapping UI, not a rigid schema.

**Value rating:** 4/5 — closes the estimating feedback loop. Estimators who can see which assemblies consistently run over will improve future bids.

**MVP:** Import STACK estimate JSON → show line items. Customer does one-time mapping of STACK assembly names to QBO cost codes. Display variance table. No automatic re-mapping.

**Full version:** Learned mappings stored and suggested automatically. Historical variance per assembly type across jobs.

**Dependencies:** STACK API-Enabled Subscription + QBO integration + customer willingness to do one-time mapping.

**Caveat on Bluebeam:** Bluebeam is the dominant takeoff tool in the physical plans world. The Studio API returns snapshot PDFs, not structured BAX markup XML. Structured assembly data from Bluebeam requires either (a) the customer exports a BAX file manually and uploads it to Sitelayer, or (b) you use the bFX server path — which is customer-premise infrastructure. For Bluebeam shops, build a file upload path (CSV/Excel export from Bluebeam → manual upload to Sitelayer) as the bridge until the Bluebeam Cloud API reaches GA.

---

### Workflow 8: Labor Productivity Benchmarking

**Sources:** QB Time / Workyard / ClockShark + QBO job metadata + STACK (optional)
**Derived output:** Hours per unit of work across jobs. Example: average hours per 1,000 sqft of EIFS on multi-story residential, trailing 6 jobs. Highlights which jobs ran efficiently and which didn't.

**Why it's genuinely glue:** Time data tells you hours. Job metadata (scope, size) from QBO or STACK tells you units of work. Neither alone tells you productivity. Across multiple jobs, this becomes a performance signal — and eventually benchmark data across your customer base.

**Engineering effort:** L — 15–25 days. The hard part is capturing "units of work" in a structured way. Either pull scope from STACK estimates or require the contractor to enter job scope (sqft, number of floors, etc.) in Sitelayer as a one-time setup per job.

**Value rating:** 3/5 initially (requires data accumulation), 5/5 at scale (benchmark data across customers).

**MVP:** Manual scope entry (customer enters sqft per job). Hours from time tool. Output: hours/sqft per job, compared to customer's own average. No cross-customer benchmarks yet.

**Full version:** Aggregate across all Sitelayer customers (anonymized), produce industry benchmarks by trade, region, job type.

**Dependencies:** Time tool integration + some form of job scope data.

---

### Workflow 9: Blueprint Version Tracking

**Sources:** Google Drive / Dropbox / OneDrive (webhook on file change)
**Derived output:** A per-job log of when drawing files changed, with version history. Alert when a file in a project folder is replaced.

**Why it's genuinely glue:** The GC sends updated blueprints via email or drops them into a shared Drive folder. The subcontractor often doesn't know a new version exists until they're already framing to old specs. This workflow watches the folder, logs every file change with a timestamp, and can alert the project manager.

**Engineering effort:** S — 5–8 days. Google Drive webhooks are among the easiest webhooks to implement. Build a per-project folder-watch with a simple audit log.

**Value rating:** 3/5 — reduces rework risk, but customers may not connect it to direct cost savings.

**MVP:** Customer connects Google Drive. Sitelayer watches specified project folders. Any file change is logged with filename, timestamp, version. Weekly digest email.

**Full version:** Side-by-side diff alert for PDF drawings (using pdf-parse or similar). Notify specific people per project.

**Dependencies:** Customer must organize drawings in Drive/Dropbox/OneDrive folders by project (most do).

---

### Workflow 10: Photo + Daily Report Audit Trail

**Sources:** CompanyCam photos + Raken or SafetyCulture daily reports
**Derived output:** Per-job evidence timeline: daily reports aggregated with geotagged photos, showing what work was done, when, by which crew, with visual documentation.

**Why it's genuinely glue:** CompanyCam has photos. Raken has daily reports. Neither surfaces a unified per-job evidence view that a contractor can hand to a GC or adjuster when a payment dispute arises.

**Engineering effort:** M — 10–15 days (two integrations, each 3–7 days, plus a timeline stitching layer).

**Value rating:** 3/5 — defensively valuable (dispute resolution) but not a daily-use tool for most customers.

**MVP:** Pull CompanyCam photos by project. Pull Raken daily reports by project. Render a timeline by date. No analysis.

**Full version:** PDF export of the per-job evidence file. Filter by date range. Add QBO invoices to the timeline for a complete project history.

**Dependencies:** Customer uses both CompanyCam and Raken (or SafetyCulture). Two integrations required — only worth building if customers actually use both tools.

---

### Workflow 11: Equipment Utilization per Job

**Sources:** Samsara / Motive / Fleetio + QBO job list + time entries (optional)
**Derived output:** Hours of GPS-confirmed equipment presence at each job site, mapped to QBO jobs, with imputed equipment cost allocation.

**Why it's genuinely glue:** Fleet tools track where equipment is. QBO tracks job costs. Joining them tells you which jobs are consuming equipment time and what that costs — something the contractor either ignores entirely or estimates manually.

**Engineering effort:** M/L — 15–20 days. Requires building geofence logic: define each job site as a polygon or radius, then match GPS vehicle location history to site presence. Samsara has geofence APIs; Motive also has location history.

**Value rating:** 3/5 — high value for equipment-heavy contractors (excavation, concrete), lower value for stucco/finishing subs. Not a Day 1 build for L&A specifically.

**MVP:** Customer defines job site locations (lat/lng + radius). Samsara GPS matches vehicle to site each day. Show total hours per vehicle per site per week.

**Full version:** Multiply equipment hours by configurable ownership cost rate to produce equipment cost allocation per job. Feed into job margin view.

**Dependencies:** Samsara or Motive subscription + QBO integration + job site location data.

---

### Workflow 12: Bid Pipeline Visibility

**Sources:** HubSpot / Pipedrive / Followup CRM + BuildingConnected (optional)
**Derived output:** Bid win rate by GC, by project type, by trade. Weighted pipeline value. Backlog forecast.

**Why it's genuinely glue:** The CRM has bids and outcomes. BuildingConnected has project intelligence. Combining them shows win rate patterns the contractor cannot see in either tool alone.

**Engineering effort:** M — 10–14 days (CRM integration is fast; BuildingConnected requires APS access request).

**Value rating:** 2/5 for current ICP (stucco sub focused on repeat GC relationships). Higher value for specialty contractors doing more competitive bid work.

**Pushback:** For L&A and similar repeat-GC subcontractors, bid pipeline analytics are a lower priority than job cost visibility. Build this only after margin and labor workflows are live. Most SMB subcontractors in the 10–100 employee range win work through relationships, not from improving their bid win rate analytics.

**MVP:** Pull all deals from HubSpot/Pipedrive, filter by construction pipeline. Show win rate, average deal size, and days to close by GC/client.

**Dependencies:** CRM integration live + customer actually uses CRM for bid tracking (many don't).

---

### Workflow 13: Supplier Invoice Allocation Helper

**Sources:** QBO Bills + job context (from QBO)
**Derived output:** For bills that span multiple jobs, a UI to allocate the bill across jobs by percentage or amount. One-time write-back (the only exception to no-write-back, justified because the alternative is the customer doing this manually in QBO with higher error rate).

**Why it's genuinely glue:** A $40,000 supplier invoice for framing materials often covers 3 active jobs. QBO requires this to be split manually. Sitelayer can show the jobs that are currently active, the proportional spend, and a suggested allocation — reducing a 20-minute manual task to a 2-minute review.

**Engineering effort:** M — 10–15 days (includes the write-back, which requires careful error handling and idempotency).

**Value rating:** 3/5 — reduces accounting friction but is not a differentiated insight. Also note: this is the one workflow with a write-back, which violates the no-write-back principle. Be deliberate about this. The write-back must be optional and clearly labeled — never automatic.

**Recommendation:** Defer this until Tier 1 workflows are live and validated. The write-back complexity is non-trivial.

---

### Workflow 14: Certified Payroll / Prevailing Wage Helper

**Canadian context makes this different.** In Canada, the prevailing wage equivalent is project labor agreements and provincial wage schedules, not the US Davis-Bacon Act. eBacon, the US specialized tool for this, has no API and is US-only.

For Canadian construction, the equivalent workflow would be: pull hours by employee by job from the time tool, pull the job classification (federal vs. provincial work, union vs. non-union) from job metadata in QBO, and produce a report formatted for CRA or union reporting.

**Engineering effort:** L — 20+ days. Requires building a reporting template layer that varies by province and job type. Not a standard integration workflow — it's a compliance reporting feature.

**Recommendation:** Defer entirely until you have 10+ customers asking for it. This is a niche workflow that requires significant domain expertise to build correctly. Do not let it distract from the core margin and labor workflows.

---

## 5. Integration Combinations That Unlock Outsized Value

### Combo 1: STACK + QBO + QB Time = Closed-Loop Estimating

The estimate in STACK gives you quantities and budget. QBO gives you what was actually spent. QB Time gives you actual labor hours. Together, these three produce an assembly-level performance view: estimated cost, actual cost, estimated hours, actual hours, variance. This is the information a superintendent needs to improve the next bid. None of these tools can produce it alone, and none of them are trying to. Effort to reach this view: 12–18 days of integration + 5–8 days of workflow UI. This is the first "wow" demo for a Bluebeam-or-STACK customer.

### Combo 2: QBO + QB Time + Division Classes = Bonus Calculator

For L&A specifically: division-level margin (QBO Classes) + per-division labor hours (QB Time job codes mapped to divisions) + configurable bonus formula = the bonus pool prep report. The founder can walk into the quarterly review with a number instead of a spreadsheet. Effort: 8–12 days incremental after QBO and QB Time are live.

### Combo 3: Xero + ClockShark + STACK = Xero Customer Equivalent of Combo 1

For customers not on the Intuit stack. Xero Tracking Categories replace QBO Classes. ClockShark replaces QB Time. STACK stays the same. Build this after Combo 1 is proven — the architecture is nearly identical, just different adapters.

### Combo 4: DocuSign (or Dropbox Sign) + QBO = Change Order Integrity

Executed COs in e-sig are matched to invoices in QBO. Any CO signed more than 30 days ago with no corresponding invoice in QBO is flagged. This is a high-value, low-engineering alert for accounts receivable staff. Effort: 4–6 days incremental after both integrations are live.

### Combo 5: Procore + QBO + CompanyCam = Subcontractor-Facing-GC Workflow

For subcontractors whose GC runs Procore, this is the most complete workflow: pull the approved budget and RFIs from Procore, match invoices in QBO, attach CompanyCam photos to the job record. The subcontractor has a single view of everything related to a GC job. Effort: 15–20 days (Procore integration is 5–10 days alone, data model is complex). This is a Tier 2 build, not Day 1.

---

## 6. What NOT to Integrate (and Why)

### Hard No's — No Real API

**PlanSwift:** Has been promising a REST API since at least 2023. As of April 2026, the only programmatic access is OLE Automation — a Windows COM scripting interface that requires the desktop app to be running locally. Not a cloud integration. Not buildable in the standard sense. The practical path for PlanSwift customers is file upload: customer exports CSV from PlanSwift, uploads to Sitelayer. Build the file upload parser, not an API integration. Estimated: 2–3 days for the CSV parser vs. a non-feasible REST integration.

**Buildertrend:** No public REST API. The only path is Supergood.ai's reverse-engineered session-based API, which is fragile, potentially violates Buildertrend's ToS, and will break whenever Buildertrend updates their frontend. This is a blocker. If a customer uses Buildertrend, tell them to use the QBO integration to access financial data and accept that Buildertrend-specific PM data is unavailable.

**Melio:** Looks like a modern fintech product. It is not a developer-accessible API — it is a 100% embedded partner platform (Fiserv, Capital One, Gusto, Shopify). There is no path to read a customer's Melio payment history without becoming a revenue-share platform partner, which is a multi-million-dollar business conversation. Skip.

**Stampli, AvidXchange, Siteline:** Same category. No public developer API. Internal integration engines only. AvidXchange requires a formal ISV partner agreement. Siteline explicitly confirms no API. Not feasible.

**Home Depot Pro / Lowe's Pro:** Closed B2B partner programs. The Buildxact and Buildertrend integrations with Home Depot are bespoke commercial agreements, not an open API. Sitelayer is not positioned to negotiate this. Skip permanently. If customers need materials purchase visibility, pull it from QBO bills.

**eBacon:** US-only certified payroll tool. No public API. File-based GL export only. Not relevant for Canadian contractors.

**Paycom:** No public API. Finch is the only practical path, and Finch's Canadian payroll system coverage is limited. Skip direct Paycom integration.

---

### Don't Integrate Because the Effort Exceeds the Value for This ICP

**Foundation Software (direct):** Requires a commercial partnership agreement before you can see the API documentation. The "secure API" language on their website is marketing for a closed ecosystem. Use Agave API as a middleware path if a customer is on Foundation — but Foundation customers are typically larger US contractors, not the 10–100 employee Canadian sub market. Defer until there is specific customer demand.

**Sage 300 CRE:** No native REST API. Any integration requires a Windows agent installed at the customer's site (via Agave or hh2) that must stay running. Even with Agave's sandbox, each new customer requires a separate on-premise agent installation coordinated with the customer's IT. This is a support nightmare for a small team. Defer until you have explicit demand from a Sage 300 customer who is willing to do the setup work.

**ADP:** Each customer must purchase "API Central" from ADP — a separately billed add-on of unknown price (ADP hides the price behind a login). Then you must exchange mTLS certificates. Then you deal with undocumented rate limits. For Canadian contractors on ADP Canada, the Canadian-specific fields need separate verification. The effort-to-value ratio is poor given your ICP. If a customer specifically needs ADP data, point them to Finch as the aggregator path.

**NetSuite:** 14–21 day integration with no webhooks and a complex data model. NetSuite customers are above the 10–100 employee ICP ceiling in most cases. Defer indefinitely.

**Fieldwire:** API access requires an Enterprise contract or a paid add-on. The customer has to contact Fieldwire's accounts team to enable API access. For a tool that primarily provides plan markup and task management (not time or money data), the Sitelayer value is limited. Skip until customers ask for it.

**Raken daily reports:** The developer portal returned 404/blocked during research. The OAuth integration appears functional based on third-party evidence, but confirming this requires a live Raken account. The value is real (structured daily reports with photos, manpower) but secondary to financial and labor data. Build CompanyCam first; add Raken if customers specifically request structured daily report data.

---

## 7. The Aggregator Question

The four aggregators are: Merge.dev (accounting + HRIS), Codat (accounting), Rutter (accounting, strong in hard cases), and Finch (HRIS/payroll).

**The honest answer: do not use any of them in Year 1. Revisit at Year 2.**

Here is the reasoning:

**QBO and Xero are your accounting market.** Together they cover 90%+ of the 10–100 employee Canadian subcontractor market. Both have excellent native APIs that take 3–5 days each to build. The aggregators charge $30–$65/connection/month. At 50 customers, that is $1,500–$3,250/month in pure middleware cost before you have built any derived insight. You are paying to avoid 3–5 days of engineering that you would have had to do anyway (each aggregator still requires per-customer OAuth flows and connection management).

**Merge.dev pricing:** $650/month for up to 10 connections on the Launch tier. $65/connection beyond that. If you reach 30 customers with accounting connections, you are paying ~$2,000/month to Merge before your own infrastructure costs. For a small team at this stage, this is premature.

**Where aggregators are justified:** If you need to support Sage 300 CRE (Agave/Rutter) or Foundation Software (Agave) for specific enterprise customers, use the aggregator for those cases only — as a case-by-case add-on, not a foundational layer. Rutter's strength in the hard cases (QBD, Sage Intacct, NetSuite) is genuinely valuable if those customers appear.

**Finch for payroll:** Finch is the right answer for US payroll complexity (Paycom, ADP RUN). For Canadian contractors, Finch's Canadian coverage is partial. The practical Canadian payroll stack is ADP Canada (API access is painful but exists), Ceridian Dayforce (API exists), or the contractor uses a QBO payroll add-on (covered via QBO). There is no clean aggregator play here in the Canadian market. Build specific integrations when customers ask.

**The aggregator you should watch:** Agave API is purpose-built for construction — it covers Procore, Sage 300, Foundation, Viewpoint, and others with a unified model. If Sitelayer ever needs to support multiple construction ERP back-ends beyond QBO/Xero, Agave is the right path. They have a sandbox and a documented unified model. But this is a Year 2+ problem.

---

## 8. Revised 6-Month Build Order

Starting assumption: VPS stack is live (Next.js + DigitalOcean + Hatchet + Clerk). The previous roadmap had canvas/daily confirm replacement as a build target — drop that entirely. Here is the revised order.

### Month 1: Accounting Foundation

**Build:**

- QBO integration: OAuth, CDC sync, Invoices, Bills, Estimates, Classes, Time Activities, Customers, Vendors. Webhook handler. Token refresh lifecycle.
- Xero integration: OAuth, modified-since sync, Invoices, Bills, Quotes, Tracking Categories. Webhook handler.
- Internal job normalization layer: every downstream workflow depends on having a stable job identifier that maps across tools. Build this data model now, not later.

**Ship to customers:**

- Division margin view (QBO Classes / Xero Tracking Categories)
- Job cost summary: estimated vs. billed vs. cost per job
- Invoice aging per job

**What NOT to build:** Canvas replacement, daily confirm replacement, anything that requires write-back.

---

### Month 2: Labor Data

**Build:**

- QB Time integration: OAuth, timesheets, job code assignments, GPS geolocation pulls. Job code → QBO job mapping layer (semi-automatic with customer review).
- ClockShark integration: API key pull, timesheets, jobs, cost codes. Same mapping layer.

**Ship to customers:**

- Labor hours by job (job cost view now includes hours alongside dollars)
- Field hours → cost code reconciliation export (weekly CSV for payroll review)
- Daily burn-rate alert (basic version: committed costs + estimated accrued labor vs. budget)

---

### Month 3: E-Signature and Change Orders

**Build:**

- Dropbox Sign integration: API key, signature requests, signed document download, webhooks.
- PandaDoc integration: OAuth, documents, status, webhooks.
- Change order reconciliation workflow: executed CO matching vs. QBO invoices, unmatched CO alert.

**Ship to customers:**

- Change order reconciliation table (live, updated via webhooks)
- Executed CO list per job with invoice match status

**Optional if demand exists:**

- DocuSign integration (adds 2–4 days, only build if specific customers are on DocuSign Business Pro)

---

### Month 4: Takeoff + Estimating

**Build:**

- STACK integration: OAuth, project list, takeoff line items, estimate proposals.
- Assembly-to-cost-code mapping UI: one-time setup per customer.
- File upload path for Bluebeam: CSV/Excel export from Bluebeam ingested as estimate baseline.

**Ship to customers:**

- Assembly-level bid vs. actual (for STACK customers)
- Estimated vs. actual variance table per assembly
- Bluebeam file upload workflow (manual, not API-based)

---

### Month 5: Bonus Calculator + Advanced Labor Analytics

**Build:**

- Bonus pool calculator: configuration UI for formula (margin threshold, bonus rate, division split method), calculation engine, output CSV.
- Labor productivity metrics: hours per unit of work (requires customer to input job scope in Sitelayer).
- Workyard integration (if customer base justifies): bearer token, time cards, projects, cost codes.

**Ship to customers:**

- Bonus pool calculator (live demo to L&A equivalent customers immediately)
- Labor productivity view (per-job hours vs. customer's own average)

---

### Month 6: File Watching + Fleet (Selective)

**Build:**

- Google Drive webhook integration: folder watch, file change log, per-job version audit.
- Samsara integration (if fleet-heavy customers exist): vehicle locations, geofence matching.
- CompanyCam integration (if customers use it): photos by project, GPS metadata.

**Ship to customers:**

- Blueprint version tracking (Drive/Dropbox)
- Photo audit trail (CompanyCam) — if demand exists

**Explicitly NOT on the 6-month roadmap:**

- Procore (build only if a specific Procore GC relationship appears; the data model is large and the value for a sub-only product is lower than for GCs)
- BuildingConnected / bid platform integrations (too early for this ICP)
- Certified payroll (Canadian version is complex; no customer demand yet)
- Any Sage product (Sage 100, 300, Intacct) — defer to specific customer requests
- Equipment utilization (build only if you land a fleet-heavy customer)
- Supplier invoice allocation with write-back (deferred; write-back risk too high at this stage)

---

## 9. Moat Recap

**Why the glue + derived insight + benchmark data strategy builds a moat:**

**1. Data normalization is hard and not automatable.** The job-code mapping layer — connecting QB Time job codes to QBO Customer:Jobs to STACK assembly names — is not something an AI can generate from scratch for each customer. It requires per-customer configuration, learning from historical corrections, and domain knowledge about how construction job costing actually works. Once built for a customer, it is sticky. Switching means rebuilding all those mappings somewhere else.

**2. Cross-customer benchmark data is not replicable.** Once Sitelayer has normalized labor hours, job scope, and cost data across 100 stucco/EIFS subcontractors, you can publish: "median hours per 1,000 sqft EIFS, Alberta market, multi-family residential, Q1 2026." No individual tool can produce this. No AI can produce this without the underlying normalized data. This is a data asset that compounds with every new customer.

**3. Construction-specific insight is not a general AI problem.** General-purpose AI tools (ChatGPT, Copilot) can help a contractor ask questions of their own data in natural language, but they cannot normalize job codes across 4 tools, detect an unmatched change order, or calculate a division bonus pool from QBO classes and QB Time data. These workflows require integration architecture, data normalization, and construction-specific business logic. That is what Sitelayer builds.

**4. The switching cost grows over time.** After 6 months of data in Sitelayer, a customer has job-cost trends, assembly variance history, and labor productivity baselines they cannot easily recreate elsewhere. Their bonus formula is configured. Their CO reconciliation history is logged. The longer they stay, the harder it is to leave — not because Sitelayer is trying to lock them in, but because the derived data is genuinely accumulated.

**5. The integrations themselves are defensible.** Building a production-quality QBO + QB Time + STACK integration with proper CDC sync, token lifecycle management, and error handling takes 4–6 weeks of real engineering. A first-time developer with no context cannot replicate this in a weekend. A well-funded competitor could, but they would also face the same data normalization and construction domain problems.

The correct framing for the next 12 months: earn the right to be the derived-insight layer for Canadian construction subcontractors by solving the margin and labor visibility problem better than any single tool or manual Excel process. Do not try to replace tools. Do not try to manage state. Pull data, derive insight, surface it cleanly. Everything else follows from doing that well.

---

_Sources: glue_research_accounting_payroll.md, glue_research_timefield.md, glue_research_takeoff_misc.md — all verified against official API documentation as of April 2026._
