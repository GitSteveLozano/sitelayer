import type { ProjectRow } from '@/lib/api'
import { MButton } from '../../../components/m/index.js'

export function EstimateTab({ project, navigate }: { project: ProjectRow; navigate: (path: string) => void }) {
  return (
    <div style={{ paddingTop: 8, padding: 16 }}>
      <p style={{ color: 'var(--m-ink-2)', fontSize: 14, lineHeight: 1.5, marginTop: 0 }}>
        Estimate detail loads in its own screen — line items, totals, and send-to-client live there.
      </p>
      <div style={{ marginTop: 16 }}>
        <MButton variant="primary" onClick={() => navigate(`/projects/${project.id}/estimate`)}>
          Open estimate
        </MButton>
      </div>
    </div>
  )
}
