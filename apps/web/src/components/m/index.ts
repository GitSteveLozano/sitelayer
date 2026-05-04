/**
 * Mobile design system primitives. Wraps the `m-*` CSS classes in
 * apps/web/src/styles/m.css with TypeScript-typed React shells. Use these
 * for any new mobile screen — every persona's UI is built from this set.
 *
 * The CSS is the source of truth for visuals. These primitives just emit
 * the right class names + JSX shape + a11y. Add new primitives here as
 * the persona screens uncover new patterns.
 */
export { MTopBar } from './topbar.js'
export { MLargeHead } from './large-head.js'
export { MListRow, MListInset, MListPlain } from './list.js'
export { MKpi, MKpiRow } from './kpi.js'
export { MPill, MChip, MChipRow } from './pill.js'
export { MButton, MButtonRow, MButtonStack } from './button.js'
export { MBanner } from './banner.js'
export { MBottomTabs } from './bottom-tabs.js'
export { MAvatar, MAvatarGroup, avatarToneFor, initialsFor } from './avatar.js'
export { MSectionH, MShell, MBody, MStatStrip, MStat } from './section.js'
export { MQuickAction, MQuickActionGrid } from './quick-action.js'
export { MAiEyebrow, MAiStripe, MAiAgent, MAttribution, Spark } from './ai.js'
export { MI } from './icons.js'

export type { MTone, MListRowProps } from './list.js'
export type { MKpiProps } from './kpi.js'
export type { MPillProps, MChipProps } from './pill.js'
export type { MButtonProps } from './button.js'
export type { MBannerTone, MBannerProps } from './banner.js'
export type { MBottomTabSpec } from './bottom-tabs.js'
export type { MAvatarProps, MAvatarGroupProps } from './avatar.js'
export type { MTopBarProps } from './topbar.js'
export type { MLargeHeadProps } from './large-head.js'
export type { MAiStripeProps, MAiAgentProps } from './ai.js'
