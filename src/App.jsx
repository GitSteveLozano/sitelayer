import { useState } from 'react'
import { TH } from './lib/theme'
import { useAuth } from './hooks/useAuth'
import { useProjects } from './hooks/useProjects'

import { Login }         from './components/Login'
import { Sidebar }       from './components/Sidebar'
import { Dashboard }     from './components/Dashboard'
import { ProjectDetail } from './components/ProjectDetail'
import { NewTakeoff }    from './components/NewTakeoff'
import { TimeTracking }  from './components/TimeTracking'
import { Settings }      from './components/Settings'
import { Spinner }       from './components/Atoms'

export default function App() {
  const { user, company, loading: authLoading, signIn, signOut } = useAuth()
  const { projects, loading: projLoading, refresh } = useProjects(company?.id)

  const [view,       setView]      = useState('dashboard')
  const [selectedId, setSelected]  = useState(null)

  const navigate = (v) => { setView(v); setSelected(null) }

  // ── Full-page loading spinner ─────────────────────────────────────────────
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', background: TH.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner />
      </div>
    )
  }

  // ── Not signed in ─────────────────────────────────────────────────────────
  if (!user) {
    return <Login onSignIn={signIn} />
  }

  // ── Signed in ─────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: TH.bg, color: TH.text, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <Sidebar
        current={view === 'project' ? 'projects' : view}
        onChange={navigate}
        company={company}
        user={user}
        onSignOut={signOut}
      />

      <main style={{ flex: 1, overflowY: 'auto', minHeight: '100vh' }}>
        {view === 'dashboard' && (
          <Dashboard
            projects={projects}
            loading={projLoading}
            onSelectProject={p => { setSelected(p.id); setView('project') }}
            onNewTakeoff={() => navigate('takeoff')}
          />
        )}

        {view === 'projects' && (
          <Dashboard
            projects={projects}
            loading={projLoading}
            onSelectProject={p => { setSelected(p.id); setView('project') }}
            onNewTakeoff={() => navigate('takeoff')}
          />
        )}

        {view === 'project' && selectedId && (
          <ProjectDetail
            projectId={selectedId}
            onBack={() => navigate('dashboard')}
          />
        )}

        {view === 'takeoff' && (
          <NewTakeoff
            companyId={company?.id}
            onBack={() => navigate('dashboard')}
            onCreated={() => refresh()}
          />
        )}

        {view === 'time' && (
          <TimeTracking
            projects={projects}
            onLogged={() => refresh()}
          />
        )}

        {view === 'settings' && (
          <Settings
            company={company}
            onUpdated={() => {}}
          />
        )}
      </main>
    </div>
  )
}
