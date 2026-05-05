/* global React, MI, MTopBar, MLargeHead, MSectionH, MRow, MKpi, MPill, MBottomTabs, MQA, MAvatarGroup, MBanner, MStage */

// ============================================================
// SECTION 12 — FOREMAN APP
// ============================================================

// ForemanTabs — single bottom-nav for every top-level foreman screen.
// Mounted on Today, Crew, Field, Log, Schedule, CrewMap so users can jump
// between sections from anywhere instead of dead-ending.
function ForemanTabs({ active = 'today', fieldBadge = 2 }) {
  const tabs = [
    {l:'Today', id:'today', i:MI.home},
    {l:'Crew',  id:'crew',  i:MI.users},
    {l:'Field', id:'field', i:MI.bell, badge: fieldBadge},
    {l:'Log',   id:'log',   i:MI.edit},
    {l:'Time',  id:'time',  i:MI.time},
  ];
  return (
    <div style={{display:'flex', height:64, background:'#fff', borderTop:'1px solid #e8e3db', flexShrink:0}}>
      {tabs.map(t => {
        const on = t.id === active;
        return (
          <div key={t.id} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3, color: on ? '#d9904a' : '#8a8278', position:'relative'}}>
            {t.i}
            {t.badge > 0 && <span style={{position:'absolute', top:8, right:'30%', minWidth:14, height:14, padding:'0 4px', background:'#c0463d', color:'#fff', borderRadius:7, fontSize:9, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center', fontFeatureSettings:'"tnum"'}}>{t.badge}</span>}
            <span style={{fontSize:10, fontWeight: on ? 600 : 500}}>{t.l}</span>
          </div>
        );
      })}
    </div>
  );
}

function ForemanToday() {
  const projects = [
    {
      id:'p1', name:'Hillcrest', sub:'Day 18 · Phase 4', tone:'#E8A86B', primary:true,
      crew:[{n:'Ana C.', i:'AC', t:1}, {n:'Marcus L.', i:'ML', t:2}, {n:'Tomás R.', i:'TR', t:5}],
      crewLabel:'3 of 3', live:true,
      cost:{spent:724, plan:796, dayBudget:2440, status:'under', delta:'9% under'},
      scope:'EPS · East elevation · 1,284 sf',
      brief:{ status:'pushed', by:'You', at:'6:42 AM', goal:'Anchor + plate east wall, top to bottom — leave the cornice for tomorrow.' },
      ping:null,
    },
    {
      id:'p2', name:'Aspen Ridge', sub:'Day 6 · Phase 1', tone:'#A05A33', primary:false,
      crew:[{n:'Sara V.', i:'SV', t:3}, {n:'Diego A.', i:'DA', t:4}],
      crewLabel:'2 of 2',
      cost:{spent:412, plan:480, dayBudget:1620, status:'under', delta:'14% under'},
      scope:'Mesh + corner bead · South wall',
      brief:{ status:'pushed', by:'Ana C.', at:'6:51 AM', goal:'South wall top to bottom — same rhythm as yesterday. Stop at the window line.' },
      ping:'Diego flagged: out of mesh',
    },
    {
      id:'p3', name:'Greenwillow', sub:'Day 1 · scaffold day', tone:'#7A8C6F', primary:false,
      crew:[{n:'Marco P.', i:'MP', t:6}],
      crewLabel:'1 of 2 · ⚠ Carlos no-show',
      cost:{spent:96, plan:280, dayBudget:980, status:'lag', delta:'staffing short'},
      scope:'Scaffold setup',
      brief:{ status:'unbriefed' },
      ping:null,
    },
  ];

  // Field pings — open issues coming in from workers across all sites
  const fieldPings = [
    {who:'Diego A.', site:'Aspen', kind:'materials', text:'Out of EPS 1.5" — need 12 more sheets', when:'12m', tone:'#c98a2e'},
    {who:'Tomás R.', site:'Hillcrest', kind:'photo', text:'Posted 4 photos · east wall progress', when:'34m', tone:'#5b8aa8'},
    {who:'Marco P.', site:'Greenwillow', kind:'blocker', text:'Scaffold needs sign-off before crew tomorrow', when:'1h', tone:'#c0463d'},
  ];
  const openCount = fieldPings.filter(p => p.kind !== 'photo').length;

  return (
    <div className="m">
      {/* Header */}
      <div style={{padding:'14px 20px 6px'}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div>
            <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Foreman · Mon Apr 28</div>
            <div style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em', marginTop:2}}>3 sites · 6 crew · 11:18 AM</div>
          </div>
          <div className="m-avatar" data-tone="1">AC</div>
        </div>
      </div>

      {/* From the field — intake stripe surfacing worker pings */}
      <div style={{padding:'8px 16px 4px'}}>
        <div style={{padding:'12px 14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8}}>
            <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase', display:'flex', alignItems:'center', gap:7}}>
              <span style={{width:7, height:7, borderRadius:4, background:'#c0463d'}}/>
              From the field · {openCount} need you
            </div>
            <button style={{fontSize:11, color:'#d9904a', fontWeight:600, background:'transparent', border:'none', fontFamily:'inherit'}}>See all →</button>
          </div>
          {fieldPings.slice(0, 2).map(p => (
            <div key={p.who+p.text} style={{display:'flex', alignItems:'center', gap:10, padding:'6px 0'}}>
              <span style={{width:3, height:24, background:p.tone, borderRadius:2, flexShrink:0}}/>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:12, color:'#1c1816', lineHeight:1.35}}><span style={{fontWeight:600}}>{p.who}</span> <span style={{color:'#8a8278'}}>· {p.site}</span> — {p.text}</div>
              </div>
              <span style={{fontSize:10, color:'#8a8278', fontFeatureSettings:'"tnum"', flexShrink:0}}>{p.when}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Day-wide loaded labor strip — quick read across all sites */}
      <div style={{padding:'8px 16px 4px'}}>
        <div style={{padding:'12px 14px', background:'#1c1816', color:'#f3ecdf', borderRadius:12, display:'flex', alignItems:'center', gap:14}}>
          <div style={{flex:1}}>
            <div style={{fontSize:10, color:'#aea69a', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>All sites · today</div>
            <div style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em', fontFeatureSettings:'"tnum"', marginTop:3, lineHeight:1}}>$1,232 <span style={{fontSize:11, color:'#aea69a', fontWeight:500}}>/ $5,040 plan</span></div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:11, color:'#7adba0', fontWeight:600}}>● live</div>
            <div style={{fontSize:10, color:'#aea69a', marginTop:2, fontFeatureSettings:'"tnum"'}}>22.7 crew-hrs</div>
          </div>
        </div>
      </div>

      {/* Project stack */}
      <div className="m-section-h">My sites</div>
      <div style={{padding:'0 16px 12px', display:'flex', flexDirection:'column', gap:10}}>
        {projects.map(p => (
          <div key={p.id} style={{
            background:'#fff',
            border: p.primary ? '1.5px solid #d9904a' : '1px solid #e8e3db',
            borderRadius:14, overflow:'hidden',
          }}>
            {/* project header */}
            <div style={{padding:'12px 14px', display:'flex', alignItems:'center', gap:12, borderBottom: p.primary ? '1px solid #f5e9d8' : '1px solid #f5f1ec'}}>
              <span style={{width:6, height:36, background:p.tone, borderRadius:3, flexShrink:0}}/>
              <div style={{flex:1, minWidth:0}}>
                <div style={{display:'flex', alignItems:'center', gap:6}}>
                  <div style={{fontSize:14, fontWeight:600, letterSpacing:'-0.01em'}}>{p.name}</div>
                  {p.primary && <span style={{fontSize:9, fontWeight:700, color:'#d9904a', letterSpacing:'.06em'}}>YOU'RE HERE</span>}
                </div>
                <div style={{fontSize:11, color:'#8a8278', marginTop:1}}>{p.sub} · {p.scope}</div>
              </div>
              <span style={{color:'#aea69a', flexShrink:0}}>{MI.chev}</span>
            </div>

            {/* compact metrics row */}
            <div style={{display:'grid', gridTemplateColumns:'1.1fr 1fr 1fr', borderBottom:'1px solid #f5f1ec'}}>
              {/* crew */}
              <div style={{padding:'10px 14px', borderRight:'1px solid #f5f1ec'}}>
                <div style={{fontSize:9, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Crew</div>
                <div style={{display:'flex', alignItems:'center', gap:-4, marginTop:5}}>
                  {p.crew.slice(0, 3).map((c, i) => (
                    <div key={c.n} className="m-avatar" data-size="sm" data-tone={c.t} style={{width:22, height:22, fontSize:9, marginLeft: i === 0 ? 0 : -6, border:'2px solid #fff'}}>{c.i}</div>
                  ))}
                  <div style={{fontSize:11, color:'#5b544c', fontWeight:500, marginLeft:6, fontFeatureSettings:'"tnum"'}}>{p.crewLabel}</div>
                </div>
              </div>
              {/* labor cost */}
              <div style={{padding:'10px 14px', borderRight:'1px solid #f5f1ec'}}>
                <div style={{fontSize:9, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Labor · today</div>
                <div style={{fontSize:14, fontWeight:600, fontFeatureSettings:'"tnum"', marginTop:2}}>${p.cost.spent}</div>
                <div style={{fontSize:10, color: p.cost.status === 'under' ? '#2c8a55' : '#c98a2e', fontWeight:600, marginTop:1}}>{p.cost.delta}</div>
              </div>
              {/* progress bar */}
              <div style={{padding:'10px 14px'}}>
                <div style={{fontSize:9, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Day budget</div>
                <div style={{fontSize:13, fontWeight:600, fontFeatureSettings:'"tnum"', marginTop:2, color:'#1c1816'}}>${(p.cost.dayBudget/1000).toFixed(1)}k</div>
                <div style={{position:'relative', height:4, background:'#f5f1ec', borderRadius:2, marginTop:5, overflow:'hidden'}}>
                  <div style={{position:'absolute', left:0, top:0, bottom:0, width:`${(p.cost.spent/p.cost.dayBudget)*100}%`, background: p.cost.status === 'under' ? '#2c8a55' : '#c98a2e'}}/>
                </div>
              </div>
            </div>

            {/* ping row — flagged issue from the field */}
            {p.ping && (
              <div style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:10, background:'#fff8ec', borderBottom:'1px solid #f5e9d8'}}>
                <span style={{color:'#c98a2e'}}>{MI.alert}</span>
                <span style={{flex:1, fontSize:12, color:'#5b544c'}}>{p.ping}</span>
                <button style={{padding:'4px 10px', background:'#c98a2e', color:'#fff', border:'none', borderRadius:6, fontFamily:'inherit', fontSize:11, fontWeight:600}}>Open</button>
              </div>
            )}

            {/* brief row — what the crew sees on their Scope tab */}
            {p.brief && p.brief.status === 'pushed' ? (
              <div style={{padding:'10px 14px', display:'flex', alignItems:'flex-start', gap:10, background:'#fafaf7'}}>
                <span style={{color:'#2c8a55', marginTop:1, flexShrink:0}}>{MI.check}</span>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize:11, color:'#8a8278', display:'flex', alignItems:'center', gap:5}}>
                    <span style={{color:'#5b544c', fontWeight:600}}>Briefed</span>
                    <span>· {p.brief.by} · {p.brief.at}</span>
                  </div>
                  <div style={{fontSize:12, color:'#1c1816', marginTop:3, lineHeight:1.4, overflow:'hidden', textOverflow:'ellipsis', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical'}}>“{p.brief.goal}”</div>
                </div>
                <button style={{padding:'4px 8px', background:'transparent', border:'1px solid #e8e3db', borderRadius:6, fontFamily:'inherit', fontSize:11, color:'#5b544c', flexShrink:0}}>Edit</button>
              </div>
            ) : (
              <div style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:10, background:'rgba(217,144,74,.06)'}}>
                <span style={{width:18, height:18, borderRadius:9, background:'#d9904a', color:'#fff', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, flexShrink:0}}>!</span>
                <span style={{flex:1, fontSize:12, color:'#5b544c'}}>Crew not briefed yet</span>
                <button style={{padding:'5px 12px', background:'#d9904a', color:'#fff', border:'none', borderRadius:6, fontFamily:'inherit', fontSize:11, fontWeight:600}}>Brief crew</button>
              </div>
            )}
          </div>
        ))}

        {/* Scheduled but not started */}
        <button style={{padding:'10px 14px', background:'transparent', border:'1px dashed #d6cdbe', borderRadius:12, color:'#8a8278', fontFamily:'inherit', fontSize:12, display:'flex', alignItems:'center', justifyContent:'center', gap:8}}>
          <span>{MI.plus}</span>Add a site to today
        </button>
      </div>

      <div style={{flex:1}}/>

      <ForemanTabs active="today" fieldBadge={openCount}/>
    </div>
  );
}

function ForemanDailyLog() {
  return (
    <div className="m">
      <MTopBar title="Daily log" sub="Mon Apr 28 · Hillcrest" action="more" actionIcon={MI.share}/>
      <div className="m-body">
        {/* Status strip */}
        <div className="m-stat-strip">
          <div>
            <div className="m-stat-strip-l">Photos</div>
            <div className="m-stat-strip-v num">12</div>
          </div>
          <div>
            <div className="m-stat-strip-l">Hours</div>
            <div className="m-stat-strip-v num">32.3</div>
          </div>
          <div>
            <div className="m-stat-strip-l">Issues</div>
            <div className="m-stat-strip-v num" style={{color:'#c98a2e'}}>1</div>
          </div>
        </div>

        {/* Weather card */}
        <div style={{margin:'14px 16px 0', padding:'12px 14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12, display:'flex', alignItems:'center', gap:14}}>
          <div style={{width:44, height:44, background:'linear-gradient(135deg, #f0d5a8 0%, #d9904a 100%)', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center'}}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:13, fontWeight:600}}>Sunny · 68°F · 6 mph</div>
            <div style={{fontSize:11, color:'#8a8278'}}>Optimal for finish coats · 0% rain through Wed</div>
          </div>
        </div>

        {/* Photo grid */}
        <div className="m-section-h">Photos (12)</div>
        <div style={{padding:'0 16px', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6}}>
          {Array.from({length:9}).map((_, i) => {
            const c = ['#E8A86B', '#C77B4F', '#A05A33', '#7A8C6F', '#9C7A5B', '#6FA8A0', '#c98a2e', '#5b544c', '#aea69a'][i];
            const tag = ['EPS', 'EPS', 'BASE', 'BASE', 'EPS', 'BASE', 'ISSUE', 'EPS', 'BASE'][i];
            return (
              <div key={i} style={{aspectRatio:'1', background: `linear-gradient(135deg, ${c} 0%, ${c}aa 100%)`, borderRadius:8, position:'relative', overflow:'hidden'}}>
                <div style={{position:'absolute', top:4, left:4, padding:'2px 6px', background:'rgba(0,0,0,.5)', borderRadius:6, color:'#fff', fontSize:8, fontWeight:600}}>{tag}</div>
                {i === 8 && <div style={{position:'absolute', inset:0, background:'rgba(0,0,0,.5)', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:14, fontWeight:600}}>+3</div>}
              </div>
            );
          })}
        </div>

        {/* Narrative — AI LAYER · Agent surface (foreman authors, agent drafts) */}
        <div className="m-section-h">Narrative</div>
        <div style={{padding:'0 16px'}}>
          <MAiAgent>
            <div style={{fontSize:13, color:'var(--m-ink-2)', lineHeight:1.55}}>
              Started East elevation EPS at 7:00. All 4 crew clocked in by 7:08. Made good progress — about 80% of east wall anchored by lunch. After lunch ran into a soft spot on the foundation flashing — flagged for review. Wrapped up at 3:30, materials staged for basecoat tomorrow.
            </div>
            <div style={{marginTop:12, paddingTop:10, borderTop:'1px dashed var(--m-line-2)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8}}>
              <MAttribution>Drafted from <strong>12 photos · 2 voice memos · clock-in data</strong>.</MAttribution>
              <button style={{padding:'5px 10px', background:'transparent', border:'1px solid var(--m-line)', borderRadius:6, fontSize:11, color:'var(--m-ink-2)', fontFamily:'inherit'}}>Edit</button>
            </div>
          </MAiAgent>
        </div>

        {/* Issues */}
        <div className="m-section-h">Issues (1)</div>
        <div style={{margin:'0 16px 16px', padding:'14px', background:'rgba(201,138,46,.08)', border:'1px solid rgba(201,138,46,.25)', borderRadius:12}}>
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
            <span style={{color:'#c98a2e'}}>{MI.alert}</span>
            <strong style={{fontSize:13}}>Soft spot on foundation flashing</strong>
          </div>
          <div style={{fontSize:12, color:'#5b544c', lineHeight:1.45, paddingLeft:24}}>2'×3' area on north corner. Need PM call before basecoating over it.</div>
          <div style={{display:'flex', gap:8, marginTop:10}}>
            <button className="m-btn m-btn-sm" data-variant="primary">Notify PM</button>
            <button className="m-btn m-btn-sm" data-variant="ghost">Add photo</button>
          </div>
        </div>

        <div className="m-btn-stack">
          <button className="m-btn" data-variant="primary">Submit log</button>
          <button className="m-btn" data-variant="ghost">Send to client too</button>
        </div>
      </div>
      <ForemanTabs active="log"/>
    </div>
  );
}

function ForemanScheduleAhead() {
  return (
    <div className="m">
      <MTopBar back title="Schedule ahead" sub="My crew · 2 weeks"/>
      <div className="m-body">
        {[
          {wk:'This week · Apr 27', days:[
            {d:'Mon', n:28, p:'Hillcrest · EPS', conf:true, today:true},
            {d:'Tue', n:29, p:'Hillcrest · EPS', conf:true},
            {d:'Wed', n:30, p:'Hillcrest · Caulk', conf:true},
            {d:'Thu', n:1, p:'Hillcrest · Basecoat', conf:false},
            {d:'Fri', n:2, p:'Hillcrest · Basecoat', conf:false},
          ]},
          {wk:'Next week · May 4', days:[
            {d:'Mon', n:4, p:'Aspen Ridge · Block A', conf:true},
            {d:'Tue', n:5, p:'Aspen Ridge · Block A', conf:true},
            {d:'Wed', n:6, p:null, conf:false, off:true},
            {d:'Thu', n:7, p:'Greenwillow · Punch', conf:false},
            {d:'Fri', n:8, p:null, conf:false, off:true},
          ]},
        ].map(w => (
          <React.Fragment key={w.wk}>
            <div className="m-section-h">{w.wk}</div>
            <div className="m-list-inset">
              {w.days.map(d => (
                <div key={d.d} style={{padding:'14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:14, background: d.today ? 'rgba(217,144,74,.05)' : '#fff'}}>
                  <div style={{width:42, textAlign:'center'}}>
                    <div style={{fontSize:10, color:'#8a8278', fontWeight:600}}>{d.d}</div>
                    <div style={{fontSize:20, fontWeight:600, fontFeatureSettings:'"tnum"', color: d.today ? '#d9904a' : '#1c1816'}}>{d.n}</div>
                  </div>
                  {d.p ? (
                    <>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13, fontWeight:500}}>{d.p}</div>
                        <div style={{fontSize:11, color:'#8a8278'}}>7:00 AM start · 3 crew</div>
                      </div>
                      {d.conf
                        ? <span className="m-pill" data-tone="green" dot>conf.</span>
                        : <span className="m-pill" data-tone="amber" dot>tent.</span>}
                    </>
                  ) : <div style={{flex:1, fontSize:12, color:'#aea69a', fontStyle:'italic'}}>No assignment</div>}
                </div>
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// SECTION 13 — SYSTEM STATES
// ============================================================

function StateOffline() {
  return (
    <div className="m">
      <div style={{padding:'10px 14px', background:'#1c1816', color:'#f3ecdf', display:'flex', alignItems:'center', gap:10, fontSize:13}}>
        <span style={{color:'#c98a2e'}}>●</span>
        <span style={{flex:1}}>Offline · 4 changes will sync when you're back</span>
        <button style={{background:'transparent', border:'1px solid #4a3f33', color:'#f3ecdf', borderRadius:8, padding:'4px 10px', fontFamily:'inherit', fontSize:11}}>Retry</button>
      </div>
      <div style={{padding:'14px 20px 8px'}}>
        <div style={{display:'flex', alignItems:'baseline', gap:10}}>
          <div style={{fontSize:30, fontWeight:700, letterSpacing:'-0.02em'}}>Today</div>
          <div style={{fontSize:14, color:'#8a8278'}}>Mon, Apr 28</div>
        </div>
      </div>
      <div className="m-body">
        <div className="m-section-h">Pending sync (4)</div>
        <div className="m-list-inset">
          <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:10}}>
            <span style={{width:20, height:20, borderRadius:10, background:'rgba(201,138,46,.15)', color:'#c98a2e', display:'inline-flex', alignItems:'center', justifyContent:'center'}}>{MI.time}</span>
            <div style={{flex:1}}><div style={{fontSize:14, fontWeight:500}}>Clock-in · 7:04 AM</div><div style={{fontSize:11, color:'#8a8278'}}>Marcus Lee · Hillcrest</div></div>
            <span className="m-pill" data-tone="amber">queued</span>
          </div>
          <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:10}}>
            <span style={{width:20, height:20, borderRadius:10, background:'rgba(201,138,46,.15)', color:'#c98a2e', display:'inline-flex', alignItems:'center', justifyContent:'center'}}>{MI.cam}</span>
            <div style={{flex:1}}><div style={{fontSize:14, fontWeight:500}}>3 photos · daily log</div><div style={{fontSize:11, color:'#8a8278'}}>Hillcrest · 12.4 MB</div></div>
            <span className="m-pill" data-tone="amber">queued</span>
          </div>
          <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:10}}>
            <span style={{width:20, height:20, borderRadius:10, background:'rgba(201,138,46,.15)', color:'#c98a2e', display:'inline-flex', alignItems:'center', justifyContent:'center'}}>{MI.edit}</span>
            <div style={{flex:1}}><div style={{fontSize:14, fontWeight:500}}>Note added to log</div><div style={{fontSize:11, color:'#8a8278'}}>EPS east · 28 words</div></div>
            <span className="m-pill" data-tone="amber">queued</span>
          </div>
          <div style={{padding:'12px 14px', display:'flex', alignItems:'center', gap:10}}>
            <span style={{width:20, height:20, borderRadius:10, background:'rgba(201,138,46,.15)', color:'#c98a2e', display:'inline-flex', alignItems:'center', justifyContent:'center'}}>{MI.alert}</span>
            <div style={{flex:1}}><div style={{fontSize:14, fontWeight:500}}>Issue flagged</div><div style={{fontSize:11, color:'#8a8278'}}>Foundation flashing · north corner</div></div>
            <span className="m-pill" data-tone="amber">queued</span>
          </div>
        </div>
        <div className="m-section-h">Cached for offline</div>
        <div className="m-list-inset">
          <MRow leading={MI.check} leadingTone="green" headline="Today's schedule" supporting="3 jobs, 18 crew" chev={false}/>
          <MRow leading={MI.check} leadingTone="green" headline="Hillcrest project files" supporting="Drawings, measurements, contract" chev={false}/>
          <MRow leading={MI.check} leadingTone="green" headline="Crew profiles + rates" chev={false}/>
        </div>
      </div>
    </div>
  );
}

function StateError() {
  return (
    <div className="m" style={{padding:'40px 24px', textAlign:'center'}}>
      <div style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center'}}>
        <div style={{width:80, height:80, background:'rgba(192,70,61,.08)', borderRadius:20, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:18}}>
          <span style={{color:'#c0463d'}}><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg></span>
        </div>
        <div style={{fontSize:20, fontWeight:600, letterSpacing:'-0.01em', marginBottom:6}}>Couldn't load estimate</div>
        <div style={{fontSize:13, color:'#5b544c', lineHeight:1.5, maxWidth:260, marginBottom:24}}>
          We hit a snag pulling EST-2026-184 from QuickBooks. The estimate is saved — just the live sync failed.
        </div>
        <div className="m-btn-stack" style={{width:'100%', maxWidth:280}}>
          <button className="m-btn" data-variant="primary">Try again</button>
          <button className="m-btn" data-variant="ghost">Open offline copy</button>
          <button className="m-btn" data-variant="quiet">Get help</button>
        </div>
        <div style={{marginTop:24, padding:'10px 14px', background:'#f7f4ef', borderRadius:10, fontSize:11, color:'#8a8278', fontFamily:'Geist Mono, monospace'}}>
          Error · QBO/auth · 401 · ref a4c8f1
        </div>
      </div>
    </div>
  );
}

function StateEmpty() {
  return (
    <div className="m">
      <MTopBar title="Projects" action="add" actionIcon={MI.plus}/>
      <div className="m-body" style={{display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'40px 24px', textAlign:'center'}}>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
          <rect x="20" y="40" width="80" height="60" rx="6" fill="#f3e9d8" stroke="#d9904a" strokeWidth="1.5" strokeDasharray="4,3"/>
          <path d="M20 50h80" stroke="#d9904a" strokeWidth="1.5" strokeDasharray="4,3"/>
          <circle cx="35" cy="46" r="2" fill="#d9904a"/>
          <circle cx="42" cy="46" r="2" fill="#d9904a"/>
          <circle cx="49" cy="46" r="2" fill="#d9904a"/>
          <path d="M40 70h40M40 80h28M40 88h35" stroke="#aea69a" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <div style={{fontSize:20, fontWeight:600, marginTop:18}}>No projects yet</div>
        <div style={{fontSize:13, color:'#5b544c', lineHeight:1.5, maxWidth:260, marginTop:8, marginBottom:24}}>
          Start with an address or upload drawings — Sitelayer will help you get to a measurement plan in under a minute.
        </div>
        <div className="m-btn-stack" style={{width:'100%', maxWidth:280}}>
          <button className="m-btn" data-variant="primary">{MI.plus}<span>New project</span></button>
          <button className="m-btn" data-variant="ghost">Import from QuickBooks</button>
        </div>
      </div>
    </div>
  );
}

function StateLoading() {
  return (
    <div className="m">
      <MTopBar back title="Hillcrest Mews" sub="loading…"/>
      <div className="m-body">
        {/* skeleton hero */}
        <div style={{padding:'14px 16px 8px'}}>
          <div style={{padding:'16px', background:'#fff', border:'1px solid #e8e3db', borderRadius:14}}>
            <div style={{height:14, width:90, background:'#f5f1ec', borderRadius:4, marginBottom:14}} className="sk"/>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
              <div>
                <div style={{height:10, width:30, background:'#f5f1ec', borderRadius:3, marginBottom:6}} className="sk"/>
                <div style={{height:20, width:90, background:'#f5f1ec', borderRadius:4}} className="sk"/>
              </div>
              <div>
                <div style={{height:10, width:50, background:'#f5f1ec', borderRadius:3, marginBottom:6}} className="sk"/>
                <div style={{height:20, width:70, background:'#f5f1ec', borderRadius:4}} className="sk"/>
              </div>
            </div>
            <div style={{height:6, background:'#f5f1ec', borderRadius:3, marginTop:14}} className="sk"/>
          </div>
        </div>
        <div className="m-section-h" style={{opacity:.5}}>By scope</div>
        <div className="m-list-inset">
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
              <div style={{width:36, height:36, background:'#f5f1ec', borderRadius:8}} className="sk"/>
              <div style={{flex:1}}>
                <div style={{height:12, width:'60%', background:'#f5f1ec', borderRadius:3, marginBottom:6}} className="sk"/>
                <div style={{height:10, width:'40%', background:'#f5f1ec', borderRadius:3, marginBottom:6}} className="sk"/>
                <div style={{height:4, background:'#f5f1ec', borderRadius:2}} className="sk"/>
              </div>
              <div style={{width:34, height:14, background:'#f5f1ec', borderRadius:3}} className="sk"/>
            </div>
          ))}
        </div>
      </div>
      <style>{`
        .sk { animation: skp 1.4s ease-in-out infinite; }
        @keyframes skp { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
      `}</style>
    </div>
  );
}

function StatePermissionDenied() {
  return (
    <div className="m" style={{padding:'24px 24px 30px', display:'flex', flexDirection:'column'}}>
      <div style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', textAlign:'center'}}>
        <div style={{width:80, height:80, background:'rgba(201,138,46,.10)', borderRadius:20, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:18}}>
          <span style={{color:'#c98a2e'}}><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="11" r="3"/><path d="M12 14v7M21 11c0 6-9 11-9 11s-9-5-9-11a9 9 0 0118 0z"/><line x1="3" y1="3" x2="21" y2="21" stroke="#c0463d"/></svg></span>
        </div>
        <div style={{fontSize:20, fontWeight:600, letterSpacing:'-0.01em', marginBottom:6}}>Location is off</div>
        <div style={{fontSize:13, color:'#5b544c', lineHeight:1.5, maxWidth:280, marginBottom:24}}>
          Sitelayer uses geofences to verify clock-in. Without location, your hours need a foreman to manually approve each one.
        </div>
        <div className="m-btn-stack" style={{width:'100%', maxWidth:300}}>
          <button className="m-btn" data-variant="primary">Open settings</button>
          <button className="m-btn" data-variant="ghost">Continue without location</button>
        </div>
      </div>
      <div style={{padding:'14px', background:'#f7f4ef', borderRadius:12, fontSize:11, color:'#5b544c', display:'flex', alignItems:'flex-start', gap:8}}>
        <span style={{color:'#5b544c', flexShrink:0}}>{MI.lock}</span>
        <span>We only check your location when you tap Clock-in or Clock-out. We never track you between shifts.</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// ForemanField — intake feed of pings/photos/issues from workers across all sites.
// This is what the user was missing: workers post from the field, foreman receives here.
// ────────────────────────────────────────────────────────
function ForemanField() {
  const items = [
    { id:1, kind:'blocker', who:'Diego A.', tone:'#A05A33', site:'Aspen Ridge', when:'12m', resolved:false,
      title:'Out of EPS 1.5"', body:'Need 12 more sheets to finish south wall. Crew can pivot to mesh prep but only buys ~2hrs.', cta:'Order materials' },
    { id:2, kind:'blocker', who:'Marco P.', tone:'#7A8C6F', site:'Greenwillow', when:'1h', resolved:false,
      title:'Scaffold sign-off needed', body:'Setup complete on north + east. Need sign-off before crew works it tomorrow morning.', cta:'Resolve' },
    { id:3, kind:'photo', who:'Tomás R.', tone:'#E8A86B', site:'Hillcrest', when:'34m', resolved:false,
      title:'East wall progress · 4 photos', body:'~80% of east elevation anchored. Going strong.', photos:4 },
    { id:4, kind:'note', who:'Ana C.', tone:'#E8A86B', site:'Hillcrest', when:'2h', resolved:false,
      title:'Soft spot on foundation flashing', body:'2\u2032×3\u2032 area on north corner. Need PM call before basecoating over it.', cta:'Call PM' },
    { id:5, kind:'photo', who:'Sara V.', tone:'#A05A33', site:'Aspen Ridge', when:'3h', resolved:true,
      title:'Mesh + corner bead · before / after', body:'South wall first lift wrapped 9:40 AM.', photos:6 },
  ];

  const tabs = [
    { l:'All', n:5, on:true },
    { l:'Blockers', n:2 },
    { l:'Photos', n:2 },
    { l:'Resolved', n:1 },
  ];

  const kindMeta = {
    blocker: { label:'Blocker', bg:'rgba(192,70,61,.10)', fg:'#c0463d', icon:MI.alert },
    photo:   { label:'Photo',   bg:'rgba(91,138,168,.10)', fg:'#5b8aa8', icon:MI.cam },
    note:    { label:'Note',    bg:'#f5f1ec', fg:'#5b544c', icon:MI.edit },
  };

  return (
    <div className="m">
      <div style={{padding:'14px 20px 6px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>From the field · today</div>
        <div style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em', marginTop:2, display:'flex', alignItems:'baseline', gap:10}}>
          5 incoming
          <span style={{fontSize:12, color:'#c0463d', fontWeight:600}}>· 2 need you</span>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{display:'flex', gap:6, padding:'10px 16px', borderBottom:'1px solid #e8e3db', overflowX:'auto', background:'#fff'}}>
        {tabs.map(t => (
          <button key={t.l} style={{
            flex:'0 0 auto', padding:'6px 12px', borderRadius:18,
            background: t.on ? '#1c1816' : '#fff',
            color: t.on ? '#fff' : '#5b544c',
            border: t.on ? 'none' : '1px solid #e8e3db',
            fontFamily:'inherit', fontSize:12, fontWeight:500,
            display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap',
          }}>
            {t.l}
            <span style={{fontSize:10, color: t.on ? '#aea69a' : '#8a8278', fontFeatureSettings:'"tnum"'}}>{t.n}</span>
          </button>
        ))}
      </div>

      <div className="m-body" style={{padding:'10px 16px 16px', display:'flex', flexDirection:'column', gap:10}}>
        {items.filter(x => !x.resolved).map(it => {
          const k = kindMeta[it.kind];
          return (
            <div key={it.id} style={{background:'#fff', border:'1px solid #e8e3db', borderRadius:12, overflow:'hidden'}}>
              {/* header */}
              <div style={{padding:'12px 14px 8px', display:'flex', alignItems:'flex-start', gap:10}}>
                <div className="m-avatar" data-size="sm" data-tone="1" style={{flexShrink:0}}>{it.who.split(' ').map(w => w[0]).join('').slice(0,2)}</div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#5b544c'}}>
                    <span style={{fontWeight:600, color:'#1c1816'}}>{it.who}</span>
                    <span style={{color:'#aea69a'}}>·</span>
                    <span style={{display:'inline-flex', alignItems:'center', gap:4}}>
                      <span style={{width:6, height:6, borderRadius:3, background:it.tone}}/>{it.site}
                    </span>
                    <span style={{color:'#aea69a'}}>·</span>
                    <span style={{fontFeatureSettings:'"tnum"'}}>{it.when}</span>
                  </div>
                  <div style={{fontSize:14, fontWeight:600, letterSpacing:'-0.01em', marginTop:3, color:'#1c1816'}}>{it.title}</div>
                </div>
                <span style={{padding:'3px 8px', borderRadius:6, background:k.bg, color:k.fg, fontSize:10, fontWeight:700, letterSpacing:'.04em', textTransform:'uppercase', flexShrink:0, display:'inline-flex', alignItems:'center', gap:4}}>
                  {k.icon && <span style={{display:'inline-flex'}}>{React.cloneElement(k.icon, {width:11, height:11})}</span>}
                  {k.label}
                </span>
              </div>
              {/* body */}
              <div style={{padding:'0 14px 12px', fontSize:12, color:'#5b544c', lineHeight:1.5}}>{it.body}</div>
              {/* photo strip */}
              {it.photos && (
                <div style={{padding:'0 14px 12px', display:'flex', gap:4}}>
                  {Array.from({length: Math.min(it.photos, 4)}).map((_, i) => (
                    <div key={i} style={{flex:1, aspectRatio:'1.2', background:`linear-gradient(135deg, ${it.tone} 0%, ${it.tone}aa 100%)`, borderRadius:6, position:'relative'}}>
                      {i === 3 && it.photos > 4 && <div style={{position:'absolute', inset:0, background:'rgba(0,0,0,.5)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:12, fontWeight:600}}>+{it.photos - 4}</div>}
                    </div>
                  ))}
                </div>
              )}
              {/* actions */}
              <div style={{padding:'10px 14px', borderTop:'1px solid #f5f1ec', display:'flex', alignItems:'center', gap:8, background:'#fafaf6'}}>
                {it.cta && <button style={{padding:'6px 12px', background:'#1c1816', color:'#fff', border:'none', borderRadius:7, fontFamily:'inherit', fontSize:12, fontWeight:600}}>{it.cta}</button>}
                <button style={{padding:'6px 12px', background:'transparent', border:'1px solid #e8e3db', borderRadius:7, fontFamily:'inherit', fontSize:12, color:'#5b544c'}}>Reply</button>
                <span style={{flex:1}}/>
                <button style={{background:'transparent', border:'none', color:'#8a8278', fontFamily:'inherit', fontSize:11}}>Mark resolved</button>
              </div>
            </div>
          );
        })}

        {/* Resolved divider */}
        <div style={{display:'flex', alignItems:'center', gap:10, padding:'8px 4px', color:'#8a8278', fontSize:11, fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>
          <span style={{flex:1, height:1, background:'#e8e3db'}}/>
          Resolved · 1
          <span style={{flex:1, height:1, background:'#e8e3db'}}/>
        </div>

        {items.filter(x => x.resolved).map(it => (
          <div key={it.id} style={{padding:'10px 12px', display:'flex', alignItems:'center', gap:10, background:'#fff', border:'1px solid #e8e3db', borderRadius:12, opacity:.65}}>
            <span style={{color:'#2c8a55'}}>{MI.check}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:12, color:'#1c1816', fontWeight:500}}>{it.title}</div>
              <div style={{fontSize:11, color:'#8a8278'}}>{it.who} · {it.site} · {it.when}</div>
            </div>
          </div>
        ))}
      </div>

      <ForemanTabs active="field"/>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// ForemanBriefCrew — authoring surface that produces what the
// worker sees on their Scope tab. Scope picker → goal text →
// step plan (with crew + time blocks) → materials note → push.
// This is the source-of-truth for WorkerScopeToday.
// ────────────────────────────────────────────────────────
function ForemanBriefCrew() {
  return (
    <div className="m">
      <MTopBar back title="Brief the crew" sub="Hillcrest · Day 18"/>

      <div className="m-body">
        {/* Scope picker — pulls from estimate scope items */}
        <div style={{padding:'14px 16px 8px'}}>
          <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Today's scope</div>
          <div style={{display:'flex', flexDirection:'column', gap:6}}>
            {[
              {code:'EPS', tone:'#E8A86B', label:'East elevation', sf:'1,284 sf', selected:true, status:'in progress · 56%'},
              {code:'EPS', tone:'#E8A86B', label:'West elevation', sf:'1,100 sf', status:'not started'},
              {code:'BASE', tone:'#C77B4F', label:'Basecoat · East', sf:'1,284 sf', status:'queued · needs EPS done'},
            ].map(s => (
              <div key={s.code+s.label} style={{padding:'10px 12px', background:'#fff', border: s.selected ? '1.5px solid #d9904a' : '1px solid #e8e3db', borderRadius:10, display:'flex', alignItems:'center', gap:12}}>
                <span style={{width:28, height:28, background:s.tone, color:'#fff', borderRadius:6, display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700, flexShrink:0}}>{s.code}</span>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize:13, fontWeight:500}}>{s.label}</div>
                  <div style={{fontSize:11, color:'#8a8278', fontFeatureSettings:'"tnum"'}}>{s.sf} · {s.status}</div>
                </div>
                <div style={{width:18, height:18, borderRadius:9, border: s.selected ? 'none' : '1.5px solid #d6cdbe', background: s.selected ? '#d9904a' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', flexShrink:0}}>
                  {s.selected && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12l5 5L20 7"/></svg>}
                </div>
              </div>
            ))}
          </div>
          <button style={{marginTop:8, fontSize:12, color:'#d9904a', fontWeight:600, background:'transparent', border:'none', fontFamily:'inherit', padding:'4px 0'}}>+ Pick from another phase</button>
        </div>

        {/* Goal text — what shows up as 'Today's goal' on worker home */}
        <div style={{padding:'8px 16px 8px'}}>
          <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Today's goal</div>
          <div style={{padding:'12px', background:'#fff', border:'1px solid #e8e3db', borderRadius:10}}>
            <div style={{fontSize:13, color:'#1c1816', lineHeight:1.5, minHeight:40}}>Anchor + plate east wall, top to bottom — leave the cornice for tomorrow.</div>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:8, paddingTop:8, borderTop:'1px solid #f5f1ec'}}>
              <button style={{fontSize:11, color:'#8a8278', background:'transparent', border:'none', fontFamily:'inherit', display:'flex', alignItems:'center', gap:4, padding:0}}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 19V5M5 12h14"/></svg>
                Voice memo
              </button>
              <span style={{fontSize:10, color:'#8a8278', fontFeatureSettings:'"tnum"'}}>72 / 280</span>
            </div>
          </div>
        </div>

        {/* Steps — ordered tasks with crew + time block */}
        <div className="m-section-h" style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', paddingRight:16}}>
          <span>Step plan</span>
          <button style={{fontSize:11, color:'#d9904a', fontWeight:600, background:'transparent', border:'none', fontFamily:'inherit'}}>+ Add step</button>
        </div>
        <div style={{padding:'0 16px', display:'flex', flexDirection:'column', gap:6}}>
          {[
            {n:'Insulation board (EPS 1.5")', q:'24 sheets', time:'7:00–9:30', who:'all', drag:true},
            {n:'Plate fasteners', q:'~620 anchors', time:'9:30–11:00', who:'all', drag:true},
            {n:'Mesh + corner bead', q:'East wall + window jambs', time:'11:00–14:00', who:'Marcus + Tomás', drag:true, active:true},
            {n:'Cleanup + cover', q:'Tarp scaffold for overnight', time:'14:30–15:00', who:'Ana', drag:true},
          ].map((s, i) => (
            <div key={i} style={{padding:'12px', background:'#fff', border: s.active ? '1.5px solid rgba(217,144,74,.5)' : '1px solid #e8e3db', borderRadius:10, display:'flex', alignItems:'flex-start', gap:10}}>
              <span style={{fontSize:14, color:'#aea69a', cursor:'grab', flexShrink:0, marginTop:2, lineHeight:1}}>⋮⋮</span>
              <div style={{flex:1, minWidth:0}}>
                <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:8}}>
                  <div style={{fontSize:13, fontWeight:500}}>{s.n}</div>
                  <div style={{fontSize:11, color:'#5b544c', fontFeatureSettings:'"tnum"', flexShrink:0}}>{s.time}</div>
                </div>
                <div style={{fontSize:11, color:'#8a8278', marginTop:3, display:'flex', alignItems:'center', gap:6}}>
                  <span style={{fontFeatureSettings:'"tnum"'}}>{s.q}</span>
                  <span style={{color:'#aea69a'}}>·</span>
                  <span style={{display:'inline-flex', alignItems:'center', gap:4, color:'#5b544c'}}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="3"/><path d="M5 21c0-4 3-6 7-6s7 2 7 6"/></svg>
                    {s.who}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Materials / site note */}
        <div style={{padding:'14px 16px 8px'}}>
          <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Site note (optional)</div>
          <div style={{padding:'10px 12px', background:'#fff', border:'1px solid #e8e3db', borderRadius:10, fontSize:12, color:'#1c1816', lineHeight:1.5}}>Materials staged at south gate · scaffold A is yours</div>
        </div>

        {/* Push */}
        <div style={{padding:'14px 16px 16px'}}>
          <div style={{padding:'12px 14px', background:'#1c1816', borderRadius:12, color:'#aea69a', fontSize:11, marginBottom:10, display:'flex', alignItems:'center', gap:10}}>
            <span style={{color:'#7adba0'}}>{MI.users}</span>
            <span style={{flex:1}}>3 crew will see this on their Scope tab when they clock in</span>
          </div>
          <div className="m-btn-stack">
            <button className="m-btn" data-variant="primary">Push to crew</button>
            <button className="m-btn" data-variant="ghost">Save as draft</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// ForemanCrew — Crew tab home. Roster across sites, who's
// scoped to what today, status. The clear answer to
// "where is everybody and what are they doing?"
// ────────────────────────────────────────────────────────
function ForemanCrew() {
  const sites = [
    { name:'Hillcrest', tone:'#E8A86B', briefed:true, briefedBy:'You', when:'6:42 AM',
      crew:[
        { n:'Ana Castillo',  i:'AC', t:1, role:'Lead', task:'EPS · East elevation', step:'Mesh + corner bead', status:'on', clockIn:'7:02' },
        { n:'Marcus Lee',    i:'ML', t:2, role:'Crew', task:'EPS · East elevation', step:'Mesh + corner bead', status:'on', clockIn:'7:04' },
        { n:'Tomás Reyes',   i:'TR', t:5, role:'Crew', task:'EPS · East elevation', step:'Mesh + corner bead', status:'break', clockIn:'7:08' },
      ]
    },
    { name:'Aspen Ridge', tone:'#A05A33', briefed:true, briefedBy:'Ana C.', when:'6:51 AM',
      crew:[
        { n:'Sara Vega',     i:'SV', t:3, role:'Lead', task:'Mesh + bead · South', step:'First lift', status:'on', clockIn:'7:00' },
        { n:'Diego Aldana',  i:'DA', t:4, role:'Crew', task:'Mesh + bead · South', step:'First lift', status:'blocker', clockIn:'7:02', flag:'Out of EPS' },
      ]
    },
    { name:'Greenwillow', tone:'#7A8C6F', briefed:false, briefedBy:null, when:null,
      crew:[
        { n:'Marco Pena',    i:'MP', t:6, role:'Lead', task:'(no scope yet)', step:'—', status:'on', clockIn:'7:14' },
        { n:'Carlos Rivera', i:'CR', t:1, role:'Crew', task:'(no scope yet)', step:'—', status:'noshow', clockIn:null },
      ]
    },
  ];

  const statusMeta = {
    on:      { label:'on site',  color:'#2c8a55', dot:'#2c8a55' },
    break:   { label:'on break', color:'#c98a2e', dot:'#c98a2e' },
    blocker: { label:'flagged',  color:'#c0463d', dot:'#c0463d' },
    noshow:  { label:'no-show',  color:'#c0463d', dot:'#c0463d' },
  };

  return (
    <div className="m">
      {/* Header */}
      <div style={{padding:'14px 20px 6px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Crew · today</div>
        <div style={{display:'flex', alignItems:'baseline', gap:10, marginTop:2}}>
          <div style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em'}}>7 of 8 on site</div>
          <span style={{fontSize:12, color:'#c0463d', fontWeight:600}}>· 1 no-show</span>
        </div>
      </div>

      {/* View toggle */}
      <div style={{display:'flex', gap:6, padding:'10px 16px', borderBottom:'1px solid #e8e3db', background:'#fff'}}>
        {[{l:'By site', on:true}, {l:'By person'}, {l:'Map'}].map(t => (
          <button key={t.l} style={{
            flex:'0 0 auto', padding:'6px 12px', borderRadius:18,
            background: t.on ? '#1c1816' : '#fff',
            color: t.on ? '#fff' : '#5b544c',
            border: t.on ? 'none' : '1px solid #e8e3db',
            fontFamily:'inherit', fontSize:12, fontWeight:500,
          }}>{t.l}</button>
        ))}
      </div>

      <div className="m-body" style={{padding:'10px 16px 16px', display:'flex', flexDirection:'column', gap:12}}>
        {sites.map(s => (
          <div key={s.name} style={{background:'#fff', border:'1px solid #e8e3db', borderRadius:12, overflow:'hidden'}}>
            {/* Site header */}
            <div style={{padding:'12px 14px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #f5f1ec'}}>
              <span style={{width:6, height:28, background:s.tone, borderRadius:3, flexShrink:0}}/>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:14, fontWeight:600, letterSpacing:'-0.01em'}}>{s.name}</div>
                <div style={{fontSize:11, color:'#8a8278', marginTop:1}}>
                  {s.briefed ? `Briefed by ${s.briefedBy} · ${s.when}` : 'Not briefed yet'}
                </div>
              </div>
              {s.briefed ? (
                <button style={{padding:'5px 10px', background:'transparent', border:'1px solid #e8e3db', borderRadius:7, fontFamily:'inherit', fontSize:11, color:'#5b544c'}}>Edit brief</button>
              ) : (
                <button style={{padding:'5px 12px', background:'#d9904a', border:'none', borderRadius:7, fontFamily:'inherit', fontSize:11, color:'#fff', fontWeight:600}}>Brief now</button>
              )}
            </div>

            {/* Crew rows */}
            <div>
              {s.crew.map(c => {
                const sm = statusMeta[c.status];
                return (
                  <div key={c.n} style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #f5f1ec'}}>
                    <div className="m-avatar" data-size="sm" data-tone={c.t} style={{flexShrink:0}}>{c.i}</div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{display:'flex', alignItems:'baseline', gap:6}}>
                        <span style={{fontSize:13, fontWeight:500}}>{c.n}</span>
                        {c.role === 'Lead' && <span style={{fontSize:9, fontWeight:700, color:'#d9904a', letterSpacing:'.06em'}}>LEAD</span>}
                      </div>
                      <div style={{fontSize:11, color:'#8a8278', marginTop:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
                        {c.task}{c.step !== '—' && <> · <span style={{color:'#5b544c'}}>{c.step}</span></>}
                      </div>
                    </div>
                    <div style={{textAlign:'right', flexShrink:0}}>
                      <div style={{display:'inline-flex', alignItems:'center', gap:5, fontSize:11, fontWeight:600, color:sm.color}}>
                        <span style={{width:6, height:6, borderRadius:3, background:sm.dot}}/>
                        {sm.label}
                      </div>
                      {c.clockIn && <div style={{fontSize:10, color:'#8a8278', marginTop:2, fontFeatureSettings:'"tnum"'}}>in {c.clockIn}</div>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Inline blocker if anyone flagged */}
            {s.crew.some(c => c.flag) && (
              <div style={{padding:'8px 14px', background:'#fff8ec', borderTop:'1px solid #f5e9d8', display:'flex', alignItems:'center', gap:8}}>
                <span style={{color:'#c98a2e'}}>{MI.alert}</span>
                <span style={{flex:1, fontSize:12, color:'#5b544c'}}>{s.crew.find(c => c.flag).flag} — {s.crew.find(c => c.flag).n.split(' ')[0]}</span>
                <button style={{padding:'4px 10px', background:'#c98a2e', color:'#fff', border:'none', borderRadius:6, fontFamily:'inherit', fontSize:11, fontWeight:600}}>Open</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <ForemanTabs active="crew"/>
    </div>
  );
}

Object.assign(window, {
  ForemanToday, ForemanDailyLog, ForemanScheduleAhead, ForemanField,
  ForemanBriefCrew, ForemanCrew, ForemanTabs,
  StateOffline, StateError, StateEmpty, StateLoading, StatePermissionDenied,
});
