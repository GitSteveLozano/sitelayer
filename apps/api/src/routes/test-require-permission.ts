/**
 * Shared test helper: a faithful `requirePermission` mock for route tests.
 *
 * The production overlay (server.ts:requirePermission) resolves the caller's
 * effective named-action authority from their built-in base + custom-role
 * grants and 403s on deny / over-cap. Route-unit tests don't boot that wiring,
 * so this rebuilds the same verdict from the test fixture's company role
 * (no custom grants — those are exercised in the parity + permission-seam
 * tests) and pushes the same-shaped 403 onto the test's response sink.
 *
 * Using the REAL `companyRoleToBuiltin` + `permissionDecision` here keeps the
 * touched route tests honest: a built-in role gates exactly as it would in
 * prod (e.g. a bookkeeper is denied clock_in_out, an estimator/office is
 * denied auth_materials), rather than rubber-stamping every call.
 */
import { companyRoleToBuiltin, type CompanyRole, type PermissionAction } from '@sitelayer/domain'
import { permissionDecision } from '../permission-seam.js'

export function makeTestRequirePermission(
  role: CompanyRole,
  responses: Array<{ status: number; body: unknown }>,
): (action: PermissionAction, opts?: { amountCents?: number; otHours?: number }) => boolean {
  const base = companyRoleToBuiltin(role)
  return (action, opts = {}) => {
    const verdict = permissionDecision(base, [], action, opts)
    if (verdict.outcome === 'denied') {
      responses.push({ status: 403, body: { error: 'forbidden: permission not granted', action, role: base } })
      return false
    }
    if (verdict.outcome === 'over_cap') {
      responses.push({ status: 403, body: { error: 'forbidden: over permission cap', action, cap: verdict.cap } })
      return false
    }
    return true
  }
}
