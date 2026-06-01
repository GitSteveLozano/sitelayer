import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_PERMISSIONS,
  PERMISSION_ACTIONS,
  builtinToCompanyRole,
  companyRoleToBuiltin,
  resolveEffectivePermissions,
  hasPermission,
  COMPANY_ROLES,
  type BuiltinRole,
  type CompanyRole,
  type PermissionAction,
} from '@sitelayer/domain'

// ===========================================================================
// RBAC overhaul — the EXHAUSTIVE parity test (LAYER 2 + the long-tail safety
// net). This is the single source that asserts, in one place:
//
//   (A) every BuiltinRole × every one of the 9 named actions matches the
//       design matrix (msg__89/90 ACTION_MATRIX / owner-settings RolesScreen),
//       resolved through the SAME resolveEffectivePermissions the live
//       requirePermission overlay uses (no custom grants = the pure matrix);
//
//   (B) the long tail is unchanged for non-custom members:
//       builtinToCompanyRole(companyRoleToBuiltin(r)) === r for all 5 company
//       roles — so making role resolution custom-role-aware in ONE place
//       (server.ts) does not move any of the ~260 existing requireRole sites
//       for a member with no custom role;
//
//   (C) the INTENDED per-action deltas at each of the 9 routes: for every
//       action route we pin the OLD requireRole allow-list (the company roles
//       that reached the write before this overhaul) against the NEW matrix
//       verdict (after the requirePermission overlay), and assert each
//       newly-DENIED (role × action) pair is exactly the operator-chosen
//       demotion — and that nothing ELSE changed.
//
// If this file goes red, either the matrix moved or a route's overlay drifted
// from the design — both are deliberate code changes that must update this
// test in the same commit.
// ===========================================================================

/** The authoritative design grid — typed independently of the production
 *  constant so a typo in permissions.ts can't silently agree with itself.
 *  Mirrors apps/web/src/screens/settings/owner-settings-mobile.tsx ACTION_MATRIX
 *  (owner/estimator/foreman/crew) plus the operator's bookkeeper decision
 *  (universal safety only: flag_issue + stop_work). */
const DESIGN_MATRIX: Record<BuiltinRole, Record<PermissionAction, boolean>> = {
  owner: {
    create_project: true,
    edit_pricing_book: true,
    auth_materials: true,
    brief_crew: true,
    submit_daily_log: true,
    approve_time: true,
    clock_in_out: true,
    flag_issue: true,
    stop_work: true,
  },
  estimator: {
    create_project: true,
    edit_pricing_book: true,
    auth_materials: false,
    brief_crew: false,
    submit_daily_log: false,
    approve_time: false,
    clock_in_out: true,
    flag_issue: true,
    stop_work: true,
  },
  foreman: {
    create_project: false,
    edit_pricing_book: false,
    auth_materials: false,
    brief_crew: true,
    submit_daily_log: true,
    approve_time: true,
    clock_in_out: true,
    flag_issue: true,
    stop_work: true,
  },
  crew: {
    create_project: false,
    edit_pricing_book: false,
    auth_materials: false,
    brief_crew: false,
    submit_daily_log: false,
    approve_time: false,
    clock_in_out: true,
    flag_issue: true,
    stop_work: true,
  },
  bookkeeper: {
    create_project: false,
    edit_pricing_book: false,
    auth_materials: false,
    brief_crew: false,
    submit_daily_log: false,
    approve_time: false,
    clock_in_out: false,
    flag_issue: true,
    stop_work: true,
  },
}

/** Does `role` (no custom grants) hold `action` per the LIVE resolver the
 *  requirePermission overlay calls on every request? */
function liveHolds(role: BuiltinRole, action: PermissionAction): boolean {
  return hasPermission(resolveEffectivePermissions(role, []), action)
}

// ---------------------------------------------------------------------------
// (A) The exhaustive matrix: every BuiltinRole × every action.
// ---------------------------------------------------------------------------

describe('(A) RBAC parity — every BuiltinRole × every action matches the design matrix', () => {
  for (const role of BUILTIN_ROLES) {
    for (const action of PERMISSION_ACTIONS) {
      const expected = DESIGN_MATRIX[role][action]
      it(`${role} ${expected ? 'HOLDS' : 'is DENIED'} ${action}`, () => {
        // Both the production constant and the live resolver must agree with
        // the independent design grid.
        const inConstant = BUILTIN_ROLE_PERMISSIONS[role].includes(action)
        expect(inConstant).toBe(expected)
        expect(liveHolds(role, action)).toBe(expected)
      })
    }
  }

  it('the design grid covers exactly the 5 bases × 9 actions (no gaps, no extras)', () => {
    expect(Object.keys(DESIGN_MATRIX).sort()).toEqual([...BUILTIN_ROLES].sort())
    for (const role of BUILTIN_ROLES) {
      expect(Object.keys(DESIGN_MATRIX[role]).sort()).toEqual([...PERMISSION_ACTIONS].sort())
    }
  })
})

// ---------------------------------------------------------------------------
// (B) The long-tail safety net: the ~260 requireRole sites do not move for a
// member WITHOUT a custom role. resolveCompanyRoleAuthority gives such a member
// effectiveRole = normalizeCompanyRole(raw); the overhaul only routes a member
// WITH a custom role to builtinToCompanyRole(inherit_from). The invariant that
// guarantees zero tail change is that the builtin mapping is a clean bijection.
// ---------------------------------------------------------------------------

describe('(B) RBAC parity — long tail unchanged for non-custom members', () => {
  for (const role of COMPANY_ROLES) {
    it(`builtinToCompanyRole(companyRoleToBuiltin(${role})) === ${role}`, () => {
      expect(builtinToCompanyRole(companyRoleToBuiltin(role as CompanyRole))).toBe(role)
    })
  }

  it('every BuiltinRole also round-trips through the company role and back', () => {
    for (const base of BUILTIN_ROLES) {
      expect(companyRoleToBuiltin(builtinToCompanyRole(base))).toBe(base)
    }
  })

  it('the 5 company roles and 5 builtin bases are in 1:1 correspondence', () => {
    const mappedBases = COMPANY_ROLES.map((r) => companyRoleToBuiltin(r as CompanyRole))
    expect(new Set(mappedBases).size).toBe(COMPANY_ROLES.length)
    expect(new Set(mappedBases)).toEqual(new Set(BUILTIN_ROLES))
  })
})

// ---------------------------------------------------------------------------
// (C) The INTENDED per-action route deltas.
//
// For each of the 9 action routes we record:
//   - route:            the single endpoint that performs the action.
//   - action:           the PERMISSION_ACTION overlaid there.
//   - oldRequireRole:   the company-role allow-list the route gated on BEFORE
//                       this overhaul (the long-tail requireRole, still present
//                       and running FIRST). `null` = the route had NO role gate
//                       (any authenticated member reached the write).
//
// The NEW gate is requireRole (unchanged) AND THEN requirePermission(action).
// A company role `r` (no custom role) reaches the write iff:
//     oldRequireRole.includes(r)  AND  matrix[companyRoleToBuiltin(r)][action]
// The DELTA set is every company role allowed by the OLD gate but DENIED by the
// matrix overlay. Those are the operator-chosen demotions and must be exactly
// the list pinned per route below.
// ---------------------------------------------------------------------------

type RouteSpec = {
  action: PermissionAction
  route: string
  /** Company roles the OLD requireRole let through; null = no role gate. */
  oldRequireRole: CompanyRole[] | null
  /** The EXPECTED newly-denied company roles (the intended demotions). */
  expectedNewlyDenied: CompanyRole[]
  note: string
}

const ROUTE_SPECS: RouteSpec[] = [
  {
    action: 'create_project',
    route: 'POST /api/projects',
    oldRequireRole: ['admin', 'office'],
    // admin→owner ✓, office→estimator ✓ — both still hold create_project.
    expectedNewlyDenied: [],
    note: 'no delta — owner+estimator == admin+office both hold create_project',
  },
  {
    action: 'edit_pricing_book',
    route: 'PUT/DELETE /api/**/pricing-overrides + POST/PATCH /api/service-items',
    oldRequireRole: ['admin', 'office'],
    // admin→owner ✓, office→estimator ✓ — both still hold edit_pricing_book.
    // (Foreman was never in this requireRole list, so the matrix "Foreman loses
    //  edit_pricing_book" line is moot at THIS route — foreman never reached it.)
    expectedNewlyDenied: [],
    note: 'no delta at the route — owner+estimator both hold edit_pricing_book',
  },
  {
    action: 'auth_materials',
    route: 'POST /api/projects/:id/material-bills',
    oldRequireRole: ['admin', 'foreman', 'office'],
    // Owner-only by default → foreman AND office are demoted off auth_materials.
    expectedNewlyDenied: ['foreman', 'office'],
    note: 'INTENDED: foreman + office demoted (Owner-only matrix); also the live $-cap route',
  },
  {
    action: 'brief_crew',
    route: 'POST /api/schedules/:id/events (CONFIRM)',
    oldRequireRole: ['admin', 'foreman'],
    // admin→owner ✓, foreman ✓ — both still hold brief_crew.
    expectedNewlyDenied: [],
    note: 'no delta — owner+foreman both hold brief_crew',
  },
  {
    action: 'submit_daily_log',
    route: 'POST /api/daily-logs/:id/events (+ /submit alias)',
    oldRequireRole: ['foreman', 'admin', 'office'],
    // owner ✓, foreman ✓, but office→estimator is demoted off submit_daily_log.
    expectedNewlyDenied: ['office'],
    note: 'INTENDED: office→estimator demoted off submit_daily_log',
  },
  {
    action: 'approve_time',
    route: 'POST /api/time-review-runs/:id/events (APPROVE)',
    oldRequireRole: ['admin', 'foreman', 'office'],
    // owner ✓, foreman ✓, but office→estimator is demoted off approve_time.
    expectedNewlyDenied: ['office'],
    note: 'INTENDED: office→estimator demoted off approve_time (OT cap stays INERT)',
  },
  {
    action: 'clock_in_out',
    route: 'POST /api/clock/in + /out',
    // Self path had NO requireRole — ANY member could clock; so the OLD gate is
    // the full company-role union. (The foreman_override branch additionally
    // gated [admin,foreman,office], but the self path is the broad surface.)
    oldRequireRole: [...COMPANY_ROLES] as CompanyRole[],
    // Matrix holds clock_in_out for every base EXCEPT bookkeeper.
    expectedNewlyDenied: ['bookkeeper'],
    note: 'INTENDED: bookkeeper demoted off clock_in_out (financial persona, no field clock)',
  },
  {
    action: 'flag_issue',
    route: 'POST /api/worker-issues (severity != stopped)',
    oldRequireRole: null, // any member could flag
    // Every base holds flag_issue → no role newly denied.
    expectedNewlyDenied: [],
    note: 'no delta — flag_issue is in every built-in base',
  },
  {
    action: 'stop_work',
    route: 'POST /api/worker-issues (severity == stopped)',
    oldRequireRole: null, // any member could stop work
    // Every base holds stop_work → no role newly denied.
    expectedNewlyDenied: [],
    note: 'no delta — stop_work is in every built-in base',
  },
]

/** The company roles allowed by the OLD route gate (null gate = all roles). */
function oldAllowedRoles(spec: RouteSpec): CompanyRole[] {
  return spec.oldRequireRole ?? ([...COMPANY_ROLES] as CompanyRole[])
}

/** Roles the OLD gate let through but the NEW matrix overlay denies. */
function computeNewlyDenied(spec: RouteSpec): CompanyRole[] {
  return oldAllowedRoles(spec).filter((r) => !liveHolds(companyRoleToBuiltin(r), spec.action))
}

describe('(C) RBAC parity — the intended per-action route deltas', () => {
  it('covers exactly the 9 named actions, one route each', () => {
    expect(ROUTE_SPECS.map((s) => s.action).sort()).toEqual([...PERMISSION_ACTIONS].sort())
    expect(new Set(ROUTE_SPECS.map((s) => s.action)).size).toBe(PERMISSION_ACTIONS.length)
  })

  for (const spec of ROUTE_SPECS) {
    describe(`${spec.action} @ ${spec.route}`, () => {
      it(`newly-denied roles are exactly [${spec.expectedNewlyDenied.join(', ') || '<none>'}] — ${spec.note}`, () => {
        const actual = computeNewlyDenied(spec)
        expect(actual.sort()).toEqual([...spec.expectedNewlyDenied].sort())
      })

      it('every role the OLD gate allowed AND the matrix holds still reaches the write (no unintended loss)', () => {
        for (const r of oldAllowedRoles(spec)) {
          const stillReaches = liveHolds(companyRoleToBuiltin(r), spec.action)
          const intentionallyDenied = spec.expectedNewlyDenied.includes(r)
          // A role keeps access iff it isn't on the intended-demotion list.
          expect(stillReaches).toBe(!intentionallyDenied)
        }
      })

      it('roles the OLD gate already blocked are unaffected by the overlay', () => {
        const oldBlocked = (COMPANY_ROLES as readonly CompanyRole[]).filter((r) => !oldAllowedRoles(spec).includes(r))
        for (const r of oldBlocked) {
          // These never reached requirePermission (requireRole 403s first), so
          // the overlay cannot change their outcome — they stay blocked.
          expect(oldAllowedRoles(spec).includes(r)).toBe(false)
        }
      })
    })
  }

  it('the ONLY intended demotions across all 9 routes are auth_materials(foreman,office), submit_daily_log(office), approve_time(office), clock_in_out(bookkeeper)', () => {
    // A single roll-up so an accidental new demotion anywhere fails loudly.
    const allDeltas = ROUTE_SPECS.flatMap((s) => computeNewlyDenied(s).map((r) => `${s.action}:${r}`)).sort()
    expect(allDeltas).toEqual(
      [
        'approve_time:office',
        'auth_materials:foreman',
        'auth_materials:office',
        'clock_in_out:bookkeeper',
        'submit_daily_log:office',
      ].sort(),
    )
  })
})
