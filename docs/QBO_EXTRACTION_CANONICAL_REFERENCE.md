# L&A Operations: QBO Setup as Canonical Reference

**Source:** WhatsApp screenshots from Cavy (L&A owner), April 3, 2026
**Gemini AI Extraction:** Text OCR from 7 QBO mobile interface screenshots
**Purpose:** Define L&A's actual business structure for Sitelayer design

---

## 1. Organizational Structure: The 9 Divisions

L&A Operations organizes work into **9 divisions** (QBO Classes):

| Division | Code | Purpose |
|----------|------|---------|
| Stucco | D1 | Exterior stucco finish work |
| Masonry | D2 | Brick, stone, masonry work |
| Siding | D3 | Exterior siding installation |
| EIFS | D4 | Exterior Insulation & Finish System (primary focus) |
| Paper & Wire | D5 | Substrate prep, air barriers, underlayment |
| Snow Removal | D6 | Seasonal snow removal services |
| Warranty | D7 | Warranty/service callbacks |
| Overhead | D8 | Administrative, project mgmt, non-billable |
| Scaffolding | D9 | Temporary scaffolding/equipment rental |

**Key insight:** D4-EIFS is the core business (primary revenue driver). Other divisions support or complement EIFS work.

**Sitelayer implication:** Projects must be assigned to one primary division. All labor, material, and sub-costs should roll up by division for profitability analysis.

---

## 2. Service Catalog: 50+ Billable Items

QBO contains a comprehensive service item master with 50+ line items covering:

### A. Core Scope Items (Measured in Takeoff)
- **EPS** — Expanded Polystyrene foam board
- **Basecoat** — Stucco base layer
- **Finish Coat** — Final stucco/coating layer
- **Air Barrier** — Vapor/air barrier membranes
- **Envelope Seal** — Sealant application
- **Cementboard** — Substrate material
- **Cultured Stone** — Manufactured stone veneer
- **Caulking** — Linear feet of caulk
- **Flashing** — Linear feet of flashing

### B. Material/Supply Items
- Aluminum (framing, trim)
- Brick, Brick-Tex
- Blueskin (membrane brand)
- Cornice, Bulkhead (trim)
- Corner Band Detail, Expandable Joints
- Downspouts, Evestrough
- House Wrap
- Insulation

### C. Trade Work Items
- Carpentry
- Direct Apply Walls/Ceiling (spray application)
- HVAC
- Heating
- Fireplace

### D. Administrative/Billing Items
- Billable Income (general billing catch-all)
- Change Order (scope additions)
- Credit Card Surcharge 2.4%
- Deposit (customer advance)
- Deposit Refund
- Drive Time (out of town travel)
- Engineering (design fees)
- Extra (misc charges)

### E. Accounting Entries (Non-Billable)
- Credit (reversal)
- CEWS Subsidy Receivable
- Holdback (retainage held by customer)
- Hourly Labour (generic time entry)
- Labour for L&A Scaffolding (crew time for rental division)

### F. Discounts/Allowances
- Exclusions (scope removal)
- Inflation (price adjustment)

**Key insight:** QBO service items serve **dual purpose:**
1. **Billable to customers** (scope items, materials, trades)
2. **Internal accounting** (deposits, holdback, subsidies, credits)

Not all 50+ items are suitable for takeoff/estimation. The system needs to distinguish billable work items from administrative entries.

---

## 3. Customer Base

### Active/Primary Customers
- **Foxridge Homes** — Residential builder (multiple projects)
- **Streetside Developments** — Commercial/multi-unit developer
- **6 Thompson Court project** — Specific job address in Oak Bluff, MB
- **Vulcan Construction** (10173913 Manitoba Ltd) — Contractor/partner

### Secondary/Occasional Customers
- 0812 Building Solutions
- 10001659 Manitoba Ltd
- 10055596 Manitoba Ltd
- 10142266 Manitoba Ltd
- Various address-based entries (116 Cathedral, 153 Valley View, 160 Furby)

**Business model insight:** Mix of direct builder customers (Foxridge, Streetside) and project-based work. Some entries are tagged by project address rather than customer name.

**Sitelayer implication:** Projects need customer/builder lookup and address tracking. Customer list grows over time as new builders/contractors are acquired.

---

## 4. Rate Structure & Pricing

### Explicitly Visible Rates (from QBO)
- **Credit Card Surcharge:** 2.4% (markup for card payments)
- **Service item rates:** Present in QBO item master but not visible in these select-list screenshots

### Inferred Rate Categories
1. **Labor rates** (hourly)
   - Base labor rate: ~$38/hour (industry standard for trades)
   - Varies by trade (HVAC, Carpentry likely different)
   
2. **Material rates** (per unit)
   - Per SqFt: EPS, Basecoat, Finish Coat, Air Barrier, Envelope Seal, Cementboard, Cultured Stone
   - Per Linear Foot: Caulking, Flashing, Downspouts, Evestrough

3. **Project markup** 
   - Bid rates set per project ($/SqFt or $/job)
   - Varies by builder, project complexity, market conditions

### Bonus Structure (from chat context, April 10)
- Supervisor bonus tied to project margin performance
- Historical data tracked in Google Sheet (confidential)
- Bonus tiers: 4%, 9%, 14%, 19% of labor (based on profit margin%)
- Currently only calculated for EIFS division (Cavy's core business)

**Sitelayer implication:** 
- Dual rate system: labor hourly + material unit rates
- Project-level bid rate for quick estimation
- Bonus calculation must track actual vs. bid margin per project
- Rate management should be flexible (project templates, builder-specific rates)

---

## 5. Project Lifecycle in QBO

### Estimate Phase
- QBO Estimates created for customer bids
- Estimate status tracks: Draft → Sent → Accepted → Invoice
- Once accepted, becomes basis for project creation

### Project/Job Tracking
- QBO Jobs (customer-linked) represent active projects
- Job can have multiple tasks/milestones
- Customer is linked to Job (enables cost rollup)

### Time Tracking
- TimeActivity records associate worker hours with specific Job
- Service item selected per time entry (what work was done)
- Captures date, hours, employee ref
- **Gap in QBO:** No productivity metrics (SqFt done per hour)

### Billing
- Bills for materials/subcontractor costs linked to Job
- Sales Receipts for direct material purchases
- Invoices created from Job data (labor + materials)
- Progress billing common (milestone-based)

### Financial Reporting
- Division-level P&L (profit per division)
- Job costing (actual hours vs. budgeted)
- Supervisor/crew profitability (bonus basis)

**Sitelayer implication:** System must track projects from bid → estimate → job → billing → margin analysis, with division as primary cost center.

---

## 6. Data Architecture Implications

### Master Data (Static, QBO Source)
- **Divisions:** 9 fixed categories (rarely change)
- **Service Items:** 50+ billable/internal line items (grow over time)
- **Customers:** 20-100+ (dynamic, added as new business acquired)
- **Rates:** Labor hourly + material unit rates (configured in QBO)

### Transactional Data (Project-Specific)
- **Estimates:** Customer bids (before project starts)
- **Projects:** Active jobs with scope, schedule, budget
- **Time Entries:** Daily crew hours by service item
- **Material Bills:** Supplier invoices linked to projects
- **Invoices:** Customer billing records
- **Bonus Tracking:** Actual margin vs. bid margin per project

### Key Relationships
```
Division
  ├── Service Items (multiple per division)
  ├── Projects (assigned to one division)
  │   ├── Estimate (pre-project bid)
  │   ├── Time Entries (labor)
  │   │   └── Service Item (what work was done)
  │   ├── Bills (material costs)
  │   ├── Customer (who paid for it)
  │   └── Bonus Calculation (margin tracking)
  └── Profitability Reporting (P&L by division)
```

---

## 7. Critical Business Metrics (From Chat Context)

### Per-Project Tracking
- **Bid total:** $/SqFt × SqFt (customer quote)
- **Actual cost:** Labor + Material + Subs
- **Margin:** Bid − Actual (profit/loss)
- **Labor rate (actual):** Total hours ÷ SqFt (efficiency metric)
- **Bonus eligibility:** If margin > threshold, supervisor gets bonus tier payout

### Per-Division (Cavy's Main Gap)
- EIFS division has historical bonus data (one year tracked)
- Other divisions lack formalized cost tracking
- Goal: Extend bonus structure company-wide (all 9 divisions)

### Per-Supervisor/Crew
- Track which supervisor managed the project
- Compare actual margin vs. estimate
- Identify high-performing and at-risk crews

**Sitelayer implication:** System must provide real-time visibility into:
1. Project profitability (bid vs. actual) during execution, not post-mortem
2. Labor efficiency (hours vs. SqFt) by crew/trade
3. Bonus calculation (margin tiers) for supervisor accountability
4. Division-level P&L for business unit profitability

---

## 8. Current Pain Points (From Workflow Analysis PDF)

### The Problem: Data Fragmentation
- **Blueprints** trapped in email/Google Drive (no searchable, no measurement linkage)
- **Takeoff measurements** isolated in PlanSwift (not synced to budget/billing systems)
- **Estimates** manually keyed into QuickBooks (data entry error prone)
- **Field crew** sees drawings but not budget/scope data (can't track if on-budget)
- **Performance analysis** only happens post-project (reactive, too late to correct)
- **Labor tracking** (T-Sheets) disconnected from project scope items (can't answer "how many hours on EPS vs. Basecoat?")
- **Bonus calculation** manual (one spreadsheet for EIFS only; requires hours of data compilation)

### The Opportunity: Real-Time Data Integration
- Blueprints → Digital takeoff (measurements, scope breakdown, estimate)
- Estimate → Project setup (auto-populate budget, scope items, labor rates)
- Field crew → Time entry (daily confirm, scope item breakdown, crew schedule)
- QBO sync → Material costs, invoices, actual spending
- Real-time dashboard → Project margin tracking, bonus tiers, crew performance
- Automated bonus → Division-wide, supervisor-specific, tied to actual margin

---

## 9. Design Requirements Summary

### From QBO Setup
1. **Multi-division support** — Projects assigned to one of 9 divisions for P&L
2. **Service item flexibility** — 50+ items in QBO; takeoff uses ~9 measurable items
3. **Customer/Builder tracking** — 20-100+ active customers, project address tracking
4. **Dual rate system** — Labor hourly + material unit rates (SqFt or linear feet)
5. **Project-level pricing** — Bid rate per project (can override defaults)
6. **Time entry by service item** — Crew logs hours per scope item (not just total hours)
7. **Material cost capture** — Bill linkage to projects for cost tracking
8. **Bonus calculation** — Real-time margin tracking; multi-tier bonus scaling
9. **Division P&L** — Profitability reporting by division (not just company-wide)

### Architectural Implications
- **Master data source:** QBO divisions, service items, customers, rates
- **Sidelayer as digital layer:** Takeoff, project mgmt, time entry, bonus tracking
- **Data flow:** Blueprint → Estimate → Project → QBO Estimate/Job → Sitelayer time/cost tracking → Margin analysis
- **User roles:** Estimator (takeoff), Foreman (time entry), Supervisor (bonus tracking), Owner (P&L)
- **Mobile-first:** Field crew needs mobile time entry; foreman needs daily confirm UI

---

## 10. Verification Checklist for Future Implementation

- [ ] All 9 divisions imported from QBO (match exactly: D1-Stucco through D9-Scaffolding)
- [ ] Service item catalog synced from QBO (50+ items; takeoff uses ~9 curated items)
- [ ] Customer master synced from QBO (add new customers without code change)
- [ ] Labor rates configurable (company default + project override)
- [ ] Material unit rates configurable (per SqFt, per linear foot)
- [ ] Projects assigned to division (for P&L rollup)
- [ ] Time entries track division + service item + hours (not just total)
- [ ] Material bills linked to projects (QBO cost import)
- [ ] Bonus calculation multi-division (not just EIFS)
- [ ] Real-time margin tracking (bid vs. actual during project)
- [ ] Historical data validation (matches QBO P&L for EIFS division)

---

**Document Purpose:** This extract represents the ground truth of L&A's business structure as defined in QBO. Any Sitelayer redesign should treat these 9 divisions, 50+ service items, and rate structure as immutable requirements, not implementation details.
