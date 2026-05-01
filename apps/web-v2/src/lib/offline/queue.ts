// Offline mutation queue — IndexedDB-backed.
//
// When a mutation fails with a NetworkError (no response — caller is
// offline or the API is unreachable) we enqueue a serializable
// description of the call here. The replay engine in `replay.ts`
// drains the queue when `online` fires (or every 15s) and applies the
// mutations in order, dropping any that 4xx after replay (bad input
// won't get fixed by retry) and keeping ones that 5xx for the next
// cycle.
//
// Why IndexedDB and not localStorage:
//   - the queue can grow large (a foreman who works a 4G-dead site for
//     a day might queue dozens of clock events + 12 photos)
//   - photos are File / Blob, not strings — IndexedDB stores binary
//     natively, localStorage doesn't
//   - we don't want to block the main thread on JSON.parse of the
//     entire queue at startup
//
// The queue is small + boutique enough that we hand-roll the IDB
// access rather than pull in idb-keyval. Keeps the dep floor flat.

const DB_NAME = 'sitelayer-offline'
const DB_VERSION = 1
const STORE_NAME = 'mutations'

/**
 * Mutation kinds the queue knows how to replay. Each kind is paired
 * with a payload shape; the replay engine has a switch on `kind` that
 * calls the right `request()` invocation.
 */
export type OfflineMutationKind =
  | 'clock_in'
  | 'clock_out'
  | 'clock_void'
  | 'daily_log_patch'
  | 'daily_log_submit'
  | 'daily_log_photo_upload'
  | 'daily_log_photo_delete'
  | 'time_review_event'
  | 'notification_pref_save'

export interface OfflineMutation {
  /** Auto-generated. */
  id: string
  kind: OfflineMutationKind
  /** Wall-clock timestamp at enqueue time. */
  enqueued_at: number
  /** Re-stringified arguments. The replay handler casts to its expected shape. */
  payload: Record<string, unknown>
  /** Last error message captured during a failed replay attempt. */
  last_error?: string | null
  attempt_count: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'))
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('enqueued_at', 'enqueued_at')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

function nextMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Add one mutation to the back of the queue. */
export async function enqueueOfflineMutation(
  kind: OfflineMutationKind,
  payload: Record<string, unknown>,
): Promise<OfflineMutation> {
  const db = await openDb()
  const mutation: OfflineMutation = {
    id: nextMutationId(),
    kind,
    enqueued_at: Date.now(),
    payload,
    attempt_count: 0,
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).add(mutation)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
  notifyChange()
  return mutation
}

/** List queued mutations in insertion order. */
export async function listOfflineMutations(): Promise<OfflineMutation[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).index('enqueued_at').getAll()
    req.onsuccess = () => resolve(req.result as OfflineMutation[])
    req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'))
  })
}

/** Remove one mutation by id. Called after a successful replay. */
export async function removeOfflineMutation(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'))
  })
  notifyChange()
}

/** Update a row (used to bump attempt_count + last_error after a failed replay). */
export async function updateOfflineMutation(mutation: OfflineMutation): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(mutation)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB update failed'))
  })
  notifyChange()
}

/** Pure count for the offline banner badge. */
export async function offlineMutationCount(): Promise<number> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB count failed'))
  })
}

// ---------------------------------------------------------------------------
// Subscriber pattern — let the OfflineBanner re-render on enqueue/dequeue
// without polling. Lightweight; we don't need pub-sub semantics beyond
// "tell every active subscriber that the queue changed."
// ---------------------------------------------------------------------------

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribeOfflineMutations(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notifyChange(): void {
  for (const l of listeners) {
    try {
      l()
    } catch {
      // best-effort
    }
  }
}
