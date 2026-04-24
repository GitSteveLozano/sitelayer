# Current State Workflow: L&A Operations

**Objective:** Project lifecycle from lead intake to post-mortem financial analysis.

## Phase 1: Intake & Estimating (The "Data Silo" Phase)

- **Step 1: Lead Receipt:** Customer design documents (blueprints) are received via email.
- **Step 2: Quantitative Takeoff:** Blueprints are manually imported into **PlanSwift**. Quantities (SqFt, linear footage) are measured.
- **Step 3: The Data Leak:** Takeoff is completed. Measurements exist only within the PlanSwift file.
  - **Pain Point:** There is no digital bridge between the takeoff and the rest of the business. Data is "trapped," requiring manual transcription.
- **Step 4: Bidding & Sales:** SqFt data is manually keyed into **QuickBooks Online** to generate a formal estimate. The project enters a "Waiting" state pending award.

## Phase 2: Project Initiation (The "Manual Migration" Phase)

- **Step 5: Project Kick-off (SOP Triggered):** Upon contract award, the "New Project" SOP is initiated.
  - **Document Migration:** Blueprints and specs are manually uploaded to **Google Drive**.
  - **Field Access:** Field staff are granted access to the Drive folder to review project details.
  - **Friction Point:** The field staff is looking at static PDFs, disconnected from the original takeoff measurements or the estimated budget.

## Phase 3: Production & Billing

- **Step 6: Progress Billing:** As milestones or project phases are completed, invoices are generated and sent via **QuickBooks Online**.
  - **Friction Point:** Invoicing is often done based on "felt" progress or rough milestones because the actual production data (what was measured in Step 2) isn't easily accessible to the billing admin.

## Phase 4: Post-Mortem Analysis (The "Reactive Clarity" Phase)

- **Step 7: Performance Dissection:** Once the job is closed or invoiced, management performs manual job costing:
  - **Labor Data:** Exporting reports from **T-Sheets** (Time Tracking).
  - **Production Data:** Manually pulling the original SqFt measurements from **PlanSwift**.
  - **Analysis:** Comparing hours vs. SqFt to determine the actual labor rate and project profitability.
  - **Critical Flaw:** This analysis is **reactive**. By the time the data is dissected, the project is finished, and any profit loss is already realized.

---

## Summary of Workflow Friction for the Tech Team:

1.  **Redundancy:** Information (Customer info, project names, SqFt) is manually typed into 4 different systems (Email, PlanSwift, QBO, Google Drive).
2.  **Latency:** "Clarity" on job performance is only achieved at the _end_ of the project, not during it.
3.  **Accessibility:** The field crew has the "drawings" (Drive) but lacks the "data" (Takeoff/Budget) to know if they are performing efficiently.
