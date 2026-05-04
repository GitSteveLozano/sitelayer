/* global React, ReactDOM, useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakColor, TweakSelect */
const { useState: uSA, useEffect: uEA, useMemo: uMA } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "#D9904A",
  "density": "comfortable",
  "scenario": "healthy",
  "navStyle": "side",
  "scheduleView": "4week",
  "persona": "worker",
  "autoClock": true,
  "geofence": 100,
  "entryMode": "list",
  "approvalState": "pending"
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [role, setRole] = uSA('owner');
  const ownerHome = 'projects';
  const foremanHome = 'fm-today';
  const workerHome = 'wk-today';
  const homeFor = r => r === 'foreman' ? foremanHome : r === 'worker' ? workerHome : ownerHome;
  const [route, setRoute] = uSA(ownerHome);
  React.useEffect(() => { setRoute(homeFor(role)); }, [role]);
  const [projectId, setProjectId] = uSA('p-hillcrest');
  const [collapsed, setCollapsed] = uSA(false);
  const [editMode, setEditMode] = uSA(false);

  uEA(() => {
    document.documentElement.setAttribute('data-theme', tweaks.theme);
    document.documentElement.style.setProperty('--accent', tweaks.accent);
  }, [tweaks.theme, tweaks.accent]);

  uEA(() => {
    function onMsg(e){
      if (e.data?.type==='__activate_edit_mode') setEditMode(true);
      if (e.data?.type==='__deactivate_edit_mode') setEditMode(false);
    }
    window.addEventListener('message', onMsg);
    window.parent.postMessage({type:'__edit_mode_available'}, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const data = window.SITELAYER_DATA;

  function openProject(id) { setProjectId(id); setRoute('detail'); }
  function goBack() { setRoute('projects'); }

  const titles = {
    projects: 'Projects', detail: 'Project',
    takeoff: 'Measurements', estimate: 'Estimate',
    schedule: 'Schedule', time: 'Time',
    rentals: 'Rentals', sync: 'QBO Sync',
    'fm-today': 'Today', 'fm-crew': 'Crew time', 'fm-log': 'Daily log', 'fm-schedule': 'Schedule',
    'wk-today': 'Today', 'wk-week': 'My week', 'wk-time': 'My hours',
  };

  return (
    <div className="app" data-collapsed={collapsed}>
      <window.SLSidebar route={route === 'detail' ? 'projects' : route} setRoute={setRoute}
        collapsed={collapsed} syncCount={3} role={role} setRole={setRole}/>

      <div className="mob-top">
        <button className="btn" data-variant="ghost" style={{padding:6}} onClick={() => setCollapsed(c=>!c)}>{window.SLIcons.menu}</button>
        <div className="brand-mark"><span/></div>
        <div className="mob-title">{titles[route] || 'Sitelayer'}</div>
        <button className="btn" data-variant="ghost" style={{padding:6}}
          onClick={() => setTweak('theme', tweaks.theme === 'light' ? 'dark' : 'light')}>
          {tweaks.theme === 'light' ? window.SLIcons.moon : window.SLIcons.sun}
        </button>
      </div>

      <main className="main">
        <div className="main-inner">
          <div className="row" style={{justifyContent:'flex-end', marginBottom: 8, gap: 6}}>
            <span className="pill" data-tone="green"><span className="dot"/>Online · synced</span>
            <button className="btn" data-variant="ghost" style={{padding:6}}
              onClick={() => setTweak('theme', tweaks.theme === 'light' ? 'dark' : 'light')}>
              {tweaks.theme === 'light' ? window.SLIcons.moon : window.SLIcons.sun}
            </button>
          </div>

          {route === 'projects' && <window.SLProjects data={data} openProject={openProject}/>}
          {route === 'detail' && <window.SLProjectDetail data={data} projectId={projectId} setRoute={setRoute} goBack={goBack}/>}
          {route === 'takeoff' && <window.SLTakeoff data={data} projectId={projectId} setRoute={setRoute}/>}
          {route === 'estimate' && <window.SLEstimate data={data} projectId={projectId}/>}
          {route === 'schedule' && <window.SLSchedule data={data} viewMode={tweaks.scheduleView || '4week'}/>}
          {route === 'time' && <window.SLTime data={data} initialEntryMode={tweaks.entryMode || 'list'}/>}
          {route === 'field' && null}
          {route === 'rentals' && <window.SLRentals data={data}/>}
          {route === 'sync' && <window.SLSync data={data}/>}
          {/* Foreman lens */}
          {route === 'fm-today' && <window.SLRoleHome data={data} role="foreman" view="today" geofence={tweaks.geofence || 100}/>}
          {route === 'fm-crew' && <window.SLTime data={data} initialEntryMode={tweaks.entryMode || 'list'} foremanLens/>}
          {route === 'fm-log' && <window.SLRoleHome data={data} role="foreman" view="log"/>}
          {route === 'fm-schedule' && <window.SLRoleHome data={data} role="foreman" view="schedule"/>}
          {/* Worker lens */}
          {route === 'wk-today' && <window.SLRoleHome data={data} role="worker" view="today" geofence={tweaks.geofence || 100} autoClock={tweaks.autoClock !== false}/>}
          {route === 'wk-week' && <window.SLRoleHome data={data} role="worker" view="schedule"/>}
          {route === 'wk-time' && <window.SLRoleHome data={data} role="worker" view="hours"/>}
        </div>
      </main>

      <window.SLMobBot route={route === 'detail' ? 'projects' : route} setRoute={setRoute}/>

      {editMode && (
        <TweaksPanel onClose={() => setEditMode(false)}>
          <TweakSection title="Theme">
            <TweakRadio label="Mode" value={tweaks.theme}
              options={[{value:'light',label:'Light'},{value:'dark',label:'Dark'}]}
              onChange={v => setTweak('theme', v)}/>
            <TweakColor label="Accent" value={tweaks.accent} onChange={v => setTweak('accent', v)}/>
          </TweakSection>
          <TweakSection title="Demo">
            <TweakRadio label="Scenario" value={tweaks.scenario}
              options={[{value:'healthy',label:'Healthy'},{value:'over',label:'Over budget'},{value:'closeout',label:'Closeout'}]}
              onChange={v => setTweak('scenario', v)}/>
          </TweakSection>
          <TweakSection title="Schedule">
            <TweakRadio label="Default view" value={tweaks.scheduleView}
              options={[{value:'4week',label:'4-week'},{value:'week',label:'Week'},{value:'gantt',label:'Gantt'}]}
              onChange={v => setTweak('scheduleView', v)}/>
          </TweakSection>
          <TweakSection title="Field · mobile">
            <TweakRadio label="Persona" value={tweaks.persona}
              options={[{value:'worker',label:'Worker'},{value:'foreman',label:'Foreman'}]}
              onChange={v => setTweak('persona', v)}/>
            <TweakToggle label="Auto clock-in" value={tweaks.autoClock}
              onChange={v => setTweak('autoClock', v)}/>
            <window.TweakSlider label="Geofence radius" value={tweaks.geofence}
              min={50} max={250} step={25} unit="m"
              onChange={v => setTweak('geofence', v)}/>
          </TweakSection>
          <TweakSection title="Time">
            <TweakRadio label="Entry mode" value={tweaks.entryMode}
              options={[{value:'list',label:'List'},{value:'grid',label:'Grid'},{value:'stopwatch',label:'Watch'}]}
              onChange={v => setTweak('entryMode', v)}/>
          </TweakSection>
        </TweaksPanel>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
