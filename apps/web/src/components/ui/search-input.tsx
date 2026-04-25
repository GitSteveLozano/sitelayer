import * as React from 'react'

import { cn } from '../../lib/utils.js'
import { Input } from './input.js'

export type SearchInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  debounceMs?: number
  'aria-label'?: string
  name?: string
}

/**
 * Debounced search input. The visible text updates synchronously, but
 * `onChange` only fires after `debounceMs` of idle (150ms default) so
 * downstream filters don't re-run on every keystroke.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  className,
  debounceMs = 150,
  name,
  'aria-label': ariaLabel,
}: SearchInputProps) {
  const [local, setLocal] = React.useState(value)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    setLocal(value)
  }, [value])

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value
    setLocal(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      onChange(next)
    }, debounceMs)
  }

  return (
    <Input
      type="search"
      className={cn('max-w-sm', className)}
      value={local}
      onChange={handleChange}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      {...(name ? { name } : {})}
    />
  )
}

export function usePersistedSearch(
  companySlug: string,
  resourceKey: string,
): [string, (next: string) => void] {
  const storageKey = `sitelayer.search.${companySlug}.${resourceKey}`
  const [value, setValue] = React.useState<string>(() => {
    if (typeof window === 'undefined') return ''
    try {
      return window.localStorage.getItem(storageKey) ?? ''
    } catch {
      return ''
    }
  })

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      setValue(window.localStorage.getItem(storageKey) ?? '')
    } catch {
      setValue('')
    }
  }, [storageKey])

  const update = React.useCallback(
    (next: string) => {
      setValue(next)
      if (typeof window === 'undefined') return
      try {
        if (next) window.localStorage.setItem(storageKey, next)
        else window.localStorage.removeItem(storageKey)
      } catch {
        /* quota or disabled storage — silently drop */
      }
    },
    [storageKey],
  )

  return [value, update]
}
