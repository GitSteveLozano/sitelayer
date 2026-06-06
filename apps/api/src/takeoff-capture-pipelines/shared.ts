/** Drop keys whose value is undefined so exactOptionalPropertyTypes consumers accept the object. */
export function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> }
}

/** Default draft-name fallback when the caller doesn't supply one. */
export function defaultCaptureName(kind: string): string {
  switch (kind) {
    case 'roomplan':
      return 'RoomPlan capture'
    case 'photogrammetry':
      return 'Photogrammetry capture'
    case 'drone':
      return 'Drone capture'
    case 'blueprint_vision':
      return 'Blueprint capture'
    default:
      return 'Capture draft'
  }
}
