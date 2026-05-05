/* global React, ReactDOM */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---------- ICONS ----------
const I = {
  home: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>,
  layers: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>,
  ruler: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 17l14-14 4 4-14 14z"/><path d="M7 7l2 2M10 4l2 2M13 7l2 2M16 10l2 2M5 13l2 2M8 16l2 2"/></svg>,
  receipt: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 3h14v18l-3-2-3 2-3-2-3 2-2-2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>,
  cal: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>,
  clock: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  box: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>,
  sync: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M20 11A8 8 0 0 0 6.34 6.34L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 13.66 4.66L20 16"/><path d="M20 20v-4h-4"/></svg>,
  search: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>,
  plus: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>,
  filter: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 5h18l-7 9v6l-4-2v-4z"/></svg>,
  back: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M15 18l-6-6 6-6"/></svg>,
  more: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>,
  sun: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></svg>,
  moon: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>,
  menu: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h16M4 12h16M4 18h16"/></svg>,
  pen: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>,
  arrow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  poly: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"><path d="M3 11l5-7 12 3-1 12-12 3z"/></svg>,
  line: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"><path d="M4 20l16-16"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/></svg>,
  hand: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"><path d="M9 11V5a2 2 0 0 1 4 0v6"/><path d="M13 11V4a2 2 0 0 1 4 0v9"/><path d="M17 11V6a2 2 0 0 1 4 0v9a6 6 0 0 1-12 0V9a2 2 0 0 1 4 0v2"/></svg>,
  cursor: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18"><path d="M5 3l14 8-7 1-3 7z"/></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M4 12l5 5L20 6"/></svg>,
  drag: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>,
  field: <svg className="nav-icon icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="6" y="2" width="12" height="20" rx="2.5"/><circle cx="12" cy="18.5" r="0.6" fill="currentColor"/><path d="M10 5h4"/></svg>,
  x: <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 6l12 12M18 6L6 18"/></svg>,
};

const fmt$ = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt$k = (n) => {
  if (n >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return '$' + n.toFixed(0);
};
const fmtN = (n, d=0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------- COVER (subtle striped placeholder per project) ----------
function Cover({ seed = 'a' }) {
  const palettes = {
    a: ['#E8C9A4', '#C77B4F'], b: ['#C8D8E0', '#5B8AA8'],
    c: ['#D4C8B4', '#9C7A5B'], d: ['#C8D8C4', '#7A8C6F'],
    e: ['#D8C4D0', '#8A6F9C'],
  };
  const [a, b] = palettes[seed] || palettes.a;
  return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="56" fill={a} opacity="0.55"/>
      {Array.from({length: 14}).map((_, i) => (
        <line key={i} x1={-10 + i*8} y1="0" x2={-10 + i*8 + 30} y2="56" stroke={b} strokeOpacity="0.18" strokeWidth="1"/>
      ))}
      <rect width="100" height="56" fill="url(#g)" opacity="0.3"/>
    </svg>
  );
}

// ---------- SIDEBAR ----------
function Sidebar({ route, setRoute, collapsed, syncCount, role, setRole }) {
  const ownerItems = [
    { id: 'projects', label: 'Projects',  icon: I.home },
    { id: 'takeoff',  label: 'Measurements', icon: I.layers },
    { id: 'estimate', label: 'Estimate',  icon: I.receipt },
    { id: 'schedule', label: 'Schedule',  icon: I.cal },
    { id: 'time',     label: 'Time',      icon: I.clock },
    { id: 'rentals',  label: 'Rentals',   icon: I.box },
    { id: 'sync',     label: 'QBO Sync',  icon: I.sync, badge: syncCount },
  ];
  const foremanItems = [
    { id: 'fm-today',    label: 'Today',     icon: I.home },
    { id: 'fm-crew',     label: 'Crew time', icon: I.clock },
    { id: 'fm-log',      label: 'Daily log', icon: I.layers },
    { id: 'fm-schedule', label: 'Schedule',  icon: I.cal },
  ];
  const workerItems = [
    { id: 'wk-today',    label: 'Today',    icon: I.home },
    { id: 'wk-week',     label: 'My week',  icon: I.cal },
    { id: 'wk-time',     label: 'My hours', icon: I.clock },
  ];
  const items = role === 'foreman' ? foremanItems : role === 'worker' ? workerItems : ownerItems;
  const profile = role === 'foreman'
    ? { initials: 'AR', name: 'Ana Rodriguez', meta: 'Foreman · Crew A', tone: 'tone-3' }
    : role === 'worker'
      ? { initials: 'MT', name: 'Marcus Tate',   meta: 'Worker · Crew A', tone: 'tone-2' }
      : { initials: 'SL', name: 'Sam Lozano',    meta: 'Owner · LA Ops',  tone: 'tone-1' };
  const [open, setOpen] = useState(false);
  return (
    <aside className="side">
      <div className="side-brand">
        <div className="brand-mark"><span/></div>
        <div>
          <div className="brand-name">Sitelayer</div>
          <div className="brand-sub">LA Operations</div>
        </div>
      </div>
      {items.map(it => (
        <button key={it.id} className="nav-item" data-active={route === it.id}
          onClick={() => setRoute(it.id)}>
          {it.icon}
          <span className="nav-label">{it.label}</span>
          {it.badge ? <span className="nav-badge">{it.badge}</span> : null}
        </button>
      ))}
      <div className="side-foot">
        <button className="user-chip role-switch" onClick={() => setOpen(o => !o)}>
          <div className={"avatar " + profile.tone}>{profile.initials}</div>
          <div style={{minWidth:0,flex:1,textAlign:'left'}}>
            <div className="user-name">{profile.name}</div>
            <div className="user-meta">{profile.meta}</div>
          </div>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{width:14,height:14,opacity:0.5}}><path d="M7 10l5 5 5-5"/></svg>
        </button>
        {open && (
          <div className="role-menu">
            <div className="role-menu-label">View as</div>
            {[
              {id:'owner', name:'Sam Lozano', meta:'Owner', initials:'SL', tone:'tone-1'},
              {id:'foreman', name:'Ana Rodriguez', meta:'Foreman', initials:'AR', tone:'tone-3'},
              {id:'worker', name:'Marcus Tate', meta:'Worker', initials:'MT', tone:'tone-2'},
            ].map(r => (
              <button key={r.id} className="role-opt" data-active={role === r.id}
                onClick={() => { setRole(r.id); setOpen(false); }}>
                <div className={"avatar " + r.tone}>{r.initials}</div>
                <div style={{minWidth:0,flex:1,textAlign:'left'}}>
                  <div className="user-name">{r.name}</div>
                  <div className="user-meta">{r.meta}</div>
                </div>
                {role === r.id && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{width:14,height:14}}><path d="M5 12l5 5L20 7"/></svg>}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function MobBot({ route, setRoute }) {
  const items = [
    { id: 'projects', label: 'Projects',  icon: I.home },
    { id: 'takeoff',  label: 'Measurements', icon: I.layers },
    { id: 'schedule', label: 'Schedule',  icon: I.cal },
    { id: 'time',     label: 'Time',      icon: I.clock },
    { id: 'sync',     label: 'Sync',      icon: I.sync },
  ];
  return (
    <nav className="mob-bot">
      {items.map(it => (
        <button key={it.id} className="nav-item" data-active={route === it.id}
          onClick={() => setRoute(it.id)}>
          {it.icon}
          <span className="nav-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}

window.SLIcons = I;
window.SLFmt = { fmt$, fmt$k, fmtN };
window.SLCover = Cover;
window.SLSidebar = Sidebar;
window.SLMobBot = MobBot;
