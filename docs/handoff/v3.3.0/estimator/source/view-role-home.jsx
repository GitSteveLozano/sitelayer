/* global React, IOSDevice */
const { useState: uSRH } = React;

// SLRoleHome — single-canvas role-aware view.
// Foreman / Worker see Sitelayer through their own lens. Same data, different defaults.
// On desktop we frame a phone in the center of the canvas so the user understands
// this IS the same product, just narrower; on small viewports the phone fills width.

function PhoneCanvas({ children, sub, sideContent }) {
  return (
    <div className="role-canvas">
      <div className="role-phone-col">
        <div className="role-phone-shell">
          <IOSDevice width={402} height={874}>{children}</IOSDevice>
        </div>
        {sub && <div className="role-phone-sub">{sub}</div>}
      </div>
      {sideContent && <div className="role-side">{sideContent}</div>}
    </div>
  );
}

function RoleHome({ data, role, view, geofence = 100, autoClock = true }) {
  // Today screen reuses worker / foreman home screen primitives
  if (role === 'worker' && view === 'today') {
    return (
      <PhoneCanvas
        sub="Worker · Today screen"
        sideContent={<WorkerSideRail data={data} autoClock={autoClock} geofence={geofence}/>}
      >
        <window.SLWorkerHomeScreen data={data} autoClock={autoClock}/>
      </PhoneCanvas>
    );
  }
  if (role === 'foreman' && view === 'today') {
    return (
      <PhoneCanvas
        sub="Foreman · Crew today"
        sideContent={<ForemanSideRail data={data}/>}
      >
        <window.SLForemanHomeScreen data={data}/>
      </PhoneCanvas>
    );
  }
  if (role === 'foreman' && view === 'log') {
    return <window.SLDailyLogTab data={data}/>;
  }
  if (role === 'foreman' && view === 'schedule') {
    return <ForemanSchedule data={data}/>;
  }
  if (role === 'worker' && view === 'schedule') {
    return (
      <PhoneCanvas sub="Worker · My week"
        sideContent={<WorkerWeekSide data={data}/>}>
        <WorkerWeekScreen data={data}/>
      </PhoneCanvas>
    );
  }
  if (role === 'worker' && view === 'hours') {
    return (
      <PhoneCanvas sub="Worker · My hours"
        sideContent={<WorkerHoursSide data={data}/>}>
        <WorkerHoursScreen data={data}/>
      </PhoneCanvas>
    );
  }
  return <div style={{padding:24}}>Loading…</div>;
}

// ──────────────────────────────────────────────────────────────
// Side rails — context the phone screen can't fit
// ──────────────────────────────────────────────────────────────
function WorkerSideRail({ data, autoClock, geofence }) {
  return (
    <>
      <div className="rs-card">
        <div className="rs-eyebrow">This week</div>
        <div className="rs-stat">38.5 <span className="rs-unit">hrs</span></div>
        <div className="rs-meta">~$1,540 gross · 2 OT hrs Mon</div>
      </div>
      <div className="rs-card">
        <div className="rs-eyebrow">Auto clock-in</div>
        <div className="rs-row">
          <span className={"rs-pill " + (autoClock ? 'rs-on' : 'rs-off')}>
            <span className="rs-dot"/>{autoClock ? 'On' : 'Off'}
          </span>
          <span className="rs-meta">{geofence}m geofence</span>
        </div>
        <div className="rs-meta" style={{marginTop:8}}>You'll be clocked in when your phone enters the project geofence.</div>
      </div>
      <div className="rs-card">
        <div className="rs-eyebrow">Need help?</div>
        <div className="rs-link">Text foreman Ana →</div>
        <div className="rs-link">Report a problem →</div>
      </div>
    </>
  );
}

function ForemanSideRail({ data }) {
  return (
    <>
      <div className="rs-card">
        <div className="rs-eyebrow">Crew A · today</div>
        <div className="rs-stat">5/6 <span className="rs-unit">on site</span></div>
        <div className="rs-meta">Marcus T. flagged late · 7:35</div>
      </div>
      <div className="rs-card">
        <div className="rs-eyebrow">Hours today (so far)</div>
        <div className="rs-stat">22.4 <span className="rs-unit">crew-hrs</span></div>
        <div className="rs-meta">Target 26.0 · pace ok</div>
      </div>
      <div className="rs-card">
        <div className="rs-eyebrow">To do</div>
        <div className="rs-todo">○ Submit yesterday's daily log</div>
        <div className="rs-todo">○ Approve 2 manual time edits</div>
        <div className="rs-todo">● Confirm tomorrow's assignment</div>
      </div>
    </>
  );
}

function WorkerWeekSide({ data }) {
  return (
    <div className="rs-card">
      <div className="rs-eyebrow">Total scheduled</div>
      <div className="rs-stat">42 <span className="rs-unit">hrs</span></div>
      <div className="rs-meta">5 days · Hillcrest Phase 4</div>
    </div>
  );
}

function WorkerHoursSide({ data }) {
  return (
    <div className="rs-card">
      <div className="rs-eyebrow">Current period</div>
      <div className="rs-stat">38.5 <span className="rs-unit">hrs</span></div>
      <div className="rs-meta">Closes Sun · ~$1,540 gross</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Worker · My Week (phone)
// ──────────────────────────────────────────────────────────────
function WorkerWeekScreen({ data }) {
  const days = [
    {d:'Mon',date:'Mar 17',proj:'Hillcrest Phase 4',scope:'EPS · 1,284 sf',hrs:8,start:'7:00',state:'done'},
    {d:'Tue',date:'Mar 18',proj:'Hillcrest Phase 4',scope:'EPS · 1,100 sf',hrs:8,start:'7:00',state:'done'},
    {d:'Wed',date:'Mar 19',proj:'Hillcrest Phase 4',scope:'EPS · 980 sf',hrs:8,start:'7:00',state:'today'},
    {d:'Thu',date:'Mar 20',proj:'Hillcrest Phase 4',scope:'Stucco scratch',hrs:9,start:'6:30',state:'next'},
    {d:'Fri',date:'Mar 21',proj:'Hillcrest Phase 4',scope:'Stucco scratch',hrs:9,start:'6:30',state:'next'},
    {d:'Sat',date:'Mar 22',proj:'—',scope:'Off',hrs:0,start:'',state:'off'},
  ];
  return (
    <div className="pmb">
      <window.SLPStatusBar/>
      <div className="pmb-hd">
        <div>
          <div className="pmb-title">My week</div>
          <div className="pmb-sub">Mar 17 – 22 · 42 hrs</div>
        </div>
      </div>
      <div className="pmb-list">
        {days.map(d => (
          <div key={d.d} className="ww-row" data-state={d.state}>
            <div className="ww-day">
              <div className="ww-dow">{d.d}</div>
              <div className="ww-date">{d.date.split(' ')[1]}</div>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div className="ww-proj">{d.proj}</div>
              <div className="ww-scope">{d.scope}</div>
            </div>
            <div className="ww-meta">
              {d.hrs > 0 ? <><div className="ww-hrs">{d.hrs}h</div><div className="ww-start">{d.start}</div></> : <div className="ww-off">—</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="pmb-tabs">
        <window.SLPMTab label="Today" icon="home"/>
        <window.SLPMTab label="Week" icon="cal" active/>
        <window.SLPMTab label="Hours" icon="clock"/>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Worker · My Hours (phone)
// ──────────────────────────────────────────────────────────────
function WorkerHoursScreen({ data }) {
  return (
    <div className="pmb">
      <window.SLPStatusBar/>
      <div className="pmb-hd">
        <div>
          <div className="pmb-title">My hours</div>
          <div className="pmb-sub">Pay period · Mar 17 – 23</div>
        </div>
      </div>
      <div className="wh-hero">
        <div className="wh-hours">38.5</div>
        <div className="wh-unit">hours so far</div>
        <div className="wh-meta">~$1,540 gross · 2 OT hrs</div>
      </div>
      <div className="wh-bar">
        <div className="wh-bar-fill" style={{width:'77%'}}/>
        <div className="wh-bar-tick" style={{left:'80%'}}>40h</div>
      </div>
      <div className="pmb-section">By day</div>
      <div className="pmb-list">
        {[
          {d:'Mon Mar 17',hrs:'8.0',ot:'',anomaly:''},
          {d:'Tue Mar 18',hrs:'10.5',ot:'2.5 OT',anomaly:''},
          {d:'Wed Mar 19',hrs:'8.0',ot:'',anomaly:'GPS · approved'},
          {d:'Thu Mar 20',hrs:'12.0',ot:'4.0 OT',anomaly:''},
          {d:'Fri Mar 21',hrs:'—',ot:'',anomaly:'scheduled'},
        ].map(r => (
          <div key={r.d} className="wh-row">
            <div className="wh-day">{r.d}</div>
            <div className="wh-hrs">{r.hrs}{r.hrs!=='—' && <span className="wh-h">h</span>}</div>
            {r.ot && <div className="wh-ot">{r.ot}</div>}
            {r.anomaly && <div className="wh-anom">{r.anomaly}</div>}
          </div>
        ))}
      </div>
      <div className="pmb-tabs">
        <window.SLPMTab label="Today" icon="home"/>
        <window.SLPMTab label="Week" icon="cal"/>
        <window.SLPMTab label="Hours" icon="clock" active/>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Foreman schedule (desktop-ish list)
// ──────────────────────────────────────────────────────────────
function ForemanSchedule({ data }) {
  const days = [
    {d:'Wed Mar 19', state:'today',  proj:'Hillcrest Phase 4', scope:'EPS · 980 sf',  crew:['MT','JS','RP','EV','LD'], hrs:8,  conf:5},
    {d:'Thu Mar 20', state:'next',   proj:'Hillcrest Phase 4', scope:'Stucco scratch', crew:['MT','JS','RP','EV','LD','BK'], hrs:9, conf:4},
    {d:'Fri Mar 21', state:'next',   proj:'Hillcrest Phase 4', scope:'Stucco scratch', crew:['MT','JS','RP','EV','LD','BK'], hrs:9, conf:3},
    {d:'Mon Mar 24', state:'future', proj:'Carmel Pointe',     scope:'Color coat',     crew:['MT','JS','RP'], hrs:8, conf:0},
  ];
  return (
    <div className="fm-sched">
      <div className="fm-sched-hd">
        <div>
          <div className="fm-sched-title">Crew A · upcoming</div>
          <div className="fm-sched-sub">4 assignments scheduled by Sam · confirm crew availability</div>
        </div>
        <button className="btn btn-ghost">Request change</button>
      </div>
      <div className="fm-sched-list">
        {days.map(d => (
          <div key={d.d} className="fm-sched-row" data-state={d.state}>
            <div className="fm-sched-day">
              <div className="fm-sched-d">{d.d.split(' ').slice(0,2).join(' ')}</div>
              <div className="fm-sched-state">{d.state === 'today' ? 'TODAY' : d.state === 'next' ? 'TOMORROW' : ''}</div>
            </div>
            <div className="fm-sched-body">
              <div className="fm-sched-proj">{d.proj}</div>
              <div className="fm-sched-scope">{d.scope} · {d.hrs}h · crew of {d.crew.length}</div>
              <div className="fm-sched-crew">
                {d.crew.map(i => <span key={i} className="fm-avatar">{i}</span>)}
              </div>
            </div>
            <div className="fm-sched-conf">
              <div className="fm-sched-conf-n">{d.conf}/{d.crew.length}</div>
              <div className="fm-sched-conf-l">confirmed</div>
              {d.conf < d.crew.length && d.state !== 'today' && <button className="btn btn-tiny">Nudge {d.crew.length - d.conf}</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

window.SLRoleHome = RoleHome;
