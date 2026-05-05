/* global React, ReactDOM, DesignCanvas, DCSection, DCArtboard, DCPostIt,
   PWAInstallSafari, PWAInstallSheet, PWAPermLocation, PWAPermNotif, PWASplash,
   NavBottomIOS, NavTopAppBar, NavDrawerOverflow, NavSwitcher, NavMore,
   DashboardPM,
   ProjectsList,
   ScheduleDay, ScheduleWeek, ScheduleCreateAssignment,
   TimeBurden, TimeLiveVsBudget, TimeForemanEntry,
   RentalsCatalog, RentalsScan, RentalsDispatch, RentalsUtilization, RentalsReturn,
   SettingsHome, SettingsPricing, SettingsTeam,
   WorkerToday, WorkerHoursWeek, WorkerLogPhoto,
   WorkerClockInSuccess, WorkerScopeToday, WorkerIssue,
   ForemanToday, ForemanDailyLog, ForemanScheduleAhead,
   ForemanCrewMap, ForemanField, ForemanBriefCrew, ForemanCrew,
   GeofenceProjectSetup,
   ProjectCreateEntry, ProjectCreateSheet,
   ProjectCreateQBDedupe,
   ProjectDrafting, BlueprintCanvasFull, ShareProposalSheet,
   ProjectSent, ProjectAccepted, ProjectInProgress, ProjectDone, ProjectArchiveSheet,
   ProjectCrewOwner, ProjectCrewForeman, TimeQueueAllProjects,
   DashboardCalmDefault, DashboardCalmFiltered,
   StateOffline, StateError, StateEmpty, StateLoading, StatePermissionDenied
*/

const PHONE_W = 290;
const PHONE_H = 600;

function Phone({ children }) {
  return (
    <div style={{
      width:'100%', height:'100%', borderRadius: 32, overflow:'hidden',
      background: '#f7f4ef',
      boxShadow: '0 1px 0 rgba(0,0,0,0.06), 0 30px 60px rgba(50,40,30,0.10), 0 0 0 1px rgba(60,50,40,0.10)',
      display:'flex', flexDirection:'column',
      position:'relative',
    }}>
      {/* fake notch */}
      <div style={{position:'absolute', top:8, left:'50%', transform:'translateX(-50%)', width:90, height:22, borderRadius:14, background:'#0e0c0a', zIndex:50}}/>
      {/* status bar */}
      <div style={{height:30, padding:'8px 18px 0', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0, fontSize:11, fontWeight:600, fontFamily:'Geist, system-ui, sans-serif', position:'relative', zIndex:5}}>
        <span style={{fontFeatureSettings:'"tnum"'}}>9:41</span>
        <span style={{display:'flex', gap:5, alignItems:'center'}}>
          <svg width="16" height="10" viewBox="0 0 16 10" fill="currentColor"><rect x="0" y="6" width="3" height="4" rx="0.5"/><rect x="4" y="4" width="3" height="6" rx="0.5"/><rect x="8" y="2" width="3" height="8" rx="0.5"/><rect x="12" y="0" width="3" height="10" rx="0.5"/></svg>
          <svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 4a8 8 0 0112 0M3.5 6.5a4 4 0 017 0M6 9h2"/></svg>
          <svg width="22" height="10" viewBox="0 0 22 10" fill="none"><rect x="0.5" y="0.5" width="18" height="9" rx="2.5" stroke="currentColor"/><rect x="2" y="2" width="14" height="6" rx="1" fill="currentColor"/><rect x="19.5" y="3.5" width="1.5" height="3" rx="0.5" fill="currentColor"/></svg>
        </span>
      </div>
      {/* content */}
      <div style={{flex:1, minHeight:0, display:'flex', flexDirection:'column', overflow:'hidden'}}>
        {children}
      </div>
      {/* home indicator */}
      <div style={{position:'absolute', bottom:6, left:'50%', transform:'translateX(-50%)', width:90, height:4, borderRadius:2, background:'rgba(0,0,0,0.25)', zIndex:60}}/>
    </div>
  );
}

function Frame({ children, w = PHONE_W, h = PHONE_H }) {
  return (
    <div style={{ width: w, height: h }}>
      <Phone>{children}</Phone>
    </div>
  );
}

function App() {
  return (
    <DesignCanvas backgroundColor="#f0eee9" initialScale={0.55}>
      <div style={{padding: '50px 60px 8px', maxWidth: 880}}>
        <div style={{fontSize:11, fontWeight:600, color:'rgba(60,50,40,0.55)', letterSpacing:'.10em', textTransform:'uppercase'}}>Sitelayer · Mobile</div>
        <h1 style={{fontSize:46, fontWeight:700, letterSpacing:'-0.025em', margin:'8px 0 12px', color:'rgba(20,16,10,0.92)'}}>Run the day from your pocket.</h1>
        <p style={{fontSize:16, color:'rgba(60,50,40,0.70)', lineHeight:1.55, margin:0, maxWidth:680}}>
          A complete mobile design pass for Sitelayer — every screen a contractor, foreman, or crew member touches on phone. Install + permissions, role-aware home, project flows (bid → estimate → schedule → time), rentals, settings, dedicated worker and foreman apps, and the system states that hold it all together.
        </p>
      </div>

      {/* ===== 1. PWA SHELL ===== */}
      <DCSection id="sec1" title="1 · Install + permissions" subtitle="Web app on iOS & Android. First-run flows that earn the home-screen install and the location/notification permissions we genuinely need.">
        <DCArtboard id="pwa-safari" label="Safari · landing" width={PHONE_W} height={PHONE_H}><Phone><PWAInstallSafari/></Phone></DCArtboard>
        <DCArtboard id="pwa-sheet" label="iOS install sheet" width={PHONE_W} height={PHONE_H}><Phone><PWAInstallSheet/></Phone></DCArtboard>
        <DCArtboard id="pwa-loc" label="Location prime" width={PHONE_W} height={PHONE_H}><Phone><PWAPermLocation/></Phone></DCArtboard>
        <DCArtboard id="pwa-notif" label="Notifications prime" width={PHONE_W} height={PHONE_H}><Phone><PWAPermNotif/></Phone></DCArtboard>
        <DCArtboard id="pwa-splash" label="Splash · cold start" width={PHONE_W} height={PHONE_H}><Phone><PWASplash/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 2. NAV ===== */}
      <DCSection id="sec2" title="2 · Navigation system" subtitle="The chassis: tabs, top app bar, drawer, account switcher. Same behavior on iOS and Android with platform-appropriate ornaments.">
        <DCArtboard id="nav-ios" label="iOS · tabs (variant)" width={PHONE_W} height={PHONE_H}><Phone><NavBottomIOS/></Phone></DCArtboard>
        <DCArtboard id="nav-top" label="Top app bar" width={PHONE_W} height={PHONE_H}><Phone><NavTopAppBar/></Phone></DCArtboard>
        <DCArtboard id="nav-drawer" label="Drawer + overflow" width={PHONE_W} height={PHONE_H}><Phone><NavDrawerOverflow/></Phone></DCArtboard>
        <DCArtboard id="nav-switch" label="Account switcher" width={PHONE_W} height={PHONE_H}><Phone><NavSwitcher/></Phone></DCArtboard>
        <DCArtboard id="nav-more" label="More tab · 5th slot" width={PHONE_W} height={PHONE_H}><Phone><NavMore/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 3. DASHBOARD ===== */}
      <DCSection id="sec3" title="3 · Owner / PM home" subtitle="Calm by default — the morning view shouldn't be a wall of metrics. One signal at a time when something needs eyes; today's projects below.">
        <DCArtboard id="db-calm-default" label="Default — calm" width={PHONE_W} height={PHONE_H}><Phone><DashboardCalmDefault/></Phone></DCArtboard>
        <DCArtboard id="db-calm-filtered" label="What needs me?" width={PHONE_W} height={PHONE_H}><Phone><DashboardCalmFiltered/></Phone></DCArtboard>
        <DCArtboard id="db-pm" label="With attention card" width={PHONE_W} height={PHONE_H}><Phone><DashboardPM/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 4. PROJECT LIFECYCLE — one record, one page, many states ===== */}
      <DCSection id="sec4" title="4 · Projects · one record, one page" subtitle="A project is the only durable record. There is no separate bid, estimate, takeoff, or contract — those are just states of the same thing. Read this row left to right: it's the literal journey of a project from creation to close, with the alt-paths (QB dedupe, drill-ins, archive) sitting next to the screen they branch from.">

        {/* === ENTRY === */}
        <DCArtboard id="prj-list" label="① Projects list" width={PHONE_W} height={PHONE_H}><Phone><ProjectsList/></Phone></DCArtboard>
        <DCArtboard id="prj-create-entry" label="② Tap + New" width={PHONE_W} height={PHONE_H}><Phone><ProjectCreateEntry/></Phone></DCArtboard>
        <DCArtboard id="prj-create-sheet" label="③ Create sheet · 2 required fields" width={PHONE_W} height={PHONE_H}><Phone><ProjectCreateSheet/></Phone></DCArtboard>
        <DCArtboard id="prj-create-qb" label="③ alt · QB name conflict" width={PHONE_W} height={PHONE_H}><Phone><ProjectCreateQBDedupe/></Phone></DCArtboard>

        {/* === DRAFTING === */}
        <DCArtboard id="prj-drafting" label="④ State · Drafting" width={PHONE_W} height={PHONE_H}><Phone><ProjectDrafting/></Phone></DCArtboard>
        <DCArtboard id="prj-blueprint" label="④ drill-in · Blueprint canvas" width={PHONE_W} height={PHONE_H}><Phone><BlueprintCanvasFull/></Phone></DCArtboard>
        <DCArtboard id="prj-share" label="⑤ Tap Send → share sheet" width={PHONE_W} height={PHONE_H}><Phone><ShareProposalSheet/></Phone></DCArtboard>

        {/* === CLIENT-FACING === */}
        <DCArtboard id="prj-sent" label="⑥ State · Sent" width={PHONE_W} height={PHONE_H}><Phone><ProjectSent/></Phone></DCArtboard>
        <DCArtboard id="prj-archive" label="⑥ alt · Lost / archived" width={PHONE_W} height={PHONE_H}><Phone><ProjectArchiveSheet/></Phone></DCArtboard>
        <DCArtboard id="prj-accepted" label="⑦ State · Accepted" width={PHONE_W} height={PHONE_H}><Phone><ProjectAccepted/></Phone></DCArtboard>
        <DCArtboard id="prj-geofence" label="⑦ Setup · draw site geofence" width={PHONE_W} height={PHONE_H}><Phone><GeofenceProjectSetup/></Phone></DCArtboard>

        {/* === IN FLIGHT === */}
        <DCArtboard id="prj-progress" label="⑧ State · In progress" width={PHONE_W} height={PHONE_H}><Phone><ProjectInProgress/></Phone></DCArtboard>
        <DCArtboard id="prj-crew-owner" label="⑧ drill-in · Crew (owner)" width={PHONE_W} height={PHONE_H}><Phone><ProjectCrewOwner/></Phone></DCArtboard>
        <DCArtboard id="prj-crew-foreman" label="⑧ drill-in · Crew (foreman)" width={PHONE_W} height={PHONE_H}><Phone><ProjectCrewForeman/></Phone></DCArtboard>

        {/* === CLOSE === */}
        <DCArtboard id="prj-done" label="⑨ State · Done" width={PHONE_W} height={PHONE_H}><Phone><ProjectDone/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 7. SCHEDULE ===== */}
      <DCSection id="sec7" title="7 · Schedule" subtitle="Where bodies meet jobs. Daily stream for foremen and PMs; weekly grid for capacity planning; a focused sheet for assigning a crew with smart defaults.">
        <DCArtboard id="sch-day" label="Today · day stream" width={PHONE_W} height={PHONE_H}><Phone><ScheduleDay/></Phone></DCArtboard>
        <DCArtboard id="sch-week" label="Week · capacity grid" width={PHONE_W} height={PHONE_H}><Phone><ScheduleWeek/></Phone></DCArtboard>
        <DCArtboard id="sch-create" label="New assignment" width={PHONE_W} height={PHONE_H}><Phone><ScheduleCreateAssignment/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 8. TIME — labor management, accessed three ways ===== */}
      <DCSection id="sec8" title="8 · Time · labor management" subtitle="Time isn't a destination — it's labor management. Owners approve from inside a project (above) or in a cross-project queue. Foremen do CRUD. Burden + live-vs-budget are the supporting math.">
        <DCArtboard id="t-cross" label="Time queue · all projects" width={PHONE_W} height={PHONE_H}><Phone><TimeQueueAllProjects/></Phone></DCArtboard>
        <DCArtboard id="t-foreman" label="Foreman entry sheet" width={PHONE_W} height={PHONE_H}><Phone><TimeForemanEntry/></Phone></DCArtboard>
        <DCArtboard id="t-burden" label="Loaded labor cost" width={PHONE_W} height={PHONE_H}><Phone><TimeBurden/></Phone></DCArtboard>
        <DCArtboard id="t-vs" label="Live vs budget detail" width={PHONE_W} height={PHONE_H}><Phone><TimeLiveVsBudget/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 9. RENTALS ===== */}
      <DCSection id="sec9" title="9 · Rentals" subtitle="Equipment as a side-revenue line. Tag-scan the asset to dispatch or return; track utilization to find dead weight in the fleet.">
        <DCArtboard id="rent-cat" label="Catalog · 14 assets" width={PHONE_W} height={PHONE_H}><Phone><RentalsCatalog/></Phone></DCArtboard>
        <DCArtboard id="rent-scan" label="Scan · QR found" width={PHONE_W} height={PHONE_H}><Phone><RentalsScan/></Phone></DCArtboard>
        <DCArtboard id="rent-dispatch" label="Dispatch sheet" width={PHONE_W} height={PHONE_H}><Phone><RentalsDispatch/></Phone></DCArtboard>
        <DCArtboard id="rent-return" label="Return + condition" width={PHONE_W} height={PHONE_H}><Phone><RentalsReturn/></Phone></DCArtboard>
        <DCArtboard id="rent-util" label="Utilization · 30d" width={PHONE_W} height={PHONE_H}><Phone><RentalsUtilization/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 10. SETTINGS ===== */}
      <DCSection id="sec10" title="10 · Settings" subtitle="Where the workspace lives: integrations (QBO, Gusto, Stripe), the pricing book, and the team. Loaded-rate config lives here too — it's the lever that fixes margins.">
        <DCArtboard id="set-home" label="Settings home" width={PHONE_W} height={PHONE_H}><Phone><SettingsHome/></Phone></DCArtboard>
        <DCArtboard id="set-pricing" label="Pricing book" width={PHONE_W} height={PHONE_H}><Phone><SettingsPricing/></Phone></DCArtboard>
        <DCArtboard id="set-team" label="Team · 14 + invites" width={PHONE_W} height={PHONE_H}><Phone><SettingsTeam/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 11. WORKER APP ===== */}
      <DCSection id="sec11" title="11 · Worker app" subtitle="The crew member's view: dark, minimal, glove-friendly. Big clock, today's job, this week's hours, photo logging with auto-tag.">
        <DCArtboard id="wk-today" label="Today · clocked in" width={PHONE_W} height={PHONE_H}><Phone><WorkerToday/></Phone></DCArtboard>
        <DCArtboard id="wk-clockin" label="Auto clock-in success" width={PHONE_W} height={PHONE_H}><Phone><WorkerClockInSuccess/></Phone></DCArtboard>
        <DCArtboard id="wk-scope" label="Today's scope" width={PHONE_W} height={PHONE_H}><Phone><WorkerScopeToday/></Phone></DCArtboard>
        <DCArtboard id="wk-issue" label="Flag a problem" width={PHONE_W} height={PHONE_H}><Phone><WorkerIssue/></Phone></DCArtboard>
        <DCArtboard id="wk-hours" label="My week · hours" width={PHONE_W} height={PHONE_H}><Phone><WorkerHoursWeek/></Phone></DCArtboard>
        <DCArtboard id="wk-log" label="Photo + note" width={PHONE_W} height={PHONE_H}><Phone><WorkerLogPhoto/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 12. FOREMAN APP ===== */}
      <DCSection id="sec12" title="12 · Foreman app" subtitle="Field lead: oversees the crew across all sites, receives field pings (the missing receiver for worker issues), owns the daily log. Schedule lookahead is a deeper screen — the office authors the schedule, the foreman just executes it.">
        <DCArtboard id="fm-today" label="Today · multi-site home" width={PHONE_W} height={PHONE_H}><Phone><ForemanToday/></Phone></DCArtboard>
        <DCArtboard id="fm-brief" label="Brief crew · authoring" width={PHONE_W} height={PHONE_H}><Phone><ForemanBriefCrew/></Phone></DCArtboard>
        <DCArtboard id="fm-crew" label="Crew tab · roster today" width={PHONE_W} height={PHONE_H}><Phone><ForemanCrew/></Phone></DCArtboard>
        <DCArtboard id="fm-field" label="Field intake · from the crew" width={PHONE_W} height={PHONE_H}><Phone><ForemanField/></Phone></DCArtboard>
        <DCArtboard id="fm-map" label="Live crew map" width={PHONE_W} height={PHONE_H}><Phone><ForemanCrewMap/></Phone></DCArtboard>
        <DCArtboard id="fm-log" label="Daily log · drafted" width={PHONE_W} height={PHONE_H}><Phone><ForemanDailyLog/></Phone></DCArtboard>
        <DCArtboard id="fm-sched" label="Schedule · 2 wks" width={PHONE_W} height={PHONE_H}><Phone><ForemanScheduleAhead/></Phone></DCArtboard>
      </DCSection>

      {/* ===== 13. SYSTEM STATES ===== */}
      <DCSection id="sec13" title="13 · System states" subtitle="Offline (job sites have no signal), error (QBO/auth), empty (new account), loading (skeletons that match real layout), and permissions denied (location off).">
        <DCArtboard id="st-offline" label="Offline · 4 queued" width={PHONE_W} height={PHONE_H}><Phone><StateOffline/></Phone></DCArtboard>
        <DCArtboard id="st-error" label="Error · QBO 401" width={PHONE_W} height={PHONE_H}><Phone><StateError/></Phone></DCArtboard>
        <DCArtboard id="st-empty" label="Empty · no projects" width={PHONE_W} height={PHONE_H}><Phone><StateEmpty/></Phone></DCArtboard>
        <DCArtboard id="st-loading" label="Loading · skeleton" width={PHONE_W} height={PHONE_H}><Phone><StateLoading/></Phone></DCArtboard>
        <DCArtboard id="st-perm" label="Permission denied" width={PHONE_W} height={PHONE_H}><Phone><StatePermissionDenied/></Phone></DCArtboard>
      </DCSection>

      <div style={{padding:'40px 60px 80px', maxWidth:880, fontSize:13, color:'rgba(60,50,40,0.6)', lineHeight:1.6}}>
        11 sections · {5+5+3+13+3+4+5+3+3+6+5+5} screens · designed mobile-first against the existing Sitelayer brand and the desktop portal in <code style={{padding:'2px 6px', background:'rgba(60,50,40,0.06)', borderRadius:4}}>index.html</code>. Every screen sized to a 290×600 viewport (iPhone-class) with the same 4px grid, color tokens, and type stack as the desktop product.
      </div>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
