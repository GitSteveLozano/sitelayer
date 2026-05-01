import { Route, Routes } from 'react-router-dom'
import { ProjectsListScreen, ProjectDetailScreen } from '@/screens/projects'
import { ProjectSetupScreen } from '@/screens/projects/setup'

/**
 * Projects tab — nested routes under /projects.
 *   /projects               → prj-list
 *   /projects/:id           → prj-detail (sub-tabs via ?tab=)
 *   /projects/:id/setup     → prj-geofence + project setup form
 */
export default function ProjectsRoute() {
  return (
    <Routes>
      <Route index element={<ProjectsListScreen />} />
      <Route path=":id" element={<ProjectDetailScreen />} />
      <Route path=":id/setup" element={<ProjectSetupScreen />} />
    </Routes>
  )
}
