import { Route, Routes } from 'react-router-dom'
import { ProjectsListScreen, ProjectDetailScreen } from '@/screens/projects'

/**
 * Projects tab — nested routes under /projects.
 *   /projects        → prj-list
 *   /projects/:id    → prj-detail (sub-tabs via ?tab=)
 *
 * Phase 2D will add /projects/:id/schedule for the dedicated week
 * grid; until then the Schedule sub-tab on the detail shell handles
 * it inline.
 */
export default function ProjectsRoute() {
  return (
    <Routes>
      <Route index element={<ProjectsListScreen />} />
      <Route path=":id" element={<ProjectDetailScreen />} />
    </Routes>
  )
}
