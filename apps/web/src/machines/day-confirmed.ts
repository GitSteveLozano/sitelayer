import { useEffect, useState } from 'react'

const STORAGE_KEY = 'sitelayer.lastConfirmedDay'
const DAY_CONFIRMED_EVENT = 'sitelayer:day-confirmed'

function readToday(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return new Date().toISOString().slice(0, 10)
  } catch {
    return null
  }
}

function readStoredDay(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Tracks whether the current day's confirm step has been completed. Backed
 * by `localStorage[sitelayer.lastConfirmedDay]` and refreshed on the
 * `sitelayer:day-confirmed` window event so the App shell badge updates
 * immediately after the confirm view fires the event.
 *
 * Returns a stable boolean. The hook is read-only — to mark today's confirm
 * as done, the confirm view writes the localStorage key and dispatches the
 * event itself.
 */
export function useDayConfirmed(): boolean {
  const [confirmDoneToday, setConfirmDoneToday] = useState<boolean>(() => {
    const today = readToday()
    return today !== null && readStoredDay() === today
  })

  useEffect(() => {
    function refresh() {
      const today = readToday()
      setConfirmDoneToday(today !== null && readStoredDay() === today)
    }
    refresh()
    const handler = () => refresh()
    window.addEventListener(DAY_CONFIRMED_EVENT, handler)
    return () => window.removeEventListener(DAY_CONFIRMED_EVENT, handler)
  }, [])

  return confirmDoneToday
}
