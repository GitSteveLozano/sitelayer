# RBAC Overhaul — Custom Roles, Permission Matrix, and Attribute-Constrained Grants

**Status:** Decision-grade analysis. Not an ADR yet; recommends the ADR.
**Date:** 2026-06-01
**Scope:** How Sitelayer should represent roles/permissions to ship the Steve "custom roles" design (4 built-in roles + 9-action matrix + inherit-from-base custom roles + parameterized "extra powers" like _Auth materials up to $1,000_ and _Approve OT ≤ 8h/week_).
**Inputs:** Five research lanes (ReBAC/Zanzibar, policy-engines/Cedar-OPA, commercial+Clerk, academia/NIST, codebase ground-truth) plus direct re-verification against the repo.

> **Codebase numbers in this doc are re-verified, not quoted.** The codebase lane reported "260 `requireRole`"; the live count is **404 `requireRole` call sites in `apps/api/src/routes/` (excluding tests), 472 total including tests, across 145 route module files.** The allow-list distribution below is the live `grep` output. Schema is at migration **135** (next free prefix **136**), not 096.

---

## 1. Executive Recommendation

**Build a Postgres-native, role-centric RBAC + attribute-constraint model in-house. Do not adopt an external authorization engine (OpenFGA/SpiceDB, Cedar-as-service, OPA sidecar, Oso Cloud) and do not push roles into Clerk.**

Concretely:

1. **Promote the implicit permission relation out of code into data.** The ~404 hardcoded `requireRole([...])` allow-lists _are_ the permission-assignment (PA) relation, scattered as constants. Replace them with **one `requirePermission(action, ctx?)` seam** over a **9-action permission catalog** and a per-company **role → permission** resolution. There is exactly one seam to change (`RouteContext.requireRole`, wired once in `server.ts`), so this is a single-function swap plus a mechanical per-site action relabel, not 404 independent rewrites.
2. **Model custom roles as `inherit_from` (one base built-in) + additive grants.** Effective permissions = base role's permissions ∪ additive grants. Single-parent only (the design says "inherit from ONE base role" — enforce it in schema).
3. **Model the $-cap and OT-cap as typed constraint _parameters on the grant_, never as roles.** This is non-negotiable and is the load-bearing theoretical result (role-explosion, §2). Store them as a `constraints jsonb` on the grant row (`{"max_amount_cents": 100000}`, `{"max_ot_hours_per_week": 8}`).
4. **Enforce constraints at the point of action where the magnitude is already in scope.** The material-$ cap has a _live_ enforcement point today (`material_bills.amount`, `POST /api/projects/:id/material-bills`). The OT-cap does **not** have a per-request enforcement point yet (OT is an aggregate computed in payroll burden, not a value presented at the "Approve time" boundary) — so it ships **defined-but-inert** in v1: storable, editable in the UI, validated, but not yet enforced. Be explicit about that to avoid shipping a security theater control.
5. **Keep RLS as-is and orthogonal.** RLS (`SET LOCAL app.company_id` via `set_config`, confirmed live in `mutation-tx.ts`) answers _which company's rows_. The new model answers _which action, within what cap_. Do not merge them; do not push dollar-cap logic into RLS policies.

**Why build, not buy (one paragraph):** Every external engine that _cleanly_ fits the conceptual shape (ReBAC/Cedar) is either a separate stateful service with its own datastore + consistency tokens (OpenFGA/SpiceDB — reintroduces an eventual-consistency problem Sitelayer doesn't have under single-tx RLS) or a Rust/WASM library whose entire decisive advantage (Cedar's formal equivalence prover) is realizable _offline in CI_ without running Cedar at runtime. The actual runtime problem — "is this action in this role's effective permission set, and is `amount ≤ cap`" — is a two-table join and a numeric comparison in the exact raw-SQL/plain-Node idiom this repo deliberately chose. For a single-Postgres, raw-SQL, no-framework, solo-operated app with RLS already present and Clerk as identity-only, the in-house model is ~600–900 LOC, adds zero new services, zero new paid dependencies, and zero new failure modes in `INCIDENT_RESPONSE.md`. (All four buy-side lanes independently land here: the academia lane calls the design "specifically engineered to drop onto an existing RBAC deployment without modification"; the commercial lane says "build the model in Postgres"; the ReBAC lane says "steal the vocabulary, not the engine"; the policy lane concedes "a hand-rolled Postgres-stored permission matrix + a tiny constraint-evaluator can cover this exact model.")

**The one genuinely valuable thing to steal from "buy": Cedar's symbolic equivalence analysis as a _CI gate_, not a runtime.** It is the only mechanism that can _prove_ the new built-in-role policy set is equivalent to the old allow-lists before flipping 404 enforcement points. Whether that proof is worth the WASM build dependency is the single most defensible "buy" decision left open (§7); the default recommendation is to replace it with an **exhaustive table-driven parity test** (cheaper, no new dependency, sufficient at this scale).

---

## 2. The Taxonomy, and Exactly Where Sitelayer Sits

### 2.1 The four families

| Family             | Core primitive                                                                             | Decision question it answers natively                                         |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **RBAC (RBAC0–3)** | user→role→permission relations; role hierarchy (RH); membership constraints                | "Does this user's role grant this permission?"                                |
| **ABAC**           | subject/object/operation/environment **attributes** evaluated against rules at access time | "Do the attributes of this request satisfy the policy?" (e.g. `amount ≤ cap`) |
| **ReBAC**          | relationship tuples `object#relation@subject` + userset rewrite                            | "Is there a relationship path from subject to (object, relation)?"            |
| **PBAC**           | externalized policy + Policy Decision Point                                                | "What does the declarative policy say?" (XACML/NGAC/OPA/Cedar substrate)      |

The RBAC reference family (Sandhu et al., IEEE Computer 1996; NIST standard, ACM TISSEC 2001 / ANSI INCITS 359-2004):

- **RBAC0** — core: `UA ⊆ U×R` (user-assignment) and `PA ⊆ P×R` (permission-assignment).
- **RBAC1** — adds `RH ⊆ R×R`, a partial order: senior roles inherit junior roles' permissions.
- **RBAC2** — adds membership constraints (separation-of-duty, cardinality, prerequisites).
- **RBAC3** — RBAC1 + RBAC2.

### 2.2 Where Sitelayer is _today_

Pure **RBAC0**, with the PA relation encoded as scattered code constants rather than data:

- `company_memberships.role` = the UA relation (free-text, one role per user per company).
- The 404 `requireRole([...])` allow-lists = the PA relation, hardcoded.
- `normalizeCompanyRole` collapses `office → admin` on read (`roles.ts:21`) — a degenerate RBAC1 hierarchy collapse already in the code.
- `ProjectRole` (admin/foreman/worker via `project_assignments`) is a _second_, project-scoped role axis — relationship-shaped, resolved by `getProjectRole()`.

### 2.3 Where the Steve design sits — **RBAC-with-role-hierarchy + attribute-constrained permissions** (role-centric RBAC-A / RABAC)

This is not a borderline call. The target design maps **exactly** onto the NIST/Kuhn-Coyne-Weil **role-centric RBAC-A** model (IEEE Computer 43(6), June 2010, Table 1 option 9), formalized as **RABAC** (Jin-Sandhu-Krishnan, MMM-ACNS 2012):

| Design element (Steve handoff)                                 | Taxonomy mapping                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 4 built-in roles (Owner/Estimator/Foreman/Crew) over 9 actions | **RBAC0** — roles + an explicit PA matrix as data                                     |
| Custom role **inherits-from one base role**                    | **RBAC1** — a single role-hierarchy edge (limited/tree, single-parent)                |
| Custom role adds **additive "extra powers"**                   | RBAC0 PA extension — extra grant rows on top of the inherited base                    |
| "Auth materials up to **$1,000**", "Approve OT **≤ 8h/week**"  | **ABAC** — numeric attribute-constraints (NIST SP 800-162), evaluated at request time |
| Per-company                                                    | tenant scoping (already handled by RLS + `company_id`)                                |

So Sitelayer is a **pragmatic RBAC/ABAC hybrid**: an RBAC skeleton (roles, single-parent hierarchy, an action matrix) carrying a thin ABAC layer (a small set of typed numeric caps as grant parameters). It is **not**:

- pure ABAC (you keep role reviewability — "what's the most this role can ever do" stays statically answerable);
- ReBAC (no relationship graph is needed for the caps — only the orthogonal `ProjectRole` axis is relationship-shaped, and that already exists);
- a full PBAC/XACML engine (you borrow the **PEP/PDP separation** idea — one central evaluator replacing 404 scattered checks — without adopting a policy _language_).

### 2.4 Why the $-cap / OT-cap **MUST be attributes/constraints, not roles** (the role-explosion result)

This is the single most important theoretical constraint on the design, and it is dispositive.

A role is a _named, reusable bundle of permissions_ meant to change slowly and be reviewed statically. A dollar limit is a _continuous magnitude that varies per grant_. Encoding the limit as a role triggers the classic **role explosion**:

- **Kuhn-Coyne-Weil (2010) quantify the boolean case:** _n_ boolean conditions require **up to 2ⁿ roles**, one per combination. Their worked example: 10 attributes (4 static, 6 dynamic) ⇒ 1,024 pure-RBAC roles, OR a combined design of **16 roles + 64 rules**.
- **The continuous case is strictly worse.** A dollar cap (`$500`, `$1,000`, `$1,001`, `$2,500`, …) is an **unbounded** family — there is **no finite role encoding at all**. "A role per dollar limit" is not a 2ⁿ problem; it has no closed cardinality.
- **Jin-Sandhu-Krishnan (2012) give the relational version:** without attributes you'd need a separate role per patient-set / per project; with a single attribute, "two role definitions are enough." Mapped to Sitelayer: without a cap parameter you'd need `Foreman-who-can-auth-$1000`, `Foreman-who-can-auth-$2500`, … per company per threshold. With a `max_amount_cents` parameter on the grant, **one Foreman (or one "Foreman + auth-materials" custom role) whose ceiling is data** suffices.
- **The safety property:** role-centric RBAC-A's defining theorem is that effective permissions = **P ∩ R** (P = role-derived permissions, R = permissions passing the attribute filter) — i.e. **attribute constraints can only _reduce_ a role's permission set, never expand it**. This preserves least-privilege and static reviewability: the role still tells you the _ceiling_; the cap only narrows _within_ it.

**Reconciling "additive" with "reductive":** the Steve mockup frames extra powers as _additive_. That is additive **at the action level** (the grant gives the role an action it didn't have, e.g. Crew normally can't auth materials) and **reductive at the magnitude level** (the cap narrows that action to `amount ≤ $1,000` vs unlimited). Both framings are consistent: grant the _action_ at the role level, attach a numeric _ceiling_ to that grant. Keep this distinction crisp in the schema or you'll accidentally build an expansion model that violates P ∩ R.

**Conclusion:** the cap is a typed numeric attribute on the role-permission grant, compared at request time against the magnitude already in the handler's scope. This is settled by the literature, and all five lanes converge on it independently (ReBAC: "cap stored on the tuple, quantity from request"; Cedar: "`when { ctx.amount <= principal.limit }`"; commercial: "typed limit columns on a grant row"; academia: the role-explosion proof itself; codebase: "constraints are the ABAC layer that will live on custom-role permissions").

---

## 3. SOTA Landscape — Fit-for-Sitelayer Scoring

Scoring is **fit for _this_ app** (single-Postgres, raw-SQL, plain-Node, solo-operator, RLS present, Clerk identity-only, ~150 endpoints), not abstract capability. Capability is "is the model expressive enough"; fit is "should Sitelayer adopt it."

| Engine / Family                        | Roles + inherit-from-base                                 | Additive grants    | $-cap / OT-cap (ABAC)                                                                                       | Runtime shape vs Sitelayer                                                                   | New service / datastore                                             | New consistency burden                          | Verdict                                                                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-house Postgres RBAC+constraints** | ✅ schema rows + `inherit_from`                           | ✅ grant rows      | ✅ `jsonb` cap param, compared in-handler                                                                   | ✅ raw SQL + plain Node, in-process                                                          | ❌ none                                                             | ❌ none (single-tx RLS already strong)          | **★ RECOMMENDED**                                                                                                                                                                                                               |
| **AWS Cedar (embedded lib)**           | ✅ `in` entity edges                                      | ✅ extra `permit`s | ✅ `when{ctx.amount<=principal.limit}` (best-in-class syntax)                                               | 🟡 WASM artifact in `apps/api`; per-request entity-store build                               | ❌ none                                                             | ❌ none (request-time only)                     | **Strong tech fit; runtime not needed. Use analyzer in CI only (optional).**                                                                                                                                                    |
| **OPA / Rego (sidecar)**               | ✅ set-union                                              | ✅ extra `allow`   | ✅ `input.amount <= data...`                                                                                | ❌ Go sidecar; no in-process Node; ~ms RPC × 404 sites                                       | 🟡 sidecar process on droplet                                       | ❌                                              | Over-scoped. Its unique win (partial-eval → SQL filtering) duplicates RLS. **No.**                                                                                                                                              |
| **OpenFGA / SpiceDB (ReBAC)**          | ✅ relations + computed userset                           | ✅ union           | 🟡 Conditions/Caveats (cap on tuple, amount in request context; degrades ListObjects — hurts the matrix UI) | ❌ separate stateful service + dedicated datastore; per-request RPC replaces a `.includes()` | ✅ dedicated DB (SpiceDB needs `track_commit_timestamp`, GC window) | ✅ zookies/ZedTokens to avoid new-enemy problem | Near-perfect _model_, wrong _infrastructure_. **No** (revisit only for cross-app/Drive-style sharing — not on the table).                                                                                                       |
| **Oso / Polar**                        | ✅ cleanest hierarchy syntax (`"foreman" if "estimator"`) | ✅ shorthand rules | 🟡 custom rule bodies                                                                                       | OSS lib viable, but vendor momentum → Oso Cloud (fact-sync to hosted paid service)           | 🟡 (Cloud)                                                          | 🟡                                              | OSS lib is maintenance-track; Cloud is a paid sync dependency. **No.** Named as the _only_ post-pilot "buy" escape hatch (reads Postgres without full sync).                                                                    |
| **Casbin (node-casbin)**               | ✅ transitive `g`                                         | ✅ policy rows     | 🟡 matcher field refs (clumsiest at the parameterized cap — the whole point)                                | ✅ in-process Node                                                                           | ❌ none                                                             | ❌ none                                         | In-process and free, but weakest exactly where it matters (parameterized constraints) and no analysis story. **No** — if you're building in-process anyway, your own 2-table model is clearer than Casbin's PERM/matcher split. |
| **Clerk RBAC**                         | ❌ 10-role cap, org-wide only                             | ❌                 | ❌ no numeric-constraint field; custom perms not in JWT; paid B2B add-on                                    | identity-only today                                                                          | n/a                                                                 | n/a                                             | **Disqualified.** Keep Clerk identity-only; `company_memberships` stays authoritative.                                                                                                                                          |
| **Auth0 / WorkOS RBAC**                | 🟡 coarse, org-wide                                       | 🟡                 | ❌ no parameterized constraint                                                                              | external IdP                                                                                 | n/a                                                                 | n/a                                             | Coarse, org-wide, no cap field. **No.**                                                                                                                                                                                         |

**Reading of the table:** the only two serious contenders are **in-house Postgres** and **Cedar-embedded**. They tie on capability for this design. In-house wins on fit (zero new artifacts, native to the stack, RLS-orthogonal). Cedar's _only_ differentiator is the formal analyzer — which is a CI tool, not a runtime requirement. Everything else is either operationally disqualified (OpenFGA/SpiceDB/OPA) or capability-disqualified at the parameterized-cap feature (Clerk/Auth0/Casbin).

---

## 4. Build-vs-Buy Verdict

**Verdict: BUILD in Postgres. Optionally borrow Cedar's analyzer as a CI gate; default to a parity test instead.**

### 4.1 Why not OpenFGA/SpiceDB (the "best model" option)

The ReBAC model is a near-perfect conceptual match (roles = relations, inherit-from = union, hierarchy = tuple-to-userset, $-cap = Condition/Caveat). It is the wrong _infrastructure_ for this app:

- A **separate stateful network service with its own dedicated datastore** (SpiceDB on Postgres implements its own MVCC, requires `track_commit_timestamp=on`, a GC window; OpenFGA runs its own connection pool). That's a second production system to back up, monitor, and reason about in incidents — a new row in runtime-deps and a new failure mode in `INCIDENT_RESPONSE.md`.
- **Dual-write**: every `company_memberships`/custom-role change must also write tuples and stay in sync (outbox plumbing).
- **Reintroduces eventual consistency**: you'd need zookies/ZedTokens to avoid the new-enemy problem. Today, RLS + a single Postgres transaction gives you strong consistency for free.
- **Conditions degrade list queries**: the permission-matrix UI (the Steve mockup) leans on ListObjects/ListUsers, which Conditions make slower and which _fail_ without request context.
- You'd buy "2 trillion ACLs in <10ms" scale Sitelayer will never approach, as pure operational tax.

### 4.2 Why not OPA

OPA's headline advantage is partial-evaluation → SQL `WHERE` (data filtering). Sitelayer **already** solves data filtering with RLS. You'd pay the full sidecar tax (a Go process on the droplet, ~ms RPC per check × 404 sites, no in-process Node path, Datalog learning curve) mostly for per-action checks Cedar/in-house do more cheaply.

### 4.3 Why not Clerk/Auth0/WorkOS

Hard-disqualified: 10-role cap, org-wide-only scope, **no field for a numeric constraint**, custom perms absent from the JWT, paid B2B add-on. The parameterized cap — the entire point of the overhaul — has nowhere to live. Keep Clerk strictly for identity; `company_memberships` remains the RBAC source of truth.

### 4.4 Cedar: strong tech, but the runtime isn't needed

Cedar genuinely wins on three axes: `when` numeric conditions express the caps as data; `in` entity edges give inherit-from for free; and — uniquely — a **formally-verified evaluator (Lean/Dafny) plus an open-source symbolic analyzer** that can _prove_ policy-set equivalence/permissiveness. But:

- The **runtime** problem (action ∈ effective set, `amount ≤ cap`) is a 2-table join + a comparison. Cedar's ~5µs `is_authorized` is irrelevant when the cost is the per-request **entity-store construction** (marshalling Postgres rows into Cedar entities) — which is work you'd add _on top of_ a SQL lookup you'd still do.
- The Node path is **WASM bindings** (`cedar-wasm`/community `cedarjs`) — a build artifact whose maturity a solo operator must validate against `apps/api`'s Node version.
- The **analyzer runs offline** (SMT/cvc5). You can keep Cedar entirely out of the running binary and still use the analyzer in CI to prove the 404-site cutover preserves access. That's the only piece worth wanting — and §7/§4.5 give a cheaper substitute.

### 4.5 The honest middle: in-house + (optional) Cedar-in-CI

- **Runtime: in-house Postgres.** ~600–900 LOC total. Native to the stack. No new service, no new paid dep, no new consistency token, full RLS/raw-SQL compatibility.
- **Migration safety: pick ONE of**
  - **(a) Exhaustive parity test (default).** A table-driven test asserting, for all 4 built-in roles × 9 actions × every route, that the new `requirePermission` decision equals the old `requireRole` allow-list decision. Cheap, no new dependency, sufficient at this cardinality (36 role×action cells + ~150 routes is trivially enumerable).
  - **(b) Cedar analyzer in CI (optional, only if (a) feels insufficient).** Render the built-in roles to a `.cedar` file and use `cedar-policy-symcc` to prove the built-in policy set is equivalent to the old allow-lists and that each custom role is a strict additive superset of its base. This is the _one_ thing in-house can't give you (machine-checked equivalence). It adds a CI-only Cedar dependency, no runtime Cedar.

**Recommendation:** ship (a). Reach for (b) only if a real privilege-drift scare during the cutover justifies the dependency. At 36 cells the exhaustive test _is_ the proof.

---

## 5. The Recommended Architecture (in detail)

### 5.1 The 9-action permission catalog (the PA relation, as data)

Derive a stable permission-key enum from the Steve matrix (`apps/web/src/screens/desktop/owner-settings.tsx:88–98`):

```
create_project      -- Create project
edit_pricing_book   -- Edit pricing book
auth_materials      -- Authorize materials ($)      [CONSTRAINABLE: max_amount_cents]
brief_crew          -- Brief crew
submit_daily_log    -- Submit daily log
approve_time        -- Approve time                 [CONSTRAINABLE: max_ot_hours_per_week — inert in v1]
clock_in_out        -- Clock in / out
flag_issue          -- Flag issue
stop_work           -- Stop work
```

Store as a seed catalog (immutable forward-only seed migration). Two of the nine actions are _constrainable_ — they accept a typed cap parameter; the other seven are boolean.

### 5.2 Built-in role → permission map (the matrix, as seed data)

The four built-ins are the matrix from the mockup (T = granted):

| Action             | Owner | Estimator | Foreman | Crew |
| ------------------ | ----- | --------- | ------- | ---- |
| create_project     | T     | T         | –       | –    |
| edit_pricing_book  | T     | T         | –       | –    |
| auth_materials ($) | T     | –         | –       | –    |
| brief_crew         | T     | –         | T       | –    |
| submit_daily_log   | T     | –         | T       | –    |
| approve_time       | T     | –         | T       | –    |
| clock_in_out       | T     | T         | T       | T    |
| flag_issue         | T     | T         | T       | T    |
| stop_work          | T     | T         | T       | T    |

**Built-ins are code-or-seed constants, not editable rows** (they define the _system_ contract; only _custom_ roles are per-company editable). Cleanest: a checked-in constant `BUILTIN_ROLE_PERMISSIONS` in `@sitelayer/domain` (versioned like a migration), so the built-in lookup is a constant-time map with no DB round-trip; custom roles resolve from DB.

**Mapping today's 5 company roles onto the 4 built-ins** (the demotion risk — see §6.4):

- `admin` → **Owner** (full).
- `office` → already collapses to `admin` (`normalizeCompanyRole`) → **Owner**. No behavior change.
- `foreman` (company role) → **Foreman**. ⚠️ But today `foreman` is in 63 `['admin','foreman','office']` allow-lists that include actions the _new_ Foreman doesn't have (e.g. `edit_pricing_book` is Estimator/Owner-only in the new matrix). The naive map **demotes** today's foreman. See §6.4.
- `member` → **Crew** (clock/flag/stop only).
- `bookkeeper` → **no clean home in the 4-role matrix.** Bookkeeper appears in TRIAGE/CREATE/READ role-sets (financial triage, work-requests). Placement is an open decision (§7). The safe default: a **built-in "Bookkeeper" custom role** seeded per company that inherits Owner-minus-field-actions, or a 5th built-in — do **not** silently fold bookkeeper into Crew (that strips financial visibility).

### 5.3 `custom_roles` + grants schema

```sql
-- Migration 136 (next free prefix). Additive, immutable once committed.
CREATE TABLE custom_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  inherit_from  text NOT NULL,            -- 'owner' | 'estimator' | 'foreman' | 'crew' (single parent)
  created_by    text NOT NULL,            -- clerk_user_id
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (company_id, name),
  CHECK (inherit_from IN ('owner','estimator','foreman','crew'))
);
ALTER TABLE custom_roles ENABLE ROW LEVEL SECURITY;
-- reuse the existing app_current_company_id() policy pattern (migration 066)
CREATE POLICY custom_roles_tenant ON custom_roles
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

CREATE TABLE custom_role_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custom_role_id uuid NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  action        text NOT NULL,            -- one of the 9 permission keys
  -- constraint parameters; NULL means "granted, uncapped"
  constraints   jsonb,                    -- e.g. {"max_amount_cents": 100000}
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (custom_role_id, action)
);
ALTER TABLE custom_role_grants ENABLE ROW LEVEL SECURITY;
-- RLS inherited transitively via custom_roles.company_id; policy uses an EXISTS subquery on custom_roles
```

**Why `jsonb` for constraints (not typed columns):** the design will grow more cap _types_ (OT-hours, daily limits, per-vendor) faster than it grows _rows_; `jsonb` keeps each new constraint type a code change in the evaluator, not a migration. Money still stored as **integer cents** inside the jsonb to avoid float bugs (note `material_bills.amount` is `numeric(12,2)` — convert at the boundary). If a single, stable cap dominates and you want a CHECK/index on it, a generated column off the jsonb is the escape hatch.

**Binding a membership to a custom role (expand phase, nullable, backward-compatible):**

```sql
ALTER TABLE company_memberships
  ADD COLUMN custom_role_id uuid REFERENCES custom_roles(id) ON DELETE SET NULL;
-- role (text) stays authoritative when custom_role_id IS NULL: 'admin'→Owner, etc.
-- when custom_role_id IS NOT NULL, it wins and `role` is ignored for permission resolution.
```

### 5.4 How a request resolves effective permissions

A small resolver, called once per request and **cached per (company_id, role-key/custom_role_id)** for the request lifetime:

```
resolveEffectivePermissions(membership):
  base = membership.custom_role_id ? customRole.inherit_from : normalizeToBuiltin(membership.role)
  perms = clone(BUILTIN_ROLE_PERMISSIONS[base])          // base ceiling (Map<action, constraints|null>)
  if membership.custom_role_id:
    for grant in custom_role_grants where custom_role_id = …:
      perms.set(grant.action, grant.constraints)          // additive: add action / tighten cap
  return perms                                            // Map<action, constraints | null>
```

- Built-in resolution is a constant-time map lookup (no DB hit).
- Custom resolution is one indexed query (`custom_role_grants` by `custom_role_id`).
- `office → admin` and the 4-role normalization live in `normalizeToBuiltin` — one place, client+server consistent (the existing `normalizeCompanyRole` is folded in, not duplicated).

### 5.5 Where parameterized constraints are enforced (and what's inert in v1)

`requirePermission` does the boolean check; the **constraint** is checked at the action site where the magnitude is in scope:

- **`auth_materials` → LIVE enforcement point.** `POST /api/projects/:id/material-bills` (and the PATCH) already receive `body.amount` and write `material_bills.amount numeric(12,2)` (verified). The handler:

  ```ts
  const perm = ctx.requirePermission('auth_materials') // boolean gate
  if (!perm.granted) return forbid()
  if (perm.constraints?.max_amount_cents != null && toCents(body.amount) > perm.constraints.max_amount_cents) {
    return ctx.sendJson(403, {
      error: 'forbidden: amount exceeds role cap',
      cap_cents: perm.constraints.max_amount_cents,
    })
  }
  ```

  This is the one cap that is **fully live** in v1. (Today this route gates on `['admin','foreman','office']` at `material-bills.ts:99` — note the new matrix makes `auth_materials` **Owner-only** by default, so the built-in gate _tightens_ here; foreman/office lose default material-auth unless granted a custom role with a capped `auth_materials`. That's a deliberate design change, flag it to Steve.)

- **`approve_time` → DEFINED-BUT-INERT in v1.** The OT cap (`max_ot_hours_per_week ≤ 8`) is an **aggregate** constraint: it needs a sum of OT hours over a rolling week, and the "Approve time" boundary (`time_review_run` workflow) does **not** currently present a per-request OT-hours figure — OT is computed downstream in payroll burden (`032_labor_burden.sql`: `ot_hours`, `ot_premium_pct`), not gated at approval. So in v1 the OT-cap is: storable on the grant, editable in the UI, schema-valid — **but not enforced**. Ship it explicitly inert (the UI may show it; the evaluator returns the constraint; no enforcement point consumes it yet) and file a follow-up to add an OT-aggregate read at the approve boundary. Do **not** fake-enforce it.

**The general rule:** the cap parameter is portable into the grant store; the _value being checked against it_ stays application-supplied at the point of action. Several such points don't exist yet — that's expected and must be documented as inert, not hidden.

### 5.6 Composition with RLS

Unchanged and orthogonal. RLS (`set_config('app.company_id', …, true)` in `mutation-tx.ts`, FORCE on ~100 tables) answers _which company's rows_. The new model answers _which action + within what cap_. `custom_roles`/`custom_role_grants` get the **same** `app_current_company_id()` tenant policy so custom-role data is itself tenant-isolated. **Do not** push dollar-cap predicates into RLS — RLS is row-visibility; the cap is a write-time predicate on a magnitude. (Per-action authz at the DB layer would require threading a `current_role` GUC and rewriting every policy into a dynamic permission-matrix lookup — slower, and pure defense-in-depth; explicitly deferred. App-layer enforcement is authoritative for v1.)

### 5.7 The `requirePermission` API

```ts
// route-context.ts — the ONE seam.
type PermissionDecision = { granted: boolean; constraints: Record<string, number> | null }

interface RouteContext {
  // keep requireRole during expand phase (delegates internally), remove in contract phase:
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  requirePermission: (action: PermissionKey) => PermissionDecision // new seam
}
```

- `requirePermission('edit_pricing_book')` → `{ granted, constraints }`. Boolean gate uses `granted`; constrainable actions read `constraints`.
- It is wired **once** in `server.ts` (exactly where `requireRole` is wired at `server.ts:885`), closing over the resolved company + the request-scoped effective-permission map.
- Every one of the 404 call sites changes from `if (!ctx.requireRole([...])) return true` to `if (!ctx.requirePermission('the_action').granted) return true` — a mechanical relabel, made safe by the parity test (§4.5a).

---

## 6. What the Overhaul Means (Migration)

### 6.1 The real call-site footprint (re-verified)

| Allow-list pattern (live grep, routes/ excl. tests)  | Count | Maps to new permission(s)                                                                                  |
| ---------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------- |
| `['admin','office']`                                 |   124 | Owner-only family → relabel per-route action (most are admin/office CRUD: pricing, settings, financial)    |
| `['admin','foreman','office']`                       |    63 | the field-management family (brief_crew / submit_daily_log / approve_time) → **but watch demotion** (§6.4) |
| `['admin']`                                          |    16 | Owner-only (company settings, integrations, bonus rules)                                                   |
| `['admin','foreman','office','member']`              |    10 | broadest non-bookkeeper (clock/flag/stop family)                                                           |
| `['admin','office','foreman']` (order variant)       |     7 | same as the 63 family                                                                                      |
| `['foreman','admin','office']` (order variant)       |     6 | same family                                                                                                |
| `['admin','foreman','office','member','bookkeeper']` |     5 | all-roles (create\_\* / capture)                                                                           |
| `['admin','office','bookkeeper']`                    |     2 | bookkeeper financial scope                                                                                 |
| `['admin','foreman']`                                |     2 | foreman+admin                                                                                              |
| `['admin','foreman','office','worker']`              |     2 | ⚠️ includes `'worker'` (a ProjectRole, not a CompanyRole) — pre-existing inconsistency to clean up         |

**Totals: 404 sites in `routes/` (excl. tests), 472 incl. tests, 145 route files.** The top 3 patterns are ~203/404 (~50%). Named constants (`TRIAGE_ROLES`, `CREATE_ROLES`, `READ_ROLES`, `LIST_ROLES`) collapse some literals further — meaning the _distinct decision shapes_ number ~10–12, so the per-site relabel maps onto a small set of action assignments, not 404 unique judgments.

### 6.2 Expand / backfill / contract (no flag-day)

**Phase E — Expand (no behavior change, fully back-compat):**

1. Migration 136: `custom_roles`, `custom_role_grants` (+ RLS), `company_memberships.custom_role_id` (nullable). Seed migration: permission catalog + nothing else (built-ins live in code).
2. Add `BUILTIN_ROLE_PERMISSIONS` to `@sitelayer/domain` + `resolveEffectivePermissions` + `normalizeToBuiltin` (folds in `normalizeCompanyRole`).
3. Add `requirePermission` to `RouteContext`/`server.ts`. **`requireRole` stays and is unchanged.** Nothing calls `requirePermission` yet.
4. **Parity test (§4.5a):** for all 4 built-ins × 9 actions × every route, assert `requirePermission(action)` would equal the existing `requireRole(allow-list)` decision. This _defines_ the per-route action map and proves the relabel before any call site changes.

**Phase B — Backfill (relabel call sites in batches, behavior-preserving):** 5. Convert call sites from `requireRole([...])` → `requirePermission('action')`, batch by route module, each batch green against the parity test. Start with the highest-value, lowest-ambiguity routes (e.g. `material-bills.ts`, where the constraint also lands). No data migration needed — existing `company_memberships.role` text stays authoritative while `custom_role_id IS NULL`. 6. Ship the `/api/companies/:id/roles` endpoints (GET list built-ins+custom, POST create custom role, PATCH grants, DELETE) and wire the existing presentational matrix UI (`owner-settings.tsx`, `owner-settings-mobile.tsx` RolesScreen/CustomRoleScreen) to them. Add the constraint editor ($-cap input) — the one UI piece that doesn't exist yet. 7. Light up the **live** `auth_materials` cap enforcement (§5.5). Ship the `approve_time` OT-cap **inert** with a visible "not yet enforced" note in the editor or a follow-up task.

**Phase C — Contract (remove the old path):** 8. Once all 404 sites are on `requirePermission` and green, delete `requireRole` from `RouteContext` and `server.ts`, and delete the dead `'worker'`-in-CompanyRole-allow-list anomalies.

### 6.3 Test strategy

- **Parity test (the spine):** exhaustive role×action×route table, asserting equivalence of old vs new decisions through the whole expand+backfill. This is the migration's safety net (and the cheaper substitute for Cedar's prover).
- **Resolver unit tests:** `resolveEffectivePermissions` for built-ins (no DB), custom (base ∪ grants), single-parent enforcement, `office→admin` collapse, P ∩ R invariant (a grant can add an action or tighten a cap but a custom role can never _remove_ a base action — confirm the additive-only shape).
- **Constraint-predicate tests:** `auth_materials` cap boundary (`amount == cap`, `cap+1`, uncapped, cents conversion off `numeric(12,2)`). Mark OT-cap tests `it.skip`/`todo` with a clear "inert in v1" reason.
- **RLS parity audit:** confirm `custom_roles`/`custom_role_grants` are covered by the tenant policy (extend `scripts/audit-pg-schema-parity.py`-style checks).

### 6.4 Risks

1. **Foreman demotion (highest-likelihood regression).** Today `foreman` rides in 63 `['admin','foreman','office']` allow-lists; some of those routes correspond to actions the _new_ Foreman built-in lacks (notably `edit_pricing_book`, which is Estimator/Owner in the matrix). A naive map silently strips foreman access. **Mitigation:** the parity test _will_ flag every route where old-foreman-allowed ≠ new-Foreman-allowed; for each, decide explicitly: (a) the route's action is genuinely Foreman in the new matrix, (b) it's Estimator and today's foremen should be migrated/notified, or (c) it needs a seeded custom role. This is a _design reconciliation_, surfaced mechanically — not a code accident.
2. **office→admin demotion is already true** (collapsed on read) — low risk, but verify no route relies on distinguishing `office` from `admin` post-collapse.
3. **Bookkeeper has no clean 4-role home** (§5.2). Folding it into Crew strips financial visibility; folding into Owner over-grants. **Mitigation:** decide placement explicitly (§7) — seeded built-in "Bookkeeper" custom role, or a 5th built-in. Do not let the parity test's "bookkeeper" rows default to Crew.
4. **`auth_materials` tightening** — the new matrix makes it Owner-only by default, removing it from foreman/office who have it today via the `['admin','foreman','office']` material-bills gate. Intended by the design (the cap exists precisely so a Foreman gets it _capped_ via a custom role), but it is a real access change on a live customer path — flag to Steve before flipping.
5. **OT-cap as security theater** — if shipped as if enforced while inert, it misleads. **Mitigation:** explicit "defined-but-inert" labeling + follow-up.
6. **ProjectRole × custom-role interaction is undefined.** A custom company role (e.g. "Crew + capped auth_materials") assigned to a project as `worker` — which wins? The design is silent. **Mitigation:** out of scope for v1; document as a known gap; keep the two axes independent until Steve specifies.

### 6.5 Effort estimate

- Schema + seed + resolver + `requirePermission` seam + parity test (Phase E): **~2–4 days.**
- Call-site relabel (Phase B, 404 sites in ~10–12 decision shapes, batched, parity-gated): **~3–5 days** (mechanical, the parity test makes it low-risk).
- Roles API + wire the existing matrix UI + new constraint editor + live `auth_materials` cap: **~3–5 days.**
- Contract phase + cleanup: **~1 day.**
- **Total: ~2–3 weeks** of focused work, shippable incrementally (no flag-day; production stays on `requireRole` until each batch flips).

---

## 7. Open Decisions for the Operator

1. **Bookkeeper placement.** 5th built-in role, OR seeded per-company "Bookkeeper" custom role (inherits Owner minus field actions), OR fold into Owner? (Recommend: **seeded built-in custom role** — keeps the matrix at 4 visible built-ins while preserving bookkeeper's financial scope. Needs the TRIAGE/financial action set defined.)
2. **`auth_materials` default tightening.** Confirm with Steve that material-auth becoming Owner-only-by-default (foreman/office lose it unless granted a capped custom role) is the intended product behavior on a live path.
3. **Cedar analyzer in CI: yes or no?** Default recommendation is **no** (the exhaustive parity test is sufficient at 36 cells). Reach for it only if you want machine-checked equivalence/superset proofs and accept a CI-only WASM/Cedar dependency. This is the single real "build-vs-buy" knob left.
4. **`constraints jsonb` vs typed columns.** Recommend jsonb (constraint _types_ will outgrow _rows_). Decide if any single cap warrants a generated column + index/CHECK.
5. **ProjectRole × custom-role precedence.** Defer to a later design pass, or specify now? (Recommend defer; keep axes independent in v1.)
6. **Are built-in roles ever per-company editable?** Recommend **no** — built-ins are the system contract; only custom roles are editable. Confirm the mockup's editable matrix is for _custom_ roles, not for redefining built-ins.

---

## 8. Phased Implementation Roadmap

| Phase                                          | Work                                                                                                                                                                                                                                                                                                                | Exit criterion                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **0. Reconcile (½ day)**                       | Resolve §7 decisions 1–3, 6 with Steve. Produce the authoritative route→action map (one row per distinct decision shape).                                                                                                                                                                                           | Action map agreed; bookkeeper + auth_materials behavior signed off.                                           |
| **1. Expand (2–4 days)**                       | Migration 136 (`custom_roles`, `custom_role_grants` + RLS, nullable `company_memberships.custom_role_id`); permission-catalog seed; `BUILTIN_ROLE_PERMISSIONS` + resolver in `@sitelayer/domain`; `requirePermission` seam in `server.ts`/`route-context.ts` (`requireRole` untouched); **exhaustive parity test**. | Parity test green; zero behavior change in prod; `requireRole` still the only thing called.                   |
| **2. Backfill call sites (3–5 days)**          | Relabel 404 sites `requireRole([...])` → `requirePermission('action')` in batches by module, each batch parity-green. Reconcile every foreman-demotion flag from the parity test.                                                                                                                                   | All 404 sites on `requirePermission`; parity test exhaustively green; demotion deltas explicitly resolved.    |
| **3. Custom roles + UI + live cap (3–5 days)** | `/api/companies/:id/roles` CRUD; wire existing matrix UI (`owner-settings*.tsx`) to it; add $-cap constraint editor; light up **live** `auth_materials` cap; ship `approve_time` OT-cap **inert** with explicit label + follow-up task.                                                                             | Owner can create a custom role with a capped auth_materials and it enforces end-to-end; OT-cap visibly inert. |
| **4. Contract (1 day)**                        | Remove `requireRole` from `RouteContext`/`server.ts`; delete the `'worker'`-in-allow-list anomalies; RLS parity audit on the two new tables.                                                                                                                                                                        | `requireRole` gone; only `requirePermission` remains; schema-parity audit clean.                              |
| **5. Follow-ups (separate)**                   | OT-aggregate read at the `time_review_run` approve boundary → enforce OT-cap; ProjectRole × custom-role precedence design; optional DB-layer per-action defense-in-depth.                                                                                                                                           | Tracked as discrete tasks, not blocking v1.                                                                   |

---

### Citations (by lane)

- **RBAC0–3 / NIST standard:** Sandhu et al., IEEE Computer 29(2), 1996; Ferraiolo et al., ACM TISSEC 4(3), 2001 (ANSI INCITS 359-2004).
- **Role-centric RBAC-A (the design's exact match) + role-explosion:** Kuhn-Coyne-Weil, IEEE Computer 43(6), June 2010 (Table 1 option 9; P ∩ R; 2ⁿ-roles result, 1,024-vs-16+64 example).
- **RABAC (the implementation blueprint):** Jin-Sandhu-Krishnan, MMM-ACNS 2012, LNCS 7531 ("permission-filtering policy without modification to original deployment"; "two role definitions are enough").
- **ABAC attribute-constraints:** NIST SP 800-162 (Hu et al., 2014).
- **Parameterized-role lineage:** Giuri-Iglio, RBAC'97 (more schema-invasive; cite as lineage, implement RABAC's shape).
- **ReBAC model & operational cost:** Zanzibar (Pang et al., USENIX ATC 2019); OpenFGA Conditions; SpiceDB Caveats/Consistency/Datastores (new-enemy problem, zookies/ZedTokens, `track_commit_timestamp`, GC window).
- **Policy engines:** Cedar syntax + Lean/Dafny verification + `cedar-policy-symcc` analyzer (the CI-equivalence option); OPA partial-eval→SQL (duplicates RLS); Oso/Polar; Casbin.
- **Commercial/identity:** Clerk roles (10-role cap, org-wide, no numeric constraint, paid B2B add-on); GitHub custom-repository-roles (inherit-base + additive precedent); Cerbos "sync is 50–70% of build-vs-buy effort."
- **Codebase ground-truth (re-verified):** `packages/domain/src/roles.ts`, `apps/api/src/server.ts:397/885`, `apps/api/src/route-context.ts:25`, `apps/api/src/mutation-tx.ts` (`set_config('app.company_id',…,true)`), `apps/api/src/routes/material-bills.ts:99` (`amount numeric(12,2)`), `docker/postgres/init/001_schema.sql:261` (material_bills), `032_labor_burden.sql` (OT columns), `066_row_level_security.sql`/`085_rls_enable_phase_3.sql` (RLS), schema at migration **135**, **404** `requireRole` sites in `routes/` (472 incl. tests) across **145** files.
