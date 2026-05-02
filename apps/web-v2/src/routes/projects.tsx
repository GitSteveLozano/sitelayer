import { Route, Routes } from 'react-router-dom'
import { ProjectsListScreen, ProjectDetailScreen } from '@/screens/projects'
import { ProjectSetupScreen } from '@/screens/projects/setup'
import { TakeoffCanvasScreen } from '@/screens/projects/takeoff-canvas'
import { ProjectRentalContractScreen } from '@/screens/inventory-admin'

/**
 * Projects tab — nested routes under /projects.
 *   /projects                       → prj-list
 *   /projects/:id                   → prj-detail (sub-tabs via ?tab=)
 *   /projects/:id/setup             → prj-geofence + project setup form
 *   /projects/:id/takeoff-canvas    → polygon / lineal / count drawing surface
 *   /projects/:id/rental-contract   → per-project rental contract editor
 */
export default function ProjectsRoute() {
  return (
    <Routes>
      <Route index element={<ProjectsListScreen />} />
      <Route path=":id" element={<ProjectDetailScreen />} />
      <Route path=":id/setup" element={<ProjectSetupScreen />} />
      <Route path=":id/takeoff-canvas" element={<TakeoffCanvasScreen />} />
      <Route path=":id/rental-contract" element={<ProjectRentalContractScreen />} />
    </Routes>
  )
}
