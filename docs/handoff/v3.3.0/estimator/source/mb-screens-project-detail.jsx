/* global React, MI, MTopBar, MAttribution, MSpark */

// ============================================================
// PROJECT DETAIL — the linear estimating-canvas page
//
// Model: a project IS the estimate during Drafting. Same page
// across the whole lifecycle; what's visible/editable changes
// with state. No worksheet/proposal split — the proposal is a
// PDF generated when you tap Send.
//
// Lifecycle: Drafting → Sent → Accepted → In progress → Done
//                   (or → Archived w/ loss reason)
// Linear sections: Header → Site/blueprint → Materials → Labor
//                  → Rentals → Totals → Action footer
// ============================================================

const M_LINE = 'var(--m-line)';
const M_SOFT = 'var(--m-card-soft)';

// ---------- shared chrome ----------

function StateChip({ state }) {
  const map = {
    draft:   { l:'Drafting',     bg:'rgba(217,144,74,0.10)', fg:'var(--m-accent-ink)', dot:'var(--m-accent)' },
    sent:    { l:'Sent',         bg:'rgba(47,111,181,0.10)', fg:'#2f6fb5',             dot:'#2f6fb5' },
    accepted:{ l:'Accepted',     bg:'rgba(44,138,85,0.10)',  fg:'#2c8a55',             dot:'#2c8a55' },
    progress:{ l:'In progress',  bg:'rgba(44,138,85,0.10)',  fg:'#2c8a55',             dot:'#2c8a55' },
    done:    { l:'Done',         bg:'var(--m-card-soft)',    fg:'var(--m-ink-2)',      dot:'var(--m-ink-3)' },
  };
  const t = map[state] || map.draft;
  return (
    <span style={{display:'inline-flex', alignItems:'center', gap:5, padding:'3px 8px', background:t.bg, color:t.fg, borderRadius:5, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'.05em'}}>
      <span style={{width:6, height:6, borderRadius:3, background:t.dot}}/>
      {t.l}
    </span>
  );
}

function ProjectHeader({ state, customer, address, totalLabel, totalValue, sub }) {
  return (
    <div style={{padding:'14px 16px 16px', background:'#fff', borderBottom:`1px solid ${M_LINE}`}}>
      <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
        <StateChip state={state}/>
        <span style={{flex:1}}/>
        {sub && <span style={{fontSize:11, color:'var(--m-ink-3)'}}>{sub}</span>}
      </div>
      <div style={{fontSize:11, color:'var(--m-ink-3)', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>{customer}</div>
      <div style={{fontSize:18, fontWeight:700, marginTop:2, letterSpacing:'-0.01em', lineHeight:1.2}}>{address}</div>
      <div style={{display:'flex', alignItems:'baseline', gap:8, marginTop:12}}>
        <span style={{fontSize:10, fontWeight:600, color:'var(--m-ink-3)', letterSpacing:'.06em', textTransform:'uppercase'}}>{totalLabel}</span>
        <span style={{fontSize:30, fontWeight:700, fontFamily:'ui-monospace,monospace', letterSpacing:'-0.025em', lineHeight:1}}>{totalValue}</span>
      </div>
    </div>
  );
}

function SectionH({ label, right }) {
  return (
    <div style={{padding:'14px 16px 8px', display:'flex', alignItems:'baseline', justifyContent:'space-between'}}>
      <span style={{fontSize:11, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em'}}>{label}</span>
      {right && <span style={{fontSize:10.5, color:'var(--m-ink-3)'}}>{right}</span>}
    </div>
  );
}

function Card({ children, accent, dashed, style }) {
  return (
    <div style={{
      padding:'12px 14px', background:'#fff',
      border: dashed ? `1px dashed var(--m-line-2)` : `1px solid ${M_LINE}`,
      borderRadius:10,
      borderLeft: accent ? `3px solid var(--m-accent)` : undefined,
      paddingLeft: accent ? 11 : 14,
      ...style,
    }}>{children}</div>
  );
}

function LineRow({ name, qty, amt, sub, optional, included }) {
  return (
    <Card dashed={optional}>
      <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
        {optional && (
          <div style={{width:18, height:18, borderRadius:5, background: included?'var(--m-accent)':'transparent', border: included?'none':'1.5px solid var(--m-line-2)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1}}>
            {included && <span style={{fontSize:11, fontWeight:700}}>✓</span>}
          </div>
        )}
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:13, fontWeight:600, lineHeight:1.3}}>{name}</div>
          {qty && <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:2}}>{qty}</div>}
          {sub && <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:3, lineHeight:1.45}}>{sub}</div>}
        </div>
        <div style={{fontSize:13, fontWeight:700, fontFamily:'ui-monospace,monospace', flexShrink:0}}>{amt}</div>
      </div>
    </Card>
  );
}

function ActualVsEst({ name, est, actual, status }) {
  const tone = status === 'over' ? '#d9904a' : status === 'under' ? '#2c8a55' : 'var(--m-ink-2)';
  return (
    <Card>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6}}>
        <span style={{fontSize:13, fontWeight:600}}>{name}</span>
        <span style={{fontSize:10, fontWeight:700, color:tone, textTransform:'uppercase', letterSpacing:'.05em'}}>{status === 'over' ? 'Over' : status === 'under' ? 'Under' : 'On track'}</span>
      </div>
      <div style={{display:'flex', alignItems:'baseline', gap:8, fontSize:11, fontFamily:'ui-monospace,monospace'}}>
        <span style={{color:'var(--m-ink-3)'}}>Estimate <span style={{color:'var(--m-ink-2)'}}>{est}</span></span>
        <span style={{color:'var(--m-ink-4)'}}>·</span>
        <span style={{color:'var(--m-ink-3)'}}>Actual <span style={{color:tone, fontWeight:700}}>{actual}</span></span>
      </div>
    </Card>
  );
}

// ============================================================
// 1 · DRAFTING — the linear estimating page
// ============================================================
function ProjectDrafting() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Project" sub="Apr 19 · just created" action="more" actionIcon={MI.more}/>
      <ProjectHeader
        state="draft"
        customer="Acme Holdings · John Marchetti"
        address="Hillcrest Mews — Phase 4"
        totalLabel="Estimate"
        totalValue="$184,250"
        sub="34% margin"
      />

      <div className="m-body" style={{padding:'0 0 14px'}}>
        {/* SITE & BLUEPRINT */}
        <SectionH label="Site & blueprint"/>
        <div style={{padding:'0 14px'}}>
          <Card style={{padding:0, overflow:'hidden'}}>
            <div style={{height:120, background:'linear-gradient(135deg, #ede5d6 0%, #d9cdb5 100%)', position:'relative', borderBottom:`1px solid ${M_LINE}`}}>
              {/* faux blueprint */}
              <svg viewBox="0 0 200 120" width="100%" height="100%" style={{position:'absolute', inset:0}}>
                <g stroke="rgba(60,50,40,0.30)" fill="none" strokeWidth="1">
                  <rect x="20" y="20" width="160" height="80"/>
                  <rect x="40" y="35" width="50" height="30"/>
                  <rect x="100" y="35" width="65" height="30"/>
                  <rect x="40" y="75" width="125" height="20"/>
                  <line x1="20" y1="60" x2="180" y2="60" strokeDasharray="2,2"/>
                </g>
                <g fill="rgba(217,144,74,0.35)" stroke="#d9904a" strokeWidth="1.5">
                  <polygon points="40,35 90,35 90,65 40,65" opacity="0.5"/>
                </g>
              </svg>
              <div style={{position:'absolute', top:8, right:8, padding:'4px 8px', background:'rgba(255,255,255,0.85)', borderRadius:5, fontSize:10, fontWeight:600, color:'var(--m-ink-2)'}}>elevations.pdf</div>
              <div style={{position:'absolute', bottom:8, left:10, padding:'4px 9px', background:'var(--m-ink)', color:'#fff', borderRadius:6, fontSize:10.5, fontWeight:600, display:'flex', alignItems:'center', gap:5}}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/></svg>
                Open canvas
              </div>
            </div>
            <div style={{padding:'10px 12px'}}>
              <div style={{fontSize:13, fontWeight:600}}>2,226 sf measured · 4 elevations</div>
            </div>
          </Card>
        </div>

        {/* MATERIALS */}
        <SectionH label="Materials" right="Auto from measurements"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <LineRow name="Wall assembly" qty="2,226 sf · $4.85/sf" amt="$10,796"/>
          <LineRow name="Stone veneer accent" qty="184 sf · $22.50/sf" amt="$4,140"/>
          <LineRow name="Sealant + flashing" qty="452 lf · $5.10/lf" amt="$2,305"/>
          <button style={{padding:'10px', background:'transparent', color:'var(--m-ink-3)', border:`1px dashed var(--m-line-2)`, borderRadius:9, fontSize:12, fontFamily:'inherit'}}>+ Add material</button>
        </div>

        {/* LABOR */}
        <SectionH label="Labor" right="1,250 hrs"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <LineRow name="Crew · 5 incl. foreman" qty="1,250 hrs × $48/hr" amt="$60,000"/>
          <Card>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
              <div>
                <div style={{fontSize:12, fontWeight:600, color:'var(--m-ink-2)'}}>Working days</div>
                <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>~32 days · 5-person crew</div>
              </div>
              <span style={{color:'var(--m-ink-4)'}}>{MI.chev}</span>
            </div>
          </Card>
        </div>

        {/* RENTALS */}
        <SectionH label="Rentals" right="If needed"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <LineRow name="Scaffold · 32 days" qty="$180/day" amt="$5,760"/>
          <LineRow name="Lift · 4 days" qty="$360/day" amt="$1,440"/>
          <button style={{padding:'10px', background:'transparent', color:'var(--m-ink-3)', border:`1px dashed var(--m-line-2)`, borderRadius:9, fontSize:12, fontFamily:'inherit'}}>+ Add rental</button>
        </div>

        {/* ADD-ONS */}
        <SectionH label="Optional add-ons" right="Client opts in"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <LineRow name="Premium finish + 10-yr warranty" sub="Higher-grade system" amt="$14,200" optional included/>
          <LineRow name="Covered entry · 220 sf" sub="Adds 6 days" amt="$8,450" optional/>
        </div>

        {/* TOTALS */}
        <div style={{padding:'18px 14px 0'}}>
          <Card style={{background:'var(--m-card-soft)'}}>
            <Row l="Materials" v="$17,241"/>
            <Row l="Labor" v="$60,000"/>
            <Row l="Rentals" v="$7,200"/>
            <Row l="Add-ons (included)" v="$14,200"/>
            <div style={{height:1, background:M_LINE, margin:'8px 0'}}/>
            <Row l="Subtotal" v="$98,641" bold/>
            <Row l="Margin · 34%" v="$33,538" muted/>
            <div style={{height:1, background:M_LINE, margin:'8px 0'}}/>
            <Row l="Estimate to client" v="$184,250" big/>
          </Card>
        </div>

        {/* ACTION FOOTER */}
        <div style={{padding:'18px 14px 0'}}>
          <button style={{width:'100%', padding:'14px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:8}}>
            {MI.send}<span>Send proposal to client</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ l, v, bold, muted, big }) {
  return (
    <div style={{display:'flex', justifyContent:'space-between', padding:'5px 0', fontSize: big?14:12.5, fontWeight: bold||big?700:500, color: muted?'var(--m-ink-3)':'var(--m-ink-2)'}}>
      <span>{l}</span>
      <span style={{fontFamily:'ui-monospace,monospace', color: big?'var(--m-ink)':undefined}}>{v}</span>
    </div>
  );
}

// ============================================================
// 2 · BLUEPRINT CANVAS · fullscreen measuring
// ============================================================
function BlueprintCanvasFull() {
  return (
    <div className="m" style={{background:'#1c1816', color:'#f3ecdf', position:'relative'}}>
      {/* top toolbar */}
      <div style={{padding:'12px 14px', display:'flex', alignItems:'center', gap:10, background:'#0e0c0a', borderBottom:'1px solid #2a241c'}}>
        <span style={{color:'#aea69a'}}>{MI.back}</span>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:13, fontWeight:600, color:'#f3ecdf'}}>elevations.pdf · pg 2</div>
          <div style={{fontSize:10.5, color:'#8a8278'}}>2,226 sf · 4 elevations</div>
        </div>
        <button style={{padding:'5px 10px', background:'#d9904a', color:'#fff', border:'none', borderRadius:6, fontSize:11, fontWeight:600, fontFamily:'inherit'}}>Done</button>
      </div>

      {/* canvas */}
      <div style={{flex:1, position:'relative', overflow:'hidden', background:'#0e0c0a'}}>
        <svg viewBox="0 0 290 380" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
          {/* grid */}
          <defs>
            <pattern id="bp-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>
            </pattern>
          </defs>
          <rect width="290" height="380" fill="url(#bp-grid)"/>
          {/* blueprint outline */}
          <g stroke="#5a5346" fill="none" strokeWidth="1.5">
            <rect x="40" y="80" width="210" height="200"/>
            <rect x="60" y="100" width="60" height="60"/>
            <rect x="140" y="100" width="90" height="60"/>
            <rect x="60" y="180" width="170" height="80"/>
            <line x1="40" y1="160" x2="250" y2="160" strokeDasharray="3,3"/>
          </g>
          {/* measured area */}
          <g>
            <polygon points="60,100 120,100 120,160 60,160" fill="rgba(217,144,74,0.30)" stroke="#d9904a" strokeWidth="2"/>
            {/* vertices */}
            {[{x:60,y:100},{x:120,y:100},{x:120,y:160},{x:60,y:160}].map((p,i) => (
              <circle key={i} cx={p.x} cy={p.y} r="5" fill="#d9904a" stroke="#fff" strokeWidth="2"/>
            ))}
            <text x="90" y="135" fill="#fff" fontSize="10" fontWeight="700" textAnchor="middle" fontFamily="ui-monospace,monospace">540 sf</text>
          </g>
          {/* in-progress polygon */}
          <g>
            <polygon points="140,100 230,100 230,160" fill="rgba(47,111,181,0.20)" stroke="#2f6fb5" strokeWidth="2" strokeDasharray="4,3"/>
            <circle cx="140" cy="100" r="5" fill="#2f6fb5" stroke="#fff" strokeWidth="2"/>
            <circle cx="230" cy="100" r="5" fill="#2f6fb5" stroke="#fff" strokeWidth="2"/>
            <circle cx="230" cy="160" r="6" fill="#fff" stroke="#2f6fb5" strokeWidth="2"/>
          </g>
        </svg>

        {/* tool bar (right) */}
        <div style={{position:'absolute', right:10, top:50, display:'flex', flexDirection:'column', gap:6}}>
          {[
            {l:'Polygon', active:true, icon:'△'},
            {l:'Subtract', icon:'⊖'},
            {l:'Scale', icon:'⇔'},
            {l:'Photo', icon:'📷'},
          ].map(t => (
            <button key={t.l} style={{width:38, height:38, borderRadius:9, background: t.active?'#d9904a':'rgba(255,255,255,0.06)', border: t.active?'none':'1px solid #2a241c', color:'#fff', fontSize:14, fontFamily:'inherit', cursor:'pointer'}}>{t.icon}</button>
          ))}
        </div>

        {/* zoom */}
        <div style={{position:'absolute', left:10, top:50, display:'flex', flexDirection:'column', gap:4, background:'rgba(255,255,255,0.06)', borderRadius:8, padding:3, border:'1px solid #2a241c'}}>
          <button style={{width:30, height:30, borderRadius:6, background:'transparent', color:'#f3ecdf', border:'none', fontSize:14, fontFamily:'inherit'}}>+</button>
          <button style={{width:30, height:30, borderRadius:6, background:'transparent', color:'#f3ecdf', border:'none', fontSize:14, fontFamily:'inherit'}}>−</button>
        </div>
      </div>

      {/* bottom — measurements list */}
      <div style={{background:'#0e0c0a', borderTop:'1px solid #2a241c', padding:'10px 14px'}}>
        <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:8}}>
          <span style={{fontSize:10.5, fontWeight:700, color:'#aea69a', textTransform:'uppercase', letterSpacing:'.06em', flex:1}}>Measurements · 4</span>
          <span style={{fontSize:11, color:'#d9904a', fontWeight:600, fontFamily:'ui-monospace,monospace'}}>2,226 sf total</span>
        </div>
        <div style={{display:'flex', gap:6, overflow:'auto'}}>
          {[
            {l:'North wall', v:'540 sf', a:true},
            {l:'East wall', v:'686 sf'},
            {l:'South wall', v:'620 sf'},
            {l:'West wall', v:'380 sf'},
          ].map(m => (
            <div key={m.l} style={{padding:'6px 10px', background: m.a?'rgba(217,144,74,0.15)':'rgba(255,255,255,0.04)', border: m.a?'1px solid #d9904a':'1px solid #2a241c', borderRadius:6, flexShrink:0}}>
              <div style={{fontSize:10, color:'#aea69a'}}>{m.l}</div>
              <div style={{fontSize:11.5, fontWeight:600, color:'#f3ecdf', fontFamily:'ui-monospace,monospace'}}>{m.v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 3 · SHARE PROPOSAL · native-share style sheet
// ============================================================
function ShareProposalSheet() {
  return (
    <div className="m" style={{position:'relative', background:'var(--m-bg)'}}>
      <div style={{padding:'14px 16px 0', opacity:0.4}}>
        <div style={{fontSize:14, fontWeight:600}}>Hillcrest Mews — Phase 4</div>
        <div style={{fontSize:11, color:'var(--m-ink-3)'}}>Estimate · $184,250</div>
      </div>
      <div style={{position:'absolute', inset:0, background:'rgba(20,16,10,0.45)'}}/>

      <div style={{position:'absolute', left:0, right:0, bottom:0, top:50, background:'#fff', borderRadius:'18px 18px 0 0', padding:'14px 16px 18px', display:'flex', flexDirection:'column'}}>
        <div style={{width:38, height:4, background:'var(--m-line-2)', borderRadius:2, margin:'0 auto 14px'}}/>

        {/* PDF preview */}
        <div style={{padding:'12px 14px', background:'var(--m-card-soft)', border:`1px solid ${M_LINE}`, borderRadius:11, marginBottom:14, display:'flex', alignItems:'center', gap:11}}>
          <div style={{width:42, height:54, background:'#fff', border:`1px solid ${M_LINE}`, borderRadius:5, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, color:'#d9904a', fontSize:9, fontWeight:700, fontFamily:'ui-monospace,monospace'}}>PDF</div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:13, fontWeight:600}}>Hillcrest_Mews_Estimate.pdf</div>
            <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>4 pages · $184,250</div>
          </div>
          <span style={{fontSize:11, color:'var(--m-accent-ink)', fontWeight:600}}>Preview</span>
        </div>

        {/* Recipient */}
        <div style={{fontSize:10.5, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6}}>Send to</div>
        <div style={{padding:'10px 12px', background:'#fff', border:`1px solid ${M_LINE}`, borderRadius:10, marginBottom:14, display:'flex', alignItems:'center', gap:10}}>
          <div style={{width:30, height:30, borderRadius:'50%', background:'#2f6fb5', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:600}}>JM</div>
          <div style={{flex:1}}>
            <div style={{fontSize:13, fontWeight:600}}>John Marchetti</div>
            <div style={{fontSize:11, color:'var(--m-ink-3)'}}>john@hillcresthomes.com · (415) 555-0190</div>
          </div>
        </div>

        {/* Native share row */}
        <div style={{fontSize:10.5, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8}}>Send via</div>
        <div style={{display:'flex', gap:10, marginBottom:14}}>
          {[
            {l:'Email', tone:'#1971e8', i:'✉'},
            {l:'iMessage', tone:'#5ac74f', i:'💬'},
            {l:'Copy link', tone:'var(--m-ink)', i:'🔗'},
            {l:'AirDrop', tone:'#0066cc', i:'⬛'},
          ].map(s => (
            <div key={s.l} style={{flex:1, textAlign:'center'}}>
              <div style={{width:48, height:48, background: s.tone, color:'#fff', borderRadius:12, margin:'0 auto 5px', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18}}>{s.i}</div>
              <div style={{fontSize:10.5, color:'var(--m-ink-2)'}}>{s.l}</div>
            </div>
          ))}
        </div>

        <div style={{padding:'9px 11px', background:'rgba(47,111,181,0.06)', border:'1px solid rgba(47,111,181,0.20)', borderRadius:9, marginBottom:12, display:'flex', gap:8, alignItems:'flex-start'}}>
          <MSpark state="muted" size={11}/>
          <div style={{fontSize:11, color:'var(--m-ink-2)', lineHeight:1.4}}>
            We'll track when John opens it. Project moves to <strong>Sent</strong> automatically.
          </div>
        </div>
        <div style={{flex:1}}/>
      </div>
    </div>
  );
}

// ============================================================
// 4 · SENT — the same page, with viewed-by-client banner + accept/decline
// ============================================================
function ProjectSent() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Project" sub="Sent 4 days ago" action="more" actionIcon={MI.more}/>

      {/* Viewed banner */}
      <div style={{padding:'12px 16px', background:'rgba(47,111,181,0.06)', borderBottom:`1px solid ${M_LINE}`}}>
        <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:3}}>
          <span style={{width:8, height:8, borderRadius:'50%', background:'#2f6fb5', boxShadow:'0 0 0 4px rgba(47,111,181,0.18)'}}/>
          <span style={{fontSize:13, fontWeight:700, color:'#2f6fb5'}}>Viewed by client · 3×</span>
        </div>
        <div style={{fontSize:11.5, color:'var(--m-ink-2)', paddingLeft:18}}>Last opened 14 hrs ago · spent 4m on the proposal</div>
      </div>

      <ProjectHeader
        state="sent"
        customer="Acme Holdings · John Marchetti"
        address="Hillcrest Mews — Phase 4"
        totalLabel="Estimate"
        totalValue="$184,250"
      />

      <div className="m-body" style={{padding:'0 0 14px'}}>
        <SectionH label="What they got" right="Tap to view"/>
        <div style={{padding:'0 14px'}}>
          <Card>
            <div style={{display:'flex', alignItems:'center', gap:11}}>
              <div style={{width:36, height:46, background:'var(--m-card-soft)', border:`1px solid ${M_LINE}`, borderRadius:5, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, color:'var(--m-accent-ink)', fontSize:9, fontWeight:700, fontFamily:'ui-monospace,monospace'}}>PDF</div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:13, fontWeight:600}}>Hillcrest_Mews_Estimate.pdf</div>
                <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>5 line items · 2 optional add-ons · $184,250</div>
              </div>
              <span style={{color:'var(--m-ink-4)'}}>{MI.chev}</span>
            </div>
          </Card>
        </div>

        <SectionH label="Activity"/>
        <div style={{padding:'4px 16px', borderLeft:`2px solid ${M_LINE}`, marginLeft:24}}>
          {[
            {t:'Viewed alternates section', d:'14 hrs ago', c:'#2f6fb5'},
            {t:'Opened proposal · 4m', d:'2 days ago', c:'#2f6fb5'},
            {t:'Sent to john@hillcresthomes.com', d:'Apr 19, 4:42 PM', c:'var(--m-ink-3)'},
            {t:'Estimate drafted', d:'Apr 19, 4:30 PM', c:'var(--m-ink-4)'},
          ].map((e,i) => (
            <div key={i} style={{position:'relative', padding:'7px 0 7px 18px'}}>
              <span style={{position:'absolute', left:-6, top:11, width:9, height:9, borderRadius:5, background:'#fff', border:`2px solid ${e.c}`}}/>
              <div style={{fontSize:13, fontWeight:500}}>{e.t}</div>
              <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>{e.d}</div>
            </div>
          ))}
        </div>

        {/* Action footer */}
        <div style={{padding:'18px 14px 0', display:'flex', flexDirection:'column', gap:8}}>
          <button style={{width:'100%', padding:'14px', background:'#2c8a55', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit'}}>Mark accepted · ready to start</button>
          <div style={{display:'flex', gap:8}}>
            <button style={{flex:1, padding:'11px', background:'transparent', color:'var(--m-ink-2)', border:`1px solid ${M_LINE}`, borderRadius:11, fontSize:13, fontFamily:'inherit'}}>Edit + resend</button>
            <button style={{flex:1, padding:'11px', background:'transparent', color:'var(--m-ink-3)', border:`1px solid ${M_LINE}`, borderRadius:11, fontSize:13, fontFamily:'inherit'}}>Archive</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 5 · ACCEPTED — pre-kickoff checklist surfaces, "start work" CTA
// ============================================================
function ProjectAccepted() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Project" sub="Accepted Apr 22" action="more" actionIcon={MI.more}/>
      <ProjectHeader
        state="accepted"
        customer="Acme Holdings · John Marchetti"
        address="Hillcrest Mews — Phase 4"
        totalLabel="Contract"
        totalValue="$184,250"
        sub="Target start May 6"
      />

      {/* Pre-kickoff strip */}
      <div style={{padding:'14px 16px 12px', background:'#fff', borderBottom:`1px solid ${M_LINE}`}}>
        <div style={{fontSize:11, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6}}>Before kickoff</div>
        <div style={{display:'flex', alignItems:'baseline', gap:10, marginBottom:10}}>
          <span style={{fontSize:30, fontWeight:700, fontFamily:'ui-monospace,monospace', letterSpacing:'-0.02em'}}>4<span style={{color:'var(--m-ink-3)', fontWeight:500}}>/11</span></span>
          <span style={{fontSize:11.5, color:'var(--m-ink-3)'}}>10 days to target start</span>
        </div>
        <div style={{height:5, background:M_SOFT, borderRadius:3, overflow:'hidden'}}>
          <div style={{width:'36%', height:'100%', background:'var(--m-accent)'}}/>
        </div>
      </div>

      <div className="m-body" style={{padding:'12px 0 14px'}}>
        <CheckGroup title="Materials">
          <Check label="EPS panels · 4-week lead time" sub="Order by Apr 25" hot done/>
          <Check label="Specialty mix · 2-week lead" sub="Order by May 8"/>
          <Check label="Stone veneer · accent wall" sub="Local stock confirmed"/>
        </CheckGroup>

        <CheckGroup title="Crew">
          <Check label="Foreman assigned · Mike R." done/>
          <Check label="Crew commits · 4 of 4" sub="Jose, Dani, Ahmad, Tomás confirmed"/>
          <Check label="Sub · stone install" sub="Re-confirm Castelli quote" warn/>
        </CheckGroup>

        <CheckGroup title="Site setup">
          <Check label="Draw site geofence" sub="Auto clock-in / out for the crew" hot/>
          <Check label="Add gate code · Lockbox 2734" done/>
        </CheckGroup>

        <CheckGroup title="Approvals">
          <Check label="Permits required?" sub="Tap to mark required / not" hot/>
          <Check label="HOA / architect signoff"/>
          <Check label="Client kickoff call"/>
        </CheckGroup>

        <div style={{padding:'14px 16px 0'}}>
          <button style={{width:'100%', padding:'14px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit'}}>Start work · flip to In progress</button>
          <div style={{fontSize:11, color:'var(--m-ink-3)', textAlign:'center', marginTop:8, lineHeight:1.5}}>
            Available once crew + materials are ✓
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckGroup({ title, children }) {
  return (
    <div style={{padding:'12px 16px 6px'}}>
      <div style={{fontSize:11, fontWeight:700, color:'var(--m-ink-2)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8}}>{title}</div>
      <div style={{display:'flex', flexDirection:'column', gap:6}}>{children}</div>
    </div>
  );
}

function Check({ label, sub, done, warn, hot }) {
  const tone = done ? {bg:'rgba(44,138,85,0.10)', fg:'#2c8a55', border:'rgba(44,138,85,0.25)'}
              : warn ? {bg:'rgba(217,144,74,0.10)', fg:'var(--m-accent-ink)', border:'rgba(217,144,74,0.30)'}
              : {bg:'#fff', fg:'var(--m-ink-3)', border:M_LINE};
  return (
    <div style={{display:'flex', alignItems:'flex-start', gap:11, padding:'10px 12px', background:'#fff', border:`1px solid ${hot?'var(--m-accent)':M_LINE}`, borderRadius:10, borderLeft: hot?'3px solid var(--m-accent)':undefined, paddingLeft: hot?10:12}}>
      <div style={{width:20, height:20, borderRadius:5, background: tone.bg, border: done?'none':`1.5px solid ${tone.border}`, color: tone.fg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1}}>
        {done && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" width="13" height="13"><path d="M5 12l5 5L20 7"/></svg>}
        {warn && <span style={{fontSize:11, fontWeight:700, color: tone.fg}}>!</span>}
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:13, fontWeight:600, lineHeight:1.3, color: done?'var(--m-ink-2)':'var(--m-ink)'}}>{label}</div>
        {sub && <div style={{fontSize:11, color: warn?'var(--m-accent-ink)':'var(--m-ink-3)', marginTop:2, lineHeight:1.4}}>{sub}</div>}
      </div>
      {!done && <span style={{color:'var(--m-ink-4)', flexShrink:0}}>{MI.chev}</span>}
    </div>
  );
}

// ============================================================
// 6 · IN PROGRESS — actuals materialize next to estimates
// ============================================================
function ProjectInProgress() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Project" sub="Day 8 of 32" action="more" actionIcon={MI.more}/>
      <ProjectHeader
        state="progress"
        customer="Acme Holdings · John Marchetti"
        address="Hillcrest Mews — Phase 4"
        totalLabel="Spent · $42k of $121k"
        totalValue="35%"
        sub="On track"
      />

      <div className="m-body" style={{padding:'0 0 14px'}}>
        {/* One-sentence status — answers "is anything on fire?" */}
        <div style={{padding:'18px 18px 16px', background:'#fff', borderBottom:`1px solid ${M_LINE}`}}>
          <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
            <span style={{width:8, height:8, borderRadius:4, background:'#d68a3a', marginTop:7, flexShrink:0}}/>
            <div style={{fontSize:15, lineHeight:1.45, color:'var(--m-ink-1)', textWrap:'pretty'}}>
              On track overall. Materials trending <strong style={{color:'var(--m-accent-ink)'}}>$1.2k over</strong> from last week's stone veneer change — worth a look.
            </div>
          </div>
        </div>

        {/* Action rows — sorted by what's most actionable today */}
        <div style={{padding:'14px 14px 0', display:'flex', flexDirection:'column', gap:6}}>
          <ActionRow icon={MI.users} label="Crew & hours" sub="5 on site · 3 entries to approve" badge="3"/>
          <ActionRow icon={MI.receipt} label="Materials & costs" sub="$1.2k over plan · review change"/>
          <ActionRow icon={MI.cal} label="Schedule" sub="Mon–Fri · 4 crew assigned"/>
          <ActionRow icon={MI.cam} label="Daily logs" sub="Last · 6h ago"/>
          <ActionRow icon={MI.layers} label="Photos & files" sub="142 photos · 4 PDFs"/>
          <ActionRow icon={MI.receipt2 || MI.receipt} label="Billing & milestones" sub="$55k of $184k invoiced"/>
        </div>
      </div>
    </div>
  );
}

function Tile({ l, v, sub }) {
  return (
    <div style={{flex:1, padding:'9px 10px', background:'#fff'}}>
      <div style={{fontSize:9.5, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.05em'}}>{l}</div>
      <div style={{fontSize:16, fontWeight:700, fontFamily:'ui-monospace,monospace', marginTop:2}}>{v}</div>
      {sub && <div style={{fontSize:10, color:'var(--m-ink-3)', marginTop:1}}>{sub}</div>}
    </div>
  );
}

function ActionRow({ icon, label, sub, badge }) {
  return (
    <Card>
      <div style={{display:'flex', alignItems:'center', gap:11}}>
        <div style={{width:30, height:30, borderRadius:8, background:M_SOFT, color:'var(--m-ink-2)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
          {React.cloneElement(icon, {width:15, height:15})}
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6}}>
            {label}
            {badge && <span style={{fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:9, background:'var(--m-accent-soft, #f5e6d3)', color:'var(--m-accent-ink)'}}>{badge}</span>}
          </div>
          <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>{sub}</div>
        </div>
        <span style={{color:'var(--m-ink-4)'}}>{MI.chev}</span>
      </div>
    </Card>
  );
}

// ============================================================
// 7 · DONE — final variance
// ============================================================
function ProjectDone() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Project" sub="Closed May 24" action="more" actionIcon={MI.more}/>
      <ProjectHeader
        state="done"
        customer="Acme Holdings · John Marchetti"
        address="Hillcrest Mews — Phase 4"
        totalLabel="Final"
        totalValue="$184,250"
        sub="Net margin · 33%"
      />

      <div className="m-body" style={{padding:'0 0 14px'}}>
        {/* Variance summary */}
        <div style={{padding:'14px 16px', background:'#fff', borderBottom:`1px solid ${M_LINE}`}}>
          <div style={{fontSize:11, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8}}>Estimate vs actual</div>
          <div style={{display:'flex', gap:1, background:M_LINE, border:`1px solid ${M_LINE}`, borderRadius:8, overflow:'hidden'}}>
            <Tile l="Estimated cost" v="$121k"/>
            <Tile l="Actual cost" v="$123k"/>
            <Tile l="Variance" v="+1.7%" sub="Over"/>
          </div>
        </div>

        <SectionH label="Where it landed"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <ActualVsEst name="Wall assembly" est="$10,796" actual="$11,420" status="over"/>
          <ActualVsEst name="Stone veneer" est="$4,140" actual="$3,850" status="under"/>
          <ActualVsEst name="Sealant + flashing" est="$2,305" actual="$2,310" status="ok"/>
          <ActualVsEst name="Labor (1,250 hrs)" est="$60,000" actual="$61,840" status="over"/>
          <ActualVsEst name="Rentals" est="$7,200" actual="$6,400" status="under"/>
        </div>

        <div style={{padding:'14px'}}>
          <Card style={{background:M_SOFT, display:'flex', alignItems:'flex-start', gap:10}}>
            <MSpark state="muted" size={12}/>
            <div style={{flex:1, fontSize:11.5, color:'var(--m-ink-2)', lineHeight:1.5}}>
              Wall assembly ran <strong style={{color:'var(--m-accent-ink)'}}>5.8% over</strong>. Across 4 similar jobs, your wall lines are averaging 4-6% over — bumping the rate to <strong>$5.10/sf</strong> would close the gap.
            </div>
          </Card>
        </div>

        <div style={{padding:'14px 14px 0', display:'flex', flexDirection:'column', gap:8}}>
          <button style={{width:'100%', padding:'12px', background:'transparent', color:'var(--m-ink-2)', border:`1px solid ${M_LINE}`, borderRadius:11, fontSize:13, fontFamily:'inherit'}}>Save as template</button>
          <button style={{width:'100%', padding:'12px', background:'transparent', color:'var(--m-ink-3)', border:`1px solid ${M_LINE}`, borderRadius:11, fontSize:13, fontFamily:'inherit'}}>Export final report</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 8 · ARCHIVE w/ LOSS REASON
// ============================================================
function ProjectArchiveSheet() {
  const reasons = [
    {l:'Price', sub:'We were too high'},
    {l:'Timing', sub:"Couldn't start when they needed"},
    {l:'Lost to competitor', sub:'Optional: who?'},
    {l:'No response', sub:'Client went quiet'},
    {l:'Scope mismatch', sub:'Wanted something different'},
    {l:'Other', sub:''},
  ];
  return (
    <div className="m" style={{position:'relative', background:'var(--m-bg)'}}>
      <div style={{opacity:0.4, padding:'14px 16px 0'}}>
        <div style={{fontSize:14, fontWeight:600}}>Hillcrest Mews — Phase 4</div>
      </div>
      <div style={{position:'absolute', inset:0, background:'rgba(20,16,10,0.45)'}}/>

      <div style={{position:'absolute', left:0, right:0, bottom:0, top:60, background:'#fff', borderRadius:'18px 18px 0 0', padding:'14px 18px 18px', overflow:'auto'}}>
        <div style={{width:38, height:4, background:'var(--m-line-2)', borderRadius:2, margin:'0 auto 14px'}}/>
        <div style={{fontSize:17, fontWeight:700, marginBottom:4, letterSpacing:'-0.01em'}}>Archive this project?</div>
        <div style={{fontSize:12.5, color:'var(--m-ink-2)', lineHeight:1.5, marginBottom:14}}>
          Tell us why so future estimates can sharpen. Stays internal.
        </div>

        <div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:14}}>
          {reasons.map((r, i) => (
            <button key={r.l} style={{textAlign:'left', padding:'11px 13px', background: i===0?'rgba(217,144,74,0.08)':'#fff', border: i===0?'1.5px solid var(--m-accent)':`1px solid ${M_LINE}`, borderRadius:10, fontFamily:'inherit', cursor:'pointer'}}>
              <div style={{display:'flex', alignItems:'center', gap:10}}>
                <div style={{width:18, height:18, borderRadius:'50%', background: i===0?'var(--m-accent)':'transparent', border: i===0?'none':'1.5px solid var(--m-line-2)', flexShrink:0, position:'relative'}}>
                  {i===0 && <div style={{position:'absolute', top:5, left:5, width:8, height:8, borderRadius:'50%', background:'#fff'}}/>}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13.5, fontWeight:600, color: i===0?'var(--m-accent-ink)':'var(--m-ink)'}}>{r.l}</div>
                  {r.sub && <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>{r.sub}</div>}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div style={{padding:'10px 12px', background:'rgba(217,144,74,0.06)', border:'1px solid rgba(217,144,74,0.18)', borderRadius:9, marginBottom:14, display:'flex', alignItems:'flex-start', gap:8}}>
          <MSpark state="muted" size={11}/>
          <div style={{fontSize:11, color:'var(--m-ink-2)', lineHeight:1.45}}>
            <strong style={{color:'var(--m-ink)'}}>3 of your last 8 losses</strong> cited price.
          </div>
        </div>

        <button style={{width:'100%', padding:'13px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit', marginBottom:8}}>Archive · save reason</button>
        <button style={{width:'100%', padding:'11px', background:'transparent', color:'var(--m-ink-2)', border:`1px solid ${M_LINE}`, borderRadius:11, fontSize:13, fontFamily:'inherit'}}>Cancel</button>
      </div>
    </div>
  );
}

Object.assign(window, {
  ProjectDrafting,
  BlueprintCanvasFull,
  ShareProposalSheet,
  ProjectSent,
  ProjectAccepted,
  ProjectInProgress,
  ProjectDone,
  ProjectArchiveSheet,
});
