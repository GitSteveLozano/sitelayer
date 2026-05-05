/* global React, SLIcons, SLFmt */
const I2 = window.SLIcons; const F2 = window.SLFmt;
const { useState: uS2, useRef: uR2, useEffect: uE2, useMemo: uM2 } = React;

// ============================================================
// TAKEOFF v2 — anchored to Position C
// Adds: multi-page nav, calibration UX, multi-condition tags,
// linear+count tools, revision compare, takeoff import,
// QBO push w/ sqft preserved, assembly drill-down
// ============================================================

// --- demo extensions (stay in this file, don't touch data.js) ---
function buildAssembly(scope) {
  // Each scope item has materials + waste + labor that sum to its rate.
  // This is the PlanSwift-style assembly view.
  const a = {
    EPS:   { materials: [['EPS board 1.5"', 1.05, 2.10, 'sqft'], ['Adhesive', 0.05, 0.85, 'lb']], waste: 0.05, labor: { hrs: 0.018, rate: 64 } },
    BASE:  { materials: [['Base coat mix', 0.08, 1.40, 'lb'], ['Mesh', 1.10, 0.42, 'sqft']], waste: 0.04, labor: { hrs: 0.014, rate: 64 } },
    FIN:   { materials: [['Finish coat', 0.07, 2.85, 'lb']], waste: 0.06, labor: { hrs: 0.013, rate: 64 } },
    STONE: { materials: [['Cultured stone', 1.0, 14.50, 'sqft'], ['Mortar', 0.06, 1.40, 'lb']], waste: 0.10, labor: { hrs: 0.045, rate: 78 } },
    AIRB:  { materials: [['Air barrier', 1.05, 1.20, 'sqft']], waste: 0.05, labor: { hrs: 0.008, rate: 58 } },
    CMNB:  { materials: [['Cementboard', 1.0, 3.40, 'sqft'], ['Screws', 0.08, 0.18, 'ea']], waste: 0.06, labor: { hrs: 0.020, rate: 64 } },
    ENV:   { materials: [['Sealant tube', 0.05, 8.40, 'tube']], waste: 0.05, labor: { hrs: 0.025, rate: 58 } },
    CAULK: { materials: [['Caulk tube', 0.04, 6.20, 'tube']], waste: 0.05, labor: { hrs: 0.018, rate: 58 } },
    FLASH: { materials: [['Aluminum coil', 0.5, 4.20, 'sqft'], ['Fasteners', 0.10, 0.12, 'ea']], waste: 0.07, labor: { hrs: 0.030, rate: 64 } },
  };
  return a[scope] || a.EPS;
}

const SEED_PAGES = [
  { id: 'A2.1', name: 'A2.1 — Exterior Elev. North', mCount: 4, calibrated: true,  scale: '1″ = 100′' },
  { id: 'A2.2', name: 'A2.2 — Exterior Elev. East',  mCount: 3, calibrated: true,  scale: '1″ = 100′' },
  { id: 'A2.3', name: 'A2.3 — Exterior Elev. South', mCount: 0, calibrated: false, scale: null },
  { id: 'A2.4', name: 'A2.4 — Exterior Elev. West',  mCount: 0, calibrated: false, scale: null },
  { id: 'A3.1', name: 'A3.1 — Wall Sections',        mCount: 2, calibrated: true,  scale: '1″ = 4′' },
  { id: 'A4.1', name: 'A4.1 — Details',              mCount: 0, calibrated: false, scale: null },
];

// Demo "rev B" diff regions (in 0..100 board space)
const REV_DIFF = [
  { kind: 'added',   pts: [[14, 60], [38, 60], [38, 76], [14, 76]], note: '+ Stone wainscot east bay' },
  { kind: 'removed', pts: [[64, 32], [82, 32], [82, 50], [64, 50]], note: '− Window 4 widened' },
];

// --- helpers ---
function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const xi = pts[i][0] ?? pts[i].x, yi = pts[i][1] ?? pts[i].y;
    const xj = pts[j][0] ?? pts[j].x, yj = pts[j][1] ?? pts[j].y;
    a += xi * yj - xj * yi;
  }
  return Math.abs(a) / 2;
}
function polyCentroid(pts) {
  let x = 0, y = 0;
  pts.forEach(p => { x += p[0] ?? p.x; y += p[1] ?? p.y; });
  return { x: x / pts.length, y: y / pts.length };
}
function polyPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = (pts[j][0] ?? pts[j].x) - (pts[i][0] ?? pts[i].x);
    const dy = (pts[j][1] ?? pts[j].y) - (pts[i][1] ?? pts[i].y);
    p += Math.hypot(dx, dy);
  }
  return p;
}

// ---------- ROOT ----------
function TakeoffView({ data, projectId, setRoute }) {
  const p = data.projects.find(x => x.id === projectId) || data.projects[0];
  const [pages, setPages] = uS2(SEED_PAGES);
  const [pageId, setPageId] = uS2('A2.1');
  const page = pages.find(x => x.id === pageId);

  // Mode: draw | compare | import | qbo
  const [mode, setMode] = uS2('draw');

  // Tool: select | poly | line | count | hand | calibrate
  const [tool, setTool] = uS2('poly');
  const [scope, setScope] = uS2('EPS');
  const [zoom, setZoom] = uS2(1);
  const [pan, setPan] = uS2({ x: 0, y: 0 });
  const [showAssembly, setShowAssembly] = uS2(false);

  // Per-page measurement state — seed from data
  const [measurementsByPage, setMByP] = uS2(() => {
    const seed = {};
    SEED_PAGES.forEach(pg => seed[pg.id] = []);
    (data.measurements[p.id] || []).forEach((m, i) => {
      const pgId = i < 4 ? 'A2.1' : i < 7 ? 'A2.2' : 'A3.1';
      seed[pgId].push({
        ...m,
        // upgrade to multi-tag: existing single-code becomes the first tag
        tags: [{ code: m.code, qty: m.qty, unit: m.unit }],
        kind: 'poly',
      });
    });
    return seed;
  });
  const measurements = measurementsByPage[pageId] || [];
  function setMeasurements(updater) {
    setMByP(prev => {
      const cur = prev[pageId] || [];
      const next = typeof updater === 'function' ? updater(cur) : updater;
      return { ...prev, [pageId]: next };
    });
  }

  // Calibration banner
  const [calibrationBanner, setCalBanner] = uS2(!page?.calibrated);
  uE2(() => setCalBanner(!page?.calibrated), [pageId]);

  // Drafts (current shape being drawn)
  const [draft, setDraft] = uS2([]);
  const [hover, setHover] = uS2(null);
  const stageRef = uR2(null);
  const sw = data.scopeItems.find(s => s.code === scope);

  // Modal state
  const [activeMeasure, setActiveMeasure] = uS2(null); // for multi-tag editor

  function clientToBoard(e) {
    const rect = stageRef.current.getBoundingClientRect();
    const px = (e.clientX - rect.left - pan.x) / zoom;
    const py = (e.clientY - rect.top - pan.y) / zoom;
    return { x: (px / rect.width) * 100, y: (py / rect.height) * 100 };
  }

  function onStageClick(e) {
    if (mode !== 'draw') return;
    const pt = clientToBoard(e);
    if (pt.x < 0 || pt.x > 100 || pt.y < 0 || pt.y > 100) return;

    if (tool === 'count') {
      setMeasurements(m => [...m, {
        id: 'mc-' + Date.now(),
        kind: 'count',
        notes: `${sw?.name} count #${m.length + 1}`,
        tags: [{ code: scope, qty: 1, unit: 'ea' }],
        points: [[pt.x, pt.y]],
      }]);
      return;
    }

    if (tool === 'poly' || tool === 'line') {
      // close on click-near-first for poly
      if (tool === 'poly' && draft.length >= 3) {
        const first = draft[0];
        if (Math.hypot(pt.x - first.x, pt.y - first.y) < 3) { finishShape(); return; }
      }
      setDraft(d => [...d, pt]);
    }
  }

  function finishShape() {
    if (tool === 'line' && draft.length < 2) { setDraft([]); return; }
    if (tool === 'poly' && draft.length < 3) { setDraft([]); return; }

    const pts = draft.map(d => [d.x, d.y]);
    if (tool === 'poly') {
      const area = polyArea(pts);
      const total = polyArea([[0,0],[100,0],[100,100],[0,100]]);
      const ratio = area / total;
      const qty = Math.max(1, Math.round(ratio * p.sqft_total * 10) / 10);
      setMeasurements(m => [...m, {
        id: 'mx-' + Date.now(),
        kind: 'poly',
        notes: `${sw?.name} #${m.length + 1}`,
        tags: [{ code: scope, qty, unit: sw?.unit || 'sqft' }],
        points: pts,
      }]);
    } else if (tool === 'line') {
      const lf = polyPerimeter(pts) * (p.sqft_total / 5000);
      const qty = Math.max(1, Math.round(lf * 10) / 10);
      setMeasurements(m => [...m, {
        id: 'ml-' + Date.now(),
        kind: 'line',
        notes: `${sw?.name} run #${m.length + 1}`,
        tags: [{ code: scope, qty, unit: 'lf' }],
        points: pts,
      }]);
    }
    setDraft([]);
  }

  uE2(() => {
    function onKey(e) {
      if (e.key === 'Escape') setDraft([]);
      if (e.key === 'Enter') finishShape();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, tool]);

  function onMouseMove(e) {
    if (mode === 'draw' && (tool === 'poly' || tool === 'line')) {
      setHover(clientToBoard(e));
    }
  }
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(z => Math.max(0.5, Math.min(3, z * (e.deltaY < 0 ? 1.1 : 0.9))));
  }

  function deleteMeasurement(id) { setMeasurements(m => m.filter(x => x.id !== id)); }
  function addTagToMeasurement(id, code) {
    setMeasurements(m => m.map(x => {
      if (x.id !== id) return x;
      if (x.tags.find(t => t.code === code)) return x;
      const it = data.scopeItems.find(s => s.code === code);
      // for caulk/lf items on a polygon, default to perimeter-style qty
      const baseQty = x.tags[0].qty;
      const newQty = it?.unit === 'lf' && x.kind === 'poly' ? Math.round(polyPerimeter(x.points) * (p.sqft_total / 5000) * 10) / 10 : baseQty;
      return { ...x, tags: [...x.tags, { code, qty: newQty, unit: it?.unit || 'sqft' }] };
    }));
  }
  function removeTag(id, code) {
    setMeasurements(m => m.map(x => x.id !== id ? x : { ...x, tags: x.tags.filter(t => t.code !== code) }).filter(x => x.tags.length > 0));
  }
  function updateTagQty(id, code, qty) {
    setMeasurements(m => m.map(x => x.id !== id ? x : { ...x, tags: x.tags.map(t => t.code === code ? { ...t, qty } : t) }));
  }

  // Totals: roll up by scope code across ALL pages, summing each tag's qty * rate
  const totals = uM2(() => {
    const by = {};
    Object.values(measurementsByPage).flat().forEach(m => {
      m.tags.forEach(tag => {
        const it = data.scopeItems.find(s => s.code === tag.code);
        if (!it) return;
        by[tag.code] = by[tag.code] || { code: tag.code, name: it.name, unit: tag.unit, color: it.color, qty: 0, amount: 0, rate: it.rate };
        by[tag.code].qty += tag.qty;
        by[tag.code].amount += tag.qty * it.rate;
      });
    });
    return Object.values(by);
  }, [measurementsByPage]);
  const grandTotal = totals.reduce((s, t) => s + t.amount, 0);

  return (
    <>
      {/* HEADER */}
      <div className="row between" style={{marginBottom: 14, flexWrap: 'wrap', gap: 8}}>
        <div>
          <p className="eyebrow">Measurements</p>
          <h1 className="page-title" style={{fontSize: 19, marginTop: 2}}>{p.name}</h1>
        </div>
        <div className="row" style={{gap: 8}}>
          <div className="tog">
            {[
              { id: 'draw',    label: 'Draw' },
              { id: 'compare', label: 'Compare', badge: 'Rev B' },
              { id: 'import',  label: 'Import' },
              { id: 'qbo',     label: 'Send to QBO' },
            ].map(m => (
              <button key={m.id} data-active={mode === m.id} onClick={() => setMode(m.id)}>
                {m.label}{m.badge && <span className="muted num" style={{marginLeft: 4, fontSize: 10}}>· {m.badge}</span>}
              </button>
            ))}
          </div>
          <button className="btn" data-variant="primary">Save draft</button>
        </div>
      </div>

      {/* MAIN: page strip | canvas | right rail */}
      <div className="t2-shell">
        <PageStrip pages={pages} pageId={pageId} setPageId={setPageId} measurementsByPage={measurementsByPage}/>

        <div className="canvas-stage" ref={stageRef}
          onMouseMove={onMouseMove}
          onClick={onStageClick}
          onDoubleClick={() => mode === 'draw' && finishShape()}
          onWheel={onWheel}>

          {/* Tool palette */}
          {mode === 'draw' && (
            <div className="canvas-toolbar">
              {[
                { k: 'select', i: I2.cursor, t: 'Select' },
                { k: 'poly',   i: I2.poly,   t: 'Polygon' },
                { k: 'line',   i: I2.line,   t: 'Linear' },
                { k: 'count',  i: <span style={{fontFamily:'Geist Mono', fontWeight:600, fontSize:13}}>#</span>, t: 'Count' },
                { k: 'hand',   i: I2.hand,   t: 'Pan' },
              ].map(b => (
                <button key={b.k} className="tool-btn" data-active={tool === b.k}
                  title={b.t} onClick={() => setTool(b.k)}>{b.i}</button>
              ))}
            </div>
          )}
          <div className="canvas-zoom">
            <button className="tool-btn" onClick={() => setZoom(z => Math.max(0.5, z - 0.1))}><span style={{fontSize: 16, fontWeight: 600}}>−</span></button>
            <span className="num" style={{fontSize: 12, padding: '0 6px', color: 'var(--ink-3)', minWidth: 44, textAlign: 'center'}}>{Math.round(zoom*100)}%</span>
            <button className="tool-btn" onClick={() => setZoom(z => Math.min(3, z + 0.1))}><span style={{fontSize: 16, fontWeight: 600}}>+</span></button>
            <button className="tool-btn" onClick={() => { setZoom(1); setPan({x:0,y:0}); }} style={{fontSize: 11}}>fit</button>
          </div>

          {/* page chip */}
          <div style={{position: 'absolute', top: 12, right: 12, zIndex: 5, display: 'flex', gap: 6}}>
            {page?.calibrated
              ? <span className="pill" data-tone="teal">scale {page.scale}</span>
              : <span className="pill" data-tone="amber"><span className="dot"/>uncalibrated</span>}
            <span className="pill">{page?.name?.split(' — ')[0]}</span>
          </div>

          {/* Calibration banner */}
          {calibrationBanner && mode === 'draw' && (
            <div className="t2-cal-banner">
              <div>
                <strong>This page isn't calibrated.</strong>
                <span className="muted" style={{marginLeft: 6}}>Click two points of known distance to set scale before measuring.</span>
              </div>
              <div className="row" style={{gap: 6}}>
                <button className="btn small" onClick={() => setCalBanner(false)}>Dismiss</button>
                <button className="btn small" data-variant="primary" onClick={() => alert('Click two points on the plan to calibrate (demo)')}>Calibrate now</button>
              </div>
            </div>
          )}

          <div style={{position: 'absolute', inset: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0'}}>
            <BlueprintBg pageId={pageId}/>

            <svg className="canvas-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" style={{pointerEvents: 'none'}}>

              {/* COMPARE mode: revision diff */}
              {mode === 'compare' && REV_DIFF.map((d, i) => (
                <g key={i}>
                  <polygon
                    points={d.pts.map(p => p.join(',')).join(' ')}
                    fill={d.kind === 'added' ? 'oklch(0.62 0.18 145)' : 'oklch(0.58 0.20 25)'}
                    fillOpacity="0.22"
                    stroke={d.kind === 'added' ? 'oklch(0.55 0.18 145)' : 'oklch(0.55 0.22 25)'}
                    strokeWidth="0.5"
                    strokeDasharray={d.kind === 'removed' ? '1.2 0.8' : '0'}/>
                  <g transform={`translate(${polyCentroid(d.pts).x}, ${polyCentroid(d.pts).y - 8})`}>
                    <rect x="-12" y="-2" width="24" height="3.6" rx="0.6" fill="white" stroke={d.kind === 'added' ? 'oklch(0.55 0.18 145)' : 'oklch(0.55 0.22 25)'} strokeWidth="0.2"/>
                    <text textAnchor="middle" y="0.6" fontSize="1.7" fontFamily="Geist" fontWeight="600"
                      fill={d.kind === 'added' ? 'oklch(0.42 0.18 145)' : 'oklch(0.45 0.22 25)'}>{d.note}</text>
                  </g>
                </g>
              ))}

              {/* Existing measurements */}
              {mode !== 'compare' && measurements.map(m => {
                const primary = data.scopeItems.find(s => s.code === m.tags[0].code);
                if (m.kind === 'count') {
                  const pt = m.points[0];
                  return (
                    <g key={m.id} transform={`translate(${pt[0]}, ${pt[1]})`}>
                      <circle r="2.4" fill={primary?.color} fillOpacity="0.25" stroke={primary?.color} strokeWidth="0.4"/>
                      <text textAnchor="middle" y="0.7" fontSize="2.2" fontFamily="Geist Mono" fontWeight="600" fill={primary?.color}>{primary?.code}</text>
                    </g>
                  );
                }
                if (m.kind === 'line') {
                  const pl = m.points.map(pt => pt.join(',')).join(' ');
                  const cent = polyCentroid(m.points);
                  return (
                    <g key={m.id}>
                      <polyline points={pl} fill="none" stroke={primary?.color} strokeWidth="0.6"/>
                      {m.points.map((pt, i) => <circle key={i} cx={pt[0]} cy={pt[1]} r="0.5" fill="white" stroke={primary?.color} strokeWidth="0.3"/>)}
                      <g transform={`translate(${cent.x}, ${cent.y - 2})`}>
                        <rect x="-7" y="-1.7" width="14" height="3.4" rx="0.5" fill="white" stroke={primary?.color} strokeWidth="0.2"/>
                        <text textAnchor="middle" y="0.6" fontSize="1.7" fontFamily="Geist Mono" fontWeight="600" fill="var(--ink)">{F2.fmtN(m.tags[0].qty, 0)} lf</text>
                      </g>
                    </g>
                  );
                }
                // poly
                const pts = m.points.map(pt => pt.join(',')).join(' ');
                const c = polyCentroid(m.points);
                const isMulti = m.tags.length > 1;
                return (
                  <g key={m.id}>
                    <polygon points={pts}
                      fill={primary?.color} fillOpacity={isMulti ? 0.22 : 0.18}
                      stroke={primary?.color} strokeWidth={isMulti ? "0.6" : "0.4"}
                      strokeLinejoin="round"/>
                    <g transform={`translate(${c.x}, ${c.y})`}>
                      <rect x="-9" y="-2.4" width="18" height="4.8" rx="1" fill="white" stroke={primary?.color} strokeWidth="0.25"/>
                      <text textAnchor="middle" y="0.4" fontSize="2.2" fontFamily="Geist Mono" fill="var(--ink)" fontWeight="600">
                        {F2.fmtN(m.tags[0].qty)} {m.tags[0].unit}
                      </text>
                      {isMulti && (
                        <g transform="translate(0, -3.2)">
                          {m.tags.map((t, i) => {
                            const it = data.scopeItems.find(s => s.code === t.code);
                            return <circle key={t.code} cx={(i - (m.tags.length-1)/2) * 1.6} r="0.6" fill={it?.color}/>;
                          })}
                        </g>
                      )}
                    </g>
                  </g>
                );
              })}

              {/* Draft */}
              {mode === 'draw' && draft.length > 0 && (
                <g>
                  {tool === 'line' ? (
                    <polyline points={draft.map(d => `${d.x},${d.y}`).join(' ') + (hover ? ` ${hover.x},${hover.y}` : '')}
                      fill="none" stroke={sw?.color} strokeWidth="0.6" strokeDasharray="0.8 0.8"/>
                  ) : (
                    <>
                      <polyline points={draft.map(d => `${d.x},${d.y}`).join(' ') + (hover ? ` ${hover.x},${hover.y}` : '')}
                        fill="none" stroke={sw?.color} strokeWidth="0.4" strokeDasharray="0.8 0.8"/>
                      {draft.length >= 3 && hover && (
                        <polygon points={[...draft, hover].map(d => `${d.x},${d.y}`).join(' ')}
                          fill={sw?.color} fillOpacity="0.10" stroke="none"/>
                      )}
                    </>
                  )}
                  {draft.map((d, i) => (
                    <circle key={i} cx={d.x} cy={d.y} r={i === 0 ? '0.9' : '0.6'}
                      fill="white" stroke={sw?.color} strokeWidth="0.4"/>
                  ))}
                </g>
              )}
            </svg>
          </div>

          {/* Status bar */}
          <div style={{position: 'absolute', bottom: 12, right: 12, fontSize: 11.5, color: 'var(--ink-3)',
            background: 'var(--surface)', border: '1px solid var(--line)', padding: '4px 10px',
            borderRadius: 8, fontFamily: 'Geist Mono', display: 'flex', gap: 12}}>
            {mode === 'draw' && tool === 'poly' && <span>click to add · <span className="kbd">Enter</span> close · <span className="kbd">Esc</span> cancel</span>}
            {mode === 'draw' && tool === 'line' && <span>click vertices · <span className="kbd">Enter</span> finish</span>}
            {mode === 'draw' && tool === 'count' && <span>click to drop count marker</span>}
            {mode === 'compare' && <span>Rev A → Rev B · 2 changed regions</span>}
          </div>
        </div>

        {/* RIGHT RAIL */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0}}>
          <ScopeRail
            scopeItems={data.scopeItems}
            scope={scope} setScope={setScope}
            showAssembly={showAssembly} setShowAssembly={setShowAssembly}/>

          <div className="card" style={{padding: 14, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'}}>
            <div className="card-h">
              <h3 className="card-title">Measurements <span className="muted num" style={{fontWeight: 400, fontSize: 11, marginLeft: 4}}>· this page</span></h3>
              <span className="num" style={{fontSize: 13, fontWeight: 600}}>{F2.fmt$(grandTotal)}</span>
            </div>

            {/* AI LAYER · Agent-drafted polygons */}
            {mode === 'draw' && (
              <window.SLAi.Agent
                eyebrow="Agent draft · pattern match on plan"
                title="3 wall sections look like EPS based on hatching"
                density="card"
                attribution="Pattern-matched against EPS-3 hatch in this plan set. Quantities are estimates — verify before accepting."
                items={[
                  { id: 1, label: 'North wall · ~412 sf',  meta: 'EPS-3 · matches Sheet A2.1' },
                  { id: 2, label: 'East wall · ~268 sf',   meta: 'EPS-3 · matches Sheet A2.1' },
                  { id: 3, label: 'South wall · ~340 sf',  meta: 'EPS-3 · matches Sheet A2.2' },
                ]}
                primaryLabel="Accept all 3"
                secondaryLabel="Review one by one"
                tertiaryLabel="Dismiss"
                style={{marginBottom: 10}}
              />
            )}

            <div style={{flex: 1, overflow: 'auto', display: 'grid', gap: 4, marginBottom: 10}}>
              {measurements.map(m => (
                <MeasurementRow key={m.id} m={m} data={data}
                  onAddTag={code => addTagToMeasurement(m.id, code)}
                  onRemoveTag={code => removeTag(m.id, code)}
                  onDelete={() => deleteMeasurement(m.id)}/>
              ))}
              {!measurements.length &&
                <div className="muted" style={{fontSize: 12, padding: 18, textAlign: 'center'}}>
                  Pick a scope item, then click on the blueprint.
                </div>}
            </div>
            <div style={{borderTop: '1px solid var(--line)', paddingTop: 10, display: 'grid', gap: 6, fontSize: 12}}>
              {totals.map(t => (
                <div key={t.code} className="row between">
                  <span className="row" style={{gap: 6}}><span className="measure-dot" style={{background: t.color}}/>{t.code}</span>
                  <span className="num muted">{F2.fmtN(t.qty, 1)} {t.unit} · {F2.fmt$(t.amount)}</span>
                </div>
              ))}
            </div>
          </div>
          <SuggestedRentals projectId={projectId} data={data}/>
        </div>
      </div>

      {/* MODE OVERLAYS */}
      {mode === 'import' && <ImportModal data={data} onClose={() => setMode('draw')} onImport={(rows) => {
        // append rows as imported measurements on current page
        setMeasurements(m => [...m, ...rows.map((r, i) => ({
          id: 'mi-' + Date.now() + '-' + i,
          kind: 'poly',
          imported: true,
          notes: r.notes,
          tags: [{ code: r.code, qty: r.qty, unit: r.unit }],
          points: [[20 + (i*8) % 60, 20 + Math.floor((i*8)/60)*10], [25 + (i*8) % 60, 20 + Math.floor((i*8)/60)*10], [25 + (i*8) % 60, 25 + Math.floor((i*8)/60)*10], [20 + (i*8) % 60, 25 + Math.floor((i*8)/60)*10]],
        }))]);
        setMode('draw');
      }} onImportPages={(newPages) => {
        const added = newPages.map(np => ({
          id: np.sheet,
          name: np.sheet + ' — ' + np.title,
          mCount: 0,
          calibrated: !!np.scaleDetected,
          scale: np.scaleDetected || '—',
        }));
        setPages(ps => [...ps, ...added.filter(a => !ps.some(p => p.id === a.id))]);
        setMByP(m => {
          const next = {...m};
          added.forEach(a => { if (!next[a.id]) next[a.id] = []; });
          return next;
        });
        if (added.length) setPageId(added[0].id);
        setMode('draw');
      }}/>}
      {mode === 'qbo' && <QBOPushModal data={data} project={p} totals={totals} grandTotal={grandTotal} onClose={() => setMode('draw')}/>}
      {showAssembly && <AssemblyModal scope={scope} data={data} onClose={() => setShowAssembly(false)}/>}
    </>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function PageStrip({ pages, pageId, setPageId, measurementsByPage }) {
  return (
    <aside className="t2-pages">
      <div className="t2-pages-h">
        <p className="eyebrow" style={{margin: 0}}>Pages</p>
        <span className="muted num" style={{fontSize: 11}}>{pages.length}</span>
      </div>
      {pages.map(pg => {
        const count = (measurementsByPage[pg.id] || []).length;
        return (
          <button key={pg.id} className="t2-page" data-active={pageId === pg.id} onClick={() => setPageId(pg.id)}>
            <div className="t2-page-thumb"><MiniBlueprint pageId={pg.id}/></div>
            <div style={{flex: 1, minWidth: 0}}>
              <strong>{pg.id}</strong>
              <span className="t2-page-name">{pg.name.split(' — ')[1]}</span>
              <div className="t2-page-meta">
                {pg.calibrated
                  ? <span className="num" style={{color: 'var(--ink-3)'}}>{pg.scale}</span>
                  : <span style={{color: 'var(--amber)'}}>uncal.</span>}
                <span className="num" style={{color: count > 0 ? 'var(--ink)' : 'var(--ink-3)', fontWeight: count > 0 ? 600 : 400}}>{count} m</span>
              </div>
            </div>
          </button>
        );
      })}
    </aside>
  );
}

function ScopeRail({ scopeItems, scope, setScope, showAssembly, setShowAssembly }) {
  const a = buildAssembly(scope);
  const sw = scopeItems.find(s => s.code === scope);
  return (
    <div className="card scope-rail" style={{padding: 10}}>
      <div className="card-h" style={{padding: '4px 6px', marginBottom: 4}}>
        <h3 className="card-title">Scope items</h3>
        <button className="btn small" data-variant="ghost" onClick={() => setShowAssembly(true)} title="View assembly">{showAssembly ? '·' : 'assembly'}</button>
      </div>
      <div style={{display: 'grid', gap: 2, maxHeight: 200, overflow: 'auto'}}>
        {scopeItems.map(s => (
          <div key={s.code} className="scope-item" data-active={scope === s.code} onClick={() => setScope(s.code)}>
            <span className="scope-swatch" style={{background: s.color}}/>
            <span className="scope-name">{s.name}</span>
            <span className="scope-rate num">${s.rate} /{s.unit}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MeasurementRow({ m, data, onAddTag, onRemoveTag, onDelete }) {
  const [tagPickerOpen, setTagPickerOpen] = uS2(false);
  const usedCodes = new Set(m.tags.map(t => t.code));
  const available = data.scopeItems.filter(s => !usedCodes.has(s.code));
  return (
    <div className="t2-mrow">
      <div className="t2-mrow-h">
        <span className="t2-mrow-kind" data-kind={m.kind}>
          {m.kind === 'poly' ? '◆' : m.kind === 'line' ? '─' : '#'}
        </span>
        <strong style={{flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{m.notes}</strong>
        {m.imported && <span className="pill" data-tone="teal" style={{fontSize: 9}}>imported</span>}
        <button className="btn small" data-variant="ghost" style={{padding: 2}} onClick={onDelete}>{I2.trash}</button>
      </div>
      <div className="t2-mrow-tags">
        {m.tags.map(t => {
          const it = data.scopeItems.find(s => s.code === t.code);
          return (
            <span key={t.code} className="t2-tag">
              <span className="t2-tag-dot" style={{background: it?.color}}/>
              <span>{it?.code}</span>
              <span className="num muted">{F2.fmtN(t.qty, 0)} {t.unit}</span>
              {m.tags.length > 1 && <button onClick={() => onRemoveTag(t.code)}>×</button>}
            </span>
          );
        })}
        <button className="t2-tag-add" onClick={() => setTagPickerOpen(o => !o)}>+ tag</button>
        {tagPickerOpen && available.length > 0 && (
          <div className="t2-tag-picker">
            {available.map(s => (
              <button key={s.code} onClick={() => { onAddTag(s.code); setTagPickerOpen(false); }}>
                <span className="t2-tag-dot" style={{background: s.color}}/>
                {s.code} <span className="muted" style={{marginLeft: 'auto', fontSize: 11}}>${s.rate}/{s.unit}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- IMPORT MODAL ---
function ImportModal({ data, onClose, onImport, onImportPages }) {
  const [step, setStep] = uS2(1);
  const [source, setSource] = uS2('pdf');
  const isPdf = source === 'pdf';

  const sources = {
    pdf:       { label: 'PDF plan set',           tag: 'native · most common', accept: '.pdf', maxSize: '200MB' },
    bluebeam:  { label: 'Bluebeam Markups CSV',   tag: 'markups list → Excel', accept: '.csv,.xlsx', maxSize: '25MB',
                 sample: 'Subject,Layer,Comments,Length,Area\nEPS,Exterior,East elevation,—,1284.5\nBASE,Exterior,East elevation,—,1284.5\nFIN,Exterior,East elevation,—,1284.5\nSTONE,Exterior,Stone wainscot,—,520\nCAULK,Exterior,Window perimeter,184,—' },
    planswift: { label: 'PlanSwift Excel export', tag: 'one-time licensed',     accept: '.xlsx,.xls', maxSize: '25MB',
                 sample: 'Item,Description,Quantity,Unit\nEPS Insulation,East elev,1284.5,sqft\nBasecoat,East elev,1284.5,sqft\nCultured Stone,Wainscot,520,sqft' },
    stack:     { label: 'STACK CSV API',          tag: 'cloud, API',            accept: '.csv', maxSize: '25MB',
                 sample: 'scope_code,measurement_name,qty,uom\nEPS,East,1284.5,sqft\nBASE,East,1284.5,sqft' },
    ost:       { label: 'On-Screen Takeoff CSV',  tag: 'desktop, ConstructConnect', accept: '.csv', maxSize: '25MB',
                 sample: 'Condition,Folder,Quantity,Units\nEPS - 1.5",Exterior,1284.5,SF\nBasecoat,Exterior,1284.5,SF' },
  };

  // demo parsed rows (data import)
  const parsed = [
    { code: 'EPS',   notes: 'East elevation (imported)', qty: 1284.5, unit: 'sqft' },
    { code: 'BASE',  notes: 'East elevation (imported)', qty: 1284.5, unit: 'sqft' },
    { code: 'FIN',   notes: 'East elevation (imported)', qty: 1284.5, unit: 'sqft' },
    { code: 'STONE', notes: 'Stone wainscot (imported)', qty: 520,    unit: 'sqft' },
    { code: 'CAULK', notes: 'Window perimeter (imported)', qty: 184,  unit: 'lf' },
  ];

  // demo extracted PDF pages — what shows up in the page strip after import
  const [pdfPages, setPdfPages] = uS2([
    { idx: 1, sheet: 'A1.0', title: 'Cover Sheet',           kind: 'cover',    scaleDetected: null,         include: false },
    { idx: 2, sheet: 'A2.5', title: 'Interior Elev. Lobby',  kind: 'elevation',scaleDetected: '1″ = 50′',   include: true  },
    { idx: 3, sheet: 'A2.6', title: 'Roof Plan',             kind: 'plan',     scaleDetected: '1″ = 100′',  include: true  },
    { idx: 4, sheet: 'A3.2', title: 'Wall Sections — Bay 4', kind: 'section',  scaleDetected: '3″ = 1\'-0″',include: true  },
    { idx: 5, sheet: 'A3.3', title: 'Wall Sections — Bay 5', kind: 'section',  scaleDetected: '3″ = 1\'-0″',include: true  },
    { idx: 6, sheet: 'A4.2', title: 'EIFS Details',          kind: 'detail',   scaleDetected: '1½″ = 1\'-0″', include: true},
    { idx: 7, sheet: '—',    title: 'Specifications p.184',  kind: 'spec',     scaleDetected: null,         include: false },
  ]);
  const includedPages = pdfPages.filter(p => p.include);

  const headerStep = step === 1
    ? 'Pick source'
    : step === 2
      ? (isPdf ? 'Extract & calibrate pages' : 'Map columns')
      : (isPdf ? 'Preview pages' : 'Preview & import');

  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal" style={{maxWidth: 820}} onClick={e => e.stopPropagation()}>
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">Import measurements</p>
            <h2>Step {step} / 3 · {headerStep}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="rmodal-body">
          {step === 1 && (
            <>
              <p className="muted" style={{fontSize: 13, marginTop: 0}}>
                <strong style={{color: 'var(--ink)'}}>PDF plan set</strong> adds new sheets to your page strip. <strong style={{color: 'var(--ink)'}}>CSV / Excel exports</strong> from another measurements tool tool bring quantities straight into scope items.
              </p>
              <div className="t2-imp-grid">
                {Object.entries(sources).map(([k, v]) => (
                  <button key={k} className="t2-imp-src" data-active={source === k} onClick={() => { setSource(k); }}>
                    <strong>{v.label}</strong>
                    <span className="muted" style={{fontSize: 11}}>{v.tag}</span>
                  </button>
                ))}
              </div>
              <div className="t2-drop" data-pdf={isPdf}>
                <div className="t2-drop-icon">{isPdf ? '📄' : '↓'}</div>
                <strong>Drop {sources[source].label} here</strong>
                <span className="muted" style={{fontSize: 12}}>
                  or click to browse · {sources[source].accept.toUpperCase().replace(/\./g, '')} up to {sources[source].maxSize}
                </span>
                {isPdf && (
                  <span className="muted" style={{fontSize: 11.5, marginTop: 4}}>
                    Multi-page sets supported · sheet numbers and titles auto-detected from the title block
                  </span>
                )}
              </div>
              {!isPdf && (
                <details className="t2-sample">
                  <summary>See expected format</summary>
                  <pre>{sources[source].sample}</pre>
                </details>
              )}
            </>
          )}

          {step === 2 && !isPdf && (
            <>
              <p className="muted" style={{fontSize: 13, marginTop: 0}}>Auto-detected columns from your <strong>{sources[source].label}</strong>. Adjust if needed.</p>
              <table className="t2-map">
                <thead><tr><th>Source column</th><th>Sitelayer field</th><th>Sample</th></tr></thead>
                <tbody>
                  <tr><td className="mono">Subject / Item</td><td><select defaultValue="code"><option value="code">Scope code</option><option>Notes</option></select></td><td className="mono muted">EPS</td></tr>
                  <tr><td className="mono">Comments / Description</td><td><select defaultValue="notes"><option>Scope code</option><option value="notes">Notes</option></select></td><td className="mono muted">East elevation</td></tr>
                  <tr><td className="mono">Area / Length / Quantity</td><td><select defaultValue="qty"><option value="qty">Quantity</option></select></td><td className="mono muted">1284.5</td></tr>
                  <tr><td className="mono">Unit / UoM</td><td><select defaultValue="unit"><option value="unit">Unit</option></select></td><td className="mono muted">sqft</td></tr>
                </tbody>
              </table>
              <div className="t2-map-tip">
                <strong>5 rows detected.</strong> 5 will map to existing scope items, 0 will be flagged for review.
              </div>
            </>
          )}

          {step === 2 && isPdf && (
            <>
              <p className="muted" style={{fontSize: 13, marginTop: 0}}>
                Detected <strong style={{color: 'var(--ink)'}}>7 pages</strong> in <span className="mono">Hillcrest_Phase4_RevB.pdf</span> (4.2 MB). Sheet numbers + scale auto-extracted from the title block. Toggle which pages to import.
              </p>
              <div className="t2-pdf-list">
                {pdfPages.map(p => (
                  <label key={p.idx} className="t2-pdf-row" data-include={p.include} data-skippable={p.kind === 'cover' || p.kind === 'spec'}>
                    <input type="checkbox" checked={p.include} onChange={e => setPdfPages(ps => ps.map(x => x.idx === p.idx ? {...x, include: e.target.checked} : x))}/>
                    <div className="t2-pdf-thumb" data-kind={p.kind}>
                      <span className="t2-pdf-thumb-num">{p.idx}</span>
                    </div>
                    <div className="t2-pdf-meta">
                      <div className="t2-pdf-line1">
                        <strong>{p.sheet}</strong>
                        <span className="t2-pdf-title">{p.title}</span>
                      </div>
                      <div className="t2-pdf-line2">
                        <span className="pill" data-tone={p.kind === 'cover' || p.kind === 'spec' ? 'amber' : 'teal'} style={{fontSize: 10}}>{p.kind}</span>
                        {p.scaleDetected
                          ? <span className="num muted" style={{fontSize: 11.5}}>scale {p.scaleDetected}</span>
                          : <span className="num" style={{fontSize: 11.5, color: 'var(--accent-ink, var(--accent))'}}>no scale · needs calibration</span>}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="t2-map-tip">
                <strong>{includedPages.length} of {pdfPages.length} pages will be imported.</strong> Pages with detected scale skip calibration. Cover sheet and spec pages excluded by default.
              </div>
            </>
          )}

          {step === 3 && !isPdf && (
            <>
              <p className="muted" style={{fontSize: 13, marginTop: 0}}>Review imported measurements before adding them to <strong>A2.1 — Exterior Elev. North</strong>.</p>
              <table className="t2-map">
                <thead><tr><th>Scope</th><th>Notes</th><th style={{textAlign:'right'}}>Qty</th><th>Unit</th><th>Rate</th><th style={{textAlign:'right'}}>Amount</th></tr></thead>
                <tbody>
                  {parsed.map((r, i) => {
                    const it = data.scopeItems.find(s => s.code === r.code);
                    return (
                      <tr key={i}>
                        <td><span className="row" style={{gap:6}}><span className="measure-dot" style={{background: it?.color}}/>{r.code}</span></td>
                        <td>{r.notes}</td>
                        <td className="num right">{F2.fmtN(r.qty, 1)}</td>
                        <td className="muted">{r.unit}</td>
                        <td className="num">${it?.rate}</td>
                        <td className="num right">{F2.fmt$(r.qty * (it?.rate || 0))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {step === 3 && isPdf && (
            <>
              <p className="muted" style={{fontSize: 13, marginTop: 0}}>
                These {includedPages.length} pages will be added to the page strip. {includedPages.filter(p => !p.scaleDetected).length > 0 ? `${includedPages.filter(p => !p.scaleDetected).length} need calibration before measuring.` : 'All pages calibrated and ready to measure.'}
              </p>
              <table className="t2-map">
                <thead><tr><th>Sheet</th><th>Title</th><th>Type</th><th>Scale</th><th style={{textAlign:'right'}}>Status</th></tr></thead>
                <tbody>
                  {includedPages.map(p => (
                    <tr key={p.idx}>
                      <td className="mono"><strong>{p.sheet}</strong></td>
                      <td>{p.title}</td>
                      <td className="muted">{p.kind}</td>
                      <td className="num muted">{p.scaleDetected || '—'}</td>
                      <td style={{textAlign: 'right'}}>
                        {p.scaleDetected
                          ? <span className="pill" data-tone="green" style={{fontSize: 10}}><span className="dot"/>ready</span>
                          : <span className="pill" data-tone="amber" style={{fontSize: 10}}><span className="dot"/>calibrate</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <div className="rmodal-foot">
          <span className="muted" style={{fontSize: 12}}>Step {step} of 3</span>
          <div className="row" style={{gap: 8}}>
            {step > 1 && <button className="btn" onClick={() => setStep(s => s - 1)}>Back</button>}
            {step < 3 && <button className="btn" data-variant="primary" onClick={() => setStep(s => s + 1)}>Next →</button>}
            {step === 3 && !isPdf && <button className="btn" data-variant="primary" onClick={() => onImport(parsed)}>Import {parsed.length} measurements</button>}
            {step === 3 && isPdf && <button className="btn" data-variant="primary" onClick={() => onImportPages(includedPages)}>Import {includedPages.length} pages</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- QBO PUSH MODAL ---
function QBOPushModal({ data, project, totals, grandTotal, onClose }) {
  const [pushed, setPushed] = uS2(false);
  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal" style={{maxWidth: 760}} onClick={e => e.stopPropagation()}>
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">Push to QuickBooks Online</p>
            <h2>{pushed ? 'Pushed — sqft preserved' : 'Review before push'}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="rmodal-body">
          {!pushed && (
            <>
              <div className="t2-qbo-hero">
                <div className="t2-qbo-side">
                  <p className="eyebrow" style={{margin: 0}}>Sitelayer</p>
                  <strong>{project.name}</strong>
                  <span className="muted" style={{fontSize: 12}}>{totals.length} scope items · {F2.fmt$(grandTotal)}</span>
                </div>
                <div className="t2-qbo-arrow">→</div>
                <div className="t2-qbo-side">
                  <p className="eyebrow" style={{margin: 0}}>QuickBooks Online</p>
                  <strong>Estimate · draft</strong>
                  <span className="muted" style={{fontSize: 12}}>{project.client} · custom fields enabled</span>
                </div>
              </div>

              <div className="t2-qbo-callout">
                <strong>sqft is preserved as a structured custom field.</strong>
                <p className="muted" style={{margin: '4px 0 0', fontSize: 12.5}}>Most measurements tools push to Excel, then sqft becomes a description string in QBO. Cost-per-sqft analysis dies. Sitelayer writes <span className="mono">sqft_total</span>, <span className="mono">unit</span>, and <span className="mono">unit_rate</span> as numeric custom fields on each line — so reporting works downstream.</p>
              </div>

              <table className="t2-map" style={{marginTop: 14}}>
                <thead><tr><th>Line item</th><th style={{textAlign: 'right'}}>Amount</th><th style={{textAlign: 'right'}}>sqft / lf</th><th>Rate</th><th style={{textAlign: 'right'}}>QBO custom fields</th></tr></thead>
                <tbody>
                  {totals.map(t => (
                    <tr key={t.code}>
                      <td>
                        <span className="row" style={{gap: 6}}><span className="measure-dot" style={{background: t.color}}/>{t.code} · {t.name}</span>
                      </td>
                      <td className="num right">{F2.fmt$(t.amount)}</td>
                      <td className="num right">{F2.fmtN(t.qty, 0)}</td>
                      <td className="num">${t.rate}/{t.unit}</td>
                      <td className="mono right" style={{fontSize: 11, color: 'var(--ink-2)'}}>
                        sqft_total: <span className="num">{F2.fmtN(t.qty, 0)}</span>
                      </td>
                    </tr>
                  ))}
                  <tr style={{borderTop: '2px solid var(--line)', fontWeight: 600}}>
                    <td>Total</td>
                    <td className="num right">{F2.fmt$(grandTotal)}</td>
                    <td colSpan="3"></td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
          {pushed && (
            <div className="t2-qbo-done">
              <div className="t2-qbo-done-icon">✓</div>
              <h3 style={{margin: '14px 0 6px'}}>Estimate created in QBO</h3>
              <p className="muted">{totals.length} line items · {F2.fmt$(grandTotal)} · sqft preserved on each line</p>
              <div className="t2-qbo-done-meta">
                <div><span className="muted">QBO ref</span><strong className="mono">EST-04822</strong></div>
                <div><span className="muted">Customer</span><strong>{project.client}</strong></div>
                <div><span className="muted">Custom fields</span><strong>sqft_total, unit, unit_rate</strong></div>
              </div>
            </div>
          )}
        </div>
        <div className="rmodal-foot">
          <span className="muted" style={{fontSize: 12}}>{pushed ? 'Cost-per-sqft now reportable in QBO' : 'Last push: 4 days ago'}</span>
          <div className="row" style={{gap: 8}}>
            {!pushed && <button className="btn" onClick={onClose}>Cancel</button>}
            {!pushed && <button className="btn" data-variant="primary" onClick={() => setPushed(true)}>Push estimate to QBO</button>}
            {pushed && <button className="btn" data-variant="primary" onClick={onClose}>Done</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- ASSEMBLY MODAL ---
function AssemblyModal({ scope, data, onClose }) {
  const it = data.scopeItems.find(s => s.code === scope);
  const a = buildAssembly(scope);
  const matSubtotal = a.materials.reduce((s, [, qty, price]) => s + qty * price, 0);
  const matWithWaste = matSubtotal * (1 + a.waste);
  const laborCost = a.labor.hrs * a.labor.rate;
  const total = matWithWaste + laborCost;
  return (
    <div className="rmodal-backdrop" onClick={onClose}>
      <div className="rmodal" style={{maxWidth: 600}} onClick={e => e.stopPropagation()}>
        <div className="rmodal-h">
          <div>
            <p className="eyebrow">Assembly</p>
            <h2><span className="measure-dot" style={{background: it.color, marginRight: 8, verticalAlign: 'middle'}}/>{it.code} · {it.name}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div className="rmodal-body">
          <p className="muted" style={{fontSize: 13, marginTop: 0}}>The flat <span className="num">${it.rate}/{it.unit}</span> rate breaks down into materials, waste, and labor. Adjust components to recompute.</p>
          <table className="t2-map">
            <thead><tr><th colSpan="2">Material</th><th style={{textAlign: 'right'}}>Qty/{it.unit}</th><th style={{textAlign: 'right'}}>$/unit</th><th style={{textAlign: 'right'}}>Cost</th></tr></thead>
            <tbody>
              {a.materials.map(([name, qty, price, u]) => (
                <tr key={name}>
                  <td colSpan="2">{name}</td>
                  <td className="num right">{qty}</td>
                  <td className="num right">${price.toFixed(2)} /{u}</td>
                  <td className="num right">${(qty * price).toFixed(2)}</td>
                </tr>
              ))}
              <tr><td colSpan="4" className="muted">Material subtotal</td><td className="num right">${matSubtotal.toFixed(2)}</td></tr>
              <tr><td colSpan="4" className="muted">Waste ({(a.waste * 100).toFixed(0)}%)</td><td className="num right">+${(matSubtotal * a.waste).toFixed(2)}</td></tr>
              <tr><td colSpan="2">Labor</td><td className="num right">{a.labor.hrs} hr</td><td className="num right">${a.labor.rate}/hr</td><td className="num right">${laborCost.toFixed(2)}</td></tr>
              <tr style={{borderTop: '2px solid var(--line)', fontWeight: 600}}>
                <td colSpan="4">Per-{it.unit} cost</td>
                <td className="num right">${total.toFixed(2)}</td>
              </tr>
              <tr style={{color: 'var(--green)'}}>
                <td colSpan="4">Sell price</td>
                <td className="num right">${it.rate.toFixed(2)}</td>
              </tr>
              <tr style={{color: 'var(--green)', fontWeight: 600}}>
                <td colSpan="4">Margin</td>
                <td className="num right">${(it.rate - total).toFixed(2)} ({Math.round((it.rate - total) / it.rate * 100)}%)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="rmodal-foot">
          <span className="muted" style={{fontSize: 12}}>Used by every {it.code} measurement</span>
          <button className="btn" data-variant="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// --- BLUEPRINT placeholder, varies per page ---
function BlueprintBg({ pageId }) {
  const variant = pageId === 'A2.1' ? 'north' : pageId === 'A2.2' ? 'east' : pageId === 'A2.3' ? 'south' : pageId === 'A2.4' ? 'west' : pageId === 'A3.1' ? 'section' : 'detail';
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position: 'absolute', inset: 0, width: '100%', height: '100%'}}>
      <defs>
        <pattern id="t2grid" width="2" height="2" patternUnits="userSpaceOnUse">
          <path d="M 2 0 L 0 0 0 2" fill="none" stroke="oklch(0.92 0.01 75)" strokeWidth="0.05"/>
        </pattern>
      </defs>
      <rect width="100" height="100" fill="oklch(0.985 0.008 75)"/>
      <rect width="100" height="100" fill="url(#t2grid)"/>
      <g stroke="oklch(0.40 0.04 235)" strokeWidth="0.35" fill="none">
        {variant === 'north' && <>
          <rect x="10" y="10" width="80" height="80"/>
          <rect x="14" y="14" width="72" height="72" strokeWidth="0.18"/>
          <line x1="14" y1="44" x2="86" y2="44"/>
          <line x1="50" y1="14" x2="50" y2="86"/>
          {[20,30,38,58,66,76].map(x => <rect key={x} x={x} y="13.5" width="6" height="1" fill="white"/>)}
          {[20,30,38,58,66,76].map(x => <rect key={x+'b'} x={x} y="62" width="6" height="1" fill="white"/>)}
          <rect x="46" y="86" width="8" height="0.8" fill="white" stroke="oklch(0.40 0.04 235)" strokeWidth="0.2"/>
          <text x="50" y="6" fontFamily="Geist Mono" fontSize="1.4" fill="oklch(0.40 0.04 235)" textAnchor="middle">80'-0"</text>
          <text x="50" y="98" fontFamily="Geist Mono" fontSize="1.4" fill="oklch(0.40 0.04 235)" textAnchor="middle">A2.1 — North Elevation</text>
        </>}
        {variant === 'east' && <>
          <path d="M 12 24 L 50 12 L 88 24 L 88 86 L 12 86 Z"/>
          <line x1="12" y1="42" x2="88" y2="42"/>
          <line x1="12" y1="64" x2="88" y2="64"/>
          {[22, 38, 60, 76].map(x => <rect key={x} x={x} y="46" width="6" height="14" fill="white"/>)}
          <text x="50" y="98" fontFamily="Geist Mono" fontSize="1.4" fill="oklch(0.40 0.04 235)" textAnchor="middle">A2.2 — East Elevation</text>
        </>}
        {variant === 'south' && <>
          <rect x="10" y="14" width="80" height="74"/>
          <line x1="10" y1="38" x2="90" y2="38"/>
          <line x1="10" y1="62" x2="90" y2="62"/>
          {[18, 28, 40, 60, 72, 82].map(x => <rect key={x} x={x} y="42" width="6" height="14" fill="white"/>)}
          <text x="50" y="98" fontFamily="Geist Mono" fontSize="1.4" fill="oklch(0.40 0.04 235)" textAnchor="middle">A2.3 — South Elevation</text>
        </>}
        {variant === 'west' && <>
          <path d="M 12 28 L 50 14 L 88 28 L 88 86 L 12 86 Z"/>
          <line x1="12" y1="46" x2="88" y2="46"/>
          {[22, 40, 56, 72].map(x => <rect key={x} x={x} y="52" width="8" height="16" fill="white"/>)}
          <text x="50" y="98" fontFamily="Geist Mono" fontSize="1.4" fill="oklch(0.40 0.04 235)" textAnchor="middle">A2.4 — West Elevation</text>
        </>}
        {variant === 'section' && <>
          <rect x="20" y="14" width="60" height="74"/>
          {[20, 36, 52, 68].map(y => <line key={y} x1="20" y1={y} x2="80" y2={y} strokeWidth="0.25"/>)}
          <line x1="50" y1="14" x2="50" y2="88" strokeDasharray="0.8 0.8"/>
          <text x="50" y="98" fontFamily="Geist Mono" fontSize="1.4" fill="oklch(0.40 0.04 235)" textAnchor="middle">A3.1 — Wall Section</text>
        </>}
        {variant === 'detail' && <>
          <circle cx="50" cy="46" r="22"/>
          <circle cx="50" cy="46" r="14" strokeWidth="0.18"/>
          <line x1="22" y1="46" x2="78" y2="46" strokeWidth="0.2"/>
          <text x="50" y="98" fontFamily="Geist Mono" fontSize="1.4" fill="oklch(0.40 0.04 235)" textAnchor="middle">A4.1 — Detail D1</text>
        </>}
      </g>
    </svg>
  );
}
function MiniBlueprint({ pageId }) {
  return <div style={{width: '100%', height: '100%', background: 'oklch(0.985 0.008 75)', position: 'relative', overflow: 'hidden'}}><BlueprintBg pageId={pageId}/></div>;
}

function SuggestedRentals({ projectId, data }) {
  const suggestions = data.rentalSuggestions?.[projectId];
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div className="suggest-card">
      <div className="suggest-card-h">
        <div>
          <p className="eyebrow" style={{margin: 0}}>From these measurements</p>
          <strong style={{fontSize: 13}}>Suggested rentals</strong>
        </div>
        <span className="pill" data-tone="amber" style={{fontSize: 10}}><span className="dot"/>{suggestions.length}</span>
      </div>
      <div>
        {suggestions.map(s => {
          const c = data.catalog.find(c => c.sku === s.sku);
          const need = Math.max(0, s.qty - s.already);
          return (
            <div key={s.sku} className="suggest-row">
              <div className="suggest-row-name">
                <strong>{c?.name || s.sku}</strong>
                <span>{s.reason}</span>
              </div>
              <div style={{textAlign: 'right'}}>
                <div className="num" style={{fontSize: 12.5, fontWeight: 600}}>
                  {s.already > 0 ? <span style={{color: 'var(--ink-3)'}}>{s.already}/</span> : null}{s.qty}
                </div>
                {need > 0 && <button className="btn small" data-variant="primary" style={{marginTop: 3, padding: '2px 8px', fontSize: 11}}>Dispatch +{need}</button>}
                {need === 0 && <span className="pill" data-tone="green" style={{fontSize: 10}}><span className="dot"/>Met</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.SLTakeoff = TakeoffView;
