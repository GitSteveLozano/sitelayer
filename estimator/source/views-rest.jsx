/* global React, SLIcons, SLFmt */
const I3 = window.SLIcons; const F3 = window.SLFmt;
const { useState: uS3, useMemo: uM3, useRef: uR3 } = React;

// ---------- ESTIMATE VIEW ----------
function EstimateView({ data, projectId }) {
  const p = data.projects.find(x => x.id === projectId) || data.projects[0];
  const initial = (data.measurements[p.id] || []).map(m => {
    const it = data.scopeItems.find(s => s.code === m.code);
    return {
      id: m.id, code: m.code, desc: m.notes,
      qty: m.qty, unit: m.unit, rate: it?.rate || 0,
      color: it?.color,
    };
  });
  const [lines, setLines] = uS3(initial);
  const [gst, setGst] = uS3(0.05);

  function updateLine(id, key, val) {
    setLines(ls => ls.map(l => l.id === id ? { ...l, [key]: val } : l));
  }
  function removeLine(id) { setLines(ls => ls.filter(l => l.id !== id)); }
  function addLine() {
    const it = data.scopeItems[0];
    setLines(ls => [...ls, {
      id: 'new-' + Date.now(), code: it.code, desc: 'New line',
      qty: 0, unit: it.unit, rate: it.rate, color: it.color,
    }]);
  }

  const subtotal = lines.reduce((s, l) => s + Number(l.qty) * Number(l.rate), 0);
  const tax = subtotal * gst;
  const total = subtotal + tax;
  const bidDelta = total - p.bid;
  const deltaPct = (bidDelta / p.bid) * 100;
  const tone = Math.abs(deltaPct) < 1 ? 'amber' : deltaPct < 0 ? 'green' : 'red';

  return (
    <>
      <div className="page-h">
        <div>
          <p className="eyebrow">{p.client}</p>
          <h1 className="page-title">Estimate · {p.name}</h1>
          <p className="page-sub">Auto-generated from takeoff. Edit any cell to recalculate.</p>
        </div>
        <div className="page-actions">
          <button className="btn">Export PDF</button>
          <button className="btn" data-variant="primary">Push to QBO</button>
        </div>
      </div>

      {/* AI LAYER · Bid accuracy keystone */}
      <div style={{marginBottom: 16}}>
        <window.SLAi.Stripe
          tone="warn"
          eyebrow="Heads up · Pattern from 7 closed jobs"
          title="EPS bids on jobs > 2,500 sf have averaged 12% under actual."
          density="inline"
          attribution={<window.SLAi.Attribution>Based on <strong>7 closed EPS jobs</strong> in the past 14 months. Excludes jobs with scope changes &gt; 10%.</window.SLAi.Attribution>}
          action={
            <>
              <button className="btn" data-variant="primary">Apply $4.85/sf to EPS lines</button>
              <button className="btn" data-variant="ghost">See math</button>
              <span style={{flex:1}}/>
              <span style={{fontSize:11.5, color:'var(--ink-3)'}}>Adds <strong style={{color:'var(--ink)', fontFeatureSettings:"'tnum'"}}>+{F3.fmt$(1180)}</strong> to this bid</span>
            </>
          }
        >
          EPS lines on this estimate are at <strong>$4.32</strong>/sf. Pattern suggests <strong>$4.85</strong>/sf would land closer to actual cost.
        </window.SLAi.Stripe>
      </div>

      <div className="grid grid-3 keep" style={{marginBottom: 16}}>
        <div className="stat">
          <span className="stat-label">Subtotal</span>
          <span className="stat-val num">{F3.fmt$k(subtotal)}</span>
          <span className="stat-meta">{lines.length} line items</span>
        </div>
        <div className="stat">
          <span className="stat-label">Total w/ GST</span>
          <span className="stat-val num">{F3.fmt$k(total)}</span>
          <span className="stat-meta num">+ {F3.fmt$(tax)} ({(gst*100).toFixed(0)}%)</span>
        </div>
        <div className="stat">
          <span className="stat-label">vs Bid</span>
          <span className="stat-val num" style={{color:
            tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : 'var(--accent-ink)'}}>
            {bidDelta >= 0 ? '+' : ''}{F3.fmt$k(Math.abs(bidDelta))}
          </span>
          <span className="stat-meta">
            <span className="pill" data-tone={tone}>
              {bidDelta >= 0 ? 'over' : 'under'} {Math.abs(deltaPct).toFixed(1)}%
            </span>
          </span>
        </div>
      </div>

      <div className="card" style={{padding: 0, overflow:'hidden'}}>
        <table className="tbl">
          <thead><tr>
            <th style={{width: 32}}></th>
            <th>Scope</th><th>Description</th>
            <th className="right" style={{width: 100}}>Qty</th>
            <th style={{width: 60}}>Unit</th>
            <th className="right" style={{width: 100}}>Rate</th>
            <th className="right" style={{width: 110}}>Amount</th>
            <th style={{width: 32}}></th>
          </tr></thead>
          <tbody>
            {lines.map(l => {
              const amt = Number(l.qty) * Number(l.rate);
              return (
                <tr key={l.id}>
                  <td><span className="measure-dot" style={{background: l.color}}/></td>
                  <td>
                    <select value={l.code}
                      onChange={e => {
                        const it = data.scopeItems.find(s => s.code === e.target.value);
                        updateLine(l.id, 'code', e.target.value);
                        updateLine(l.id, 'rate', it.rate);
                        updateLine(l.id, 'unit', it.unit);
                        updateLine(l.id, 'color', it.color);
                      }}>
                      {data.scopeItems.map(s => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
                    </select>
                  </td>
                  <td><input value={l.desc} onChange={e => updateLine(l.id, 'desc', e.target.value)}/></td>
                  <td className="right num"><input className="num" type="number" value={l.qty}
                    onChange={e => updateLine(l.id, 'qty', e.target.value)}/></td>
                  <td className="muted">{l.unit}</td>
                  <td className="right num"><input className="num" type="number" value={l.rate} step="0.01"
                    onChange={e => updateLine(l.id, 'rate', e.target.value)}/></td>
                  <td className="right num" style={{fontWeight: 600}}>{F3.fmt$(amt)}</td>
                  <td><button className="btn" data-variant="ghost" style={{padding: 4}}
                    onClick={() => removeLine(l.id)}>{I3.trash}</button></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><td colSpan="6" style={{padding: '12px 14px'}}>
              <button className="btn" data-variant="ghost" onClick={addLine}>{I3.plus} Add line</button>
            </td>
            <td className="right num" style={{fontWeight: 600}}>{F3.fmt$(subtotal)}</td>
            <td/></tr>
            <tr style={{fontSize:12, color: 'var(--ink-3)'}}>
              <td colSpan="6" style={{padding: '4px 14px', textAlign:'right'}}>GST {(gst*100).toFixed(0)}%</td>
              <td className="right num">{F3.fmt$(tax)}</td><td/>
            </tr>
            <tr style={{fontSize: 14}}>
              <td colSpan="6" style={{padding: '8px 14px', textAlign:'right', fontWeight: 600}}>Total</td>
              <td className="right num" style={{fontWeight: 700, fontSize: 15}}>{F3.fmt$(total)}</td><td/>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

// ---------- SCHEDULE VIEW ----------
function ScheduleView({ data }) {
  const [assigns, setAssigns] = uS3(data.scheduleWeek.assignments.map(a => ({...a})));
  const [dragId, setDragId] = uS3(null);
  const [overDay, setOverDay] = uS3(null);

  function onDragStart(id) { setDragId(id); }
  function onDragOver(e, day) { e.preventDefault(); setOverDay(day); }
  function onDrop(e, day) {
    e.preventDefault();
    setAssigns(a => a.map(x => x.id === dragId ? {...x, day} : x));
    setDragId(null); setOverDay(null);
  }

  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">Schedule · Week of Apr 27</h1>
          <p className="page-sub">Drag crew assignments between days. Foreman confirms each morning.</p>
        </div>
        <div className="page-actions">
          <button className="btn">Copy last week</button>
          <button className="btn" data-variant="primary">{I3.plus} Assignment</button>
        </div>
      </div>

      <div className="sched-grid">
        {data.scheduleWeek.days.map((d, i) => {
          const dayAssigns = assigns.filter(a => a.day === i);
          const [dow, date] = d.split(' ');
          return (
            <div key={i} className="sched-col"
              onDragOver={e => onDragOver(e, i)}
              onDrop={e => onDrop(e, i)}
              style={overDay === i ? {borderColor: 'var(--accent)', background: 'var(--accent-soft)'} : null}>
              <div className="sched-col-h">
                <span className="sched-col-day">{dow}</span>
                <span className="sched-col-date num">{date}</span>
              </div>
              {dayAssigns.map(a => {
                const proj = data.projects.find(p => p.id === a.project);
                const crew = a.crew.map(cid => data.workers.find(w => w.id === cid)).filter(Boolean);
                return (
                  <div key={a.id} className="sched-card"
                    draggable onDragStart={() => onDragStart(a.id)}
                    style={dragId === a.id ? {opacity:.4} : null}>
                    <div className="sched-card-h">
                      <span className="sched-card-title">{proj?.name.split(' — ')[0]}</span>
                      {a.confirmed && <span style={{color:'var(--green)'}}>{I3.check}</span>}
                    </div>
                    <div className="sched-card-note">{a.note}</div>
                    <div className="row between">
                      <div className="crew-stack">
                        {crew.slice(0,4).map(c => (
                          <div key={c.id} className={`avatar tone-${c.tone}`}>{c.initials}</div>
                        ))}
                        {crew.length > 4 && <div className="avatar" style={{background: 'var(--surface-3)', color: 'var(--ink-2)'}}>+{crew.length-4}</div>}
                      </div>
                      <span className="muted" style={{fontSize: 11}}>{I3.drag}</span>
                    </div>
                  </div>
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

// ---------- TIME VIEW ----------
function TimeView({ data }) {
  const [tab, setTab] = uS3('clock');
  const me = data.workers[0];
  const [clockedIn, setClockedIn] = uS3(true);
  const [start] = uS3(new Date(Date.now() - 4 * 3600 * 1000 - 18 * 60 * 1000));
  const [now, setNow] = uS3(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, now - start.getTime());
  const hh = String(Math.floor(elapsed / 3600000)).padStart(2,'0');
  const mm = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2,'0');
  const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2,'0');

  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">Time</h1>
          <p className="page-sub">Clock in, capture daily progress, confirm the manifest.</p>
        </div>
      </div>

      <div className="tabs">
        {[['clock','Clock'],['today','Today'],['week','This week']].map(([k,l]) => (
          <button key={k} className="tab" data-active={tab===k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'clock' && (
        <div className="grid grid-2 keep">
          <div className="clock-card">
            <div className="row" style={{gap: 12, marginBottom: 16}}>
              <div className={`avatar tone-${me.tone}`} style={{width: 40, height: 40, fontSize: 13}}>{me.initials}</div>
              <div>
                <div style={{fontWeight: 600}}>{me.name}</div>
                <div className="muted" style={{fontSize: 12}}>Hillcrest Homes — Phase 4</div>
              </div>
              <div style={{flex:1}}/>
              {clockedIn && <div className="clock-status"><span className="pulse"/>On site</div>}
            </div>
            <div className="clock-time num">{hh}:{mm}<span style={{fontSize: 24, color: 'var(--ink-3)'}}>:{ss}</span></div>
            <div className="muted" style={{fontSize: 12, marginTop: 6}}>
              Started at {start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · GPS ±4m · East elevation
            </div>
            <div className="row" style={{gap: 8, marginTop: 18}}>
              <button className="btn" data-variant={clockedIn ? undefined : 'accent'} style={{flex:1, padding: '10px 16px', fontSize: 14}}
                onClick={() => setClockedIn(!clockedIn)}>
                {clockedIn ? 'Clock out' : 'Clock in'}
              </button>
              <button className="btn" style={{flex:1, padding: '10px 16px', fontSize: 14}}>Log progress</button>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3 className="card-title">Today's progress</h3></div>
            <div style={{display:'grid', gap: 10}}>
              <div>
                <div className="row between" style={{fontSize: 13, marginBottom: 4}}>
                  <span>EPS — East elevation</span>
                  <span className="num">980 / 1,284 sqft</span>
                </div>
                <div className="bar"><span style={{width:'76%', background: 'var(--accent)'}}/></div>
              </div>
              <div>
                <div className="row between" style={{fontSize: 13, marginBottom: 4}}>
                  <span>Productivity</span>
                  <span className="num">132 sqft/hr</span>
                </div>
                <div className="bar"><span style={{width:'91%', background: 'var(--green)'}}/></div>
                <div className="muted" style={{fontSize: 11, marginTop: 4}}>Target 145 — pace forecasts 8.4 hr to finish.</div>
              </div>
              <div className="card" style={{padding:12, background: 'var(--surface-2)', borderColor:'transparent'}}>
                <div className="row between" style={{fontSize: 12}}>
                  <span className="muted">Margin impact today</span>
                  <span className="num" style={{fontWeight:600, color:'var(--green)'}}>+$184.50</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {tab === 'today' && (
        <div className="card">
          <table className="tbl">
            <thead><tr><th>Worker</th><th>Project</th><th>Scope</th><th className="right">Hours</th><th className="right">Sqft</th><th>Status</th></tr></thead>
            <tbody>
              {data.workers.filter(w => w.clockedIn).map(w => (
                <tr key={w.id}>
                  <td><span className="row" style={{gap:8}}><div className={`avatar tone-${w.tone}`} style={{width:22,height:22,fontSize:9.5}}>{w.initials}</div>{w.name}</span></td>
                  <td className="muted">{data.projects.find(p=>p.id===w.project)?.name.split(' — ')[0]}</td>
                  <td className="muted">EPS — East</td>
                  <td className="right num">{(w.hoursWeek/5).toFixed(1)}h</td>
                  <td className="right num">{Math.round(w.hoursWeek/5 * 130)}</td>
                  <td><span className="pill" data-tone="green"><span className="dot"/>active</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'week' && (
        <div className="card">
          <div style={{display:'grid', gap: 10}}>
            {data.workers.map(w => (
              <div key={w.id}>
                <div className="row between" style={{fontSize: 13, marginBottom: 4}}>
                  <span className="row" style={{gap: 8}}><div className={`avatar tone-${w.tone}`} style={{width:22,height:22,fontSize:9.5}}>{w.initials}</div>{w.name}</span>
                  <span className="num">{w.hoursWeek}h</span>
                </div>
                <div className="bar"><span style={{width: `${(w.hoursWeek/40)*100}%`, background: w.hoursWeek > 36 ? 'var(--accent)' : 'var(--teal)'}}/></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------- RENTALS VIEW (moved to views-rentals.jsx) ----------

// ---------- SYNC VIEW ----------
function SyncView({ data }) {
  const [syncing, setSyncing] = uS3(false);
  const [done, setDone] = uS3(0);

  function runSync() {
    setSyncing(true); setDone(0);
    let i = 0;
    const tick = () => {
      i++; setDone(i);
      if (i < data.syncQueue.length) setTimeout(tick, 600);
      else setTimeout(() => setSyncing(false), 600);
    };
    setTimeout(tick, 400);
  }

  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">QuickBooks Sync</h1>
          <p className="page-sub">Pull-first reconciliation. Pushes only happen on explicit review.</p>
        </div>
        <div className="page-actions">
          <span className="pill" data-tone="green"><span className="dot"/>Connected · realm 9341…</span>
          <button className="btn" data-variant="primary" onClick={runSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Run sync'}
          </button>
        </div>
      </div>

      <div className="card" style={{marginBottom: 16}}>
        <div className="sync-flow">
          <div className="sync-side">
            <div className="row" style={{gap: 8, marginBottom: 6}}>
              <div className="brand-mark"><span/></div>
              <h4>Sitelayer</h4>
            </div>
            <p>1 estimate · 1 rental invoice queued for push</p>
          </div>
          <div className="sync-line">
            <svg viewBox="0 0 200 80" style={{width:'100%', height: '100%'}}>
              <defs>
                <linearGradient id="lg1" x1="0" x2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.2"/>
                  <stop offset="100%" stopColor="var(--green)" stopOpacity="0.2"/>
                </linearGradient>
              </defs>
              <path d="M 0 40 Q 100 0 200 40" fill="none" stroke="url(#lg1)" strokeWidth="20"/>
              <path d="M 0 40 Q 100 80 200 40" fill="none" stroke="url(#lg1)" strokeWidth="20"/>
              {syncing && Array.from({length:5}).map((_,i)=>(
                <circle key={i} r="3" fill="var(--accent)">
                  <animateMotion dur="1.6s" repeatCount="indefinite" begin={`${i*0.3}s`}
                    path="M 0 40 Q 100 0 200 40"/>
                </circle>
              ))}
              {syncing && Array.from({length:3}).map((_,i)=>(
                <circle key={'b'+i} r="3" fill="var(--green)">
                  <animateMotion dur="1.6s" repeatCount="indefinite" begin={`${i*0.4}s`}
                    keyPoints="1;0" keyTimes="0;1"
                    path="M 0 40 Q 100 80 200 40"/>
                </circle>
              ))}
            </svg>
          </div>
          <div className="sync-side" style={{textAlign:'right'}}>
            <div className="row" style={{gap: 8, marginBottom: 6, justifyContent:'flex-end'}}>
              <h4>QuickBooks Online</h4>
              <div style={{width: 28, height: 28, borderRadius: 8, background: 'oklch(0.55 0.18 145)',
                display:'grid', placeItems:'center', color:'white', fontFamily:'Geist Mono', fontWeight:600, fontSize: 13}}>qb</div>
            </div>
            <p>3 bills · 12 time activities pulled today</p>
          </div>
        </div>
      </div>

      <div className="card" style={{padding: 0, overflow:'hidden'}}>
        <div className="card-h" style={{padding:'14px 18px', margin:0}}>
          <h3 className="card-title">Sync queue</h3>
          <span className="muted" style={{fontSize: 12}}>{data.syncQueue.length} events</span>
        </div>
        <table className="tbl">
          <thead><tr><th>Event</th><th>Entity</th><th>Direction</th><th>Status</th><th>When</th></tr></thead>
          <tbody>
            {data.syncQueue.map((q, i) => {
              const inFlight = syncing && i === done;
              const finished = syncing && i < done;
              const status = inFlight ? 'syncing' : finished ? 'success' : q.status;
              const dir = q.kind.endsWith('.push') || q.kind.endsWith('.invoice') ? '→ QBO' : '← QBO';
              const tone = status === 'success' ? 'green' : status === 'syncing' ? 'amber' : status === 'pending' ? 'amber' : 'blue';
              return (
                <tr key={q.id}>
                  <td className="mono">{q.kind}</td>
                  <td>{q.entity}</td>
                  <td className="muted mono">{dir}</td>
                  <td><span className="pill" data-tone={tone}><span className="dot"/>{status}</span></td>
                  <td className="muted">{q.ts}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

window.SLEstimate = EstimateView;
window.SLSchedule = ScheduleView;
window.SLTime = TimeView;
window.SLSync = SyncView;
