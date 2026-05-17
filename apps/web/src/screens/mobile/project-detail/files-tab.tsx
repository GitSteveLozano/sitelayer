import type { ProjectRow } from '@/lib/api'
import { MButton } from '../../../components/m/index.js'

export function FilesTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px' }}>
        <MButton variant="ghost" onClick={() => navigate(`/projects/${project.id}/takeoff`)}>
          Open blueprints / takeoff
        </MButton>
      </div>
    </div>
  )
}
