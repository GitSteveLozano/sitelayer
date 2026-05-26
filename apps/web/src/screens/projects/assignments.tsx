/**
 * `prj-assignments` — Project assignments roster. Who's allocated to which
 * project, with their project role (foreman / worker).
 *
 * Mirrors the foreman-crew grouped-roster archetype: a By-project / By-person
 * chip toggle over `components/m/*` rows, with the full five-state coverage
 * from `components/m-states/*`.
 *
 * Data: the assignments API is per-project (GET
 * /api/projects/:projectId/assignments), so this screen pulls the company's
 * projects, fans out one assignment query per project, and aggregates the
 * results client-side. Empty/loading/error states are derived from the
 * project list query plus the fan-out query statuses.
 *
 * Identity caveat: assignment rows carry `clerk_user_id`, but the company
 * worker roster (and /api/bootstrap) keys workers by their own `id` with no
 * clerk mapping exposed, so the assignee is shown by clerk user id. If a
 * worker name join surfaces later, swap `labelForAssignee` to use it.
 */
import { useMemo, useState, type ReactNode } from 'react'
import {
  MAvatar,
  MBody,
  MChip,
  MChipRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MEmptyState, MErrorState, MSkeletonList } from '../../components/m-states/index.js'
import { useProjects } from '../../lib/api/projects.js'
import {
  useProjectAssignmentsForProjects,
  type ProjectAssignment,
  type ProjectAssignmentRole,
} from '../../lib/api/project-assignments.js'

type GroupBy = 'project' | 'person'

const ROLE_TONE: Record<ProjectAssignmentRole, 'accent' | undefined> = {
  foreman: 'accent',
  worker: undefined,
}

const ROLE_LABEL: Record<ProjectAssignmentRole, string> = {
  foreman: 'Foreman',
  worker: 'Worker',
}

/**
 * Best-effort display label for an assignee. Clerk user ids look like
 * `user_2abc…` — show a short tail so the row stays scannable without
 * pretending we have a real name.
 */
function labelForAssignee(clerkUserId: string): string {
  const trimmed = clerkUserId.trim()
  if (trimmed.length <= 14) return trimmed
  return `…${trimmed.slice(-10)}`
}

function initialsForAssignee(clerkUserId: string): string {
  const tail = clerkUserId.replace(/^user_/, '').replace(/[^a-zA-Z0-9]/g, '')
  return (tail.slice(0, 2) || '??').toUpperCase()
}

export function ProjectAssignmentsScreen() {
  const [grp, setGrp] = useState<GroupBy>('project')
  const projectsQuery = useProjects()
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data?.projects])
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects])
  const assignmentQueries = useProjectAssignmentsForProjects(projectIds)

  // Fan-out aggregation. Each entry of `assignmentQueries` lines up with
  // `projectIds` by index. We collapse them into one flat list (tagging the
  // project name) plus loading/error rollups for the system states.
  const { rows, anyLoading, anyError } = useMemo(() => {
    const flat: Array<ProjectAssignment & { projectName: string }> = []
    let loading = false
    let error = false
    assignmentQueries.forEach((q, i) => {
      if (q.isLoading) loading = true
      if (q.isError) error = true
      const project = projects[i]
      const list = q.data?.assignments ?? []
      for (const a of list) {
        if (a.deleted_at) continue
        flat.push({ ...a, projectName: project?.name ?? a.project_id })
      }
    })
    return { rows: flat, anyLoading: loading, anyError: error }
  }, [assignmentQueries, projects])

  // Group by project (project → its assignments) or by person (assignee →
  // the projects they're on). Sort foreman before worker within a group.
  const byProject = useMemo(() => {
    const map = new Map<string, { projectName: string; items: typeof rows }>()
    for (const r of rows) {
      const entry = map.get(r.project_id) ?? { projectName: r.projectName, items: [] }
      entry.items.push(r)
      map.set(r.project_id, entry)
    }
    for (const entry of map.values()) {
      entry.items.sort((a, b) => roleRank(a.role) - roleRank(b.role))
    }
    return [...map.values()].sort((a, b) => a.projectName.localeCompare(b.projectName))
  }, [rows])

  const byPerson = useMemo(() => {
    const map = new Map<string, { clerkUserId: string; items: typeof rows }>()
    for (const r of rows) {
      const entry = map.get(r.clerk_user_id) ?? { clerkUserId: r.clerk_user_id, items: [] }
      entry.items.push(r)
      map.set(r.clerk_user_id, entry)
    }
    for (const entry of map.values()) {
      entry.items.sort((a, b) => a.projectName.localeCompare(b.projectName))
    }
    return [...map.values()].sort((a, b) => a.clerkUserId.localeCompare(b.clerkUserId))
  }, [rows])

  const peopleCount = byPerson.length
  const projectsWithCrew = byProject.length

  // ---- System states -------------------------------------------------
  // Project list itself failed → hard error (nothing else to render).
  if (projectsQuery.isError) {
    return (
      <Shell>
        <MErrorState
          title="Couldn't load projects"
          body="The project roster didn't load, so assignments can't be shown. Check your connection and try again."
          primaryLabel="Retry"
          onPrimary={() => void projectsQuery.refetch()}
        />
      </Shell>
    )
  }

  // Loading: either the project list is still loading, or we have projects
  // and their assignment fan-out hasn't resolved yet.
  if (projectsQuery.isLoading || (projectIds.length > 0 && anyLoading && rows.length === 0)) {
    return (
      <Shell>
        <MSkeletonList count={6} />
      </Shell>
    )
  }

  // Assignment fan-out failed for every project we tried (and produced no
  // rows). Distinct from the project-list failure above.
  if (anyError && rows.length === 0) {
    return (
      <Shell>
        <MErrorState
          title="Couldn't load assignments"
          body="One or more projects failed to return their crew. Try again — already-loaded assignments will stay."
          primaryLabel="Retry"
          onPrimary={() => assignmentQueries.forEach((q) => void q.refetch())}
        />
      </Shell>
    )
  }

  // No assignments anywhere.
  if (rows.length === 0) {
    return (
      <Shell>
        <MEmptyState
          title="No assignments yet"
          body="No one is allocated to a project. Assignments are made when crews are scheduled, or by an admin from a project."
        />
      </Shell>
    )
  }

  return (
    <Shell>
      <div style={{ padding: '8px 16px 0' }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--m-ink-3)',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          Allocations
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
          {peopleCount} {peopleCount === 1 ? 'person' : 'people'} across {projectsWithCrew}{' '}
          {projectsWithCrew === 1 ? 'project' : 'projects'}
        </div>
      </div>
      <MChipRow>
        <MChip active={grp === 'project'} onClick={() => setGrp('project')} count={projectsWithCrew}>
          By project
        </MChip>
        <MChip active={grp === 'person'} onClick={() => setGrp('person')} count={peopleCount}>
          By person
        </MChip>
      </MChipRow>

      {grp === 'project'
        ? byProject.map((group) => (
            <div key={group.items[0]?.project_id ?? group.projectName}>
              <MSectionH>{group.projectName}</MSectionH>
              <MListInset>
                {group.items.map((a) => (
                  <MListRow
                    key={a.id}
                    leading={
                      <MAvatar
                        initials={initialsForAssignee(a.clerk_user_id)}
                        tone={avatarToneFor(a.clerk_user_id)}
                        size="sm"
                      />
                    }
                    headline={labelForAssignee(a.clerk_user_id)}
                    supporting={ROLE_LABEL[a.role]}
                    trailing={<MPill tone={ROLE_TONE[a.role]}>{ROLE_LABEL[a.role]}</MPill>}
                  />
                ))}
              </MListInset>
            </div>
          ))
        : byPerson.map((group) => (
            <div key={group.clerkUserId}>
              <MSectionH>{labelForAssignee(group.clerkUserId)}</MSectionH>
              <MListInset>
                {group.items.map((a) => (
                  <MListRow
                    key={a.id}
                    leading={
                      <MAvatar initials={initialsFor(a.projectName)} tone={avatarToneFor(a.project_id)} size="sm" />
                    }
                    headline={a.projectName}
                    supporting={ROLE_LABEL[a.role]}
                    trailing={<MPill tone={ROLE_TONE[a.role]}>{ROLE_LABEL[a.role]}</MPill>}
                  />
                ))}
              </MListInset>
            </div>
          ))}
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <MTopBar title="Assignments" />
      <MBody>{children}</MBody>
    </>
  )
}

function roleRank(role: ProjectAssignmentRole): number {
  return role === 'foreman' ? 0 : 1
}
