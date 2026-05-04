/* global React, SLIcons, SLFmt */
const ISC = window.SLIcons; const FSC = window.SLFmt;
const { useState: uSS, useMemo: uMS, useEffect: uES } = React;

// Compact day-of-week labels for 4-week grid
const DOW = ['M','T','W','T','F','S','S'];
const DOW_LONG = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function ScheduleView({ data, viewMode = '4week', goRoute }) {
  const sched = data.schedule4Week;
  const [mode, setMode] = uSS(viewMode); // '4week' | 'week'
  const [weekIdx, setWeekIdx] = uSS(0);
  const [assigns, setAssigns] = uSS(sched.assignments.map(a => ({...a})));
  const [showCreate, setShowCreate] = uSS(false);
  const [activeAssign, setActiveAssign] = uSS(null);

  uES(() => { setMode(viewMode); }, [viewMode]);

  function statusTone(s) {
    return s === 'confirmed' ? 'green' : s === 'declined' ? 'red' : s === 'sent' ? 'amber' : 'blue';
  }

  function onConfirm(id) { setAssigns(a => a.map(x => x.id === id ? {...x, status: 'confirmed', confirmed: true} : x)); }
  function onUnconfirm(id) { setAssigns(a => a.map(x => x.id === id ? {...x, status: 'pending', confirmed: false} : x)); }

  // KPIs across the 4-week horizon
  const kpis = uMS(() => {
    const all = assigns;
    const confirmed = all.filter(a => a.status === 'confirmed').length;
    const declined  = all.filter(a => a.status === 'declined').length;
    const totalHours = all.reduce((s, a) => s + a.plannedHr * a.crew.length, 0);
    const totalSqft  = all.reduce((s, a) => s + (a.sqft || 0), 0);
    return { total: all.length, confirmed, declined, totalHours, totalSqft };
  }, [assigns]);

  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">Schedule</h1>
          <p className="page-sub">Four-week look-ahead — click a week to zoom in. Workers confirm or push back; foreman sees status at a glance.</p>
        </div>
        <div className="page-actions">
          <div className="seg">
            <button className="seg-btn" data-active={mode === '4week'} onClick={() => setMode('4week')}>4-week</button>
            <button className="seg-btn" data-active={mode === 'week'} onClick={() => setMode('week')}>Week</button>
            <button className="seg-btn" data-active={mode === 'gantt'} onClick={() => setMode('gantt')}>Gantt</button>
          </div>
          <button className="btn">Copy last week</button>
          <button className="btn" data-variant="primary" onClick={() => setShowCreate(true)}>{ISC.plus} Assignment</button>
        </div>
      </div>

      <div className="grid grid-4 keep" style={{marginBottom: 16}}>
        <div className="stat">
          <span className="stat-label">Assignments</span>
          <span className="stat-val num">{kpis.total}</span>
          <span className="stat-meta">across 4 weeks</span>
        </div>
        <div className="stat">
          <span className="stat-label">Confirmed</span>
          <span className="stat-val num" style={{color: 'var(--green)'}}>{kpis.confirmed}</span>
          <span className="stat-meta num">{Math.round(kpis.confirmed / kpis.total * 100)}% of total</span>
        </div>
        <div className="stat">
          <span className="stat-label">Pushed back</span>
          <span className="stat-val num" style={{color: kpis.declined ? 'var(--red)' : 'var(--ink)'}}>{kpis.declined}</span>
          <span className="stat-meta">{kpis.declined ? 'review declined assignments' : 'all clear'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Crew-hours planned</span>
          <span className="stat-val num">{kpis.totalHours.toFixed(0)}h</span>
          <span className="stat-meta num">{(kpis.totalSqft / 1000).toFixed(1)}k sqft</span>
        </div>
      </div>

      {mode === '4week' && <FourWeekGrid sched={sched} assigns={assigns} setWeekIdx={setWeekIdx} setMode={setMode} setActiveAssign={setActiveAssign} statusTone={statusTone} data={data}/>}
      {mode === 'week'   && <WeekGrid sched={sched} assigns={assigns} setAssigns={setAssigns} weekIdx={weekIdx} setWeekIdx={setWeekIdx} setActiveAssign={setActiveAssign} statusTone={statusTone} data={data}/>}
      {mode === 'gantt'  && <GanttView sched={sched} assigns={assigns} setActiveAssign={setActiveAssign} statusTone={statusTone} data={data}/>}

      {showCreate && <CreateAssignment data={data} onClose={() => setShowCreate(false)}/>}
      {activeAssign && <AssignmentDrawer a={activeAssign} data={data} onClose={() => setActiveAssign(null)} onConfirm={onConfirm} onUnconfirm={onUnconfirm}/>}
    </>
  );
}

// ============================================================
// 4-WEEK LOOK-AHEAD GRID
// ============================================================
function FourWeekGrid({ sched, assigns, setWeekIdx, setMode, setActiveAssign, statusTone, data }) {
  return (
    <div className="card" style={{padding: 0, overflow: 'hidden'}}>
      <div className="sl-4w">
        <div className="sl-4w-corner"/>
        {DOW.map((d, i) => (
          <div key={i} className="sl-4w-dow">
            <span>{d}</span>
            <span className="muted num" style={{fontSize: 10}}>{DOW_LONG[i].slice(0,3)}</span>
          </div>
        ))}
        {sched.weeks.map(w => {
          const weekAssigns = assigns.filter(a => a.week === w.idx);
          return (
            <React.Fragment key={w.idx}>
              <button className="sl-4w-week" onClick={() => { setWeekIdx(w.idx); setMode('week'); }}>
                <span className="sl-4w-week-label">{w.label}</span>
                <span className="sl-4w-week-range num">{w.start}<span className="muted"> — </span>{w.end}</span>
                <span className="sl-4w-week-zoom">Zoom in →</span>
              </button>
              {Array.from({length: 7}).map((_, dayIdx) => {
                const cell = weekAssigns.filter(a => a.day === dayIdx);
                return (
                  <div key={dayIdx} className="sl-4w-cell" data-empty={cell.length === 0}>
                    {cell.map(a => {
                      const proj = data.projects.find(p => p.id === a.project);
                      return (
                        <button key={a.id} className="sl-4w-card" data-status={a.status}
                          onClick={() => setActiveAssign(a)}>
                          <span className="sl-4w-card-bar" data-tone={statusTone(a.status)}/>
                          <span className="sl-4w-card-title">{proj?.name.split(' — ')[0]}</span>
                          <span className="sl-4w-card-meta num">{a.crew.length}× · {a.plannedHr}h</span>
                          {a.status === 'declined' && <span className="sl-4w-card-flag">declined</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// WEEK ZOOM (single-week day grid w/ takeoff suggestion column)
// ============================================================
function WeekGrid({ sched, assigns, setAssigns, weekIdx, setWeekIdx, setActiveAssign, statusTone, data }) {
  const [dragId, setDragId] = uSS(null);
  const [overDay, setOverDay] = uSS(null);
  const week = sched.weeks[weekIdx];
  const dayDates = ['04/27','04/28','04/29','04/30','05/01','05/02','05/03'];

  function onDrop(e, day) {
    e.preventDefault();
    setAssigns(a => a.map(x => x.id === dragId && x.week === weekIdx ? {...x, day} : x));
    setDragId(null); setOverDay(null);
  }

  return (
    <>
      <div className="row between" style={{marginBottom: 12}}>
        <div className="row" style={{gap: 6}}>
          <button className="btn" onClick={() => setWeekIdx(Math.max(0, weekIdx - 1))} disabled={weekIdx === 0}>← Prev</button>
          <div className="sl-week-h">
            <span className="eyebrow">{week.label}</span>
            <strong className="num">{week.weekOf}</strong>
          </div>
          <button className="btn" onClick={() => setWeekIdx(Math.min(3, weekIdx + 1))} disabled={weekIdx === 3}>Next →</button>
        </div>
        <span className="muted" style={{fontSize: 12.5}}>Drag any card to reschedule. Worker gets a push notification on save.</span>
      </div>

      <div className="sched-grid">
        {DOW_LONG.map((dow, i) => {
          const date = dayDates[i];
          const dayAssigns = assigns.filter(a => a.week === weekIdx && a.day === i);
          return (
            <div key={i} className="sched-col"
              onDragOver={e => { e.preventDefault(); setOverDay(i); }}
              onDrop={e => onDrop(e, i)}
              style={overDay === i ? {borderColor: 'var(--accent)', background: 'var(--accent-soft)'} : null}>
              <div className="sched-col-h">
                <span className="sched-col-day">{dow}</span>
                <span className="sched-col-date num">{date}</span>
              </div>
              {dayAssigns.map(a => {
                const proj = data.projects.find(p => p.id === a.project);
                const crew = a.crew.map(cid => data.workers.find(w => w.id === cid)).filter(Boolean);
                const overUnder = a.plannedHr - a.suggestedHr;
                return (
                  <button key={a.id} className="sched-card sl-week-card" data-status={a.status}
                    draggable onDragStart={() => setDragId(a.id)}
                    onClick={() => setActiveAssign(a)}
                    style={dragId === a.id ? {opacity:.4} : null}>
                    <div className="sched-card-h">
                      <span className="sched-card-title">{proj?.name.split(' — ')[0]}</span>
                      <span className="pill" data-tone={statusTone(a.status)} style={{fontSize:10, padding:'1px 6px'}}>
                        {a.status === 'confirmed' ? '✓' : a.status === 'declined' ? '!' : a.status === 'sent' ? '→' : '·'}
                        <span style={{marginLeft: 3}}>{a.status}</span>
                      </span>
                    </div>
                    <div className="sched-card-note">{a.note}</div>
                    {a.suggestedHr > 0 && (
                      <div className="sl-week-takeoff" title={`Measurements: ${a.sqft || 0} sqft × productivity → ${a.suggestedHr.toFixed(1)} crew-hours`}>
                        <span className="sl-week-takeoff-pin">{ISC.layers}</span>
                        <span>From measurements: <strong className="num">{a.suggestedHr.toFixed(1)}h</strong></span>
                        {Math.abs(overUnder) > 0.2 && (
                          <span className="num" style={{color: overUnder > 0 ? 'var(--accent-ink)' : 'var(--green)'}}>
                            {overUnder > 0 ? '+' : ''}{overUnder.toFixed(1)}h vs plan
                          </span>
                        )}
                      </div>
                    )}
                    <div className="row between">
                      <div className="crew-stack">
                        {crew.slice(0,4).map(c => (
                          <div key={c.id} className={`avatar tone-${c.tone}`}>{c.initials}</div>
                        ))}
                        {crew.length > 4 && <div className="avatar" style={{background: 'var(--surface-3)', color: 'var(--ink-2)'}}>+{crew.length-4}</div>}
                      </div>
                      <span className="muted num" style={{fontSize: 11}}>{a.plannedHr}h</span>
                    </div>
                    {a.status === 'declined' && a.declineNote && (
                      <div className="sl-week-decline">
                        <strong>Pushed back:</strong> {a.declineNote}
                      </div>
                    )}
                  </button>
                );
              })}
              {!dayAssigns.length && (
                <div style={{flex:1, display:'grid', placeItems:'center', color:'var(--ink-3)', fontSize:11.5}}>
                  Drop here
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ============================================================
// GANTT — projects × weeks
// ============================================================
function GanttView({ sched, assigns, setActiveAssign, statusTone, data }) {
  // Group by project; each project gets a row, days are columns across all 4 weeks (28 cols)
  const projects = uMS(() => {
    const ids = [...new Set(assigns.map(a => a.project))];
    return ids.map(id => data.projects.find(p => p.id === id)).filter(Boolean);
  }, [assigns, data.projects]);

  return (
    <div className="card" style={{padding: 0, overflow: 'auto'}}>
      <div className="sl-gantt">
        <div className="sl-gantt-corner">Project</div>
        {sched.weeks.map(w => (
          <div key={w.idx} className="sl-gantt-week">
            <span className="num">{w.start} — {w.end}</span>
            <div className="sl-gantt-days">{DOW.map((d, i) => <span key={i}>{d}</span>)}</div>
          </div>
        ))}
        {projects.map(p => {
          const projAssigns = assigns.filter(a => a.project === p.id);
          return (
            <React.Fragment key={p.id}>
              <div className="sl-gantt-row-h">
                <strong>{p.name.split(' — ')[0]}</strong>
                <span className="muted" style={{fontSize: 11}}>{p.client}</span>
              </div>
              {sched.weeks.map(w => (
                <div key={w.idx} className="sl-gantt-week-cell">
                  {Array.from({length: 7}).map((_, di) => <span key={di} className="sl-gantt-day-cell"/>)}
                  {projAssigns.filter(a => a.week === w.idx).map(a => (
                    <button key={a.id} className="sl-gantt-bar" data-status={a.status}
                      style={{left: `${(a.day / 7) * 100}%`, width: `${(1/7) * 100}%`}}
                      onClick={() => setActiveAssign(a)}
                      title={a.note}>
                      <span className="sl-gantt-bar-bar" data-tone={statusTone(a.status)}/>
                      <span className="sl-gantt-bar-text">{a.note.slice(0, 18)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// CREATE ASSIGNMENT (with takeoff hour suggestion)
// ============================================================
function CreateAssignment({ data, onClose }) {
  const [project, setProject] = uSS('p-hillcrest');
  const [scope, setScope] = uSS('EPS');
  const [takeoffItem, setTakeoffItem] = uSS('eps-east');
  const [date, setDate] = uSS('2025-03-19');
  const [startTime, setStartTime] = uSS('07:00');
  const [pickedCrew, setPickedCrew] = uSS(['w1','w2','w5']);
  const [hoursOverride, setHoursOverride] = uSS(null); // null = use suggestion
  const [notify, setNotify] = uSS({ push: true, sms: true });
  const [confirmBy, setConfirmBy] = uSS('morning'); // morning | now | none

  // takeoff items per scope (would come from real takeoff in production)
  const takeoffItems = {
    EPS:  [{id:'eps-east', label:'East elevation', sqft: 1284},
           {id:'eps-west', label:'West elevation', sqft: 1100},
           {id:'eps-south', label:'South elevation', sqft: 980}],
    BASE: [{id:'base-east', label:'East elevation', sqft: 1284},
           {id:'base-west', label:'West elevation', sqft: 1100}],
    FIN:  [{id:'fin-east', label:'East elevation', sqft: 1284}],
    STONE:[{id:'stn-1', label:'Entry veneer', sqft: 240}],
  };
  const items = takeoffItems[scope] || [];
  const item = items.find(i => i.id === takeoffItem) || items[0];
  const sqft = item ? item.sqft : 0;

  const productivity = { EPS: 145, BASE: 175, FIN: 195, STONE: 38, CAULK: 0, MOB: 0, PUNCH: 0 };
  const rate = productivity[scope] || 0;
  const suggested = rate > 0 ? (sqft / rate) : 6;
  const usedHrs = hoursOverride != null ? hoursOverride : suggested;
  const crewSize = pickedCrew.length;
  const proj = data.projects.find(p => p.id === project);

  // weather (mocked from date)
  const weather = { temp: 64, label: 'Cloudy', good: true };

  const endTime = (() => {
    const [h, m] = startTime.split(':').map(Number);
    const total = h + m/60 + usedHrs + 0.5; // 30min lunch
    const eh = Math.floor(total);
    const em = Math.round((total - eh) * 60);
    return `${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}`;
  })();

  function toggleWorker(id) {
    setPickedCrew(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal sched-create" onClick={e => e.stopPropagation()}>
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">Schedule · new assignment</p>
            <h2>Plan crew time</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="rmodal-body sched-create-body">

          {/* WHEN */}
          <div className="sca-section">
            <div className="sca-section-l">When</div>
            <div className="sca-section-r">
              <div className="sca-row">
                <label className="sl-field" style={{flex:'1 1 180px'}}>
                  <span className="sl-field-l">Date</span>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)}/>
                </label>
                <label className="sl-field" style={{flex:'1 1 140px'}}>
                  <span className="sl-field-l">Start time</span>
                  <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}/>
                </label>
                <div className="sl-field" style={{flex:'1 1 140px'}}>
                  <span className="sl-field-l">Ends</span>
                  <div className="sca-readout num">{endTime} <span className="muted">({usedHrs.toFixed(1)}h + lunch)</span></div>
                </div>
              </div>
              <div className="sca-weather">
                <span className="sca-weather-icon">☁</span>
                <span><strong>{weather.temp}°F · {weather.label}</strong> forecast for Wed Mar 19 · ok for {scope}</span>
              </div>
            </div>
          </div>

          {/* WHAT */}
          <div className="sca-section">
            <div className="sca-section-l">What</div>
            <div className="sca-section-r">
              <div className="sca-row">
                <label className="sl-field" style={{flex:'2 1 240px'}}>
                  <span className="sl-field-l">Project</span>
                  <select value={project} onChange={e => setProject(e.target.value)}>
                    {data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="sl-field" style={{flex:'1 1 120px'}}>
                  <span className="sl-field-l">Scope</span>
                  <select value={scope} onChange={e => { setScope(e.target.value); const list = takeoffItems[e.target.value] || []; setTakeoffItem(list[0]?.id || ''); setHoursOverride(null); }}>
                    {Object.keys(productivity).map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </label>
              </div>
              {items.length > 0 && (
                <label className="sl-field">
                  <span className="sl-field-l">Measurement</span>
                  <select value={takeoffItem} onChange={e => { setTakeoffItem(e.target.value); setHoursOverride(null); }}>
                    {items.map(it => <option key={it.id} value={it.id}>{it.label} — {it.sqft.toLocaleString()} sqft</option>)}
                  </select>
                </label>
              )}

              <div className="sca-suggest">
                <div className="sca-suggest-l">
                  <span className="sca-suggest-icon">{ISC.layers}</span>
                  <div>
                    <div className="sca-suggest-eyebrow">From measurements · suggested duration</div>
                    <div className="sca-suggest-val">
                      <strong className="num">{suggested.toFixed(1)}h</strong>
                      <span className="muted">{rate > 0 ? `${sqft.toLocaleString()} sqft ÷ ${rate} sqft/crew-hr` : `no sqft basis · enter manually`}</span>
                    </div>
                  </div>
                </div>
                <div className="sca-suggest-r">
                  <input type="number" step="0.5" className="num sca-hrs"
                    value={hoursOverride != null ? hoursOverride : suggested.toFixed(1)}
                    onChange={e => setHoursOverride(parseFloat(e.target.value) || 0)}/>
                  <span className="muted">hours</span>
                  {hoursOverride != null && (
                    <button className="btn-textlink" onClick={() => setHoursOverride(null)}>reset</button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* WHO */}
          <div className="sca-section">
            <div className="sca-section-l">Who <span className="sca-count">{crewSize}</span></div>
            <div className="sca-section-r">
              <div className="sca-crew-grid">
                {data.workers.slice(0, 8).map(w => {
                  const picked = pickedCrew.includes(w.id);
                  return (
                    <button key={w.id} className="sca-worker" data-picked={picked}
                      onClick={() => toggleWorker(w.id)}>
                      <div className="sca-worker-avatar">{w.name.split(' ').map(n => n[0]).join('').slice(0,2)}</div>
                      <div className="sca-worker-body">
                        <div className="sca-worker-name">{w.name}</div>
                        <div className="sca-worker-meta">{w.role || 'Worker'} · {w.rate ? `$${w.rate}/h` : '$38/h'}</div>
                      </div>
                      {picked && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{width:14,height:14}}><path d="M5 12l5 5L20 7"/></svg>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* NOTIFY */}
          <div className="sca-section">
            <div className="sca-section-l">Notify</div>
            <div className="sca-section-r">
              <div className="sca-checks">
                <label className="sca-check">
                  <input type="checkbox" checked={notify.push} onChange={e => setNotify({...notify, push: e.target.checked})}/>
                  Push notification (in-app)
                </label>
                <label className="sca-check">
                  <input type="checkbox" checked={notify.sms} onChange={e => setNotify({...notify, sms: e.target.checked})}/>
                  SMS to phone number
                </label>
              </div>
              <div className="sca-confirm-by">
                <span className="muted">Require confirmation</span>
                <div className="sca-seg">
                  {[{id:'now',l:'On save'},{id:'morning',l:'Morning of'},{id:'none',l:'Not required'}].map(o => (
                    <button key={o.id} data-active={confirmBy === o.id} onClick={() => setConfirmBy(o.id)}>{o.l}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* SUMMARY */}
          <div className="sca-summary">
            <div>
              <div className="muted">Crew × hours</div>
              <strong className="num">{crewSize} × {usedHrs.toFixed(1)} = {(crewSize * usedHrs).toFixed(1)} crew-hr</strong>
            </div>
            <div>
              <div className="muted">Est. labor cost</div>
              <strong className="num">${(crewSize * usedHrs * 38 * 1.32).toFixed(0)}</strong>
              <div className="muted" style={{fontSize:11}}>@ $38/h × 1.32 loaded</div>
            </div>
            <div>
              <div className="muted">Notify</div>
              <strong>{[notify.push && 'Push', notify.sms && 'SMS'].filter(Boolean).join(' + ') || 'No notifications'}</strong>
            </div>
          </div>
        </div>
        <div className="rmodal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" data-variant="primary" onClick={onClose} disabled={crewSize === 0}>
            {crewSize === 0 ? 'Pick a crew' : `Save & notify ${crewSize}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ASSIGNMENT DETAIL DRAWER
// ============================================================
function AssignmentDrawer({ a, data, onClose, onConfirm, onUnconfirm }) {
  const proj = data.projects.find(p => p.id === a.project);
  const crew = a.crew.map(cid => data.workers.find(w => w.id === cid)).filter(Boolean);

  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal" style={{maxWidth: 520}} onClick={e => e.stopPropagation()}>
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">{proj?.name.split(' — ')[0]} · {a.note}</p>
            <h2>{DOW_LONG[a.day]} · {data.schedule4Week.weeks[a.week].label}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="rmodal-body">
          <div className="grid grid-3 keep">
            <div className="stat">
              <span className="stat-label">Status</span>
              <span className="stat-val" style={{fontSize: 18}}>
                <span className="pill" data-tone={a.status === 'confirmed' ? 'green' : a.status === 'declined' ? 'red' : 'amber'}>{a.status}</span>
              </span>
              <span className="stat-meta">notified 2h ago</span>
            </div>
            <div className="stat">
              <span className="stat-label">Crew</span>
              <span className="stat-val num">{a.crew.length}</span>
              <span className="stat-meta">{a.plannedHr}h × {a.crew.length} = {(a.plannedHr * a.crew.length).toFixed(1)} crew-hr</span>
            </div>
            <div className="stat">
              <span className="stat-label">From measurements</span>
              <span className="stat-val num">{a.suggestedHr.toFixed(1)}h</span>
              <span className="stat-meta">{a.sqft ? `${a.sqft.toLocaleString()} sqft @ ${a.scope}` : `${a.scope} (no sqft basis)`}</span>
            </div>
          </div>

          {a.status === 'declined' && (
            <div className="sl-decline-card">
              <strong>Pushed back</strong>
              <p>{a.declineNote}</p>
              <div className="row" style={{gap: 8}}>
                <button className="btn">Reassign</button>
                <button className="btn">Reply</button>
              </div>
            </div>
          )}

          <div className="card" style={{padding: 12, marginTop: 12}}>
            <p className="eyebrow" style={{margin: '0 0 8px 0'}}>Crew · {crew.length}</p>
            <div style={{display: 'grid', gap: 6}}>
              {crew.map(c => (
                <div key={c.id} className="row between" style={{padding: '4px 0'}}>
                  <div className="row" style={{gap: 8}}>
                    <div className={`avatar tone-${c.tone}`}>{c.initials}</div>
                    <div>
                      <div style={{fontWeight: 500, fontSize: 13}}>{c.name}</div>
                      <div className="muted" style={{fontSize: 11}}>{c.role}</div>
                    </div>
                  </div>
                  <span className="pill" data-tone={a.status === 'confirmed' ? 'green' : 'amber'} style={{fontSize: 10}}>
                    <span className="dot"/>{a.status === 'confirmed' ? 'confirmed' : 'awaiting'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="rmodal-foot">
          <button className="btn" onClick={onClose}>Close</button>
          {a.status !== 'confirmed' ? (
            <button className="btn" data-variant="primary" onClick={() => { onConfirm(a.id); onClose(); }}>Mark all confirmed</button>
          ) : (
            <button className="btn" onClick={() => { onUnconfirm(a.id); onClose(); }}>Unconfirm</button>
          )}
        </div>
      </div>
    </div>
  );
}

window.SLSchedule = ScheduleView;
