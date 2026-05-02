import { WorkerPhotoLogScreen } from '@/screens/worker'

/**
 * `/photo` — wk-log site-photo capture (Sitemap §11 panel 6).
 *
 * Worker FAB on wk-today routes here. Owner / foreman roles also
 * land on the same screen since the underlying daily-log photo
 * machinery is shared — they just navigate from a different surface.
 */
export default function PhotoRoute() {
  return <WorkerPhotoLogScreen />
}
