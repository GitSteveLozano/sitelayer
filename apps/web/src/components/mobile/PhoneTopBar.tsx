import type { ReactNode } from 'react'
import { Pill } from './Pill'
import { cn } from '@/lib/cn'

/**
 * Persistent top bar shown at the head of every phone screen. Holds the
 * "currently on site" status pill (matching the design's `pmb-status` /
 * `PStatusBar`) so the worker always sees their connection to the
 * project at a glance.
 */
export interface PhoneTopBarProps {
  /** Project name when on-site; null = "off-site". */
  activeProject: string | null
  className?: string
  trailing?: ReactNode
}

export function PhoneTopBar({ activeProject, className, trailing }: PhoneTopBarProps) {
  return (
    <div className={cn('flex items-center justify-between px-4 pt-3 pb-2', className)}>
      {activeProject ? (
        <Pill tone="good" withDot>
          {activeProject}
        </Pill>
      ) : (
        <Pill tone="default" withDot>
          Off-site
        </Pill>
      )}
      {trailing}
    </div>
  )
}
