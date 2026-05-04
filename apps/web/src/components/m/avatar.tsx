export type MAvatarProps = {
  initials: string
  tone?: '2' | '3' | '4' | '5' | undefined
  size?: 'sm' | 'md' | 'lg' | undefined
}

/**
 * Initials-only avatar. Tone selects from 5 muted color slots: default
 * is the warm orange family, then blue/green/red/amber. Use deterministic
 * tone selection based on user id at the call site so the same person
 * keeps the same color across screens.
 */
export function MAvatar({ initials, tone, size = 'md' }: MAvatarProps) {
  return (
    <span
      className="m-avatar"
      data-tone={tone}
      data-size={size === 'md' ? undefined : size}
    >
      {initials}
    </span>
  )
}

export type MAvatarGroupProps = {
  avatars: ReadonlyArray<{ initials: string; tone?: MAvatarProps['tone'] }>
  max?: number
  size?: MAvatarProps['size']
}

/**
 * Stacked avatars with -8px overlap. Renders up to `max`, then a +N chip.
 */
export function MAvatarGroup({ avatars, max = 4, size = 'md' }: MAvatarGroupProps) {
  const shown = avatars.slice(0, max)
  const overflow = Math.max(0, avatars.length - max)
  return (
    <div style={{ display: 'inline-flex' }}>
      {shown.map((a, i) => (
        <span key={i} style={{ marginLeft: i === 0 ? 0 : -8 }}>
          <MAvatar initials={a.initials} tone={a.tone} size={size} />
        </span>
      ))}
      {overflow ? (
        <span style={{ marginLeft: -8 }}>
          <MAvatar initials={`+${overflow}`} size={size} />
        </span>
      ) : null}
    </div>
  )
}

export function avatarToneFor(seed: string): MAvatarProps['tone'] {
  // Stable tone-from-string. Hash the seed and modulo across the 4 alt tones
  // (the default warm-orange tone is reserved for the active user / "you").
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0
  }
  const tones: NonNullable<MAvatarProps['tone']>[] = ['2', '3', '4', '5']
  return tones[Math.abs(h) % tones.length]
}

export function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}
