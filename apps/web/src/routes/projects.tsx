import { Route, Routes } from 'react-router-dom'
import { ProjectsListScreen, ProjectDetailScreen } from '@/screens/projects'
import { ProjectSetupScreen } from '@/screens/projects/setup'
import { TakeoffCanvasScreen } from '@/screens/projects/takeoff-canvas'
import { TakeoffSummaryScreen } from '@/screens/projects/takeoff-summary'
import { TakeoffDetailScreen } from '@/screens/projects/takeoff-detail'
import { PhotoMeasureScreen } from '@/screens/projects/photo-measure'
import { ProjectRentalContractScreen } from '@/screens/inventory-admin'

/**
 * Projects tab — nested routes under /projects.
 *
 * Linear takeoff pipeline (Sitemap §5):
 *   list (prj-detail Takeoff sub-tab) → detail → photo / canvas → summary
 *
 *   /projects                                  → prj-list
 *   /projects/:id                              → prj-detail (sub-tabs via ?tab=)
 *   /projects/:id/setup                        → prj-geofence + project setup form
 *   /projects/:id/takeoff/:measurementId       → to-detail single measurement view
 *   /projects/:id/takeoff-canvas               → polygon / lineal / count drawing surface
 *   /projects/:id/photo-measure                → to-photo capture + rectangle ratio
 *   /projects/:id/takeoff-summary              → per-item totals with proportional bars
 *   /projects/:id/rental-contract              → per-project rental contract editor
 */
export default function ProjectsRoute() {
  return (
    <Routes>
      <Route index element={<ProjectsListScreen />} />
      <Route path=":id" element={<ProjectDetailScreen />} />
      <Route path=":id/setup" element={<ProjectSetupScreen />} />
      <Route path=":id/takeoff/:measurementId" element={<TakeoffDetailScreen />} />
      <Route path=":id/takeoff-canvas" element={<TakeoffCanvasScreen />} />
      <Route path=":id/takeoff-summary" element={<TakeoffSummaryScreen />} />
      <Route path=":id/photo-measure" element={<PhotoMeasureScreen />} />
      <Route path=":id/rental-contract" element={<ProjectRentalContractScreen />} />
    </Routes>
  )
}
