export function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

const PROJECT_TONES = ['#E8A86B', '#A05A33', '#7A8C6F', '#6FA8A0', '#9C7A5B', '#C77B4F'] as const
export function colorForProject(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return PROJECT_TONES[Math.abs(hash) % PROJECT_TONES.length]!
}
