export const STEVE_COLLAB_MODE_STORAGE_KEY = 'sitelayer.collab-mode'
export const STEVE_COLLAB_MODE_VALUE = 'steve'
export const AUTH_FEEDBACK_ENABLED_STORAGE_KEY = 'sitelayer.auth-feedback-enabled'
export const AUTH_FEEDBACK_REPLAY_STORAGE_KEY = 'sitelayer.auth-feedback-replay-enabled'
export const AUTH_FEEDBACK_AUDIO_STORAGE_KEY = 'sitelayer.auth-feedback-audio-enabled'
export const AUTH_FEEDBACK_AUTO_OPEN_STORAGE_KEY = 'sitelayer.auth-feedback-auto-open'

export function isSteveCollabMode(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STEVE_COLLAB_MODE_STORAGE_KEY) === STEVE_COLLAB_MODE_VALUE
  } catch {
    return false
  }
}
