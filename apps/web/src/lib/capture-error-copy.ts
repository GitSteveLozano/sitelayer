type ErrorWithMessageForUser = {
  message_for_user: () => string
}

function hasMessageForUser(value: unknown): value is ErrorWithMessageForUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message_for_user' in value &&
    typeof (value as { message_for_user?: unknown }).message_for_user === 'function'
  )
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name
    return typeof name === 'string' ? name : ''
  }
  return ''
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : String(error ?? '')
  }
  return String(error ?? '')
}

export function captureErrorMessage(error: unknown, fallback: string): string {
  if (hasMessageForUser(error)) return error.message_for_user()

  const name = errorName(error)
  const message = errorMessage(error)
  const lower = message.toLowerCase()

  if (name === 'NotAllowedError' || lower.includes('permission denied') || lower.includes('not allowed')) {
    return 'Permission was denied. Use the browser permission prompt or send a text issue instead.'
  }
  if (name === 'AbortError') return 'Capture was cancelled. You can retry or send a text issue.'
  if (name === 'NotFoundError') return 'No capture device was available.'
  if (name === 'NotReadableError') return 'The capture device is already in use by another app.'
  if (name === 'NetworkError' || lower.includes('network error')) return 'Network connection failed. Try again.'
  if (lower.includes('capture consent does not allow')) return message

  return message && !message.includes(' → ') ? message : fallback
}
