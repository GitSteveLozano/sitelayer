/* global React, SLIcons, SLFmt */
const ITC = window.SLIcons; const FTC = window.SLFmt;
const { useState: uST, useMemo: uMT } = React;

function TimeView({ data, initialEntryMode = 'list' }) {
  const [tab, setTab] = uST('approval'); // approval | entry | burden | live
  const [entryMode, setEntryMode] = uST(initialEntryMode);
  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">Time</h1>
          <p className="page-sub">Field hours flow in throughout the day. Flags surface here, and the foreman can fix entries before payroll cutoff.</p>
        </div>
        <div className="page-actions">
          <button className="btn">Export · CSV</button>
          <button className="btn" data-variant="primary">Run payroll · Fri</button>
        </div>
      </div>

      <div className="seg" style={{marginBottom: 16, alignSelf: 'flex-start'}}>
        <button className="seg-btn" data-active={tab === 'approval'} onClick={() => setTab('approval')}>Approval queue</button>
        <button className="seg-btn" data-active={tab === 'entry'} onClick={() => setTab('entry')}>Foreman entry</button>
        <button className="seg-btn" data-active={tab === 'burden'} onClick={() => setTab('burden')}>Loaded labor cost</button>
        <button className="seg-btn" data-active={tab === 'live'} onClick={() => setTab('live')}>Live vs budget</button>
      </div>

      {tab === 'approval' && <ApprovalQueue data={data}/>}
      {tab === 'entry'    && <ForemanEntry data={data} mode={entryMode} setMode={setEntryMode}/>}
      {tab === 'burden'   && <BurdenRollup data={data}/>}
      {tab === 'live'     && <LiveVsBudget data={data}/>}
    </>
  );
}

// ============================================================
// APPROVAL QUEUE
// ============================================================
const ANOMALY_LABEL = {
  overtime: { label: 'OT', tone: 'amber', tip: 'Crossed 8h threshold' },
  overhours: { label: 'Over-hours', tone: 'amber', tip: 'Exceeds scheduled' },
  outside_geofence: { label: 'Outside fence', tone: 'red', tip: 'Off site at clock-in/out' },
  no_clockout: { label: 'No clock-out', tone: 'red', tip: 'Open clock — no end event' },
  manual_override: { label: 'Manual', tone: 'blue', tip: 'Foreman entered manually' },
  duplicate: { label: 'Duplicate', tone: 'red', tip: 'Same worker, overlapping ranges' },
  under_scheduled: { label: 'Under', tone: 'blue', tip: 'Less than scheduled' },
};

function ApprovalQueue({ data }) {
  const [selected, setSelected] = uST(new Set());
  const [filter, setFilter] = uST('all'); // all | flagged
  const [entries, setEntries] = uST(data.timeEntries.map(e => ({...e, status: 'pending'})));

  const visible = entries.filter(e => filter === 'all' ? true : e.anomalies.length > 0);
  const flagged = entries.filter(e => e.anomalies.length > 0);
  const totals = uMS_safe(() => {
    const totHrs = entries.filter(e => e.status !== 'rejected').reduce((s, e) => s + e.hours, 0);
    const totCost = entries.reduce((s, e) => {
      const r = data.workerRates[e.worker];
      if (!r) return s;
      const reg = Math.min(e.hours, 8);
      const ot = Math.max(0, e.hours - 8);
      return s + reg * r.base * (1 + r.ins + r.ben) + ot * r.base * (1 + r.ot) * (1 + r.ins + r.ben);
    }, 0);
    return { totHrs, totCost };
  }, [entries]);

  function toggle(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function selectAll() {
    setSelected(s => s.size === visible.length ? new Set() : new Set(visible.map(e => e.id)));
  }
  function approveSelected() {
    setEntries(es => es.map(e => selected.has(e.id) ? {...e, status: 'approved'} : e));
    setSelected(new Set());
  }
  function approveAllClean() {
    setEntries(es => es.map(e => e.anomalies.length === 0 ? {...e, status: 'approved'} : e));
  }

  return (
    <>
      <div className="grid grid-4 keep" style={{marginBottom: 12}}>
        <div className="stat">
          <span className="stat-label">Pending entries</span>
          <span className="stat-val num">{entries.filter(e => e.status === 'pending').length}</span>
          <span className="stat-meta">across 2 days</span>
        </div>
        <div className="stat">
          <span className="stat-label">Flagged</span>
          <span className="stat-val num" style={{color: 'var(--red)'}}>{flagged.length}</span>
          <span className="stat-meta">{flagged.filter(e => e.anomalies.includes('outside_geofence') || e.anomalies.includes('no_clockout')).length} need fix</span>
        </div>
        <div className="stat">
          <span className="stat-label">Total hours</span>
          <span className="stat-val num">{totals.totHrs.toFixed(1)}h</span>
          <span className="stat-meta num">{entries.filter(e => e.anomalies.includes('overtime')).length} OT</span>
        </div>
        <div className="stat">
          <span className="stat-label">
            Loaded cost
            <span style={{marginLeft:5, verticalAlign:'middle'}}><window.SLAi.Spark tooltip="Loaded rate 1.42× = base + insurance (8.5%) + benefits (12%) + WC class 5645 (18.3%) + OT premium where applicable. Updated nightly from the last 90 days of payroll."/></span>
          </span>
          <span className="stat-val num">${(totals.totCost / 1000).toFixed(2)}k</span>
          <span className="stat-meta">incl. ins + ben + OT premium</span>
        </div>
      </div>

      {/* AI LAYER · Cluster banner — Tier 2.
          Fires when ≥3 anomalies of the same kind appear in the visible queue. */}
      {(() => {
        const byKind = {};
        flagged.forEach(e => e.anomalies.forEach(a => { byKind[a] = (byKind[a] || 0) + 1; }));
        const top = Object.entries(byKind).sort((a,b) => b[1] - a[1])[0];
        const cluster = top && top[1] >= 3 ? top : null;
        if (!cluster) return null;
        const [kind, count] = cluster;
        const label = ANOMALY_LABEL[kind]?.label || kind;
        return (
          <window.SLAi.Stripe
            tone="warn"
            eyebrow="Pattern · this week"
            title={`${count} ${label} flags this week — worth a look before payroll`}
            density="inline"
            style={{marginBottom: 12}}
            attribution={`Reviewed ${entries.length} entries. Cluster threshold: ≥3 of the same flag in a 7-day window.`}
            action={
              <>
                <button className="btn" data-variant="primary">Filter to flagged</button>
                <button className="btn" data-variant="ghost">Snooze 7 days</button>
                <span style={{flex:1}}/>
                <span style={{fontSize:11.5, color:'var(--ink-3)'}}>{flagged.length} flagged of {entries.length} total</span>
              </>
            }
          >
            Historically, clusters like this precede a payroll question. A 2-minute review now beats a phone call Friday afternoon.
          </window.SLAi.Stripe>
        );
      })()}

      <div className="card" style={{padding: 0}}>
        <div className="row between" style={{padding: '10px 14px', borderBottom: '1px solid var(--line)', gap: 8}}>
          <div className="row" style={{gap: 8}}>
            <button className="btn" onClick={selectAll}>{selected.size === visible.length ? 'Clear' : 'Select all'}</button>
            <button className="btn" data-variant="primary" onClick={approveSelected} disabled={!selected.size}>
              Approve {selected.size || ''} selected
            </button>
            <button className="btn" onClick={approveAllClean}>Auto-approve {entries.filter(e => e.anomalies.length === 0 && e.status === 'pending').length} clean</button>
          </div>
          <div className="seg">
            <button className="seg-btn" data-active={filter === 'all'} onClick={() => setFilter('all')}>All ({entries.length})</button>
            <button className="seg-btn" data-active={filter === 'flagged'} onClick={() => setFilter('flagged')}>Flagged ({flagged.length})</button>
          </div>
        </div>

        <div className="sl-tt">
          <div className="sl-tt-h">
            <span/><span>Worker</span><span>Date</span><span>Project · scope</span>
            <span className="num">In</span><span className="num">Out</span><span className="num">Hours</span>
            <span>Source</span><span>Flags</span><span/>
          </div>
          {visible.map(e => {
            const w = data.workers.find(x => x.id === e.worker);
            const proj = data.projects.find(p => p.id === e.project);
            const isSel = selected.has(e.id);
            const isOpen = e.anomalies.includes('no_clockout');
            return (
              <div key={e.id} className="sl-tt-row" data-status={e.status} data-flagged={e.anomalies.length > 0}>
                <input type="checkbox" checked={isSel} onChange={() => toggle(e.id)}/>
                <div className="row" style={{gap: 8}}>
                  <div className={`avatar tone-${w?.tone || 1}`}>{w?.initials}</div>
                  <div>
                    <div style={{fontWeight: 500, fontSize: 13}}>{w?.name}</div>
                    <div className="muted" style={{fontSize: 10.5}}>{w?.role}</div>
                  </div>
                </div>
                <span className="num">{e.date}</span>
                <div>
                  <div style={{fontSize: 12.5}}>{proj?.name.split(' — ')[0]}</div>
                  <div className="muted" style={{fontSize: 11}}>{e.scope}</div>
                </div>
                <span className="num">{e.clockIn}</span>
                <span className="num" style={isOpen ? {color: 'var(--red)', fontWeight: 600} : null}>{e.clockOut}</span>
                <span className="num" style={{fontWeight: 600}}>{e.hours.toFixed(1)}h</span>
                <span className="pill" data-tone={e.source === 'auto' ? 'green' : e.source === 'manual' ? 'amber' : 'blue'} style={{fontSize: 10}}>
                  <span className="dot"/>{e.source}
                </span>
                <div className="sl-tt-flags">
                  {e.anomalies.length === 0 && <span className="muted" style={{fontSize: 11}}>—</span>}
                  {e.anomalies.map(f => {
                    const m = ANOMALY_LABEL[f];
                    if (!m) return null;
                    return <span key={f} className="pill" data-tone={m.tone} title={m.tip} style={{fontSize: 10}}>{m.label}</span>;
                  })}
                  {e.anomalies.includes('outside_geofence') && (
                    <window.SLAi.Spark tooltip={`Clock-in pinged ${(140 + (e.id?.charCodeAt?.(0) || 0) % 80)}m outside the Hillcrest jobsite fence. Could be a coffee stop, could be the worker forgot to clock in until they arrived. Tap to see the GPS trail.`}/>
                  )}
                  {e.note && <span className="muted" style={{fontSize: 10.5}} title={e.note}>· note</span>}
                </div>
                <div className="row" style={{gap: 4, justifyContent: 'flex-end'}}>
                  {e.status === 'approved' ? (
                    <span className="pill" data-tone="green" style={{fontSize: 10}}><span className="dot"/>approved</span>
                  ) : (
                    <>
                      {isOpen ? <button className="btn" data-variant="primary" style={{fontSize: 11, padding: '4px 8px'}}>Fix</button>
                              : <button className="btn" data-variant="ghost" style={{fontSize: 11, padding: '4px 8px'}}>Edit</button>}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// useMemo with React (alias for safety)
function uMS_safe(fn, deps) { return uMT(fn, deps); }

// ============================================================
// FOREMAN ENTRY — three variations
// ============================================================
function ForemanEntry({ data, mode, setMode }) {
  return (
    <>
      <div className="row between" style={{marginBottom: 12}}>
        <div>
          <p className="eyebrow">Tue · Apr 29 · Hillcrest</p>
          <strong style={{fontSize: 18}}>End-of-day crew time entry</strong>
        </div>
        <div className="seg">
          <button className="seg-btn" data-active={mode === 'list'} onClick={() => setMode('list')}>List</button>
          <button className="seg-btn" data-active={mode === 'grid'} onClick={() => setMode('grid')}>Grid</button>
          <button className="seg-btn" data-active={mode === 'stopwatch'} onClick={() => setMode('stopwatch')}>Stopwatch</button>
        </div>
      </div>

      {mode === 'list' && <EntryList data={data}/>}
      {mode === 'grid' && <EntryGrid data={data}/>}
      {mode === 'stopwatch' && <EntryStopwatch data={data}/>}
    </>
  );
}

function EntryList({ data }) {
  const crew = ['w1','w2','w5'].map(id => data.workers.find(w => w.id === id));
  const [hrs, setHrs] = uST({w1: 8.5, w2: 8.5, w5: 7.0});
  return (
    <div className="card" style={{padding: 0, maxWidth: 720}}>
      <div className="sl-entry-list-h">
        <span>Crew</span>
        <span>In</span>
        <span>Out</span>
        <span>Lunch</span>
        <span>Hours</span>
        <span/>
      </div>
      {crew.map(c => (
        <div key={c.id} className="sl-entry-list-row">
          <div className="row" style={{gap: 8}}>
            <div className={`avatar tone-${c.tone}`}>{c.initials}</div>
            <div>
              <div style={{fontWeight: 500, fontSize: 13}}>{c.name}</div>
              <div className="muted" style={{fontSize: 11}}>EPS — East</div>
            </div>
          </div>
          <input className="sl-entry-input num" defaultValue="07:00"/>
          <input className="sl-entry-input num" defaultValue={hrs[c.id] === 7.0 ? '14:30' : '15:30'}/>
          <input className="sl-entry-input num" defaultValue="0:30"/>
          <strong className="num" style={{fontSize: 15}}>{hrs[c.id].toFixed(1)}h</strong>
          <button className="btn" data-variant="ghost" style={{fontSize: 11, padding: '4px 8px'}}>Same as yesterday</button>
        </div>
      ))}
      <div className="sl-entry-list-foot">
        <span className="muted">3 workers · {Object.values(hrs).reduce((a,b) => a+b, 0).toFixed(1)} crew-hours</span>
        <button className="btn" data-variant="primary">Submit to approval queue</button>
      </div>
    </div>
  );
}

function EntryGrid({ data }) {
  const crew = ['w1','w2','w5'].map(id => data.workers.find(w => w.id === id));
  const tasks = ['EPS — East', 'Caulk', 'Cleanup'];
  return (
    <div className="card" style={{padding: 0, overflow: 'hidden'}}>
      <div className="sl-entry-grid">
        <div className="sl-entry-grid-corner">Crew × scope</div>
        {tasks.map(t => <div key={t} className="sl-entry-grid-th">{t}</div>)}
        <div className="sl-entry-grid-th" style={{background: 'var(--surface-2)'}}>Total</div>
        {crew.map(c => (
          <React.Fragment key={c.id}>
            <div className="sl-entry-grid-rh">
              <div className={`avatar tone-${c.tone}`}>{c.initials}</div>
              <div style={{minWidth: 0}}>
                <div style={{fontWeight: 500, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{c.name}</div>
                <div className="muted" style={{fontSize: 10.5}}>{c.role}</div>
              </div>
            </div>
            <input className="sl-entry-grid-cell num" defaultValue="6.5"/>
            <input className="sl-entry-grid-cell num" defaultValue="1.5"/>
            <input className="sl-entry-grid-cell num" defaultValue="0.5"/>
            <strong className="sl-entry-grid-total num">8.5h</strong>
          </React.Fragment>
        ))}
        <div className="sl-entry-grid-rh" style={{background: 'var(--surface-2)', fontWeight: 600}}>Totals</div>
        <strong className="sl-entry-grid-total num">19.5</strong>
        <strong className="sl-entry-grid-total num">4.5</strong>
        <strong className="sl-entry-grid-total num">1.5</strong>
        <strong className="sl-entry-grid-total num" style={{background: 'var(--accent-soft)', color: 'var(--accent-ink)'}}>25.5h</strong>
      </div>
      <div className="sl-entry-list-foot">
        <span className="muted">Hours allocated by scope — feeds productivity calc</span>
        <button className="btn" data-variant="primary">Submit to approval queue</button>
      </div>
    </div>
  );
}

function EntryStopwatch({ data }) {
  const crew = ['w1','w2','w5'].map(id => data.workers.find(w => w.id === id));
  return (
    <div className="card" style={{padding: 16, maxWidth: 540}}>
      <p className="eyebrow" style={{margin: '0 0 12px 0'}}>Live stopwatch · 8:24:12 elapsed</p>
      <div style={{display: 'grid', gap: 10}}>
        {crew.map(c => (
          <div key={c.id} className="sl-stopwatch">
            <div className="row" style={{gap: 10}}>
              <div className={`avatar tone-${c.tone}`} style={{width: 40, height: 40, fontSize: 14}}>{c.initials}</div>
              <div>
                <div style={{fontWeight: 600, fontSize: 14}}>{c.name}</div>
                <div className="muted" style={{fontSize: 11}}>Started 7:00 AM · EPS — East</div>
              </div>
            </div>
            <div className="row" style={{gap: 10}}>
              <strong className="num" style={{fontSize: 22, color: 'var(--green)', fontVariantNumeric: 'tabular-nums'}}>8:24:12</strong>
              <button className="btn">Pause</button>
              <button className="btn" data-variant="primary">Stop</button>
            </div>
          </div>
        ))}
      </div>
      <div className="sl-entry-list-foot" style={{marginTop: 12, paddingLeft: 0, paddingRight: 0}}>
        <span className="muted">Foreman runs once at start of day, stops at end. Phone in pocket.</span>
        <button className="btn" data-variant="primary">Stop all & submit</button>
      </div>
    </div>
  );
}

// ============================================================
// LABOR BURDEN ROLLUP
// ============================================================
function BurdenRollup({ data }) {
  const rows = data.workers.map(w => {
    const r = data.workerRates[w.id];
    const wkHours = w.hoursWeek;
    const reg = Math.min(wkHours, 40);
    const ot = Math.max(0, wkHours - 40);
    const burdenMul = 1 + r.ins + r.ben;
    const regCost = reg * r.base * burdenMul;
    const otCost  = ot  * r.base * (1 + r.ot) * burdenMul;
    return { w, r, wkHours, reg, ot, regCost, otCost, total: regCost + otCost };
  });
  const totals = rows.reduce((acc, r) => ({
    hr: acc.hr + r.wkHours, ot: acc.ot + r.ot, reg: acc.reg + r.regCost, otCost: acc.otCost + r.otCost, total: acc.total + r.total,
  }), {hr:0, ot:0, reg:0, otCost:0, total:0});
  const baseSum = rows.reduce((s, x) => s + x.wkHours * x.r.base, 0);
  const burdenPct = (totals.total / baseSum - 1) * 100;

  return (
    <>
      <div className="grid grid-4 keep" style={{marginBottom: 12}}>
        <div className="stat">
          <span className="stat-label">Crew this week</span>
          <span className="stat-val num">{rows.length}</span>
          <span className="stat-meta num">{totals.hr.toFixed(1)}h logged</span>
        </div>
        <div className="stat">
          <span className="stat-label">Base wages</span>
          <span className="stat-val num">${baseSum.toFixed(0)}</span>
          <span className="stat-meta">straight time × hourly rate</span>
        </div>
        <div className="stat">
          <span className="stat-label">Loaded cost</span>
          <span className="stat-val num">${totals.total.toFixed(0)}</span>
          <span className="stat-meta num">+{burdenPct.toFixed(1)}% load on base</span>
        </div>
        <div className="stat">
          <span className="stat-label">OT premium</span>
          <span className="stat-val num">${totals.otCost ? (totals.otCost - totals.ot * rows[0].r.base * (1+rows[0].r.ins+rows[0].r.ben)).toFixed(0) : '0'}</span>
          <span className="stat-meta num">{totals.ot.toFixed(1)}h OT</span>
        </div>
      </div>

      <div className="card" style={{padding: 0}}>
        <div className="sl-burden-h">
          <span>Worker</span>
          <span className="num">Hours</span>
          <span className="num">Base $/h</span>
          <span className="num">Reg cost</span>
          <span className="num">OT</span>
          <span>Load</span>
          <span className="num">Loaded</span>
        </div>
        {rows.map(r => (
          <div key={r.w.id} className="sl-burden-row">
            <div className="row" style={{gap: 8}}>
              <div className={`avatar tone-${r.w.tone}`}>{r.w.initials}</div>
              <div>
                <div style={{fontWeight: 500, fontSize: 13}}>{r.w.name}</div>
                <div className="muted" style={{fontSize: 11}}>{r.w.role}</div>
              </div>
            </div>
            <span className="num">{r.wkHours.toFixed(1)}h</span>
            <span className="num">${r.r.base}</span>
            <span className="num">${r.regCost.toFixed(0)}</span>
            <span className="num" style={r.ot > 0 ? {color: 'var(--accent-ink)', fontWeight: 600} : null}>
              {r.ot > 0 ? `${r.ot.toFixed(1)}h · $${r.otCost.toFixed(0)}` : '—'}
            </span>
            <div className="sl-burden-stack">
              <span title={`Insurance ${(r.r.ins*100).toFixed(0)}%`}><span className="num">+{(r.r.ins*100).toFixed(0)}%</span> ins</span>
              <span title={`Benefits ${(r.r.ben*100).toFixed(0)}%`}><span className="num">+{(r.r.ben*100).toFixed(0)}%</span> ben</span>
            </div>
            <strong className="num" style={{fontSize: 14}}>${r.total.toFixed(0)}</strong>
          </div>
        ))}
        <div className="sl-burden-foot">
          <span>Totals</span>
          <span className="num">{totals.hr.toFixed(1)}h</span>
          <span/>
          <span className="num">${totals.reg.toFixed(0)}</span>
          <span className="num">{totals.ot.toFixed(1)}h · ${totals.otCost.toFixed(0)}</span>
          <span/>
          <strong className="num">${totals.total.toFixed(0)}</strong>
        </div>
      </div>

      <div className="card" style={{marginTop: 12, padding: 14}}>
        <p className="eyebrow" style={{margin: '0 0 8px 0'}}>What's in the loaded rate</p>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12}}>
          <div><strong>Insurance · 18%</strong><div className="muted" style={{fontSize: 11.5}}>WC + GL allocated by class code</div></div>
          <div><strong>Benefits · 8–14%</strong><div className="muted" style={{fontSize: 11.5}}>Health, retirement, PTO accrual</div></div>
          <div><strong>OT premium · 1.5×</strong><div className="muted" style={{fontSize: 11.5}}>Past 40h/week, then loaded</div></div>
          <div><strong>Equipment</strong><div className="muted" style={{fontSize: 11.5}}>Truck + small tools — not in this view</div></div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// LIVE LABOR vs BUDGET (per project)
// ============================================================
function LiveVsBudget({ data }) {
  // Made-up project labor budgets vs spent
  const rows = [
    { id: 'p-aspen',     name: 'Aspen Ridge',     budget: 84000, spent: 51200, weekHours: 124.5, weekCost: 6840, status: 'on-track' },
    { id: 'p-hillcrest', name: 'Hillcrest Mews',  budget: 42000, spent: 38800, weekHours: 95.4,  weekCost: 5420, status: 'risk' },
    { id: 'p-greenwillow',name:'Greenwillow Care',budget: 28500, spent: 27900, weekHours: 30.5,  weekCost: 1740, status: 'over' },
    { id: 'p-foothills', name: 'Foothills Annex', budget: 22000, spent: 0,     weekHours: 0,     weekCost: 0,    status: 'pending' },
  ];
  const tone = { 'on-track': 'green', risk: 'amber', over: 'red', pending: 'blue' };

  return (
    <div className="card" style={{padding: 0}}>
      <div className="sl-budget-h">
        <span>Project</span>
        <span>Labor budget</span>
        <span>This week</span>
        <span>Burn</span>
        <span/>
      </div>
      {rows.map(r => {
        const pct = r.budget > 0 ? Math.min(100, (r.spent / r.budget) * 100) : 0;
        const remaining = r.budget - r.spent;
        return (
          <div key={r.id} className="sl-budget-row">
            <div>
              <strong style={{fontSize: 13.5}}>{r.name}</strong>
              <div className="muted" style={{fontSize: 11.5}}>
                <span className="pill" data-tone={tone[r.status]} style={{fontSize: 10}}><span className="dot"/>{r.status}</span>
              </div>
            </div>
            <div>
              <div className="row between" style={{marginBottom: 4}}>
                <span className="num" style={{fontWeight: 600}}>${(r.spent/1000).toFixed(1)}k</span>
                <span className="muted num">of ${(r.budget/1000).toFixed(1)}k</span>
              </div>
              <div className="sl-budget-bar">
                <div className="sl-budget-fill" style={{width: `${pct}%`, background: pct > 90 ? 'var(--red)' : pct > 75 ? 'var(--accent)' : 'var(--green)'}}/>
              </div>
              <div className="muted num" style={{fontSize: 11, marginTop: 3}}>
                {remaining >= 0 ? `$${(remaining/1000).toFixed(1)}k remaining` : `$${Math.abs(remaining/1000).toFixed(1)}k over`}
              </div>
            </div>
            <div>
              <div className="num" style={{fontWeight: 600, fontSize: 14}}>{r.weekHours.toFixed(1)}h</div>
              <div className="muted num" style={{fontSize: 11.5}}>${r.weekCost.toLocaleString()} loaded</div>
            </div>
            <div>
              <BurnSpark pct={pct}/>
            </div>
            <button className="btn">Crew log →</button>
          </div>
        );
      })}
    </div>
  );
}

function BurnSpark({ pct }) {
  // Mini sparkline showing burn trajectory vs straight-line budget
  const bars = [12, 18, 28, 35, 42, 51, pct].map(v => v / 100);
  return (
    <svg viewBox="0 0 80 28" width="80" height="28">
      <line x1="0" y1="6" x2="80" y2="22" stroke="var(--line-2)" strokeDasharray="2,2" strokeWidth="1"/>
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.6"
        points={bars.map((b, i) => `${(i/(bars.length-1))*78 + 1},${27 - b * 22}`).join(' ')}/>
      <circle cx={1 + (bars.length-1)/(bars.length-1) * 78} cy={27 - bars[bars.length-1] * 22} r="2" fill="var(--accent)"/>
    </svg>
  );
}

window.SLTime = TimeView;
