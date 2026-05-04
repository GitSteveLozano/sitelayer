/* global React, MI, MTopBar, MLargeHead, MSectionH, MRow, MKpi, MPill, MBottomTabs, MQA, MAvatarGroup, MBanner, MStage */

// ============================================================
// SECTION 14 — WORKER APP COMPLETION
//   WorkerToday already exists. Adding:
//   - WorkerClockInSuccess  (auto clock-in happy path)
//   - WorkerScopeToday      (today's scope detail)
//   - WorkerIssue           (one-tap blocker → foreman ping)
//   (WorkerLogPhoto already covers Photo capture)
// ============================================================

// Reusable worker bottom tabs (dark)
function WorkerTabs({ active = 'today' }) {
  const tabs = [
    {l:'Today', id:'today', i:MI.home},
    {l:'Scope', id:'scope', i:MI.layers},
    {l:'Hours', id:'hours', i:MI.time},
    {l:'Crew',  id:'crew',  i:MI.users},
  ];
  return (
    <div style={{display:'flex', height:64, background:'#0e0c0a', borderTop:'1px solid #2a241c', flexShrink:0}}>
      {tabs.map(t => (
        <div key={t.id} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3, color: active === t.id ? '#d9904a' : '#5a5346'}}>
          {t.i}
          <span style={{fontSize:10, fontWeight: active === t.id ? 600 : 500}}>{t.l}</span>
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────
// Auto clock-in success — the headline P0 surface
// ────────────────────────────────────────────────────────
function WorkerClockInSuccess() {
  return (
    <div className="m" style={{background:'#0e0c0a', color:'#f3ecdf'}}>
      {/* hero map showing geofence + you */}
      <div style={{position:'relative', height:240, overflow:'hidden', background:'#1c1816'}}>
        <svg viewBox="0 0 290 240" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
          {/* terrain */}
          <rect width="290" height="240" fill="#1c1816"/>
          <g opacity=".4" stroke="#3a3128" strokeWidth=".8" fill="none">
            <path d="M0 60 Q72 40 145 65 T290 50"/>
            <path d="M0 100 Q90 88 180 110 T290 100"/>
            <path d="M0 150 Q60 130 130 145 T290 130"/>
            <path d="M0 200 Q80 180 160 195 T290 190"/>
          </g>
          {/* roads */}
          <path d="M0 130 L290 110" stroke="#2a241c" strokeWidth="14"/>
          <path d="M0 130 L290 110" stroke="#3a3128" strokeWidth="1" strokeDasharray="6,4"/>
          <path d="M180 0 L165 240" stroke="#2a241c" strokeWidth="10"/>
          {/* building footprints */}
          <g fill="#2a241c">
            <rect x="55" y="135" width="44" height="32" rx="2"/>
            <rect x="105" y="138" width="36" height="28" rx="2"/>
            <rect x="200" y="125" width="38" height="36" rx="2"/>
          </g>
          {/* geofence circle */}
          <circle cx="120" cy="150" r="56" fill="rgba(217,144,74,.10)" stroke="#d9904a" strokeWidth="1.5" strokeDasharray="3,2"/>
          {/* you, pulsing pin */}
          <g transform="translate(120 150)">
            <circle r="22" fill="rgba(217,144,74,.18)">
              <animate attributeName="r" values="14;26;14" dur="2.4s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values=".6;.05;.6" dur="2.4s" repeatCount="indefinite"/>
            </circle>
            <circle r="8" fill="#d9904a" stroke="#0e0c0a" strokeWidth="2"/>
          </g>
          {/* north chip */}
          <g transform="translate(258 14)">
            <circle r="10" fill="rgba(0,0,0,.5)" stroke="#3a3128"/>
            <text textAnchor="middle" y="3.5" fontSize="9" fontWeight="700" fill="#d9904a" fontFamily="Geist Mono, monospace">N</text>
          </g>
        </svg>
        <div style={{position:'absolute', top:14, left:14, padding:'4px 10px', background:'rgba(0,0,0,.5)', backdropFilter:'blur(8px)', borderRadius:10, fontSize:10, fontWeight:600, color:'#aea69a', letterSpacing:'.04em', textTransform:'uppercase'}}>You're on site</div>
      </div>

      {/* big confirmation */}
      <div style={{padding:'22px 22px 14px', textAlign:'center'}}>
        <div style={{width:64, height:64, margin:'0 auto 14px', background:'rgba(44,138,85,.18)', borderRadius:32, display:'flex', alignItems:'center', justifyContent:'center', position:'relative'}}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#7adba0" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7"/></svg>
          <div style={{position:'absolute', inset:0, borderRadius:32, border:'2px solid #2c8a55', opacity:.35, animation:'pulseRing 2s ease-out infinite'}}/>
        </div>
        <div style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em', color:'#f3ecdf'}}>You're clocked in</div>
        <div style={{fontSize:13, color:'#aea69a', marginTop:6, lineHeight:1.5, maxWidth:260, marginLeft:'auto', marginRight:'auto'}}>Walked into the Hillcrest geofence at <strong style={{color:'#d9904a', fontFeatureSettings:'"tnum"'}}>7:02 AM</strong> · auto-clocked.</div>
      </div>

      {/* details strip */}
      <div style={{padding:'0 20px 12px'}}>
        <div style={{padding:'12px 14px', background:'#1c1816', border:'1px solid #2a241c', borderRadius:12}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:0}}>
            <div>
              <div style={{fontSize:9, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Project</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:4, color:'#f3ecdf'}}>Hillcrest</div>
            </div>
            <div style={{borderLeft:'1px solid #2a241c', borderRight:'1px solid #2a241c', paddingLeft:12}}>
              <div style={{fontSize:9, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Scope</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:4, color:'#f3ecdf'}}>EPS · East</div>
            </div>
            <div style={{paddingLeft:12}}>
              <div style={{fontSize:9, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Rate</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:4, color:'#f3ecdf', fontFeatureSettings:'"tnum"'}}>$28/hr</div>
            </div>
          </div>
        </div>
      </div>

      {/* corrections */}
      <div style={{padding:'0 20px'}}>
        <button style={{width:'100%', padding:'12px 14px', background:'transparent', border:'1px solid #2a241c', borderRadius:12, color:'#aea69a', fontFamily:'inherit', fontSize:12, textAlign:'left', display:'flex', alignItems:'center', gap:10}}>
          <span style={{color:'#8a8278'}}>{MI.edit}</span>
          <span style={{flex:1}}>Wrong project? Tap to fix · 2 min window</span>
          <span style={{color:'#8a8278'}}>{MI.chev}</span>
        </button>
      </div>

      <div style={{flex:1}}/>

      {/* CTA */}
      <div style={{padding:'14px 20px 16px'}}>
        <button style={{width:'100%', height:50, background:'#d9904a', border:'none', borderRadius:12, color:'#fff', fontFamily:'inherit', fontSize:15, fontWeight:600}}>See today's scope</button>
      </div>

      <WorkerTabs active="today"/>
      <style>{`
        @keyframes pulseRing { 0%{transform:scale(1);opacity:.4;} 100%{transform:scale(1.4);opacity:0;} }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// Today's scope — what the worker is doing today
// ────────────────────────────────────────────────────────
function WorkerScopeToday() {
  return (
    <div className="m" style={{background:'#0e0c0a', color:'#f3ecdf'}}>
      <div style={{padding:'14px 20px 6px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Today's scope</div>
        <div style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em', marginTop:4}}>EPS · East elevation</div>
        <div style={{fontSize:12, color:'#aea69a', marginTop:4}}>Hillcrest · day 18 of 32</div>
      </div>

      {/* Goal card */}
      <div style={{padding:'12px 20px 8px'}}>
        <div style={{padding:'14px', background:'#1c1816', border:'1px solid #2a241c', borderRadius:14}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:8}}>
            <span style={{fontSize:11, color:'#aea69a', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Today's goal</span>
            <span style={{fontSize:11, color:'#d9904a', fontWeight:600, fontFeatureSettings:'"tnum"'}}>1,284 sf</span>
          </div>
          <div style={{fontSize:14, color:'#f3ecdf', lineHeight:1.45, fontWeight:500}}>Anchor + plate east wall, top to bottom — leave the cornice for tomorrow.</div>
          {/* progress */}
          <div style={{marginTop:14}}>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:10, color:'#8a8278', fontFeatureSettings:'"tnum"', marginBottom:6, letterSpacing:'.04em'}}>
              <span>720 SF DONE</span><span>56% OF TODAY</span>
            </div>
            <div style={{height:6, background:'#0e0c0a', borderRadius:3, overflow:'hidden'}}>
              <div style={{width:'56%', height:'100%', background:'linear-gradient(90deg, #d9904a, #e8a86b)'}}/>
            </div>
          </div>
          {/* Scope author footer — who scoped today's work */}
          <div style={{marginTop:14, paddingTop:12, borderTop:'1px solid #2a241c', display:'flex', alignItems:'center', gap:10}}>
            <div className="m-avatar" data-size="sm" data-tone="1" style={{flexShrink:0}}>AC</div>
            <div style={{flex:1, minWidth:0, fontSize:11, color:'#aea69a'}}>Scoped by <span style={{color:'#f3ecdf', fontWeight:600}}>Ana Castillo</span> · 6:42 AM</div>
          </div>
        </div>
      </div>

      {/* Steps */}
      <div style={{padding:'12px 20px 4px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Steps</div>
        {[
          {n:'Insulation board (EPS 1.5")', q:'24 sheets', done:true, who:'7:00–9:30 · all'},
          {n:'Plate fasteners', q:'~620 anchors', done:true, who:'9:30–11:00'},
          {n:'Mesh + corner bead', q:'East wall + window jambs', done:false, active:true, who:'now → 14:00'},
          {n:'Cleanup + cover', q:'Tarp scaffold for overnight', done:false, who:'14:30–15:00'},
        ].map((s, i) => (
          <div key={i} style={{padding:'12px', marginBottom:8, background: s.active ? 'rgba(217,144,74,.08)' : '#1c1816', border: s.active ? '1px solid rgba(217,144,74,.40)' : '1px solid #2a241c', borderRadius:12, display:'flex', alignItems:'center', gap:12}}>
            <div style={{width:26, height:26, borderRadius:13, background: s.done ? '#2c8a55' : s.active ? '#d9904a' : 'transparent', border: s.done || s.active ? 'none' : '1.5px solid #4a3f33', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, color:'#fff'}}>
              {s.done ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M5 12l5 5L20 7"/></svg> : <span style={{fontSize:11, fontWeight:700, fontFeatureSettings:'"tnum"', color: s.active ? '#fff' : '#8a8278'}}>{i+1}</span>}
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:13, fontWeight: s.active ? 600 : 500, color: s.done ? '#aea69a' : '#f3ecdf', textDecoration: s.done ? 'line-through' : 'none', textDecorationColor:'#5a5346'}}>{s.n}</div>
              <div style={{fontSize:11, color:'#8a8278', marginTop:2, fontFeatureSettings:'"tnum"'}}>{s.q} · {s.who}</div>
            </div>
            {s.active && <span style={{fontSize:10, fontWeight:700, color:'#d9904a', letterSpacing:'.06em'}}>NOW</span>}
          </div>
        ))}
      </div>

      {/* Materials staged */}
      <div style={{padding:'4px 20px 12px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>On site for you</div>
        <div style={{padding:'10px 14px', background:'#1c1816', border:'1px solid #2a241c', borderRadius:12, display:'flex', alignItems:'center', gap:10, fontSize:12, color:'#aea69a'}}>
          <span style={{color:'#7adba0'}}>{MI.check}</span>
          <span style={{flex:1}}>Materials staged at south gate · scaffold A is yours</span>
        </div>
      </div>

      <div style={{flex:1}}/>
      <WorkerTabs active="scope"/>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// Issue / blocker — one tap, foreman gets ping
// ────────────────────────────────────────────────────────
function WorkerIssue() {
  return (
    <div className="m" style={{background:'#0e0c0a', color:'#f3ecdf'}}>
      <div style={{padding:'14px 20px 8px', display:'flex', alignItems:'center', gap:12}}>
        <button style={{width:36, height:36, background:'#1c1816', border:'1px solid #2a241c', borderRadius:18, color:'#f3ecdf', display:'flex', alignItems:'center', justifyContent:'center'}}>{MI.close}</button>
        <div style={{flex:1, fontSize:17, fontWeight:600}}>Flag a problem</div>
      </div>

      {/* Big buttons — preset blockers */}
      <div style={{padding:'8px 20px 4px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:10}}>What's the issue?</div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
          {[
            {l:'Out of materials', sub:'Need delivery', i:MI.layers, t:'#d9904a', selected:true},
            {l:'Equipment broken', sub:'Tool / scaffold', i:MI.alert, t:'#c0463d'},
            {l:'Safety concern', sub:'Stop work',     i:MI.alert, t:'#c0463d'},
            {l:'Weather hold',    sub:'Rain / wind',  i:MI.bolt,  t:'#c98a2e'},
            {l:'Scope question',  sub:'Need clarity', i:MI.edit,  t:'#5b8aa8'},
            {l:'Other',           sub:'Type it out',  i:MI.more,  t:'#aea69a'},
          ].map(b => (
            <button key={b.l} style={{padding:'14px 12px', background: b.selected ? 'rgba(217,144,74,.08)' : '#1c1816', border: b.selected ? '1.5px solid #d9904a' : '1px solid #2a241c', borderRadius:12, color:'#f3ecdf', display:'flex', flexDirection:'column', alignItems:'flex-start', gap:6, fontFamily:'inherit', textAlign:'left'}}>
              <span style={{color:b.t}}>{b.i}</span>
              <span style={{fontSize:13, fontWeight:600}}>{b.l}</span>
              <span style={{fontSize:10, color:'#8a8278'}}>{b.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Detail */}
      <div style={{padding:'14px 20px 4px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>What do you need?</div>
        <div style={{padding:'12px 14px', background:'#1c1816', border:'1px solid #2a241c', borderRadius:12, fontSize:13, color:'#f3ecdf', lineHeight:1.5, minHeight:72}}>
          Out of EPS 1.5" — used the last 4 sheets on the south corner. Need 12 more to finish today.
          <span style={{display:'inline-block', width:1.5, height:14, background:'#d9904a', verticalAlign:'middle', marginLeft:1, animation:'blink 1s infinite'}}/>
        </div>
      </div>

      {/* Optional photo */}
      <div style={{padding:'8px 20px'}}>
        <button style={{width:'100%', padding:'10px 14px', background:'transparent', border:'1px dashed #4a3f33', borderRadius:12, color:'#aea69a', fontFamily:'inherit', fontSize:12, display:'flex', alignItems:'center', gap:10}}>
          <span style={{color:'#d9904a'}}>{MI.cam}</span>
          <span style={{flex:1, textAlign:'left'}}>Add photo (optional)</span>
        </button>
      </div>

      {/* Who gets it */}
      <div style={{padding:'14px 20px 4px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Going to</div>
        <div style={{padding:'10px 12px', background:'#1c1816', border:'1px solid #2a241c', borderRadius:12, display:'flex', alignItems:'center', gap:10}}>
          <div className="m-avatar" data-size="sm" data-tone="1">AC</div>
          <div style={{flex:1}}>
            <div style={{fontSize:13, fontWeight:600, color:'#f3ecdf'}}>Ana Castillo · foreman</div>
            <div style={{fontSize:11, color:'#aea69a'}}>+ Sarah (PM) on materials issues</div>
          </div>
          <span style={{fontSize:11, color:'#7adba0', fontWeight:600}}>● online</span>
        </div>
      </div>

      <div style={{flex:1}}/>

      <div style={{padding:'14px 20px 18px'}}>
        <button style={{width:'100%', height:52, background:'#d9904a', border:'none', borderRadius:12, color:'#fff', fontFamily:'inherit', fontSize:15, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:8}}>
          <span>{MI.send}</span>Send to Ana
        </button>
        <div style={{textAlign:'center', fontSize:11, color:'#8a8278', marginTop:10}}>She'll get a push notification right away</div>
      </div>
    </div>
  );
}

// ============================================================
// SECTION 15 — GEOFENCE & MAP SURFACES
// ============================================================

// Helper to draw a stylized site map (parcel + buildings + streets)
function MapBackground({ tone = 'light' }) {
  const isDark = tone === 'dark';
  const colors = isDark
    ? { bg:'#1c1816', land:'#2a241c', road:'#3a3128', stroke:'#4a3f33', label:'#8a8278' }
    : { bg:'#eee7da', land:'#dfd5c2', road:'#c8b89d', stroke:'#aea69a', label:'#5b544c' };
  return (
    <svg viewBox="0 0 290 280" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
      <rect width="290" height="280" fill={colors.bg}/>
      {/* parcels */}
      <g fill={colors.land} stroke={colors.stroke} strokeWidth=".5" opacity=".7">
        <rect x="0" y="0" width="120" height="140" rx="2"/>
        <rect x="170" y="0" width="120" height="140" rx="2"/>
        <rect x="0" y="170" width="120" height="110" rx="2"/>
        <rect x="170" y="170" width="120" height="110" rx="2"/>
      </g>
      {/* roads */}
      <rect x="120" y="0" width="50" height="280" fill={colors.road}/>
      <rect x="0" y="140" width="290" height="30" fill={colors.road}/>
      <line x1="145" y1="0" x2="145" y2="280" stroke={isDark ? '#5a5043' : '#fff'} strokeWidth=".8" strokeDasharray="6,5" opacity=".6"/>
      <line x1="0" y1="155" x2="290" y2="155" stroke={isDark ? '#5a5043' : '#fff'} strokeWidth=".8" strokeDasharray="6,5" opacity=".6"/>
    </svg>
  );
}

// ────────────────────────────────────────────────────────
// Project setup — draw geofence
// ────────────────────────────────────────────────────────
function GeofenceProjectSetup() {
  return (
    <div className="m">
      {/* Header */}
      <div style={{height:52, padding:'8px 16px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #e8e3db'}}>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#5b544c'}}>Back</button>
        <div style={{flex:1, textAlign:'center'}}>
          <div style={{fontSize:15, fontWeight:600}}>Set geofence</div>
          <div style={{fontSize:10, color:'#8a8278'}}>Step 3 of 4 · new project</div>
        </div>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#d9904a', fontWeight:600}}>Save</button>
      </div>

      {/* Map canvas */}
      <div style={{position:'relative', flex:1, minHeight:0, overflow:'hidden'}}>
        <MapBackground/>
        {/* Buildings on parcel */}
        <svg style={{position:'absolute', inset:0}} viewBox="0 0 290 280" preserveAspectRatio="xMidYMid slice">
          <g fill="#3a3128">
            <rect x="40" y="40" width="56" height="40" rx="2"/>
            <rect x="40" y="90" width="40" height="32" rx="2"/>
            <rect x="86" y="90" width="40" height="32" rx="2"/>
          </g>
          {/* Geofence circle (editable) */}
          <circle cx="80" cy="80" r="64" fill="rgba(217,144,74,.18)" stroke="#d9904a" strokeWidth="2"/>
          {/* center marker */}
          <g transform="translate(80 80)">
            <circle r="8" fill="#d9904a" stroke="#fff" strokeWidth="2"/>
            <circle r="2" fill="#fff"/>
          </g>
          {/* drag handles */}
          {[
            {x:80, y:16},
            {x:144, y:80},
            {x:80, y:144},
            {x:16, y:80},
          ].map((h, i) => (
            <g key={i} transform={`translate(${h.x} ${h.y})`}>
              <circle r="9" fill="#fff" stroke="#d9904a" strokeWidth="2"/>
              <circle r="2.5" fill="#d9904a"/>
            </g>
          ))}
        </svg>

        {/* Address chip */}
        <div style={{position:'absolute', top:12, left:12, right:12, padding:'10px 12px', background:'rgba(255,255,255,.96)', backdropFilter:'blur(8px)', borderRadius:10, border:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:10}}>
          <span style={{color:'#d9904a'}}>{MI.pin}</span>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:12, fontWeight:600}}>4820 Crestline Dr</div>
            <div style={{fontSize:10, color:'#8a8278'}}>Calgary AB · T3R 0A1</div>
          </div>
          <button style={{fontSize:11, color:'#d9904a', fontWeight:600, background:'transparent', border:'none'}}>Edit</button>
        </div>

        {/* Radius readout */}
        <div style={{position:'absolute', bottom:84, right:12, padding:'8px 10px', background:'rgba(28,24,22,.92)', backdropFilter:'blur(8px)', borderRadius:10, color:'#f3ecdf', fontSize:11, fontFeatureSettings:'"tnum"'}}>
          <div style={{fontSize:9, color:'#aea69a', letterSpacing:'.06em', textTransform:'uppercase', fontWeight:600}}>Radius</div>
          <div style={{fontSize:14, fontWeight:600, marginTop:2}}>120 m</div>
        </div>
      </div>

      {/* Tweak panel */}
      <div style={{padding:'12px 16px 14px', borderTop:'1px solid #e8e3db', background:'#fff', flexShrink:0}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10}}>
          <span style={{fontSize:12, fontWeight:600}}>Geofence radius</span>
          <span style={{fontSize:11, color:'#8a8278'}}>covers parcel + ~5m buffer</span>
        </div>
        {/* slider */}
        <div style={{position:'relative', height:6, background:'#f5f1ec', borderRadius:3, marginBottom:10}}>
          <div style={{width:'48%', height:'100%', background:'#d9904a', borderRadius:3}}/>
          <div style={{position:'absolute', left:'48%', top:'50%', transform:'translate(-50%, -50%)', width:20, height:20, background:'#fff', border:'2px solid #d9904a', borderRadius:10, boxShadow:'0 1px 3px rgba(0,0,0,.15)'}}/>
        </div>
        <div style={{display:'flex', justifyContent:'space-between', fontSize:10, color:'#8a8278', fontFeatureSettings:'"tnum"', marginBottom:14}}>
          <span>50 m</span><span style={{color:'#d9904a', fontWeight:600}}>120 m</span><span>300 m</span>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10}}>
          <div style={{padding:'10px', background:'#f7f4ef', borderRadius:10}}>
            <div style={{fontSize:10, color:'#8a8278', fontWeight:600, letterSpacing:'.04em', textTransform:'uppercase'}}>Auto clock-in</div>
            <div style={{fontSize:13, fontWeight:600, marginTop:2}}>On entry</div>
          </div>
          <div style={{padding:'10px', background:'#f7f4ef', borderRadius:10}}>
            <div style={{fontSize:10, color:'#8a8278', fontWeight:600, letterSpacing:'.04em', textTransform:'uppercase'}}>Auto clock-out</div>
            <div style={{fontSize:13, fontWeight:600, marginTop:2}}>5 min after exit</div>
          </div>
        </div>
        <div style={{padding:'10px 12px', background:'#f7f4ef', borderRadius:10, fontSize:11, color:'#5b544c', display:'flex', alignItems:'flex-start', gap:8, lineHeight:1.45}}>
          <span style={{color:'#d9904a', flexShrink:0}}>{MI.spark}</span>
          <span>Drag the orange handles to reshape. Smaller is more accurate but workers get false-negatives near the edge.</span>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// Foreman live crew map — pins for each crew member
// ────────────────────────────────────────────────────────
function ForemanCrewMap() {
  const crew = [
    { i:'AC', n:'Ana C.',    t:1, x:88,  y:72,  status:'on',  hrs:'4:24' },
    { i:'ML', n:'Marcus L.', t:2, x:62,  y:96,  status:'on',  hrs:'4:18' },
    { i:'TR', n:'Tomás R.',  t:5, x:106, y:104, status:'on',  hrs:'4:14' },
    { i:'SB', n:'Sara B.',   t:7, x:204, y:188, status:'off', hrs:null    }, // outside fence
  ];
  return (
    <div className="m">
      <MTopBar back title="Crew on site" sub="Hillcrest · 3 of 4 in fence" action="filter" actionIcon={MI.filter}/>

      {/* Map */}
      <div style={{position:'relative', height:340, overflow:'hidden', borderBottom:'1px solid #e8e3db'}}>
        <MapBackground/>
        <svg style={{position:'absolute', inset:0}} viewBox="0 0 290 280" preserveAspectRatio="xMidYMid slice">
          {/* Buildings */}
          <g fill="#3a3128" opacity=".85">
            <rect x="40" y="40" width="56" height="40" rx="2"/>
            <rect x="40" y="90" width="40" height="32" rx="2"/>
            <rect x="86" y="90" width="40" height="32" rx="2"/>
          </g>
          {/* Geofence */}
          <circle cx="80" cy="80" r="64" fill="rgba(44,138,85,.10)" stroke="#2c8a55" strokeWidth="1.5" strokeDasharray="3,2"/>
          {/* Project label */}
          <g transform="translate(80 18)">
            <rect x="-32" y="-9" width="64" height="18" rx="9" fill="rgba(28,24,22,.86)"/>
            <text textAnchor="middle" y="3.5" fontSize="9" fontWeight="700" fill="#d9904a" fontFamily="Geist Mono, monospace" letterSpacing=".05em">HILLCREST</text>
          </g>
          {/* Out-of-fence dotted line */}
          <line x1="80" y1="80" x2="204" y2="188" stroke="#c98a2e" strokeWidth="1" strokeDasharray="3,3" opacity=".6"/>
        </svg>

        {/* Crew pins (DOM so labels look right) */}
        {crew.map(c => (
          <div key={c.i} style={{position:'absolute', left: `${(c.x/290)*100}%`, top:`${(c.y/280)*100}%`, transform:'translate(-50%, -50%)', display:'flex', flexDirection:'column', alignItems:'center'}}>
            <div className="m-avatar" data-size="sm" data-tone={c.t} style={{border: c.status === 'on' ? '2px solid #2c8a55' : '2px solid #c98a2e', boxShadow:'0 2px 6px rgba(0,0,0,.25)'}}>{c.i}</div>
            {c.status === 'on' && (
              <div style={{position:'absolute', inset:0, borderRadius:14, border:'2px solid #2c8a55', opacity:.45, animation:'pulseDot 2.4s ease-out infinite', pointerEvents:'none'}}/>
            )}
            <div style={{marginTop:4, padding:'2px 6px', background:'rgba(28,24,22,.92)', borderRadius:6, fontSize:9, fontWeight:600, color:'#fff', whiteSpace:'nowrap'}}>{c.n}</div>
          </div>
        ))}

        {/* Out-of-fence callout */}
        <div style={{position:'absolute', bottom:10, left:10, right:10, padding:'8px 10px', background:'rgba(201,138,46,.94)', backdropFilter:'blur(8px)', borderRadius:10, color:'#fff', fontSize:11, display:'flex', alignItems:'center', gap:8}}>
          <span>{MI.alert}</span>
          <span style={{flex:1}}><strong>Sara B. is 480m outside the fence.</strong> Hours need manual approval.</span>
        </div>

        {/* Map controls */}
        <div style={{position:'absolute', top:10, right:10, display:'flex', flexDirection:'column', gap:6}}>
          <button style={{width:32, height:32, background:'rgba(255,255,255,.96)', border:'1px solid #e8e3db', borderRadius:8, fontSize:18, fontWeight:700, color:'#1c1816'}}>+</button>
          <button style={{width:32, height:32, background:'rgba(255,255,255,.96)', border:'1px solid #e8e3db', borderRadius:8, fontSize:18, fontWeight:700, color:'#1c1816'}}>−</button>
        </div>

        <style>{`@keyframes pulseDot { 0%{transform:scale(1);opacity:.55;} 100%{transform:scale(1.6);opacity:0;} }`}</style>
      </div>

      <div className="m-body">
        <div className="m-section-h">Roster · live</div>
        <div className="m-list-inset">
          {crew.map(c => (
            <div key={c.i} style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
              <div className="m-avatar" data-size="sm" data-tone={c.t}>{c.i}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:13, fontWeight:600}}>{c.n}</div>
                <div style={{fontSize:11, color: c.status === 'on' ? '#2c8a55' : '#c98a2e', fontFeatureSettings:'"tnum"'}}>
                  {c.status === 'on' ? `In fence · clocked ${c.hrs}` : 'Outside fence · not clocked'}
                </div>
              </div>
              {c.status === 'on'
                ? <span className="m-pill" data-tone="green" dot>on</span>
                : <button className="m-btn m-btn-sm" data-variant="ghost">Manual clock</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SECTION 16 — DECISION NOTES (dashboard / nav)
// These are wrapper screens that show a "decision" overlay on top
// of an existing screen.
// ============================================================

function DecisionOverlay({ verdict = 'rejected', title, body, children }) {
  const tone = verdict === 'rejected'
    ? { fg:'#c0463d', bg:'rgba(192,70,61,.06)', stripe:'#c0463d' }
    : { fg:'#2c8a55', bg:'rgba(44,138,85,.06)', stripe:'#2c8a55' };
  return (
    <div style={{position:'relative', width:'100%', height:'100%'}}>
      {/* dimmed underlay */}
      <div style={{position:'absolute', inset:0, opacity:.35, filter:'grayscale(.4)', pointerEvents:'none'}}>{children}</div>
      {/* Hatch overlay */}
      <div style={{position:'absolute', inset:0, background:'repeating-linear-gradient(135deg, transparent 0 8px, rgba(0,0,0,.025) 8px 9px)', pointerEvents:'none'}}/>
      {/* Stamp + note */}
      <div style={{position:'absolute', top:14, right:14, padding:'4px 10px', background: tone.fg, color:'#fff', fontSize:9, fontWeight:700, letterSpacing:'.1em', textTransform:'uppercase', borderRadius:4, transform:'rotate(6deg)', boxShadow:'0 2px 6px rgba(0,0,0,.18)'}}>
        {verdict === 'rejected' ? 'Not shipping' : 'Decided'}
      </div>
      <div style={{position:'absolute', bottom:18, left:14, right:14, padding:'12px 14px', background: tone.bg, border:`1px solid ${tone.fg}55`, borderLeft:`3px solid ${tone.stripe}`, borderRadius:10, backdropFilter:'blur(4px)'}}>
        <div style={{fontSize:11, fontWeight:700, color: tone.fg, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:4}}>{title}</div>
        <div style={{fontSize:11, color:'#1c1816', lineHeight:1.45}}>{body}</div>
      </div>
    </div>
  );
}

// ============================================================
// SECTION 17 — DASHBOARD CALM + ATTENTION (default + filter)
// Replaces standalone DashboardAttention. Calm is default; tapping
// "What needs me?" pivots into the prioritized list inline.
// ============================================================

function DashboardCalmDefault() {
  return (
    <div className="m" style={{background:'#f5f1ec'}}>
      <div style={{padding:'18px 20px 6px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Mon · Apr 28 · 7:42 AM</div>
        <div style={{fontSize:34, fontWeight:700, letterSpacing:'-0.025em', lineHeight:1.0, marginTop:6}}>You're<br/>caught up.</div>
        <div style={{fontSize:13, color:'#5b544c', marginTop:10, lineHeight:1.45}}>Nothing's on fire. 3 jobs are running, 18 crew are clocked in, the day's plan is set.</div>
      </div>

      {/* Filter chips — default to 'Today' */}
      <div style={{padding:'18px 16px 6px', display:'flex', gap:6, overflow:'auto'}}>
        <button className="m-chip" data-active="true">Today</button>
        <button className="m-chip" style={{display:'flex', alignItems:'center', gap:5}}>
          <span style={{width:6, height:6, borderRadius:3, background:'#aea69a'}}/>
          What needs me?
        </button>
        <button className="m-chip">This week</button>
        <button className="m-chip">All sites</button>
      </div>

      <div className="m-body" style={{padding:'10px 0 0'}}>
        <div style={{padding:'0 16px', display:'grid', gap:10}}>
          {[
            {l:'Hillcrest', sub:'EPS east · 3 on site', n:'4.2', u:'h'},
            {l:'Aspen Ridge', sub:'Basecoat · 4 on site', n:'3.8', u:'h'},
            {l:'Greenwillow', sub:'Punch · 1 on site', n:'1.5', u:'h'},
          ].map(p => (
            <div key={p.l} style={{padding:'14px 16px', background:'#fff', borderRadius:14, display:'flex', alignItems:'center'}}>
              <div style={{flex:1}}>
                <div style={{fontSize:14, fontWeight:600}}>{p.l}</div>
                <div style={{fontSize:11, color:'#8a8278', marginTop:2}}>{p.sub}</div>
              </div>
              <div style={{textAlign:'right'}}>
                <span style={{fontSize:18, fontWeight:600, fontFeatureSettings:'"tnum"'}}>{p.n}</span>
                <span style={{fontSize:11, color:'#8a8278', marginLeft:2}}>{p.u}</span>
              </div>
            </div>
          ))}
        </div>
        <div style={{textAlign:'center', padding:'40px 30px 20px', fontSize:12, color:'#aea69a', lineHeight:1.5}}>
          Tap a project for detail. Pull down to refresh.
        </div>
      </div>
      <MBottomTabs active="home"/>
    </div>
  );
}

function DashboardCalmFiltered() {
  // Same shell but "What needs me?" is active and the priority list shows
  return (
    <div className="m" style={{background:'#f5f1ec'}}>
      <div style={{padding:'18px 20px 6px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Mon · Apr 28 · 7:42 AM</div>
        <div style={{fontSize:30, fontWeight:700, letterSpacing:'-0.025em', lineHeight:1.0, marginTop:6}}>3 things<br/>need you.</div>
        <div style={{fontSize:13, color:'#5b544c', marginTop:10, lineHeight:1.45}}>Sorted by impact. Tap to handle, swipe to dismiss.</div>
      </div>

      <div style={{padding:'18px 16px 6px', display:'flex', gap:6, overflow:'auto'}}>
        <button className="m-chip">Today</button>
        <button className="m-chip" data-active="true" style={{display:'flex', alignItems:'center', gap:5}}>
          <span style={{width:6, height:6, borderRadius:3, background:'#c98a2e'}}/>
          What needs me? <span style={{opacity:.7, marginLeft:2}}>3</span>
        </button>
        <button className="m-chip">This week</button>
        <button className="m-chip">All sites</button>
      </div>

      <div className="m-body" style={{padding:'10px 0 0'}}>
        <div style={{padding:'0 16px', display:'grid', gap:10}}>
          <div className="m-ai-stripe" data-tone="warn" style={{padding:'14px'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6}}>
              <MAiEyebrow tone="warn">At risk · $3,820 over</MAiEyebrow>
              <button className="m-ai-dismiss" aria-label="Dismiss"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
            </div>
            <div style={{fontSize:14.5, fontWeight:600, lineHeight:1.3, letterSpacing:'-0.005em'}}>Aspen Ridge — labor 18% over plan</div>
            <div style={{fontSize:12, color:'#5b544c', marginTop:4, lineHeight:1.45}}>1.4× target throughput but burning fast. Wed crew added a 5th member without budget update.</div>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginTop:10, paddingTop:10, borderTop:'1px dashed var(--m-line-2)'}}>
              <MAttribution sparkState="muted">Why this card?</MAttribution>
              <button className="m-btn m-btn-sm" data-variant="primary">Open project</button>
            </div>
          </div>
          <div className="m-ai-stripe" data-tone="warn" style={{padding:'14px'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6}}>
              <MAiEyebrow tone="warn">5 to approve · ~$1,840</MAiEyebrow>
              <button className="m-ai-dismiss" aria-label="Dismiss"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
            </div>
            <div style={{fontSize:14.5, fontWeight:600, lineHeight:1.3, letterSpacing:'-0.005em'}}>Time entries waiting since Friday</div>
            <div style={{fontSize:12, color:'#5b544c', marginTop:4, lineHeight:1.45}}>2 anomalies (overtime + GPS-out-of-fence), 3 clean entries.</div>
            <div style={{display:'flex', gap:8, marginTop:10, paddingTop:10, borderTop:'1px dashed var(--m-line-2)'}}>
              <button className="m-btn m-btn-sm" data-variant="primary">Review</button>
              <button className="m-btn m-btn-sm" data-variant="ghost">Approve clean (3)</button>
            </div>
          </div>
          <div className="m-ai-stripe" style={{padding:'14px'}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6}}>
              <MAiEyebrow>Awaiting client · 9 days quiet</MAiEyebrow>
              <button className="m-ai-dismiss" aria-label="Dismiss"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
            </div>
            <div style={{fontSize:14.5, fontWeight:600, lineHeight:1.3, letterSpacing:'-0.005em'}}>Foothills Medical Annex — $156k</div>
            <div style={{fontSize:12, color:'#5b544c', marginTop:4, lineHeight:1.45}}>Sent Apr 19. Last touch: client read receipt Apr 22.</div>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginTop:10, paddingTop:10, borderTop:'1px dashed var(--m-line-2)'}}>
              <MAttribution sparkState="muted">Sent estimates quiet ≥ 7 days surface here.</MAttribution>
              <button className="m-btn m-btn-sm" data-variant="primary">Send nudge</button>
            </div>
          </div>
        </div>
        <div style={{height:24}}/>
      </div>
      <MBottomTabs active="home"/>
    </div>
  );
}

// ============================================================
// SECTION 19 — PROJECT DETAIL — burden card add-on
// Standalone variant that shows just the WTD burden card
// (devs will integrate; this is the spec.)
// ============================================================

function ProjectBurdenCard() {
  return (
    <div className="m">
      <MTopBar back title="Hillcrest Mews" sub="Phase 4 · day 18 of 32"/>
      <div className="m-body">
        {/* Mini summary header */}
        <div style={{padding:'14px 16px 6px'}}>
          <div style={{padding:'12px 14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12, display:'flex', justifyContent:'space-between'}}>
            <div>
              <div style={{fontSize:10, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Status</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:2, color:'#2c8a55'}}>● On track</div>
            </div>
            <div>
              <div style={{fontSize:10, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Crew</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:2, fontFeatureSettings:'"tnum"'}}>3 today · 4 wk</div>
            </div>
            <div>
              <div style={{fontSize:10, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Done</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:2, fontFeatureSettings:'"tnum"'}}>62%</div>
            </div>
          </div>
        </div>

        {/* WTD loaded labor card — primary feature here */}
        <div className="m-section-h">Week-to-date labor cost</div>
        <div style={{padding:'0 16px'}}>
          <div style={{padding:'16px', background:'#fff', border:'1px solid #e8e3db', borderRadius:14}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
              <div>
                <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.05em', textTransform:'uppercase'}}>Loaded labor · this week</div>
                <div style={{fontSize:32, fontWeight:700, letterSpacing:'-0.02em', fontFeatureSettings:'"tnum"', marginTop:6, lineHeight:1}}>$10,163</div>
                <div style={{fontSize:12, color:'#5b544c', marginTop:6}}>187.5 crew-hrs · $54.20/hr loaded</div>
              </div>
              <div style={{textAlign:'right'}}>
                <span className="m-pill" data-tone="green" dot>on plan</span>
                <div style={{fontSize:11, color:'#8a8278', marginTop:6, fontFeatureSettings:'"tnum"'}}>Mon → Thu</div>
              </div>
            </div>

            {/* Day-by-day */}
            <div style={{display:'flex', alignItems:'flex-end', gap:6, height:60, marginTop:18, padding:'0 2px'}}>
              {[
                {d:'M', v:2480, plan:2440, done:true},
                {d:'T', v:2380, plan:2440, done:true},
                {d:'W', v:2620, plan:2440, done:true, over:true},
                {d:'T', v:2683, plan:2440, today:true, over:true},
                {d:'F', v:0, plan:2440},
                {d:'S', v:0, plan:1200},
              ].map(d => {
                const max = 2800;
                const h = (d.v / max) * 50;
                const ph = (d.plan / max) * 50;
                return (
                  <div key={d.d} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4}}>
                    <div style={{flex:1, width:'100%', display:'flex', alignItems:'flex-end', justifyContent:'center', position:'relative'}}>
                      {ph > 0 && <div style={{position:'absolute', bottom:0, width:'70%', height:ph, border:'1px dashed #aea69a', borderRadius:'3px 3px 0 0'}}/>}
                      {h > 0 && <div style={{width:'70%', height:h, background: d.over ? '#c98a2e' : d.today ? '#d9904a' : '#3a3128', borderRadius:'3px 3px 0 0'}}/>}
                    </div>
                    <span style={{fontSize:9, color: d.today ? '#d9904a' : '#8a8278', fontWeight: d.today ? 600 : 500}}>{d.d}</span>
                  </div>
                );
              })}
            </div>

            <div style={{marginTop:14, paddingTop:12, borderTop:'1px solid #f5f1ec', display:'flex', justifyContent:'space-between', fontSize:11}}>
              <div>
                <div style={{color:'#8a8278'}}>WTD spend</div>
                <div style={{fontSize:13, fontWeight:600, marginTop:2, fontFeatureSettings:'"tnum"'}}>$10,163</div>
              </div>
              <div>
                <div style={{color:'#8a8278'}}>WTD budget</div>
                <div style={{fontSize:13, fontWeight:600, marginTop:2, fontFeatureSettings:'"tnum"'}}>$9,760</div>
              </div>
              <div>
                <div style={{color:'#8a8278'}}>Variance</div>
                <div style={{fontSize:13, fontWeight:600, marginTop:2, color:'#c98a2e', fontFeatureSettings:'"tnum"'}}>+$403 (4%)</div>
              </div>
            </div>
          </div>

          <div style={{padding:'10px 14px', background:'#f7f4ef', borderRadius:10, fontSize:11, color:'#5b544c', marginTop:10, lineHeight:1.45, display:'flex', alignItems:'flex-start', gap:8}}>
            <span style={{color:'#d9904a'}}>{MI.spark}</span>
            <span><strong>Wed crew added a 5th member</strong> — that's where the +$403 came from. Adjust budget or scale back Friday?</span>
          </div>
        </div>

        <div style={{height:20}}/>
      </div>
    </div>
  );
}

Object.assign(window, {
  WorkerClockInSuccess,
  WorkerScopeToday,
  WorkerIssue,
  GeofenceProjectSetup,
  ForemanCrewMap,
  DashboardCalmDefault,
  DashboardCalmFiltered,
  ProjectBurdenCard,
});
