import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Bottom sheet — the design's modal pattern (`m-sheet-back` / `m-sheet`).
 * Used for short tasks: flag-a-problem, dispatch confirm, etc.
 *
 * Click-outside dismisses; ESC dismisses; focus is trapped inside the
 * sheet while open.
 */
export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  /** Aria label when no visible title. */
  ariaLabel?: string
  children: ReactNode
  className?: string
}

export function Sheet({ open, onClose, title, ariaLabel, children, className }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Focus the sheet so screen readers + keyboard users land inside.
    sheetRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? ariaLabel}
      className="fixed inset-0 z-40 flex items-end bg-black/45"
      onClick={(e) => {
        // Backdrop click only — don't dismiss when clicking inside the sheet.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={sheetRef}
        tabIndex={-1}
        className={cn(
          'w-full max-h-[88dvh] bg-bg rounded-t-[24px]',
          'pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]',
          'shadow-[0_-4px_24px_rgba(0,0,0,0.12)] flex flex-col outline-none',
          className,
        )}
      >
        {/* Grabber */}
        <div aria-hidden="true" className="w-9 h-1 bg-line-2 rounded-full mx-auto mt-2 mb-1" />
        {title ? (
          <div className="px-5 pt-2 pb-3 border-b border-line text-[18px] font-semibold tracking-tight">{title}</div>
        ) : null}
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  )
}
