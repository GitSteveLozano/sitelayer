/* global React, SLIcons, SLFmt, SLCover */
const { useState: uS1, useMemo: uM1 } = React;
const I1 = window.SLIcons; const { fmt$, fmt$k, fmtN } = window.SLFmt;

function ProjectsView({ data, openProject }) {
  const [q, setQ] = uS1('');
  const [filter, setFilter] = uS1('all');
  const filtered = data.projects.filter(p => {
    if (filter !== 'all' && p.status !== filter) return false;
    if (q && !(p.name + ' ' + p.client).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const totalBid = data.projects.reduce((s, p) => s + p.bid, 0);
  const active = data.projects.filter(p => p.status === 'active').length;
  const overdueRentals = (data.dispatches || []).filter(d => d.status === 'overdue');
  const overdueValue = overdueRentals.reduce((s, d) => {
    const c = data.catalog?.find(c => c.sku === d.sku);
    return s + (c ? c.daily * d.qty : 0);
  }, 0);

  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">5 jobs · {active} active · {fmt$k(totalBid)} in bids</p>
        </div>
        <div className="page-actions">
          <div className="input" style={{minWidth: 220}}>
            {I1.search}
            <input placeholder="Search projects, clients…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <button className="btn" data-variant="primary">{I1.plus} New project</button>
        </div>
      </div>

      {/* AI LAYER · What needs me — Tier 2 priority cards */}
      <div className="ai-priority" style={{marginBottom: 18}}>
        <div className="ai-priority-h">
          <div className="row" style={{gap:8, alignItems:'center'}}>
            <window.SLAi.SparkIcon size={14}/>
            <p className="eyebrow" style={{margin:0}}>What needs you · 3 things stand out today</p>
          </div>
          <span className="muted" style={{fontSize:11}}>Updated 4m ago</span>
        </div>
        <div className="grid grid-3 keep" style={{gap:12}}>
          <window.SLAi.PriorityCard
            tone="warn"
            eyebrow="Over budget · Labor"
            title="Hillcrest Phase 4"
            body="Labor is tracking 14% over bid with 3 weeks remaining. Pattern looks like the framing rework loop from Phase 2."
            action="Open project"
            attribution="Comparison to Phase 2 baseline · 47 days of clock-in data"
          />
          <window.SLAi.PriorityCard
            tone="info"
            eyebrow="Approval queue · 8 entries"
            title="Time entries from Mike's crew"
            body="Cluster of overtime + 2 GPS-out-of-fence flags on the Marina Tower job last Thursday. Worth a 2-min review before payroll."
            action="Review queue"
            attribution="Reviewed 32 entries this week · 2 flagged"
          />
          <window.SLAi.PriorityCard
            tone="muted"
            eyebrow="Quiet bid · 9 days no activity"
            title="Cedar Heights estimate"
            body="Sent Apr 18. Client opened twice, no questions. This length of silence on EPS bids has historically meant a follow-up nudge converts."
            action="Draft nudge"
            attribution="Pattern from 23 closed bids · last 18 months"
          />
        </div>
      </div>

      <div className="grid grid-4 keep" style={{marginBottom: 18}}>
        <div className="stat">
          <span className="stat-label">Active bids</span>
          <span className="stat-val num">{fmt$k(data.projects.filter(p=>p.status==='bid').reduce((s,p)=>s+p.bid,0))}</span>
          <span className="stat-meta">2 jobs awaiting decision</span>
        </div>
        <div className="stat">
          <span className="stat-label">In progress</span>
          <span className="stat-val num">{fmt$k(data.projects.filter(p=>p.status==='active').reduce((s,p)=>s+p.bid,0))}</span>
          <span className="stat-meta">2 active sites</span>
        </div>
        <div className="stat" data-overdue={overdueRentals.length > 0 ? 'true' : undefined}>
          <span className="stat-label">Overdue rentals {overdueRentals.length > 0 && <span className="overdue-dot"/>}</span>
          <span className="stat-val num" style={overdueRentals.length > 0 ? {color: 'var(--red)'} : undefined}>
            {overdueRentals.length}
          </span>
          <span className="stat-meta">
            {overdueRentals.length > 0 ? `${fmt$(overdueValue)}/day leaking` : 'all on time'}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Hours this week</span>
          <span className="stat-val num">204.5<span className="unit">h</span></span>
          <span className="stat-meta">8 active crew</span>
        </div>
      </div>

      <div className="row" style={{gap: 6, marginBottom: 12}}>
        {[['all','All'],['bid','Bid'],['active','Active'],['closeout','Closeout']].map(([k,l])=>(
          <button key={k} className="btn" data-variant={filter===k?'primary':undefined} onClick={()=>setFilter(k)}>{l}</button>
        ))}
      </div>

      <div className="proj-list">
        {filtered.map(p => (
          <div key={p.id} className="proj-row" onClick={() => openProject(p.id)}>
            <div className="cover"><SLCover seed={p.cover}/></div>
            <div>
              <div className="proj-row-name">{p.name}</div>
              <div className="proj-row-meta">
                <span>{p.client}</span>
                <span>·</span>
                <span>{p.division}</span>
                <span>·</span>
                <span className="num">{fmtN(p.sqft_total)} sqft</span>
                {p.status === 'active' && (
                  <span className="pill" data-tone={p.health === 'over-budget' ? 'red' : 'green'}>
                    <span className="dot"/> {p.health === 'over-budget' ? 'Over budget' : 'On track'}
                  </span>
                )}
                {p.status === 'bid' && <span className="pill" data-tone="amber"><span className="dot"/> Bid</span>}
                {p.status === 'closeout' && <span className="pill" data-tone="blue"><span className="dot"/> Closeout</span>}
              </div>
              {p.status === 'active' && (
                <div className="bar thin" style={{marginTop: 8, maxWidth: 280}}>
                  <span style={{width: `${p.progress*100}%`}}/>
                </div>
              )}
            </div>
            <div className="proj-row-right">
              <div className="proj-row-num num">{fmt$k(p.bid)}</div>
              <div className="proj-row-cap num">${p.bid_psf.toFixed(2)}/sqft</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- PROJECT DETAIL ----------
function ProjectDetail({ data, projectId, setRoute, goBack }) {
  const p = data.projects.find(x => x.id === projectId) || data.projects[0];
  const ms = data.measurements[p.id] || [];
  const totalQty = ms.reduce((s,m) => s + (m.unit==='sqft' ? m.qty : 0), 0);

  // Live margin computation
  const labor = p.daysActive * (p.crewSize || 1) * 8 * p.laborRate;
  const material = p.bid * 0.18; // demo
  const cost = labor + material;
  const revenue = p.bid * p.progress;
  const profit = revenue - cost;
  const margin = revenue > 0 ? profit / revenue : 0;
  const targetMargin = 0.20;
  const onTarget = margin >= targetMargin;

  const bonusEligible = margin >= 0.15;
  const bonusPayout = bonusEligible ? p.bonusPool * Math.min(1, (margin - 0.15) / 0.10) : 0;

  // Margin gauge SVG
  const gaugeAngle = Math.max(-90, Math.min(90, (margin / 0.30) * 180 - 90));

  return (
    <>
      <div className="row" style={{marginBottom: 16, gap: 6}}>
        <button className="btn" data-variant="ghost" onClick={goBack}>{I1.back} Projects</button>
      </div>
      <div className="page-h">
        <div>
          <p className="eyebrow">{p.division}</p>
          <h1 className="page-title">{p.name}</h1>
          <p className="page-sub">{p.client} · {p.address}</p>
        </div>
        <div className="page-actions">
          <span className="pill" data-tone={p.status === 'active' ? 'green' : p.status === 'bid' ? 'amber' : 'blue'}>
            <span className="dot"/>{p.status}
          </span>
          <button className="btn">{I1.more}</button>
        </div>
      </div>

      <div className="grid grid-3 keep" style={{marginBottom: 18}}>
        <div className="card">
          <div className="card-h">
            <h3 className="card-title">Margin</h3>
            <span className="pill" data-tone={onTarget ? 'green' : 'red'}>
              target 20%
            </span>
          </div>
          <div className="gauge">
            <svg viewBox="0 0 220 130">
              <path d="M20 110 A90 90 0 0 1 200 110" stroke="var(--surface-3)" strokeWidth="14" fill="none" strokeLinecap="round"/>
              <path d="M20 110 A90 90 0 0 1 200 110"
                stroke={onTarget ? 'var(--green)' : 'var(--red)'} strokeWidth="14" fill="none" strokeLinecap="round"
                strokeDasharray={`${Math.max(0, Math.min(282, margin/0.30 * 282))} 282`} />
              <line x1="110" y1="110" x2={110 + 70 * Math.cos((gaugeAngle - 90) * Math.PI/180)}
                    y2={110 + 70 * Math.sin((gaugeAngle - 90) * Math.PI/180)}
                    stroke="var(--ink)" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="110" cy="110" r="5" fill="var(--ink)"/>
              <text x="110" y="80" textAnchor="middle" fontSize="22" fontWeight="600" fontFamily="Geist Mono" fill="var(--ink)">
                {(margin*100).toFixed(1)}%
              </text>
              <text x="110" y="98" textAnchor="middle" fontSize="11" fill="var(--ink-3)">{fmt$k(profit)} profit</text>
            </svg>
          </div>
          <div className="row between" style={{fontSize: 12, color: 'var(--ink-3)', borderTop: '1px solid var(--line)', paddingTop: 10}}>
            <span>Revenue {fmt$k(revenue)}</span>
            <span>Cost {fmt$k(cost)}</span>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3 className="card-title">Bid vs Actual</h3>
            <window.SLAi.Eyebrow>Burden % AI-derived</window.SLAi.Eyebrow>
          </div>
          <div style={{display: 'grid', gap: 10}}>
            {[
              { label: 'Labor',    bid: p.bid * 0.55, actual: labor,                       color: 'var(--accent)', spark: true,  why: 'Burden multiplier 1.42× derived from this crew\'s last 90 days of W-2 wages, taxes, and workers\' comp class. Updated nightly.' },
              { label: 'Material', bid: p.bid * 0.30, actual: material,                    color: 'var(--teal)' },
              { label: 'Subs',     bid: p.bid * 0.10, actual: p.bid * 0.04 * p.progress,   color: 'var(--blue)' },
              { label: 'Overhead', bid: p.bid * 0.05, actual: p.bid * 0.03 * p.progress,   color: 'var(--ink-3)' },
            ].map((row, i) => {
              const pct = Math.min(100, (row.actual / row.bid) * 100);
              return (
                <div key={i}>
                  <div className="row between" style={{fontSize: 12, marginBottom: 4}}>
                    <span className="row" style={{gap:5, alignItems:'center'}}>
                      {row.label}
                      {row.spark && <window.SLAi.Spark tooltip={row.why}/>}
                    </span>
                    <span className="num muted">{fmt$k(row.actual)} / {fmt$k(row.bid)}</span>
                  </div>
                  <div className="bar" style={{height: 6}}>
                    <span style={{width: pct + '%', background: row.color}}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3 className="card-title">Bonus simulator</h3></div>
          <div style={{display: 'grid', gap: 8, fontSize: 13}}>
            <div className="row between">
              <span className="muted">Pool</span>
              <span className="num">{fmt$(p.bonusPool)}</span>
            </div>
            <div className="row between">
              <span className="muted">Threshold</span>
              <span className="num">15.0%</span>
            </div>
            <div className="row between" style={{paddingTop: 8, borderTop: '1px solid var(--line)'}}>
              <span style={{fontWeight: 600}}>Projected payout</span>
              <span className="num" style={{fontWeight: 600, color: bonusEligible ? 'var(--green)' : 'var(--ink-3)'}}>
                {fmt$(bonusPayout)}
              </span>
            </div>
            <div style={{fontSize: 11.5, color: 'var(--ink-3)', marginTop: 4}}>
              {bonusEligible
                ? `Each crew member earns ~${fmt$(bonusPayout / Math.max(p.crewSize,1))}.`
                : `${(15 - margin*100).toFixed(1)}pt margin gap to first tier.`}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-3 keep">
        <div className="card" style={{gridColumn: 'span 2'}}>
          <div className="card-h">
            <h3 className="card-title">Measurements</h3>
            <button className="btn" data-variant="ghost" onClick={() => setRoute('takeoff')}>Open canvas {I1.arrow}</button>
          </div>
          <table className="tbl">
            <thead><tr><th>Scope</th><th>Notes</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Amount</th></tr></thead>
            <tbody>
              {ms.map(m => {
                const item = data.scopeItems.find(s => s.code === m.code);
                const amt = m.qty * (item?.rate || 0);
                return (
                  <tr key={m.id}>
                    <td><span className="row" style={{gap: 6}}><span className="measure-dot" style={{background: item?.color}}/>{item?.name}</span></td>
                    <td className="muted">{m.notes}</td>
                    <td className="right num">{fmtN(m.qty,1)} {m.unit}</td>
                    <td className="right num">{fmt$(item?.rate || 0)}</td>
                    <td className="right num">{fmt$(amt)}</td>
                  </tr>
                );
              })}
              {!ms.length && <tr><td colSpan="5" style={{textAlign:'center', color: 'var(--ink-3)', padding: 24}}>No measurements yet — open the measurements canvas to start.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-h"><h3 className="card-title">Crew on site</h3></div>
          <div style={{display: 'grid', gap: 8}}>
            {data.workers.filter(w => w.project === p.id).map(w => (
              <div key={w.id} className="row" style={{gap: 10}}>
                <div className={`avatar tone-${w.tone}`}>{w.initials}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize: 13, fontWeight: 500}}>{w.name}</div>
                  <div style={{fontSize: 11.5, color: 'var(--ink-3)'}}>{w.role} · {w.hoursWeek}h this week</div>
                </div>
                {w.clockedIn && <span className="pulse"/>}
              </div>
            ))}
            {!data.workers.filter(w => w.project === p.id).length &&
              <div className="muted" style={{fontSize: 12, padding: 8}}>No crew assigned.</div>}
          </div>
        </div>
      </div>
    </>
  );
}

window.SLProjects = ProjectsView;
window.SLProjectDetail = ProjectDetail;
