/**
 * `prj-assignments` — Project assignments roster. Who's allocated to which
 * project, with their project role (foreman / worker).
 *
 * Mirrors the foreman-crew grouped-roster archetype: a By-project / By-person
 * chip toggle over `components/m/*` rows, with the full five-state coverage
 * from `components/m-states/*`.
 *
 * Data: the screen reads the company-wide GET /api/assignments in a single
 * request (`useAllAssignments`) — no more one-query-per-project fan-out.
 * `useProjects` is still loaded, but only as a name lookup so each row can
 * show its project's name; assignment rows themselves carry only project_id.
 * Empty/loading/error states are derived from the assignments query (with the
 * project list query as a secondary signal for the name map).
 *
 * Identity: assignment rows carry `clerk_user_id`, and the API resolves it
 * against the clerk_users mirror into `assignee_name` / `assignee_email`. The
 * screen shows the name when present and falls back to a truncated id when the
 * identity hasn't been mirrored yet.
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
  useAllAssignments,
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

type AssigneeIdentity = { clerk_user_id: string; assignee_name: string | null }

/**
 * Display label for an assignee. Prefers the API-resolved `assignee_name`
 * (from the clerk_users mirror); falls back to a short tail of the clerk user
 * id (which looks like `user_2abc…`) so the row stays scannable without
 * pretending we have a real name.
 */
function labelForAssignee(identity: AssigneeIdentity): string {
  const name = identity.assignee_name?.trim()
  if (name) return name
  const trimmed = identity.clerk_user_id.trim()
  if (trimmed.length <= 14) return trimmed
  return `…${trimmed.slice(-10)}`
}

function initialsForAssignee(identity: AssigneeIdentity): string {
  const name = identity.assignee_name?.trim()
  if (name) return initialsFor(name)
  const tail = identity.clerk_user_id.replace(/^user_/, '').replace(/[^a-zA-Z0-9]/g, '')
  return (tail.slice(0, 2) || '??').toUpperCase()
}

export function ProjectAssignmentsScreen() {
  const [grp, setGrp] = useState<GroupBy>('project')
  const projectsQuery = useProjects()
  const assignmentsQuery = useAllAssignments()

  // Project-name lookup. The company-wide assignments endpoint returns
  // project_id only, so we resolve names from the (already-cached) project
  // list. A missing entry falls back to the id.
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projectsQuery.data?.projects ?? []) map.set(p.id, p.name)
    return map
  }, [projectsQuery.data?.projects])

  // One company-wide query → one flat list (server already filters
  // soft-deleted rows, but we keep the guard for safety) tagged with the
  // project name for grouping.
  const rows = useMemo(() => {
    const flat: Array<ProjectAssignment & { projectName: string }> = []
    for (const a of assignmentsQuery.data?.assignments ?? []) {
      if (a.deleted_at) continue
      flat.push({ ...a, projectName: projectNameById.get(a.project_id) ?? a.project_id })
    }
    return flat
  }, [assignmentsQuery.data?.assignments, projectNameById])

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
    const map = new Map<string, { clerkUserId: string; assigneeName: string | null; items: typeof rows }>()
    for (const r of rows) {
      const entry = map.get(r.clerk_user_id) ?? {
        clerkUserId: r.clerk_user_id,
        assigneeName: r.assignee_name,
        items: [],
      }
      entry.items.push(r)
      map.set(r.clerk_user_id, entry)
    }
    for (const entry of map.values()) {
      entry.items.sort((a, b) => a.projectName.localeCompare(b.projectName))
    }
    // Sort by the displayed label so people with resolved names sort by name.
    return [...map.values()].sort((a, b) =>
      labelForAssignee({ clerk_user_id: a.clerkUserId, assignee_name: a.assigneeName }).localeCompare(
        labelForAssignee({ clerk_user_id: b.clerkUserId, assignee_name: b.assigneeName }),
      ),
    )
  }, [rows])

  const peopleCount = byPerson.length
  const projectsWithCrew = byProject.length

  // ---- System states -------------------------------------------------
  // The company-wide assignments read is the primary load. If it fails we
  // can't show the roster (project names are only a secondary lookup that
  // degrades to ids, so a failed project list never blocks rendering here).
  if (assignmentsQuery.isError) {
    return (
      <Shell>
        <MErrorState
          title="Couldn't load assignments"
          body="The assignment roster didn't load. Check your connection and try again."
          primaryLabel="Retry"
          onPrimary={() => void assignmentsQuery.refetch()}
        />
      </Shell>
    )
  }

  // Loading the single assignments query.
  if (assignmentsQuery.isLoading) {
    return (
      <Shell>
        <MSkeletonList count={6} />
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
                      <MAvatar initials={initialsForAssignee(a)} tone={avatarToneFor(a.clerk_user_id)} size="sm" />
                    }
                    headline={labelForAssignee(a)}
                    supporting={ROLE_LABEL[a.role]}
                    trailing={<MPill tone={ROLE_TONE[a.role]}>{ROLE_LABEL[a.role]}</MPill>}
                  />
                ))}
              </MListInset>
            </div>
          ))
        : byPerson.map((group) => (
            <div key={group.clerkUserId}>
              <MSectionH>
                {labelForAssignee({ clerk_user_id: group.clerkUserId, assignee_name: group.assigneeName })}
              </MSectionH>
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
