/* global React, MI, MTopBar, MRow, MBottomTabs, MSpark */

// ============================================================
// CREW & HOURS — project-scoped time approval / labor surface
// Lives inside Project Detail as a sub-tab. Owner approves;
// foreman performs CRUD; same screen, different action set.
// ============================================================

const CR_LINE = 'var(--m-line)';
const CR_SOFT = 'var(--m-card-soft)';
const CR_INK  = 'var(--m-ink)';
const CR_INK2 = 'var(--m-ink-2)';
const CR_INK3 = 'var(--m-ink-3)';
const CR_INK4 = 'var(--m-ink-4)';
const CR_ACC  = 'var(--m-accent)';
const CR_ACCI = 'var(--m-accent-ink)';

// ---------- shared ----------

function CrewSubtabs({ active = 'crew' }) {
  const tabs = [
    { id: 'overview', l: 'Overview' },
    { id: 'estimate', l: 'Estimate' },
    { id: 'crew',     l: 'Crew', badge: 3 },
    { id: 'schedule', l: 'Schedule' },
  ];
  return (
    <div style={{
      display:'flex', borderBottom:`1px solid ${CR_LINE}`, background:'#fff',
      padding:'0 8px', overflowX:'auto', position:'sticky', top:0, zIndex:5,
    }}>
      {tabs.map(t => {
        const on = t.id === active;
        return (
          <button key={t.id} style={{
            flex:'0 0 auto', padding:'12px 12px 11px',
            background:'transparent', border:'none', fontFamily:'inherit',
            fontSize:13, fontWeight: on ? 600 : 500,
            color: on ? CR_INK : CR_INK3,
            borderBottom: on ? `2px solid ${CR_ACC}` : '2px solid transparent',
            display:'flex', alignItems:'center', gap:6, whiteSpace:'nowrap',
          }}>
            {t.l}
            {t.badge != null && (
              <span style={{
                fontSize:10, fontWeight:700,
                padding:'1px 6px', borderRadius:8,
                background: on ? CR_ACC : CR_SOFT,
                color: on ? '#fff' : CR_INK2,
                fontFeatureSettings:'"tnum"',
              }}>{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function CrewProjectHeader({ name = 'Hillcrest Mews — Phase 4', sub = 'Day 8 of 32 · 5 crew on site' }) {
  return (
    <div style={{padding:'12px 16px 12px', background:'#fff', borderBottom:`1px solid ${CR_LINE}`}}>
      <div style={{fontSize:11, fontWeight:700, color:CR_INK3, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4}}>Project</div>
      <div style={{fontSize:16, fontWeight:600, letterSpacing:'-0.01em'}}>{name}</div>
      <div style={{fontSize:11.5, color:CR_INK3, marginTop:2}}>{sub}</div>
    </div>
  );
}

function CrewSectionH({ label, right }) {
  return (
    <div style={{padding:'14px 16px 8px', display:'flex', alignItems:'baseline', justifyContent:'space-between'}}>
      <div style={{fontSize:11, fontWeight:700, color:CR_INK3, textTransform:'uppercase', letterSpacing:'.06em'}}>{label}</div>
      {right && <div style={{fontSize:11.5, color:CR_ACCI, fontWeight:600}}>{right}</div>}
    </div>
  );
}

function CrewMemberRow({ name, initials, tone, role, hours, weekHrs, status, flag, lastSeen, action, mode }) {
  // status: 'clocked-in' | 'clocked-out' | 'pending' | 'flag' | 'clean'
  const statusMap = {
    'clocked-in':  { dot:'#2c8a55', label:'Clocked in',  color:'#2c8a55' },
    'clocked-out': { dot:CR_INK4,   label:'Clocked out', color:CR_INK3 },
    'pending':     { dot:CR_ACC,    label:'Pending',     color:CR_ACCI },
    'flag':        { dot:'#c0463d', label:'Needs review',color:'#c0463d' },
    'clean':       { dot:'#2c8a55', label:'Approved',    color:'#2c8a55' },
  };
  const s = statusMap[status] || statusMap.pending;
  return (
    <div style={{
      padding:'12px 14px', background:'#fff',
      border:`1px solid ${CR_LINE}`, borderRadius:11,
      borderLeft: status === 'flag' ? '3px solid #c0463d' : status === 'pending' ? `3px solid ${CR_ACC}` : `1px solid ${CR_LINE}`,
    }}>
      <div style={{display:'flex', alignItems:'center', gap:11}}>
        <div className="m-avatar" data-tone={tone}>{initials}</div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:14, fontWeight:600}}>{name}</div>
          <div style={{fontSize:11, color:CR_INK3, marginTop:1, display:'flex', alignItems:'center', gap:6}}>
            <span style={{width:6, height:6, borderRadius:3, background:s.dot, flexShrink:0}}/>
            <span style={{color:s.color, fontWeight:500}}>{s.label}</span>
            <span style={{color:CR_INK4}}>·</span>
            <span>{role}</span>
          </div>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:18, fontWeight:700, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em'}}>
            {hours}<span style={{fontSize:11, color:CR_INK3, fontWeight:500}}>h</span>
          </div>
          <div style={{fontSize:10, color:CR_INK3, fontFeatureSettings:'"tnum"', marginTop:1}}>{weekHrs} this wk</div>
        </div>
      </div>
      {flag && (
        <div style={{
          marginTop:10, padding:'8px 10px', background:'#fdf6ec',
          border:'1px solid rgba(217,144,74,0.2)', borderRadius:7,
          fontSize:11, color:CR_INK2, lineHeight:1.4,
          display:'flex', alignItems:'flex-start', gap:7,
        }}>
          <span style={{color:'#c0463d', flexShrink:0, marginTop:1}}>{MI.alert}</span>
          <span><strong>{flag.title}</strong>{flag.body && <span> — {flag.body}</span>}</span>
        </div>
      )}
      {action && (
        <div style={{
          display:'flex', gap:6, marginTop:10, paddingTop:10,
          borderTop:`1px solid ${CR_LINE}`,
        }}>
          {action}
        </div>
      )}
      {lastSeen && (
        <div style={{fontSize:10, color:CR_INK4, marginTop:8, fontFeatureSettings:'"tnum"'}}>
          Last entry · {lastSeen}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 1 · OWNER VIEW — Crew & hours tab inside a project
// Approval-first surface. Pending banner at top, flagged entries,
// then clean entries collapsed, then weekly roll-up + labor cost link.
// ============================================================
function ProjectCrewOwner() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Project" sub="Hillcrest Mews"/>
      <CrewSubtabs active="crew"/>

      <div className="m-body" style={{padding:'0 0 14px'}}>
        <CrewProjectHeader/>

        {/* Bulk-approve banner — primary action front and center */}
        <div style={{margin:'14px 16px 0', padding:'12px 14px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:11, display:'flex', alignItems:'center', gap:11}}>
          <span style={{
            width:34, height:34, borderRadius:8,
            background:'rgba(44,138,85,0.12)', color:'#2c8a55',
            display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0,
          }}>{MI.bolt}</span>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:13, fontWeight:600}}>2 entries are clean</div>
            <div style={{fontSize:11, color:CR_INK3, marginTop:1}}>GPS matches · within plan · no OT</div>
          </div>
          <button className="m-btn m-btn-sm" data-variant="primary">Approve 2</button>
        </div>

        {/* Pending — needs review */}
        <CrewSectionH label="Needs review (1)"/>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          <CrewMemberRow
            name="Tomás Reyes" initials="TR" tone="5" role="Crew"
            hours="9.4" weekHrs="38h" status="flag"
            flag={{ title:'Long lunch (1:42)', body:'42 min over standard. GPS shows on-site.' }}
            action={<>
              <button className="m-btn m-btn-sm" data-variant="primary" style={{flex:1}}>Approve</button>
              <button className="m-btn m-btn-sm" data-variant="ghost">{MI.more}</button>
            </>}
          />
        </div>

        {/* Currently on site */}
        <CrewSectionH label="On site now (2)"/>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          <CrewMemberRow
            name="Diego Fontana" initials="DF" tone="3" role="Crew"
            hours="3.2" weekHrs="22h" status="clocked-in"
            lastSeen="In · 7:00 AM · GPS on site"
          />
          <CrewMemberRow
            name="Priya Shah" initials="PS" tone="4" role="Crew"
            hours="3.2" weekHrs="24h" status="clocked-in"
            lastSeen="In · 7:00 AM · GPS on site"
          />
        </div>

        {/* Roll-up + labor cost link */}
        <CrewSectionH label="This week"/>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          <button style={{padding:'12px 14px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:11, display:'flex', alignItems:'center', gap:11, fontFamily:'inherit', textAlign:'left'}}>
            <span style={{width:30, height:30, borderRadius:8, background:CR_SOFT, color:CR_INK2, display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>{MI.layers}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:13, fontWeight:600}}>Labor cost — $54.20/hr loaded</div>
              <div style={{fontSize:11, color:CR_INK3, marginTop:1}}>Base $38 + $16.20 loaded add-ons</div>
            </div>
            <span style={{color:CR_INK4}}>{MI.chev}</span>
          </button>
          <button style={{padding:'12px 14px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:11, display:'flex', alignItems:'center', gap:11, fontFamily:'inherit', textAlign:'left'}}>
            <span style={{width:30, height:30, borderRadius:8, background:CR_SOFT, color:CR_INK2, display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>{MI.spark}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:13, fontWeight:600}}>Live vs budget — 1.18× pace</div>
              <div style={{fontSize:11, color:'#2c8a55', marginTop:1}}>+24h ahead of plan</div>
            </div>
            <span style={{color:CR_INK4}}>{MI.chev}</span>
          </button>
        </div>

      </div>
    </div>
  );
}

// ============================================================
// 2 · CROSS-PROJECT QUEUE — reachable from side-nav "Time"
// Same approval surface, no project filter; project shown
// per row. Owner Friday-afternoon view.
// ============================================================
function TimeQueueAllProjects() {
  return (
    <div className="m">
      <div style={{padding:'14px 20px 8px'}}>
        <div style={{fontSize:30, fontWeight:700, letterSpacing:'-0.02em'}}>Time</div>
        <div style={{fontSize:13, color:CR_INK3, marginTop:4}}>12 entries waiting · 2 flagged across 3 projects</div>
      </div>

      {/* project filter chips */}
      <div style={{display:'flex', gap:6, padding:'10px 16px', overflowX:'auto', borderBottom:`1px solid ${CR_LINE}`}}>
        {[
          {l:'All projects', n:12, on:true},
          {l:'Hillcrest', n:5, c:'#E8A86B'},
          {l:'Aspen Ridge', n:6, c:'#A05A33'},
          {l:'Greenwillow', n:1, c:'#7A8C6F'},
        ].map(c => (
          <button key={c.l} style={{
            flex:'0 0 auto', padding:'6px 11px', borderRadius:18,
            background: c.on ? CR_INK : '#fff',
            color: c.on ? '#fff' : CR_INK2,
            border: c.on ? 'none' : `1px solid ${CR_LINE}`,
            fontFamily:'inherit', fontSize:12, fontWeight:500,
            display:'inline-flex', alignItems:'center', gap:6,
            whiteSpace:'nowrap',
          }}>
            {c.c && <span style={{width:6, height:6, borderRadius:3, background:c.c}}/>}
            {c.l}
            <span style={{fontSize:10, fontWeight:700, opacity:.8, fontFeatureSettings:'"tnum"'}}>{c.n}</span>
          </button>
        ))}
      </div>

      <div className="m-body" style={{padding:'12px 0'}}>
        {/* Bulk action banner */}
        <div style={{margin:'0 16px 12px', padding:'12px 14px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:12, display:'flex', alignItems:'center', gap:11}}>
          <span style={{width:34, height:34, background:'rgba(44,138,85,.12)', color:'#2c8a55', borderRadius:8, display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>{MI.bolt}</span>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:13, fontWeight:600}}>10 entries are clean across 3 projects</div>
            <div style={{fontSize:11, color:CR_INK3, marginTop:1}}>Approve them in one tap</div>
          </div>
          <button className="m-btn m-btn-sm" data-variant="primary">Approve 10</button>
        </div>

        {/* Flagged entries — grouped by project */}
        <CrewSectionH label="Needs review · Hillcrest (1)"/>
        <div style={{padding:'0 16px', display:'grid', gap:8, marginBottom:6}}>
          <CrewMemberRow
            name="Tomás Reyes" initials="TR" tone="5" role="Crew"
            hours="9.4" weekHrs="38h" status="flag"
            flag={{ title:'Long lunch (1:42)', body:'42 min over standard.' }}
            action={<>
              <button className="m-btn m-btn-sm" data-variant="primary" style={{flex:1}}>Approve</button>
              <button className="m-btn m-btn-sm" data-variant="ghost">{MI.more}</button>
            </>}
          />
        </div>

        <CrewSectionH label="Needs review · Aspen Ridge (1)"/>
        <div style={{padding:'0 16px', display:'grid', gap:8, marginBottom:6}}>
          <CrewMemberRow
            name="Hank Mueller" initials="HM" tone="6" role="Crew"
            hours="10.8" weekHrs="46h" status="flag"
            flag={{ title:'OT not approved', body:'2.8h overtime — no PM approval on file.' }}
            action={<>
              <button className="m-btn m-btn-sm" data-variant="primary" style={{flex:1}}>Approve</button>
              <button className="m-btn m-btn-sm" data-variant="ghost">{MI.more}</button>
            </>}
          />
        </div>

        {/* Clean entries — collapsed list */}
        <CrewSectionH label="Clean (10)" right="Expand"/>
        <div style={{padding:'0 16px', display:'grid', gap:6}}>
          {[
            {n:'Ana Castillo', i:'AC', t:'1', p:'Hillcrest',  pc:'#E8A86B', h:'8.4'},
            {n:'Marcus Lee',   i:'ML', t:'2', p:'Hillcrest',  pc:'#E8A86B', h:'8.4'},
            {n:'Diego Fontana',i:'DF', t:'3', p:'Aspen Ridge',pc:'#A05A33', h:'8.5'},
            {n:'Priya Shah',   i:'PS', t:'4', p:'Aspen Ridge',pc:'#A05A33', h:'8.5'},
            {n:'Sara Bouchard',i:'SB', t:'7', p:'Aspen Ridge',pc:'#A05A33', h:'8.0'},
            {n:'Jordan Olin',  i:'JO', t:'8', p:'Greenwillow',pc:'#7A8C6F', h:'5.0'},
          ].map(r => (
            <div key={r.n} style={{padding:'10px 12px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:10, display:'flex', alignItems:'center', gap:10}}>
              <div className="m-avatar" data-size="sm" data-tone={r.t}>{r.i}</div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:13, fontWeight:600}}>{r.n}</div>
                <div style={{fontSize:11, color:CR_INK3, marginTop:1, display:'flex', alignItems:'center', gap:5}}>
                  <span style={{width:6, height:6, borderRadius:3, background:r.pc}}/>
                  {r.p} · Apr 25
                </div>
              </div>
              <div style={{fontSize:14, fontWeight:600, fontFeatureSettings:'"tnum"'}}>{r.h}h</div>
            </div>
          ))}
        </div>

        {/* Portfolio insights — drill-downs to detail screens */}
        <CrewSectionH label="Insights · all projects"/>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          <button style={{padding:'12px 14px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:11, display:'flex', alignItems:'center', gap:11, fontFamily:'inherit', textAlign:'left', cursor:'pointer'}}>
            <span style={{width:34, height:34, borderRadius:8, background:CR_SOFT, color:CR_INK2, display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>{MI.layers}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:9.5, color:CR_INK3, fontWeight:700, textTransform:'uppercase', letterSpacing:'.05em'}}>Portfolio labor cost</div>
              <div style={{fontSize:15, fontWeight:700, fontFeatureSettings:'"tnum"', marginTop:1, letterSpacing:'-0.01em'}}>$54.20<span style={{fontSize:11, color:CR_INK3, fontWeight:500}}>/hr loaded</span></div>
              <div style={{fontSize:11, color:CR_INK3, marginTop:1}}>Avg across 3 active projects</div>
            </div>
            <span style={{color:CR_INK4}}>{MI.chev}</span>
          </button>
          <button style={{padding:'12px 14px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:11, display:'flex', alignItems:'center', gap:11, fontFamily:'inherit', textAlign:'left', cursor:'pointer'}}>
            <span style={{width:34, height:34, borderRadius:8, background:CR_SOFT, color:CR_INK2, display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>{MI.spark}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:9.5, color:CR_INK3, fontWeight:700, textTransform:'uppercase', letterSpacing:'.05em'}}>Live vs budget</div>
              <div style={{fontSize:15, fontWeight:700, fontFeatureSettings:'"tnum"', marginTop:1, letterSpacing:'-0.01em'}}>1.12×<span style={{fontSize:11, color:'#2c8a55', fontWeight:500, marginLeft:6}}>pace</span></div>
              <div style={{fontSize:11, color:CR_INK3, marginTop:1}}>3 of 3 projects on or ahead</div>
            </div>
            <span style={{color:CR_INK4}}>{MI.chev}</span>
          </button>
        </div>

        <div style={{height:14}}/>
      </div>
      <MBottomTabs active="more"/>
    </div>
  );
}

// ============================================================
// 3 · FOREMAN VIEW — Crew tab from a foreman's lens
// Same screen anatomy, but action set differs: foreman can
// add hours, edit anyone's, and submit for owner approval.
// ============================================================
function ProjectCrewForeman() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Project" sub="Hillcrest Mews · foreman" action="more" actionIcon={MI.more}/>
      <CrewSubtabs active="crew"/>

      <div className="m-body" style={{padding:'0 0 14px'}}>
        <CrewProjectHeader sub="Mon, Apr 28 · you're foreman of record"/>

        {/* Day total card — foreman's primary read */}
        <div style={{margin:'12px 16px 0', padding:'14px 16px', background:CR_INK, color:'#f3ecdf', borderRadius:14}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
            <div>
              <div style={{fontSize:11, color:'#aea69a', fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em'}}>Today's crew</div>
              <div style={{fontSize:24, fontWeight:700, marginTop:4, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em'}}>32.3<span style={{fontSize:14, opacity:.7, fontWeight:500}}>h</span></div>
            </div>
            <button className="m-btn m-btn-sm" style={{background:CR_ACC, color:'#fff', border:'none', fontWeight:600}}>Submit for approval</button>
          </div>
          <div style={{fontSize:11.5, color:'#aea69a', marginTop:8, paddingTop:10, borderTop:'1px solid #2a241c', display:'flex', justifyContent:'space-between'}}>
            <span>4 crew · 7:00–15:30 · 3.5h lunch breaks</span>
            <span style={{fontFeatureSettings:'"tnum"'}}>$1,750 loaded</span>
          </div>
        </div>

        {/* Crew rows — editable */}
        <CrewSectionH label="Crew (4)" right="+ Add crew"/>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          {[
            {n:'Ana Castillo',  i:'AC', t:'1', role:'Lead',   h:'8.4', s:'7:02', e:'15:24', l:'30m', ok:true,  weekHrs:'32h'},
            {n:'Marcus Lee',    i:'ML', t:'2', role:'Crew',   h:'8.4', s:'7:04', e:'15:26', l:'30m', ok:true,  weekHrs:'30h'},
            {n:'Tomás Reyes',   i:'TR', t:'5', role:'Crew',   h:'8.0', s:'7:08', e:'15:00', l:'45m', ok:false, weekHrs:'38h'},
            {n:'Sara Bouchard', i:'SB', t:'7', role:'Crew',   h:'7.5', s:'8:00', e:'15:30', l:'30m', ok:true,  weekHrs:'24h'},
          ].map(p => (
            <div key={p.n} style={{padding:'12px 14px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:11}}>
              <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:10}}>
                <div className="m-avatar" data-tone={p.t}>{p.i}</div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize:14, fontWeight:600}}>{p.n}</div>
                  <div style={{fontSize:11, color: p.ok ? '#2c8a55' : '#c98a2e', marginTop:1, display:'flex', alignItems:'center', gap:4}}>
                    <span>{p.ok ? '✓' : '⚠'}</span>
                    <span>{p.ok ? 'matches GPS' : 'differs from GPS · review'}</span>
                    <span style={{color:CR_INK4}}>·</span>
                    <span style={{color:CR_INK3}}>{p.role}</span>
                  </div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{fontSize:18, fontWeight:700, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em'}}>{p.h}<span style={{fontSize:11, color:CR_INK3, fontWeight:500}}>h</span></div>
                  <div style={{fontSize:10, color:CR_INK3, fontFeatureSettings:'"tnum"', marginTop:1}}>{p.weekHrs} wk</div>
                </div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr 36px', gap:6}}>
                <button style={{padding:'7px 4px', background:CR_SOFT, border:`1px solid ${CR_LINE}`, borderRadius:8, textAlign:'center', fontFamily:'inherit'}}>
                  <div style={{fontSize:9, color:CR_INK3, fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em'}}>In</div>
                  <div style={{fontSize:13, fontWeight:600, fontFeatureSettings:'"tnum"', marginTop:1}}>{p.s}</div>
                </button>
                <button style={{padding:'7px 4px', background:CR_SOFT, border:`1px solid ${CR_LINE}`, borderRadius:8, textAlign:'center', fontFamily:'inherit'}}>
                  <div style={{fontSize:9, color:CR_INK3, fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em'}}>Lunch</div>
                  <div style={{fontSize:13, fontWeight:600, fontFeatureSettings:'"tnum"', marginTop:1}}>{p.l}</div>
                </button>
                <button style={{padding:'7px 4px', background:CR_SOFT, border:`1px solid ${CR_LINE}`, borderRadius:8, textAlign:'center', fontFamily:'inherit'}}>
                  <div style={{fontSize:9, color:CR_INK3, fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em'}}>Out</div>
                  <div style={{fontSize:13, fontWeight:600, fontFeatureSettings:'"tnum"', marginTop:1}}>{p.e}</div>
                </button>
                <button style={{padding:'7px 4px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:8, color:'#c0463d', display:'inline-flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit'}}>
                  {React.cloneElement(MI.close, {width:14, height:14})}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Earlier this week — read-only summary */}
        <CrewSectionH label="Earlier this week" right="Open week →"/>
        <div style={{padding:'0 16px', display:'grid', gap:6}}>
          {[
            {d:'Sun, Apr 27', s:'Off', empty:true},
            {d:'Sat, Apr 26', s:'Off', empty:true},
            {d:'Fri, Apr 25', h:'33.7h', n:'4 crew · approved'},
            {d:'Thu, Apr 24', h:'34.0h', n:'4 crew · approved'},
            {d:'Wed, Apr 23', h:'25.5h', n:'3 crew · approved'},
          ].map((d, i) => (
            <div key={i} style={{padding:'10px 12px', background:'#fff', border:`1px solid ${CR_LINE}`, borderRadius:10, display:'flex', alignItems:'center', gap:10, opacity: d.empty ? .5 : 1}}>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:13, fontWeight:600}}>{d.d}</div>
                {d.n && <div style={{fontSize:11, color:CR_INK3, marginTop:1}}>{d.n}</div>}
              </div>
              <div style={{fontSize:14, fontWeight:600, fontFeatureSettings:'"tnum"', color: d.empty ? CR_INK4 : CR_INK}}>{d.h || d.s}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  ProjectCrewOwner,
  ProjectCrewForeman,
  TimeQueueAllProjects,
});
