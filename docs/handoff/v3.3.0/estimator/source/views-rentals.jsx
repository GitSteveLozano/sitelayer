/* global React */
const { useState: uSR, useMemo: uMR, useRef: uRR, useEffect: uER } = React;
const IR = window.SLIcons; const FR = window.SLFmt;

// ---------- helpers ----------
function projName(data, id) {
  return data.projects.find(p => p.id === id)?.name.split(' — ')[0] || id;
}
function skuName(data, sku) {
  return data.catalog.find(c => c.sku === sku)?.name || sku;
}
function daysBetween(mmdd, nowMmdd = '04/27') {
  // Simple demo: convert mm/dd to day-of-year-ish
  const toN = s => { const [m,d] = s.split('/').map(Number); return m*31 + d; };
  return toN(nowMmdd) - toN(mmdd);
}

// ---------- DISPATCH TICKET MODAL ----------
function DispatchModal({ data, onClose, prefill }) {
  const [project, setProject] = uSR(prefill?.project || data.projects[0].id);
  const [lines, setLines] = uSR(prefill?.lines || [{ sku: data.catalog[0].sku, qty: 1 }]);
  const [signedBy, setSignedBy] = uSR('');
  const [dueBack, setDueBack] = uSR('05/15');
  const [billUpfront, setBillUpfront] = uSR(false);

  const total = lines.reduce((s, l) => {
    const c = data.catalog.find(c => c.sku === l.sku);
    return s + (c ? c.daily * l.qty : 0);
  }, 0);
  // est days based on dueBack vs sentOn=04/27
  const days = (() => { const [m,d] = dueBack.split('/').map(Number); return Math.max(1, (m*31+d) - (4*31+27)); })();

  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Dispatch ticket">
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">New ticket · auto T-1045</p>
            <h2>Dispatch</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>{IR.x || '×'}</button>
        </div>

        <div className="rmodal-body">
          <div className="row" style={{gap: 12, marginBottom: 14}}>
            <div className="field" style={{flex: 1}}>
              <label>Project</label>
              <select value={project} onChange={e => setProject(e.target.value)}>
                {data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field" style={{width: 140}}>
              <label>Due back</label>
              <input value={dueBack} onChange={e => setDueBack(e.target.value)} placeholder="MM/DD"/>
            </div>
            <div className="field" style={{width: 200}}>
              <label>Signed by</label>
              <input value={signedBy} onChange={e => setSignedBy(e.target.value)} placeholder="Crew member"/>
            </div>
          </div>

          <div className="ticket-lines">
            <div className="ticket-line ticket-line-h">
              <span>Item</span>
              <span className="right">Qty</span>
              <span className="right">In stock</span>
              <span className="right">Daily</span>
              <span className="right">Line total / day</span>
              <span/>
            </div>
            {lines.map((l, i) => {
              const c = data.catalog.find(c => c.sku === l.sku);
              return (
                <div key={i} className="ticket-line">
                  <select value={l.sku} onChange={e => {
                    const next = [...lines]; next[i] = { ...next[i], sku: e.target.value }; setLines(next);
                  }}>
                    {data.catalog.map(c => <option key={c.sku} value={c.sku}>{c.sku} · {c.name}</option>)}
                  </select>
                  <input className="num right" type="number" min="1" value={l.qty}
                    onChange={e => { const next = [...lines]; next[i] = { ...next[i], qty: Number(e.target.value) || 1 }; setLines(next); }}/>
                  <span className="right num muted">{c?.owned || 0}</span>
                  <span className="right num muted">{FR.fmt$(c?.daily || 0)}</span>
                  <span className="right num">{FR.fmt$((c?.daily || 0) * l.qty)}</span>
                  <button className="icon-btn small" onClick={() => setLines(lines.filter((_,j) => j !== i))}>×</button>
                </div>
              );
            })}
            <button className="btn ghost ticket-add" onClick={() => setLines([...lines, { sku: data.catalog[0].sku, qty: 1 }])}>
              {IR.plus} Add line
            </button>
          </div>
        </div>

        <div className="rmodal-foot">
          <div>
            <label className="bill-toggle" onClick={() => setBillUpfront(!billUpfront)}>
              <span className={`bill-toggle-sw ${billUpfront ? 'on' : ''}`}><span/></span>
              <span style={{fontSize: 13, fontWeight: 500}}>Bill upfront</span>
              <span className="muted" style={{fontSize: 11}}>{billUpfront ? `invoice ${FR.fmt$(total * days)} now` : `bill on Apr cycle close`}</span>
            </label>
          </div>
          <div className="row" style={{gap: 12}}>
            <div style={{textAlign: 'right'}}>
              <span className="muted" style={{fontSize: 11}}>{lines.length} line{lines.length>1?'s':''} · {days}d projected</span>
              <div className="num" style={{fontSize: 16, fontWeight: 600, lineHeight: 1.2}}>{FR.fmt$(total)}/day</div>
            </div>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn" data-variant="primary" onClick={onClose}>Dispatch & sign</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- RETURN MODAL ----------
function ReturnModal({ data, dispatch, onClose }) {
  const [returned, setReturned] = uSR({ good: dispatch.qty, damaged: 0, lost: 0 });
  const sku = data.catalog.find(c => c.sku === dispatch.sku);
  const sum = returned.good + returned.damaged + returned.lost;
  const charges = returned.damaged * (sku?.replacement || 0) * 0.15 + returned.lost * (sku?.replacement || 0);

  function bump(k, delta) {
    const next = { ...returned, [k]: Math.max(0, returned[k] + delta) };
    if (next.good + next.damaged + next.lost > dispatch.qty) return;
    setReturned(next);
  }

  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal" style={{maxWidth: 540}} onClick={e => e.stopPropagation()}>
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">{dispatch.ticketId} · {projName(data, dispatch.project)}</p>
            <h2>Return — {sku?.name}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="rmodal-body">
          <p className="muted" style={{fontSize: 13, marginBottom: 14}}>
            Out: <span className="num">{dispatch.qty}</span> · Sent <span className="num">{dispatch.sentOn}</span> · Due <span className="num">{dispatch.dueBack}</span>
          </p>

          {[
            { k: 'good',     label: 'Good',     tone: 'green', help: 'Back in inventory at full' },
            { k: 'damaged',  label: 'Damaged',  tone: 'amber', help: 'Charged at 15% of replacement' },
            { k: 'lost',     label: 'Lost',     tone: 'red',   help: 'Charged at 100% of replacement' },
          ].map(row => (
            <div key={row.k} className="ret-row">
              <div>
                <span className="pill" data-tone={row.tone}><span className="dot"/>{row.label}</span>
                <span className="muted" style={{fontSize: 12, marginLeft: 8}}>{row.help}</span>
              </div>
              <div className="row" style={{gap: 6}}>
                <button className="icon-btn" onClick={() => bump(row.k, -1)}>−</button>
                <span className="num" style={{minWidth: 32, textAlign: 'center', fontSize: 16, fontWeight: 600}}>{returned[row.k]}</span>
                <button className="icon-btn" onClick={() => bump(row.k, +1)}>+</button>
              </div>
            </div>
          ))}

          <div className="photo-slot">
            <div className="photo-slot-icon">📷</div>
            <div>
              <strong>Add photo</strong>
              <p className="muted" style={{fontSize: 12, margin: 0}}>Required for damaged or lost items</p>
            </div>
          </div>

          {returned.damaged > 0 && (
            <div className="wo-link">
              <span className="wo-link-icon">{IR.wrench || '🔧'}</span>
              <div style={{flex: 1}}>
                <strong style={{fontSize: 13}}>Open repair work order</strong>
                <p className="muted" style={{fontSize: 12, margin: '2px 0 0'}}>
                  WO-212 · {returned.damaged} × {sku?.name} → Shop · D. Reyes
                  {' · '}routes out of available inventory until closed
                </p>
              </div>
              <span className="pill" data-tone="amber" style={{fontSize: 10}}>auto-create</span>
            </div>
          )}
        </div>
        <div className="rmodal-foot">
          <div>
            <span className="muted" style={{fontSize: 12}}>{sum} of {dispatch.qty} accounted for</span>
            {charges > 0 && <span className="num" style={{marginLeft: 12, color: 'var(--amber)', fontWeight: 600}}>+{FR.fmt$(charges)} charges</span>}
          </div>
          <div className="row" style={{gap: 8}}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn" data-variant="primary" onClick={onClose} disabled={sum !== dispatch.qty}>Receive return</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- TRANSFER DRAWER ----------
function TransferDrawer({ data, onClose, draggingId, setDraggingId }) {
  const [dropTarget, setDropTarget] = uSR(null);
  const [transferred, setTransferred] = uSR([]);
  const dispatch = data.dispatches.find(d => d.id === draggingId);

  function onDragStart(e, id) { setDraggingId(id); e.dataTransfer.effectAllowed = 'move'; }
  function onDrop(projectId) {
    if (draggingId && dispatch) setTransferred([...transferred, { id: draggingId, to: projectId }]);
    setDraggingId(null); setDropTarget(null);
  }

  return (
    <div className="rdrawer">
      <div className="rdrawer-h">
        <div>
          <p className="eyebrow">Drag a row →</p>
          <h3>Transfer between jobs</h3>
        </div>
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      <p className="muted" style={{fontSize: 12, padding: '0 16px 12px'}}>
        Drop a dispatch onto another project to transfer it without a return-in / dispatch-out cycle.
      </p>
      <div className="rdrawer-body">
        {data.projects.filter(p => p.status === 'active' || p.status === 'bid').map(p => {
          const isTarget = dispatch && dispatch.project !== p.id;
          return (
            <div key={p.id}
              className="drop-target"
              data-active={dropTarget === p.id && isTarget}
              data-disabled={!isTarget}
              onDragOver={e => { if (isTarget) { e.preventDefault(); setDropTarget(p.id); } }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={() => isTarget && onDrop(p.id)}
            >
              <div>
                <strong>{p.name}</strong>
                <p className="muted" style={{fontSize: 11, margin: '2px 0 0'}}>{p.client} · {p.crewSize} crew</p>
              </div>
              {transferred.find(t => t.to === p.id) && <span className="pill" data-tone="green"><span className="dot"/>Transferred</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- ACTIVITY TAB ----------
function ActivityTab({ data, onReturn, onTransferStart, transferOpen }) {
  const [filter, setFilter] = uSR('all');
  const filtered = data.dispatches.filter(d => {
    if (filter === 'overdue') return d.status === 'overdue';
    if (filter === 'out') return d.status === 'out';
    return true;
  });

  // Group by ticket
  const byTicket = uMR(() => {
    const map = {};
    filtered.forEach(d => { (map[d.ticketId] ||= []).push(d); });
    return Object.entries(map);
  }, [filtered]);

  const overdueCount = data.dispatches.filter(d => d.status === 'overdue').length;

  return (
    <>
      <div className="row" style={{gap: 6, marginBottom: 12, flexWrap: 'wrap'}}>
        {[['all','All', data.dispatches.length],['out','Out', data.dispatches.filter(d=>d.status==='out').length],['overdue','Overdue', overdueCount]].map(([k,l,n]) => (
          <button key={k} className="btn" data-variant={filter===k?'primary':undefined} onClick={() => setFilter(k)}>
            {l} <span className="num" style={{opacity: 0.7, marginLeft: 4}}>{n}</span>
            {k === 'overdue' && overdueCount > 0 && filter !== k && <span className="overdue-dot"/>}
          </button>
        ))}
      </div>

      <div className="ticket-list">
        {byTicket.map(([ticketId, lines]) => {
          const proj = lines[0].project;
          const anyOverdue = lines.some(l => l.status === 'overdue');
          return (
            <div key={ticketId} className="ticket-card" data-overdue={anyOverdue}>
              <div className="ticket-card-h">
                <div>
                  <span className="mono ticket-id">{ticketId}</span>
                  <span className="muted" style={{margin: '0 8px'}}>·</span>
                  <strong>{projName(data, proj)}</strong>
                </div>
                <div className="row" style={{gap: 6}}>
                  <span className="muted" style={{fontSize: 12}}>Sent {lines[0].sentOn} · Due {lines[0].dueBack} · {lines[0].signedBy}</span>
                  {anyOverdue && <span className="pill" data-tone="red"><span className="dot"/>Overdue</span>}
                </div>
              </div>
              <table className="tbl tbl-tight">
                <tbody>
                  {lines.map(d => (
                    <tr key={d.id}
                      draggable
                      onDragStart={e => onTransferStart(d.id, e)}
                      style={{cursor: 'grab'}}>
                      <td style={{width: 24}}><span className="grip">⋮⋮</span></td>
                      <td>{skuName(data, d.sku)}</td>
                      <td className="num right" style={{width: 60}}>{d.qty}</td>
                      <td className="num right muted" style={{width: 80}}>{FR.fmt$(data.catalog.find(c=>c.sku===d.sku)?.daily || 0)}/d</td>
                      <td className="right" style={{width: 200}}>
                        <button className="btn ghost small" onClick={() => onReturn(d)}>Return</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      {!transferOpen && (
        <p className="muted" style={{fontSize: 12, marginTop: 14, textAlign: 'center'}}>
          Tip: open the Transfer panel and drag any row onto another project.
        </p>
      )}
    </>
  );
}

// ---------- RECONCILE MODAL ----------
function ReconcileModal({ data, sku, onClose }) {
  const c = data.catalog.find(c => c.sku === sku);
  const out = data.dispatches.filter(d => d.sku === sku && d.status !== 'returned').reduce((s,d) => s + d.qty, 0);
  const [physical, setPhysical] = uSR(c.owned + (c.drift || 0));
  const expected = c.owned;
  const newDrift = physical - expected;

  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal" style={{maxWidth: 520}} onClick={e => e.stopPropagation()}>
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">{sku} · last counted {c.lastCount}</p>
            <h2>Reconcile inventory</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="rmodal-body">
          <p className="muted" style={{fontSize: 13, marginBottom: 16}}>
            System says you own <strong className="num">{expected}</strong> · <strong className="num">{out}</strong> are out on tickets.
            That leaves <strong className="num">{expected - out}</strong> in the yard. Counted differently?
          </p>
          <div className="rec-grid">
            <div className="rec-cell">
              <span className="muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>System</span>
              <span className="num" style={{fontSize: 24, fontWeight: 600}}>{expected}</span>
            </div>
            <div className="rec-cell">
              <span className="muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>Physical</span>
              <input className="num rec-input" type="number" value={physical} onChange={e => setPhysical(Number(e.target.value))} autoFocus/>
            </div>
            <div className="rec-cell" data-drift={newDrift < 0 ? 'neg' : newDrift > 0 ? 'pos' : 'zero'}>
              <span className="muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>Drift</span>
              <span className="num" style={{fontSize: 24, fontWeight: 600}}>{newDrift > 0 ? '+' : ''}{newDrift}</span>
            </div>
          </div>
          {newDrift < 0 && (
            <div className="rec-warn">
              <strong style={{fontSize: 13}}>Negative drift — {Math.abs(newDrift)} unit{Math.abs(newDrift)>1?'s':''} missing</strong>
              <p className="muted" style={{fontSize: 12, margin: '4px 0 0'}}>
                Pick a reason. SiteLayer will create an audit entry so this drift survives the next QBO sync.
              </p>
              <div className="row" style={{gap: 6, marginTop: 10, flexWrap: 'wrap'}}>
                {['Lost on jobsite', 'Theft', 'Damaged & disposed', 'Counting error', 'Sold off'].map(r => (
                  <button key={r} className="btn small">{r}</button>
                ))}
              </div>
            </div>
          )}
          {newDrift > 0 && (
            <div className="rec-info">
              <strong style={{fontSize: 13}}>Found {newDrift} more than expected</strong>
              <p className="muted" style={{fontSize: 12, margin: '4px 0 0'}}>Likely a return that wasn't logged. Check returns from last 14 days?</p>
            </div>
          )}
        </div>
        <div className="rmodal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" data-variant="primary" onClick={onClose}>Save reconciliation</button>
        </div>
      </div>
    </div>
  );
}

// ---------- CATALOG TAB ----------
function CatalogTab({ data }) {
  const [q, setQ] = uSR('');
  const [recSku, setRecSku] = uSR(null);
  const filtered = data.catalog.filter(c => !q || (c.sku + ' ' + c.name).toLowerCase().includes(q.toLowerCase()));
  const driftCount = data.catalog.filter(c => (c.drift || 0) !== 0).length;
  return (
    <>
      <div className="row" style={{gap: 8, marginBottom: 12}}>
        <div className="input" style={{flex: 1}}>{IR.search}<input placeholder="Search SKU or name…" value={q} onChange={e=>setQ(e.target.value)}/></div>
        {driftCount > 0 && (
          <button className="btn" style={{borderColor: 'var(--red)', color: 'var(--red)'}}>
            <span className="overdue-dot"/> {driftCount} drift to reconcile
          </button>
        )}
        <button className="btn" data-variant="primary">{IR.plus} New SKU</button>
      </div>
      <div className="card" style={{padding: 0, overflow: 'hidden'}}>
        <table className="tbl">
          <thead><tr>
            <th>SKU</th><th>Name</th><th>Category</th>
            <th className="right">Daily</th>
            <th className="right">Owned</th>
            <th className="right">Out</th>
            <th className="right">Available</th>
            <th className="right">Drift</th>
            <th/>
          </tr></thead>
          <tbody>
            {filtered.map(c => {
              const out = data.dispatches.filter(d => d.sku === c.sku && d.status !== 'returned').reduce((s,d) => s + d.qty, 0);
              const wo = data.workOrders.filter(w => w.sku === c.sku && w.status !== 'closed').reduce((s,w) => s + w.qty, 0);
              const avail = c.owned + (c.drift || 0) - out - wo;
              const drift = c.drift || 0;
              return (
                <tr key={c.sku}>
                  <td className="mono">{c.sku}</td>
                  <td>
                    {c.name}
                    {wo > 0 && <span className="pill" data-tone="amber" style={{marginLeft: 8, fontSize: 10}}><span className="dot"/>{wo} in repair</span>}
                  </td>
                  <td className="muted">{c.category}</td>
                  <td className="right num">{FR.fmt$(c.daily)}</td>
                  <td className="right num">{c.owned}</td>
                  <td className="right num" style={{color: out > c.owned * 0.8 ? 'var(--amber)' : undefined}}>{out}</td>
                  <td className="right num" style={{fontWeight: 600, color: avail === 0 ? 'var(--red)' : avail < 3 ? 'var(--amber)' : 'var(--green)'}}>{avail}</td>
                  <td className="right">
                    {drift !== 0 ? (
                      <button className="drift-chip" data-tone={drift < 0 ? 'neg' : 'pos'} onClick={() => setRecSku(c.sku)}>
                        {drift > 0 ? '+' : ''}{drift}
                      </button>
                    ) : <span className="muted num">—</span>}
                  </td>
                  <td className="right">
                    <button className="btn ghost small" onClick={() => setRecSku(c.sku)}>Reconcile</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {recSku && <ReconcileModal data={data} sku={recSku} onClose={() => setRecSku(null)}/>}
    </>
  );
}

// ---------- UTILIZATION TAB ----------
function UtilizationTab({ data }) {
  const [horizon, setHorizon] = uSR('now');

  const rows = data.catalog.map(c => {
    const out = data.dispatches.filter(d => d.sku === c.sku && d.status !== 'returned').reduce((s,d) => s + d.qty, 0);
    const reserved = data.reservations.filter(r => r.sku === c.sku && r.week <= 5).reduce((s,r) => Math.max(s, r.qty), 0);
    const utilization = c.owned > 0 ? out / c.owned : 0;
    const revenue = out * c.daily * 25; // Apr cycle
    return { ...c, out, reserved, utilization, revenue };
  }).sort((a,b) => b.utilization - a.utilization);

  const fleetUtil = rows.reduce((s,r) => s + r.out, 0) / rows.reduce((s,r) => s + r.owned, 0);
  const fleetRev = rows.reduce((s,r) => s + r.revenue, 0);

  return (
    <>
      <div className="grid grid-3 keep" style={{marginBottom: 14}}>
        <div className="stat">
          <span className="stat-label">Fleet utilization</span>
          <span className="stat-val num">{(fleetUtil*100).toFixed(0)}<span className="unit">%</span></span>
          <span className="stat-meta">{rows.reduce((s,r)=>s+r.out,0)} of {rows.reduce((s,r)=>s+r.owned,0)} units earning</span>
        </div>
        <div className="stat">
          <span className="stat-label">Apr cycle revenue</span>
          <span className="stat-val num">{FR.fmt$k(fleetRev)}</span>
          <span className="stat-meta" style={{color: 'var(--green)'}}>+18% vs Mar</span>
        </div>
        <div className="stat">
          <span className="stat-label">Idle SKUs</span>
          <span className="stat-val num">{rows.filter(r => r.utilization === 0).length}</span>
          <span className="stat-meta">No active dispatch</span>
        </div>
      </div>

      <div className="card" style={{padding: 16}}>
        <div className="card-h" style={{margin: '0 0 12px'}}>
          <h3 className="card-title">Utilization by SKU</h3>
          <span className="muted" style={{fontSize: 12}}>% of owned currently dispatched</span>
        </div>
        <div className="util-rows">
          {rows.map(r => (
            <div key={r.sku} className="util-row">
              <div className="util-row-name">
                <span className="mono" style={{fontSize: 11, color: 'var(--ink-3)'}}>{r.sku}</span>
                <span>{r.name}</span>
              </div>
              <div className="util-bar">
                <div className="util-bar-fill" style={{width: `${r.utilization*100}%`}}/>
                {r.reserved > r.owned && (
                  <div className="util-bar-overcommit" style={{width: `${Math.min(100, (r.reserved/r.owned)*100)}%`}}/>
                )}
              </div>
              <span className="num util-row-pct">{(r.utilization*100).toFixed(0)}%</span>
              <span className="num util-row-qty muted">{r.out}/{r.owned}</span>
              <span className="num util-row-rev">{FR.fmt$(r.revenue)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* MONETIZE IDLE — angle C's panel */}
      <div className="card monetize" style={{padding: 0, marginTop: 14, overflow: 'hidden'}}>
        <div className="monetize-h">
          <div>
            <p className="eyebrow">Monetize idle · external rental marketplace</p>
            <h3 style={{margin: '4px 0 0', fontSize: 18}}>Your idle gear, listed for other contractors to rent</h3>
            <p className="muted" style={{fontSize: 12, margin: '4px 0 0', maxWidth: 540}}>
              SiteLayer can publish your unused inventory to the marketplace. Contractors in your area book it through the customer portal — same dispatch / return / billing flow you use internally.
            </p>
          </div>
          <div className="monetize-h-side">
            <span className="muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>Est. recoverable</span>
            <span className="num" style={{fontSize: 26, fontWeight: 600, color: 'var(--green)'}}>{FR.fmt$k(rows.filter(r=>r.utilization<0.5).reduce((s,r)=>s+(r.owned-r.out)*r.daily*22, 0))}</span>
            <span className="muted" style={{fontSize: 11}}>over next 30 days at 70% list</span>
          </div>
        </div>
        <table className="tbl">
          <thead><tr>
            <th>SKU</th><th>Item</th>
            <th className="right">Idle qty</th>
            <th className="right">Idle days</th>
            <th className="right">List rate</th>
            <th className="right">Potential / mo</th>
            <th/>
          </tr></thead>
          <tbody>
            {rows.filter(r => r.owned - r.out > 0 && r.idleDays > 14).sort((a,b) => (b.owned-b.out)*b.daily - (a.owned-a.out)*a.daily).map(r => {
              const idle = r.owned - r.out;
              const list = Math.round(r.daily * 0.85); // 85% of internal rate as suggested
              const potential = idle * list * 22;
              return (
                <tr key={r.sku}>
                  <td className="mono">{r.sku}</td>
                  <td>{r.name}</td>
                  <td className="right num" style={{fontWeight: 600}}>{idle}</td>
                  <td className="right num" style={{color: r.idleDays > 30 ? 'var(--red)' : 'var(--amber)'}}>{r.idleDays}d</td>
                  <td className="right num">{FR.fmt$(list)}<span className="muted" style={{fontSize: 10}}>/d</span></td>
                  <td className="right num" style={{color: 'var(--green)', fontWeight: 600}}>+{FR.fmt$(potential)}</td>
                  <td className="right"><button className="btn small" data-variant="primary">List {idle}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="monetize-foot">
          <span className="muted" style={{fontSize: 12}}>Listed items show on the customer portal · bookings land in your dispatch queue for approval</span>
          <button className="btn">List all idle →</button>
        </div>
      </div>

      <div className="card" style={{padding: 16, marginTop: 14}}>
        <div className="card-h" style={{margin: '0 0 4px'}}>
          <h3 className="card-title">Demand forecast — 6 weeks</h3>
          <div className="row" style={{gap: 6}}>
            {['SCAF-8FT','SCAF-6FT'].map(s => (
              <button key={s} className="btn small" data-variant={horizon===s?'primary':undefined} onClick={()=>setHorizon(s)}>{s}</button>
            ))}
            <button className="btn small" data-variant={horizon==='now'?'primary':undefined} onClick={()=>setHorizon('now')}>SCAF-8FT default</button>
          </div>
        </div>
        <DemandChart data={data} sku={horizon === 'now' ? 'SCAF-8FT' : horizon}/>
      </div>
    </>
  );
}

function DemandChart({ data, sku }) {
  const c = data.catalog.find(x => x.sku === sku);
  if (!c) return null;
  const weeks = 6;
  const series = [];
  const projColors = { 'p-aspen': '#C77B4F', 'p-foothills': '#5B8AA8', 'p-hillcrest': '#7A8C6F', 'p-riverbend': '#D4A24C' };

  for (let w = 0; w < weeks; w++) {
    const entries = data.reservations.filter(r => r.sku === sku && r.week === w);
    series.push({ week: w, total: entries.reduce((s,r)=>s+r.qty,0), entries });
  }

  const maxQ = Math.max(c.owned, ...series.map(s => s.total));
  const W = 720, H = 200, padL = 60, padR = 16, padT = 12, padB = 28;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xFor = w => padL + (w / (weeks - 1)) * innerW;
  const yFor = q => padT + innerH - (q / maxQ) * innerH;

  return (
    <div style={{overflowX: 'auto'}}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width: '100%', minWidth: 600, display: 'block'}}>
        {/* grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(t => (
          <g key={t}>
            <line x1={padL} x2={W-padR} y1={padT + innerH*(1-t)} y2={padT + innerH*(1-t)} stroke="var(--line)" strokeWidth="0.5"/>
            <text x={padL - 6} y={padT + innerH*(1-t) + 3} fontFamily="Geist Mono" fontSize="10" fill="var(--ink-3)" textAnchor="end">{Math.round(maxQ*t)}</text>
          </g>
        ))}
        {/* capacity line */}
        <line x1={padL} x2={W-padR} y1={yFor(c.owned)} y2={yFor(c.owned)} stroke="var(--accent)" strokeDasharray="4 3" strokeWidth="1.2"/>
        <text x={W-padR} y={yFor(c.owned)-4} fontFamily="Geist Mono" fontSize="10" fill="var(--accent)" textAnchor="end">capacity {c.owned}</text>

        {/* stacked bars per project per week */}
        {series.map(s => {
          let stackY = yFor(0);
          return (
            <g key={s.week}>
              {s.entries.map((e, i) => {
                const h = (e.qty / maxQ) * innerH;
                stackY -= h;
                return (
                  <rect key={i} x={xFor(s.week) - 22} y={stackY} width={44} height={h}
                    fill={projColors[e.project] || '#999'} opacity={0.85}/>
                );
              })}
              <text x={xFor(s.week)} y={H - 8} fontFamily="Geist Mono" fontSize="10" fill="var(--ink-2)" textAnchor="middle">W{s.week+1}</text>
              {s.total > c.owned && (
                <text x={xFor(s.week)} y={yFor(s.total) - 4} fontFamily="Geist Mono" fontSize="10" fill="var(--red)" textAnchor="middle" fontWeight="700">⚠ {s.total - c.owned}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="row" style={{gap: 14, fontSize: 11, color: 'var(--ink-2)', marginTop: 6, flexWrap: 'wrap'}}>
        {Object.entries(projColors).filter(([id]) => series.some(s => s.entries.some(e => e.project === id))).map(([id,col]) => (
          <span key={id} className="row" style={{gap: 6}}>
            <span style={{width: 10, height: 10, background: col, borderRadius: 2}}/>
            {projName({projects: data.projects}, id)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- BILLING TAB ----------
function BillingTab({ data }) {
  const [selected, setSelected] = uSR(data.billingCycles[0].id);
  const [filter, setFilter] = uSR('ready');
  const filtered = data.billingCycles.filter(b => filter === 'all' ? true : b.status === filter);
  const ready = data.billingCycles.filter(b => b.status === 'ready');
  const totalReady = ready.reduce((s,b) => s + b.amount, 0);
  const sel = data.billingCycles.find(b => b.id === selected);
  const lines = data.billingLines[selected] || [];

  return (
    <>
      <div className="card" style={{padding: 18, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap'}}>
        <div>
          <p className="eyebrow">Ready to invoice — Apr cycle</p>
          <h2 style={{margin: '4px 0 0', fontSize: 28}} className="num">{FR.fmt$(totalReady)}</h2>
          <p className="muted" style={{fontSize: 13, margin: '4px 0 0'}}>{ready.length} cycles · {ready.reduce((s,b)=>s+b.lines,0)} line items · pushes to QBO as invoices</p>
        </div>
        <button className="btn" data-variant="primary" style={{padding: '12px 20px'}}>Approve all & push to QBO</button>
      </div>

      <div className="row" style={{gap: 6, marginBottom: 12}}>
        {[['ready','Ready'],['review','Needs review'],['pushed','Pushed'],['all','All']].map(([k,l]) => (
          <button key={k} className="btn" data-variant={filter===k?'primary':undefined} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>

      <div className="bill-split">
        <div className="bill-list">
          {filtered.map(b => (
            <div key={b.id} className="bill-row" data-active={selected === b.id} onClick={() => setSelected(b.id)}>
              <div>
                <strong>{projName(data, b.project)}</strong>
                <p className="muted" style={{margin: '2px 0 0', fontSize: 12}}>{b.period} · {b.lines} lines</p>
              </div>
              <div className="bill-row-right">
                <span className="num">{FR.fmt$(b.amount)}</span>
                <span className="pill" data-tone={b.status === 'ready' ? 'green' : b.status === 'review' ? 'amber' : 'blue'}><span className="dot"/>{b.status}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="bill-detail card" style={{padding: 0, overflow: 'hidden'}}>
          {sel && (
            <>
              <div className="bill-detail-h">
                <div>
                  <p className="eyebrow">{sel.period}</p>
                  <h3 style={{margin: '4px 0 0'}}>{projName(data, sel.project)}</h3>
                </div>
                <div className="row" style={{gap: 6}}>
                  <button className="btn">Edit</button>
                  <button className="btn" data-variant="primary">Approve & push</button>
                </div>
              </div>
              <div className="bill-terms">
                <div className="row" style={{gap: 14, alignItems: 'center'}}>
                  <span className="muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>Terms</span>
                  <div className="seg">
                    <button data-active="true">Due on receipt</button>
                    <button>Net-15</button>
                    <button>Net-30</button>
                    <button>PO required</button>
                  </div>
                </div>
                <span className="muted" style={{fontSize: 11}}>Customer terms · pushed to QBO with the invoice</span>
              </div>
              <table className="tbl">
                <thead><tr><th>SKU</th><th>Item</th><th className="right">Qty</th><th className="right">Days</th><th className="right">Daily</th><th className="right">Amount</th></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td className="mono">{l.sku}</td>
                      <td>{skuName(data, l.sku)}{l.kind === 'credit' && <span className="pill" data-tone="blue" style={{marginLeft: 6, fontSize: 10}}>credit</span>}</td>
                      <td className="right num">{l.qty}</td>
                      <td className="right num">{l.days}</td>
                      <td className="right num">{FR.fmt$(l.daily)}</td>
                      <td className="right num" style={{color: l.amount < 0 ? 'var(--blue)' : undefined, fontWeight: 600}}>{FR.fmt$(l.amount)}</td>
                    </tr>
                  ))}
                  <tr style={{background: 'var(--surf-2)'}}>
                    <td colSpan="5" className="right" style={{fontWeight: 600}}>Total</td>
                    <td className="right num" style={{fontWeight: 700, fontSize: 15}}>{FR.fmt$(sel.amount)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------- ROOT RENTALS VIEW ----------
function RentalsView({ data }) {
  const [tab, setTab] = uSR('activity');
  const [dispatchOpen, setDispatchOpen] = uSR(false);
  const [returnTarget, setReturnTarget] = uSR(null);
  const [transferOpen, setTransferOpen] = uSR(false);
  const [draggingId, setDraggingId] = uSR(null);

  const overdueCount = data.dispatches.filter(d => d.status === 'overdue').length;
  const totalOut = data.dispatches.filter(d => d.status !== 'returned').reduce((s,d)=>s+d.qty,0);

  // Idle revenue — fleet sitting in the yard NOT earning. Hero metric for angle C.
  const idle = data.catalog.map(c => {
    const out = data.dispatches.filter(d => d.sku === c.sku && d.status !== 'returned').reduce((s,d) => s + d.qty, 0);
    const idleQty = Math.max(0, c.owned + (c.drift || 0) - out);
    return { ...c, out, idleQty, idleDailyValue: idleQty * c.daily };
  });
  const idlePerDay = idle.reduce((s,r) => s + r.idleDailyValue, 0);
  const idleMonth = Math.round(idlePerDay * 30);
  const idleSkus = idle.filter(r => r.idleQty > 0 && r.idleDays > 21).sort((a,b) => b.idleDailyValue - a.idleDailyValue);

  function onTransferStart(id) {
    setTransferOpen(true);
    setDraggingId(id);
  }

  return (
    <>
      <div className="page-h">
        <div>
          <h1 className="page-title">Rentals</h1>
          <p className="page-sub">
            <span className="num">{totalOut}</span> units deployed · <span className="num">{data.catalog.length}</span> SKUs in catalog
            {overdueCount > 0 && <> · <span style={{color: 'var(--red)', fontWeight: 600}}>{overdueCount} overdue</span></>}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" data-variant={transferOpen?'primary':undefined} onClick={() => setTransferOpen(!transferOpen)}>
            ⇄ Transfer
          </button>
          <button className="btn" data-variant="primary" onClick={() => setDispatchOpen(true)}>{IR.plus} Dispatch ticket</button>
        </div>
      </div>

      {/* Angle C hero — make idle gear earn */}
      <div className="idle-hero">
        <div className="idle-hero-main">
          <p className="eyebrow">Idle inventory · what your fleet isn't earning</p>
          <div className="idle-hero-stack">
            <span className="idle-hero-num num">{FR.fmt$(idlePerDay)}<span className="idle-hero-unit">/day</span></span>
            <span className="idle-hero-pill">≈ {FR.fmt$k(idleMonth)} per month sitting in the yard</span>
          </div>
          <p className="idle-hero-sub">
            <strong className="num">{idle.reduce((s,r) => s + r.idleQty, 0)}</strong> units across <strong className="num">{idle.filter(r => r.idleQty > 0).length}</strong> SKUs idle right now ·
            {' '}<strong className="num">{idleSkus.length}</strong> have been idle 3+ weeks.
          </p>
        </div>
        <div className="idle-hero-side">
          <div className="idle-spark" aria-hidden="true">
            {idle.slice().sort((a,b)=>b.idleDailyValue-a.idleDailyValue).slice(0,8).map((r, i) => {
              const max = Math.max(...idle.map(x => x.idleDailyValue), 1);
              const h = r.idleDailyValue / max * 100;
              return <span key={r.sku} className="idle-spark-bar" style={{height: `${Math.max(8, h)}%`, opacity: 0.4 + (h/100)*0.6}} title={`${r.sku} · ${FR.fmt$(r.idleDailyValue)}/day idle`}/>;
            })}
          </div>
          <button className="btn" data-variant="primary" onClick={() => setTab('utilization')}>List on rental marketplace →</button>
        </div>
      </div>

      <div className="tabs" style={{marginBottom: 16}}>
        {[
          ['activity', 'Activity', overdueCount],
          ['catalog', 'Catalog', null],
          ['utilization', 'Utilization', null],
          ['billing', 'Billing', data.billingCycles.filter(b=>b.status==='ready').length],
        ].map(([k, l, badge]) => (
          <button key={k} className="tab" data-active={tab === k} onClick={() => setTab(k)}>
            {l}
            {badge !== null && badge > 0 && (
              <span className={`tab-badge ${k === 'activity' ? 'tab-badge-red' : ''}`}>{badge}</span>
            )}
          </button>
        ))}
      </div>

      <div className="rentals-shell" data-transfer-open={transferOpen}>
        <div className="rentals-main">
          {tab === 'activity' && <ActivityTab data={data} onReturn={setReturnTarget} onTransferStart={onTransferStart} transferOpen={transferOpen}/>}
          {tab === 'catalog' && <CatalogTab data={data}/>}
          {tab === 'utilization' && <UtilizationTab data={data}/>}
          {tab === 'billing' && <BillingTab data={data}/>}
        </div>
        {transferOpen && (
          <TransferDrawer data={data} onClose={() => setTransferOpen(false)} draggingId={draggingId} setDraggingId={setDraggingId}/>
        )}
      </div>

      {dispatchOpen && <DispatchModal data={data} onClose={() => setDispatchOpen(false)}/>}
      {returnTarget && <ReturnModal data={data} dispatch={returnTarget} onClose={() => setReturnTarget(null)}/>}
    </>
  );
}

window.SLRentals = RentalsView;
