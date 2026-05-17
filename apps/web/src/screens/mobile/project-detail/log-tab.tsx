import type { ProjectRow } from '@/lib/api'
import { MButton } from '../../../components/m/index.js'
import { MAiStripe } from '../../../components/m/ai.js'

export function LogTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ padding: '0 16px 12px' }}>
        <MAiStripe eyebrow="Daily log" title="Pulled from foreman submissions" onDismiss={() => {}}>
          When the foreman ends their day, the daily log lands here. Until then, the desktop log view shows everything
          logged so far.
        </MAiStripe>
      </div>
      <div style={{ padding: '0 16px' }}>
        <MButton variant="ghost" onClick={() => navigate(`/projects/${project.id}`)}>
          Open full project on desktop
        </MButton>
      </div>
    </div>
  )
}
