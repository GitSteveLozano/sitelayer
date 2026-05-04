/* global React, IOSDevice, IOSStatusBar, IOSNavBar, SLIcons */
const { useState: uSF, useEffect: uEF, useMemo: uMF } = React;
const FIcons = window.SLIcons;

// Phone scale — mobile screens shown at 0.85× so 2-3 fit per row
const PHONE_W = 340;
const PHONE_H = 736;

function FieldView({ data, persona = 'worker', autoClock = true, geofence = 100 }) {
  const [tab, setTab] = uSF('home');
  const sectionRef = React.useRef(null);

  const tabs = [
    { id: 'home',     label: 'Home screens' },
    { id: 'clock',    label: 'Auto clock-in' },
    { id: 'failure',  label: 'Failure states' },
    { id: 'log',      label: 'Daily log' },
    { id: 'notify',   label: 'Notifications' },
  ];

  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">Field · mobile</h1>
          <p className="page-sub">What workers and foremen actually see in the field. Shipped designs for clock-in, daily log, and the messages that drive confirmation.</p>
        </div>
        <div className="page-actions">
          <span className="pill" data-tone={autoClock ? 'green' : 'amber'}>
            <span className="dot"/>Auto clock-in {autoClock ? 'on' : 'manual only'}
          </span>
          <span className="pill" data-tone="blue">
            <span className="dot"/>Geofence {geofence}m
          </span>
        </div>
      </div>

      <div className="seg" style={{marginBottom: 16, alignSelf: 'flex-start'}}>
        {tabs.map(t => (
          <button key={t.id} className="seg-btn" data-active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div ref={sectionRef}>
        {tab === 'home' && <HomeScreensTab data={data} persona={persona} autoClock={autoClock}/>}
        {tab === 'clock' && <window.SLClockInTab data={data} autoClock={autoClock} geofence={geofence}/>}
        {tab === 'failure' && <window.SLFailureStatesTab data={data} geofence={geofence}/>}
        {tab === 'log' && <window.SLDailyLogTab data={data}/>}
        {tab === 'notify' && <window.SLNotificationsTab data={data}/>}
      </div>
    </>
  );
}

// ============================================================
// PHONE STAGE — a labelled phone with a caption
// ============================================================
function PhoneStage({ label, sub, dark, children, badge, badgeTone }) {
  return (
    <div className="fld-stage">
      <div className="fld-stage-h">
        <div>
          <p className="eyebrow" style={{margin: 0}}>{label}</p>
          {sub && <p className="muted" style={{margin: '2px 0 0 0', fontSize: 12}}>{sub}</p>}
        </div>
        {badge && <span className="pill" data-tone={badgeTone || 'blue'}>{badge}</span>}
      </div>
      <div className="fld-stage-phone">
        <IOSDevice width={PHONE_W} height={PHONE_H} dark={dark} title={undefined}>
          {children}
        </IOSDevice>
      </div>
    </div>
  );
}

// shared mobile primitives
function PStatusBar({ dark, project, time = '7:42' }) {
  return (
    <div className="pmb-status" data-dark={dark}>
      <div className="pmb-pill">
        <span className="dot" style={{background: 'var(--green)'}}/>
        <span className="num">{project || 'Hillcrest Mews'}</span>
      </div>
    </div>
  );
}

// ============================================================
// HOME SCREENS — worker + foreman + (optional persona variant)
// ============================================================
function HomeScreensTab({ data, persona, autoClock }) {
  return (
    <div className="fld-row">
      <PhoneStage label="Worker · Marcus Lee" sub="What a crew member opens the app to in the morning" badge="Default home">
        <WorkerHomeScreen data={data} autoClock={autoClock}/>
      </PhoneStage>
      <PhoneStage label="Foreman · Ana Castillo" sub="Lead's home — crew roster + day controls" badge="Lead role" badgeTone="amber">
        <ForemanHomeScreen data={data}/>
      </PhoneStage>
      <PhoneStage label="Worker · pre clock-in" sub="Before the geofence has fired — passive state" dark>
        <WorkerHomeDarkScreen data={data}/>
      </PhoneStage>
    </div>
  );
}

function WorkerHomeScreen({ data, autoClock }) {
  return (
    <div className="pmb">
      <PStatusBar/>
      <div className="pmb-greeting">
        <p className="pmb-eyebrow">Tuesday · Apr 29</p>
        <h2>Good morning, Marcus.</h2>
      </div>

      {/* Active clock-in card */}
      <div className="pmb-card pmb-clock-card" data-active={autoClock}>
        <div className="row between" style={{marginBottom: 8}}>
          <span className="pmb-label">{autoClock ? 'Clocked in · auto' : 'Tap to clock in'}</span>
          <span className="pmb-time num">7:02 AM</span>
        </div>
        <div className="pmb-clock-big num">{autoClock ? '8:24:12' : '0:00:00'}</div>
        <div className="row between" style={{marginTop: 8}}>
          <span className="pmb-meta"><span className="dot" style={{background: 'var(--green)'}}/>On site · Hillcrest</span>
          <button className="pmb-btn" data-variant={autoClock ? 'ghost' : 'primary'}>{autoClock ? 'Clock out' : 'Clock in'}</button>
        </div>
      </div>

      <p className="pmb-section">Today</p>
      <div className="pmb-card">
        <div className="row between" style={{marginBottom: 6}}>
          <strong style={{fontSize: 15}}>EPS — East elevation</strong>
          <span className="pill" data-tone="green" style={{fontSize: 10}}>confirmed</span>
        </div>
        <p className="pmb-meta" style={{margin: '0 0 8px'}}>Hillcrest Mews · with Ana, Tomás</p>
        <div className="pmb-progress">
          <div className="pmb-progress-bar" style={{width: '76%'}}/>
        </div>
        <div className="row between" style={{marginTop: 6}}>
          <span className="pmb-meta num">980 / 1,284 sqft</span>
          <span className="pmb-meta num">76%</span>
        </div>
      </div>

      <p className="pmb-section">Up next</p>
      <div className="pmb-card pmb-mini">
        <div>
          <strong style={{fontSize: 13}}>Caulk + flashing</strong>
          <div className="pmb-meta">Wed · Hillcrest · 6h</div>
        </div>
        <button className="pmb-btn" data-variant="primary" style={{fontSize: 12, padding: '5px 10px'}}>Confirm</button>
      </div>
      <div className="pmb-card pmb-mini">
        <div>
          <strong style={{fontSize: 13}}>Stone wainscot</strong>
          <div className="pmb-meta">Mon May 5 · Hillcrest · 14h over 2 days</div>
        </div>
        <button className="pmb-btn" style={{fontSize: 12, padding: '5px 10px'}}>Confirm</button>
      </div>

      <div className="pmb-tabbar">
        <PMTab label="Today" active icon={FIcons.home}/>
        <PMTab label="Schedule" icon={FIcons.cal}/>
        <PMTab label="Log" icon={FIcons.receipt}/>
        <PMTab label="Me" icon={FIcons.box}/>
      </div>
    </div>
  );
}

function ForemanHomeScreen({ data }) {
  const crew = ['w1','w2','w5'].map(id => data.workers.find(w => w.id === id));
  const statusMap = { w1: {st:'on', t:'7:02'}, w2: {st:'on', t:'7:04'}, w5: {st:'late', t:'—'} };
  return (
    <div className="pmb">
      <PStatusBar/>
      <div className="pmb-greeting" style={{paddingBottom: 4}}>
        <p className="pmb-eyebrow">Tuesday · Apr 29 · Lead</p>
        <h2>Hillcrest crew</h2>
      </div>

      <div className="pmb-card" style={{padding: 0, overflow: 'hidden'}}>
        <div className="pmb-foreman-summary">
          <div>
            <span className="pmb-label">Crew on site</span>
            <strong className="num" style={{fontSize: 24}}>2 <span className="muted" style={{fontSize: 13, fontWeight: 400}}>of 3</span></strong>
          </div>
          <div>
            <span className="pmb-label">Day progress</span>
            <strong style={{fontSize: 14}}>EPS · 76%</strong>
          </div>
          <div>
            <span className="pmb-label">Hours logged</span>
            <strong className="num" style={{fontSize: 14}}>16.4h</strong>
          </div>
        </div>

        {crew.map(c => {
          const st = statusMap[c.id];
          return (
            <div key={c.id} className="pmb-crew-row">
              <div className={`avatar tone-${c.tone}`}>{c.initials}</div>
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontWeight: 600, fontSize: 13}}>{c.name}</div>
                <div className="pmb-meta">
                  {st.st === 'on' ? <><span className="dot" style={{background: 'var(--green)'}}/>Clocked in · {st.t}</> : <><span className="dot" style={{background: 'var(--accent)'}}/>Not on site</>}
                </div>
              </div>
              {st.st === 'on' ? <span className="num pmb-meta">{c.id === 'w5' ? '0:00' : '8:24'}</span>
                : <button className="pmb-btn" style={{fontSize: 11, padding: '4px 8px'}}>Call</button>}
            </div>
          );
        })}
      </div>

      <p className="pmb-section">Quick actions</p>
      <div className="pmb-actions-grid">
        <button className="pmb-action">
          {FIcons.clock}
          <span>Crew time<br/>entry</span>
          <span className="pmb-action-badge">3</span>
        </button>
        <button className="pmb-action">
          {FIcons.receipt}
          <span>Daily log</span>
          <span className="pmb-action-badge" data-tone="amber">due</span>
        </button>
        <button className="pmb-action">
          {FIcons.layers}
          <span>Photo +<br/>note</span>
        </button>
        <button className="pmb-action">
          {FIcons.box}
          <span>Request<br/>materials</span>
        </button>
      </div>

      <p className="pmb-section">Today's schedule</p>
      <div className="pmb-card pmb-mini">
        <div>
          <strong style={{fontSize: 13}}>EPS — East elevation</strong>
          <div className="pmb-meta">3 crew · 7:00 AM – 3:30 PM · 980 sqft</div>
        </div>
        <span className="pill" data-tone="green" style={{fontSize: 10}}>active</span>
      </div>

      <div className="pmb-tabbar">
        <PMTab label="Crew" active icon={FIcons.home}/>
        <PMTab label="Schedule" icon={FIcons.cal}/>
        <PMTab label="Log" icon={FIcons.receipt}/>
        <PMTab label="Project" icon={FIcons.layers}/>
      </div>
    </div>
  );
}

function WorkerHomeDarkScreen({ data }) {
  return (
    <div className="pmb" data-dark>
      <PStatusBar dark/>
      <div className="pmb-greeting">
        <p className="pmb-eyebrow">Monday · Apr 28 · 5:42 AM</p>
        <h2>Drive safe.</h2>
      </div>

      <div className="pmb-card pmb-passive">
        <div className="row" style={{gap: 10, alignItems: 'center'}}>
          <div className="pmb-pulse"/>
          <div>
            <strong style={{fontSize: 14}}>Clock-in armed</strong>
            <div className="pmb-meta">Will start when you arrive at Hillcrest Mews</div>
          </div>
        </div>
      </div>

      <p className="pmb-section">Today</p>
      <div className="pmb-card">
        <div className="row between" style={{marginBottom: 6}}>
          <strong style={{fontSize: 15}}>EPS — East elevation</strong>
          <span className="pmb-meta num">7:00 AM</span>
        </div>
        <p className="pmb-meta" style={{margin: '0 0 8px'}}>Hillcrest Mews · 1840 Hillcrest Dr</p>
        <div className="row" style={{gap: 8}}>
          <button className="pmb-btn" data-variant="ghost" style={{flex: 1, fontSize: 12}}>Directions</button>
          <button className="pmb-btn" data-variant="primary" style={{flex: 1, fontSize: 12}}>I'll be there</button>
        </div>
      </div>

      <div className="pmb-card pmb-mini" style={{marginTop: 10}}>
        <div>
          <strong style={{fontSize: 13}}>Caulk + flashing</strong>
          <div className="pmb-meta">Tomorrow · 7:00 AM</div>
        </div>
        <button className="pmb-btn" data-variant="primary" style={{fontSize: 12, padding: '5px 10px'}}>Confirm</button>
      </div>

      <div className="pmb-card pmb-bulletin">
        <span className="pill" data-tone="amber" style={{fontSize: 10}}><span className="dot"/>Crew note</span>
        <p style={{margin: '6px 0 0 0', fontSize: 12.5}}>Bring extra mesh tape — Ana</p>
      </div>

      <div className="pmb-tabbar">
        <PMTab label="Today" active icon={FIcons.home}/>
        <PMTab label="Schedule" icon={FIcons.cal}/>
        <PMTab label="Log" icon={FIcons.receipt}/>
        <PMTab label="Me" icon={FIcons.box}/>
      </div>
    </div>
  );
}

function PMTab({ label, icon, active }) {
  return (
    <div className="pmb-tab" data-active={active}>
      <span className="pmb-tab-icon">{icon}</span>
      <span>{label}</span>
    </div>
  );
}

window.SLField = FieldView;
window.SLPhoneStage = PhoneStage;
window.SLPMTab = PMTab;
window.SLPStatusBar = PStatusBar;
window.SLWorkerHomeScreen = WorkerHomeScreen;
window.SLForemanHomeScreen = ForemanHomeScreen;
window.SLWorkerHomeDarkScreen = WorkerHomeDarkScreen;
