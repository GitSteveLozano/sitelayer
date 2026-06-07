/**
 * Blueprint PII-scan hook — OPT-IN, default OFF, currently a no-op stub.
 *
 * Blueprints are user-supplied PDFs that legitimately contain customer PII
 * (addresses, contract terms, owner names). Sitelayer does NOT scan, redact,
 * or scrub them today — RLS + company-scoped access control is the only
 * protection (see CLAUDE.md "Blueprint storage hygiene" #3 and
 * docs/BLUEPRINT_SECURITY.md).
 *
 * This module reserves the seam for a FUTURE opt-in scan (e.g. a Claude-vision
 * pass that flags / tags PII regions) so the wiring point is auditable and the
 * default-OFF contract is enforced + tested BEFORE any heavyweight scan ships.
 * It deliberately ships no model call: turning the flag on changes nothing
 * until the scan implementation lands. That mirrors the BLUEPRINT_VISION_MODE
 * gate — an accidentally-set flag must never start spending or touching blob
 * contents on its own.
 *
 * Contract:
 *   - `isBlueprintPiiScanEnabled()` is the single gate. OFF unless
 *     BLUEPRINT_PII_SCAN is explicitly one of 1/true/on/yes.
 *   - `maybeScanBlueprintForPii()` is the future hook. While the scan is
 *     unbuilt it returns a `{ scanned: false }` no-op for every input,
 *     regardless of the flag, and NEVER logs or echoes blob contents.
 */

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])

/**
 * Resolve the opt-in flag. Default OFF: only an explicit truthy value flips it
 * on. Any unset / empty / unrecognized value (including 0/false/off/no) is OFF.
 */
export function isBlueprintPiiScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BLUEPRINT_PII_SCAN?.trim().toLowerCase()
  if (!raw) return false
  return TRUTHY.has(raw)
}

/** Result of the (future) PII scan. `scanned: false` = the no-op stub path. */
export type BlueprintPiiScanResult =
  | { scanned: false }
  | {
      scanned: true
      /** Whether the scan believes the blob contains PII. */
      hasPii: boolean
      /** Opaque, content-free tags (e.g. 'address', 'owner_name'). NEVER raw PII. */
      tags: readonly string[]
    }

/**
 * Future opt-in PII-scan hook. Currently a no-op stub: it performs NO scan,
 * makes NO model call, and reads NO blob contents — it just honors the
 * default-OFF contract and returns `{ scanned: false }`. Even when the flag is
 * ON it stays a no-op until the real scan implementation lands, so flipping
 * the flag early cannot leak contents or incur cost.
 *
 * IMPORTANT for whoever implements the real scan: never log, echo, or persist
 * the raw bytes / extracted text. Emit only content-free tags + a boolean.
 */
export async function maybeScanBlueprintForPii(
  _input: { storageKey: string; mimeType: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<BlueprintPiiScanResult> {
  if (!isBlueprintPiiScanEnabled(env)) return { scanned: false }
  // Flag is ON but the scan is not built yet — stay a no-op. Do NOT fetch or
  // inspect the blob here; the implementing slice owns that, behind this gate.
  return { scanned: false }
}
