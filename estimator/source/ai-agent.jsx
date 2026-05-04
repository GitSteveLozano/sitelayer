// ai-agent.jsx — §06 Takeoff-to-bid agent (THE demo screen) · §07 Why-this overlay · §08 Anti-list

// ============================================================
// §06a · Takeoff-to-bid agent — Variant A (canvas + side panel)
// AI proposes polygons before user draws. User confirms/edits/rejects each.
// ============================================================
function ArtAgentTakeoffA() {
  return (
    <div className="ai-phone" style={{background:'#fff'}}>
      <div className="ai-phone-bar"><span>9:41</span><span style={{width:14, height:8, borderRadius:1.5, border:'1px solid currentColor'}}/></div>
      <div className="ai-phone-topbar" style={{display:'flex', alignItems:'center', gap:8}}>
        <button style={{width:28, height:28, border:'none', background:'transparent', color:'var(--ai-ink-2)'}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 6-6 6 6 6"/></svg>
        </button>
        <div style={{flex:1}}>
          <div className="h" style={{display:'flex', alignItems:'center', gap:6}}>
            Review takeoff draft
            <span className="ai-pill" data-tone="spark" style={{fontSize:9}}><Spark size={9}/>Agent</span>
          </div>
          <div style={{fontSize:11, color:'var(--ai-ink-3)', marginTop:1}}>floor-plan-east.pdf · 3 of 8 reviewed</div>
        </div>
      </div>

      {/* Plan canvas */}
      <div style={{flex:1, position:'relative', background:'#f3efe8', overflow:'hidden'}}>
        {/* Faux plan lines */}
        <svg viewBox="0 0 320 380" style={{position:'absolute', inset:0, width:'100%', height:'100%'}}>
          {/* Building outline */}
          <rect x="40" y="50" width="240" height="280" fill="none" stroke="#c0b8a8" strokeWidth="1.5"/>
          <line x1="40" y1="180" x2="280" y2="180" stroke="#d8d2c7" strokeWidth="1"/>
          <line x1="160" y1="50" x2="160" y2="330" stroke="#d8d2c7" strokeWidth="1"/>
          <line x1="40" y1="120" x2="160" y2="120" stroke="#d8d2c7" strokeWidth="1"/>
          <line x1="160" y1="240" x2="280" y2="240" stroke="#d8d2c7" strokeWidth="1"/>
          <text x="48" y="68" fontSize="8" fill="#aea69a">A</text>
          <text x="170" y="68" fontSize="8" fill="#aea69a">B</text>

          {/* Confirmed polygon — solid */}
          <polygon points="50,60 155,60 155,115 50,115" fill="rgba(217,144,74,0.18)" stroke="#d9904a" strokeWidth="1.5"/>
          <text x="68" y="92" fontSize="9" fontWeight="600" fill="#b46e2c">EPS · 540 sf</text>

          {/* Proposed (dimmed, dashed) */}
          <polygon points="170,60 270,60 270,170 170,170" fill="rgba(217,144,74,0.10)" stroke="#d9904a" strokeWidth="1.5" strokeDasharray="4 3"/>
          <text x="188" y="118" fontSize="9" fontWeight="600" fill="#b46e2c">EPS · 1,100 sf</text>

          <polygon points="50,130 155,130 155,170 50,170" fill="rgba(47,111,181,0.10)" stroke="#2f6fb5" strokeWidth="1.5" strokeDasharray="4 3"/>
          <text x="68" y="155" fontSize="9" fontWeight="600" fill="#2a5e9c">Basecoat · 420 sf</text>

          {/* Selected proposed — accented dashed */}
          <polygon points="50,190 155,190 155,325 50,325" fill="rgba(217,144,74,0.18)" stroke="#d9904a" strokeWidth="2.2" strokeDasharray="5 3"/>
          <text x="65" y="262" fontSize="10" fontWeight="700" fill="#b46e2c">EPS · 1,418 sf</text>
        </svg>

        {/* Inline review pill on selected polygon */}
        <div style={{position:'absolute', top:312, left:14, right:14, padding:'10px 12px', background:'rgba(28,24,22,.94)', color:'#fff', borderRadius:10, backdropFilter:'blur(6px)'}}>
          <div style={{display:'flex', alignItems:'center', gap:6, fontSize:10, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', color:'#f7c994', marginBottom:4}}>
            <Spark size={11}/>Polygon 4 of 8
          </div>
          <div style={{fontSize:12.5, lineHeight:1.4, marginBottom:8}}>
            <strong>EPS · 1,418 sf</strong> on south elevation. Detected from hatch pattern + dimension callouts.
          </div>
          <div style={{display:'flex', gap:6}}>
            <button style={{flex:1, padding:'7px 8px', background:'#d9904a', color:'#fff', border:'none', borderRadius:6, fontSize:11.5, fontWeight:600}}>Confirm</button>
            <button style={{padding:'7px 10px', background:'rgba(255,255,255,.12)', color:'#fff', border:'none', borderRadius:6, fontSize:11.5}}>Edit</button>
            <button style={{padding:'7px 10px', background:'transparent', color:'#aea69a', border:'1px solid rgba(255,255,255,.18)', borderRadius:6, fontSize:11.5}}>Reject</button>
          </div>
        </div>

        {/* Progress strip */}
        <div style={{position:'absolute', top:8, left:8, right:8, padding:'6px 10px', background:'rgba(255,255,255,.92)', borderRadius:8, backdropFilter:'blur(6px)', fontSize:10.5, color:'var(--ai-ink-2)', display:'flex', alignItems:'center', gap:8}}>
          <Spark size={11}/>
          <span style={{flex:1}}>3 confirmed · 4 to review · 1 rejected</span>
          <span style={{display:'flex', gap:2}}>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-good)'}}/>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-good)'}}/>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-good)'}}/>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-spark)'}}/>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-line-2)'}}/>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-line-2)'}}/>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-line-2)'}}/>
            <span style={{width:14, height:5, borderRadius:1, background:'var(--ai-bad)', opacity:.6}}/>
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// §06b · Takeoff-to-bid agent — Variant B (queue + canvas split)
// Queue-driven: list on top, canvas below. Same pattern, list-first.
// ============================================================
function ArtAgentTakeoffB() {
  return (
    <div className="ai-phone" style={{background:'#fff'}}>
      <div className="ai-phone-bar"><span>9:41</span><span style={{width:14, height:8, borderRadius:1.5, border:'1px solid currentColor'}}/></div>
      <div className="ai-phone-topbar" style={{display:'flex', alignItems:'center', gap:8}}>
        <div style={{flex:1}}>
          <div className="h" style={{display:'flex', alignItems:'center', gap:6}}>
            Review takeoff draft
          </div>
          <div style={{fontSize:11, color:'var(--ai-ink-3)', marginTop:1, display:'flex', alignItems:'center', gap:6}}>
            <Spark size={11}/>Drafted from <strong style={{color:'var(--ai-ink-2)', fontWeight:600}}>floor-plan-east.pdf</strong>
          </div>
        </div>
        <button style={{padding:'5px 10px', background:'transparent', border:'1px solid var(--ai-line)', borderRadius:6, fontSize:11, color:'var(--ai-ink-2)'}}>Skip review</button>
      </div>

      {/* Mini canvas preview */}
      <div style={{height:140, background:'#f3efe8', position:'relative', overflow:'hidden', borderBottom:'1px solid var(--ai-line)'}}>
        <svg viewBox="0 0 320 140" style={{position:'absolute', inset:0, width:'100%', height:'100%'}}>
          <rect x="20" y="14" width="280" height="112" fill="none" stroke="#c0b8a8" strokeWidth="1.2"/>
          <polygon points="28,22 130,22 130,78 28,78" fill="rgba(217,144,74,0.18)" stroke="#d9904a" strokeWidth="1.2"/>
          <polygon points="140,22 260,22 260,68 140,68" fill="rgba(217,144,74,0.10)" stroke="#d9904a" strokeWidth="1.2" strokeDasharray="3 2"/>
          <polygon points="28,86 130,86 130,118 28,118" fill="rgba(47,111,181,0.10)" stroke="#2f6fb5" strokeWidth="1.2" strokeDasharray="3 2"/>
          <polygon points="140,76 260,76 260,118 140,118" fill="rgba(217,144,74,0.10)" stroke="#d9904a" strokeWidth="1.2" strokeDasharray="3 2"/>
        </svg>
        <div style={{position:'absolute', bottom:8, left:8, fontSize:9.5, color:'var(--ai-ink-3)', background:'rgba(255,255,255,.86)', padding:'2px 6px', borderRadius:4}}>
          Tap a polygon to review
        </div>
      </div>

      {/* Queue */}
      <div style={{flex:1, overflow:'auto', padding:'10px 14px'}}>
        <div className="ai-eyebrow" style={{marginBottom:8}}>4 to review</div>
        {[
          { n:'EPS · south elevation', q:'1,418 sf', conf:'strong', why:'Hatch pattern matches' },
          { n:'EPS · north elevation', q:'1,100 sf', conf:'accent', why:'Same elevation type' },
          { n:'Basecoat · west',       q:'420 sf',  conf:'accent', why:'Adjacent to EPS' },
          { n:'Caulk · perimeter',     q:'410 lf',  conf:'dim',    why:'Inferred from EPS edges' },
        ].map((r, i) => (
          <div key={i} style={{padding:'10px 12px', background:'#fff', border:'1px solid var(--ai-line)', borderRadius:8, marginBottom:7, display:'flex', alignItems:'center', gap:10}}>
            <Spark state={r.conf} size={13}/>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:12.5, fontWeight:600}}>{r.n}</div>
              <div style={{fontSize:10.5, color:'var(--ai-ink-3)', marginTop:2}} className="num">{r.q} · <span style={{fontFamily:'inherit'}}>{r.why}</span></div>
            </div>
            <div style={{display:'flex', gap:4}}>
              <button style={{width:28, height:28, border:'none', background:'var(--ai-good)', color:'#fff', borderRadius:6}} aria-label="confirm">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{display:'block', margin:'auto'}}><path d="m5 12 5 5L20 7"/></svg>
              </button>
              <button style={{width:28, height:28, border:'1px solid var(--ai-line)', background:'#fff', color:'var(--ai-ink-3)', borderRadius:6}} aria-label="reject">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{display:'block', margin:'auto'}}><path d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            </div>
          </div>
        ))}

        <div style={{marginTop:10, padding:'10px 12px', background:'var(--ai-spark-soft)', borderRadius:8, fontSize:11, color:'var(--ai-ink-2)', display:'flex', gap:8}}>
          <Spark size={12}/>
          <span>Confirmed polygons feed your next bid. Rejected ones teach the system what to ignore.</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// §06c · Agent draft · empty state for first-time customers
// ============================================================
function ArtAgentEmpty() {
  return (
    <PhoneScreen title="Measurements" sub="New project · upload plans">
      <div style={{padding:'24px 8px 12px', textAlign:'center'}}>
        <div style={{display:'inline-flex', width:54, height:54, borderRadius:14, background:'var(--ai-spark-soft)', alignItems:'center', justifyContent:'center', marginBottom:14}}>
          <Spark state="accent" size={26}/>
        </div>
        <div style={{fontSize:16, fontWeight:600, marginBottom:6, letterSpacing:'-0.012em'}}>Drop a plan PDF.</div>
        <div style={{fontSize:12.5, color:'var(--ai-ink-2)', lineHeight:1.5, maxWidth:240, margin:'0 auto 18px'}}>
          Sitelayer reads the hatch patterns, dimensions, and callouts. You review what it found before drawing anything.
        </div>
      </div>
      <div style={{padding:'24px', background:'var(--ai-soft)', border:'2px dashed var(--ai-line-2)', borderRadius:14, textAlign:'center'}}>
        <div style={{fontSize:12, color:'var(--ai-ink-3)', marginBottom:8}}>Drag a PDF here</div>
        <button style={{padding:'8px 14px', background:'var(--ai-ink)', color:'#fff', border:'none', borderRadius:8, fontSize:12, fontWeight:600}}>Or pick from files</button>
      </div>
      <div style={{marginTop:14, padding:'12px 14px', background:'#fff', border:'1px solid var(--ai-line)', borderRadius:10, fontSize:11.5, color:'var(--ai-ink-2)', lineHeight:1.5}}>
        <div style={{fontWeight:600, color:'var(--ai-ink)', marginBottom:4, fontSize:12}}>What the agent does well</div>
        Single-elevation EIFS, repaints, multi-condition wall systems with clear hatch.
        <div style={{marginTop:8, fontWeight:600, color:'var(--ai-ink)', fontSize:12}}>Where it'll ask for help</div>
        Stacked elevations, hand-marked plans, missing dimension callouts. The agent says so before you waste time reviewing.
      </div>
    </PhoneScreen>
  );
}

// ============================================================
// §07 · "Why this?" overlay — adapted DecisionOverlay for AI
// ============================================================
function ArtWhyThis() {
  return (
    <div className="ai-phone" style={{background:'#f5f1ec', position:'relative'}}>
      <div className="ai-phone-bar"><span>11:08</span><span style={{width:14, height:8, borderRadius:1.5, border:'1px solid currentColor'}}/></div>

      {/* Dimmed underlay */}
      <div style={{flex:1, opacity:.4, filter:'grayscale(.5)', padding:'14px', overflow:'hidden'}}>
        <div className="ai-stripe-card" data-tone="warn">
          <div style={{fontSize:13, fontWeight:600, marginBottom:4}}>Aspen Ridge · labor 18% over plan</div>
          <div style={{fontSize:12, color:'var(--ai-ink-2)'}}>1.4× target throughput but burning fast.</div>
        </div>
      </div>

      {/* Why-this sheet */}
      <div style={{position:'absolute', left:14, right:14, bottom:14, background:'#fff', borderRadius:14, boxShadow:'0 12px 40px rgba(0,0,0,.18)', overflow:'hidden', maxHeight:'72%'}}>
        <div style={{padding:'14px 16px 6px', borderBottom:'1px solid var(--ai-line)', display:'flex', alignItems:'center', gap:8}}>
          <Spark state="strong" size={14}/>
          <div style={{flex:1}}>
            <div style={{fontSize:10, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', color:'var(--ai-spark-ink)'}}>Why this card?</div>
            <div style={{fontSize:14, fontWeight:600, marginTop:2, letterSpacing:'-0.005em'}}>How Sitelayer ranked Aspen Ridge first</div>
          </div>
          <button className="ai-dismiss"><XIcon/></button>
        </div>

        <div style={{padding:'12px 16px', display:'grid', gap:10}}>
          {[
            { f:'Labor variance', v:'+18% over budget · $3,820', tone:'warn' },
            { f:'Throughput',     v:'1.4× plan — high burn rate', tone:'warn' },
            { f:'Crew change',    v:'5th crew added Wed without budget update', tone:'warn' },
            { f:'Comparison',     v:'4 other projects flagged calmly today', tone:'mute' },
          ].map((r, i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:'90px 1fr', gap:10, fontSize:11.5}}>
              <div style={{color:'var(--ai-ink-3)'}}>{r.f}</div>
              <div style={{color: r.tone === 'warn' ? 'var(--ai-ink)' : 'var(--ai-ink-2)', fontWeight: r.tone === 'warn' ? 600 : 400}}>{r.v}</div>
            </div>
          ))}
        </div>
        <div style={{padding:'10px 16px 14px', borderTop:'1px dashed var(--ai-line-2)', display:'flex', alignItems:'center', gap:8, fontSize:11, color:'var(--ai-ink-3)'}}>
          <Spark size={11}/>
          <span style={{flex:1}}>Based on labor history + crew assignments + project budget.</span>
          <button style={{fontSize:11, color:'var(--ai-ink-2)', background:'transparent', border:'none', textDecoration:'underline'}}>Not useful</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// §08 · What we're NOT building — anti-list w/ rejected patterns
// ============================================================
function ArtRejectChat() {
  return (
    <RejectedPattern stamp="No chat box">
      <div className="ai-phone" style={{background:'#fff'}}>
        <div className="ai-phone-bar"><span>9:41</span><span style={{width:14, height:8, borderRadius:1.5, border:'1px solid currentColor'}}/></div>
        <div className="ai-phone-topbar"><div className="h">Hillcrest Mews</div></div>
        <div style={{flex:1, padding:'12px 14px', display:'flex', flexDirection:'column', gap:8}}>
          <div style={{padding:'10px 12px', background:'#f5f1ec', borderRadius:12, fontSize:12, color:'var(--ai-ink-2)', alignSelf:'flex-start', maxWidth:'80%'}}>What's the bid total?</div>
          <div style={{padding:'10px 12px', background:'var(--ai-spark-soft)', borderRadius:12, fontSize:12, color:'var(--ai-ink), maxWidth:80%', alignSelf:'flex-end'}}>The bid is $47,820 across 14 line items.</div>
          <div style={{padding:'10px 12px', background:'#f5f1ec', borderRadius:12, fontSize:12, color:'var(--ai-ink-2)', alignSelf:'flex-start', maxWidth:'80%'}}>Show me labor hours</div>
        </div>
        <div style={{padding:'10px 14px', borderTop:'1px solid var(--ai-line)', display:'flex', alignItems:'center', gap:8}}>
          <div style={{flex:1, padding:'8px 12px', background:'var(--ai-soft)', borderRadius:18, fontSize:12, color:'var(--ai-ink-3)'}}>Ask Sitelayer…</div>
          <div style={{width:32, height:32, borderRadius:16, background:'var(--ai-spark)', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff'}}><Spark size={16}/></div>
        </div>
      </div>
    </RejectedPattern>
  );
}

function ArtRejectAITab() {
  return (
    <RejectedPattern stamp="No AI tab">
      <div className="ai-phone" style={{background:'#fff'}}>
        <div className="ai-phone-bar"><span>9:41</span><span style={{width:14, height:8, borderRadius:1.5, border:'1px solid currentColor'}}/></div>
        <div className="ai-phone-topbar"><div className="h">AI Insights</div></div>
        <div style={{flex:1, padding:'14px', background:'linear-gradient(180deg, rgba(217,144,74,.08), transparent 50%)'}}>
          <div style={{fontSize:11, color:'var(--ai-spark-ink)', fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', marginBottom:8}}>✨ Powered by Sitelayer AI</div>
          <div style={{fontSize:18, fontWeight:700, marginBottom:14}}>Your weekly insights</div>
          <div style={{display:'grid', gap:10}}>
            <div style={{padding:14, background:'#fff', border:'1px solid var(--ai-line)', borderRadius:12}}>
              <div style={{fontSize:11, color:'var(--ai-spark)'}}>Productivity tip</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:4}}>You scheduled 12 crews this week!</div>
            </div>
            <div style={{padding:14, background:'#fff', border:'1px solid var(--ai-line)', borderRadius:12}}>
              <div style={{fontSize:11, color:'var(--ai-spark)'}}>Did you know?</div>
              <div style={{fontSize:13, fontWeight:600, marginTop:4}}>EPS bids run 12% under actual</div>
            </div>
          </div>
        </div>
        <div style={{height:54, borderTop:'1px solid var(--ai-line)', display:'flex'}}>
          {['Home','Projects','AI ✨','Time','More'].map((t, i) => (
            <div key={t} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontSize:9, color: i===2 ? 'var(--ai-spark)' : 'var(--ai-ink-3)', fontWeight: i===2 ? 700 : 400}}>
              <div style={{width:18, height:18, borderRadius:9, background: i===2 ? 'var(--ai-spark-soft)' : 'transparent', marginBottom:2}}/>
              {t}
            </div>
          ))}
        </div>
      </div>
    </RejectedPattern>
  );
}

function ArtRejectVanity() {
  return (
    <RejectedPattern stamp="No vanity metrics">
      <PhoneScreen title="Home" sub="Mon · Apr 28">
        <div style={{padding:'14px', background:'linear-gradient(135deg, #d9904a, #c0463d)', borderRadius:14, color:'#fff', textAlign:'center'}}>
          <div style={{fontSize:11, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', opacity:.8, marginBottom:6}}>This week with Sitelayer AI</div>
          <div style={{fontSize:30, fontWeight:800, letterSpacing:'-0.02em'}}>47 hours</div>
          <div style={{fontSize:12, opacity:.9, marginTop:4}}>saved across your team 🎉</div>
          <div style={{marginTop:12, padding:'8px', background:'rgba(255,255,255,.16)', borderRadius:8, fontSize:11}}>
            ⚡ 312 AI suggestions accepted · 47 dismissed
          </div>
        </div>
      </PhoneScreen>
    </RejectedPattern>
  );
}

function ArtRejectAutoOrder() {
  return (
    <RejectedPattern stamp="No auto-orders">
      <PhoneScreen title="Materials" sub="Hillcrest Mews">
        <div className="ai-stripe-card" data-tone="good" style={{padding:'14px 16px'}}>
          <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:6}}>
            <Spark size={12}/>
            <span style={{fontSize:10, fontWeight:700, color:'var(--ai-good)', textTransform:'uppercase', letterSpacing:'.08em'}}>Auto-ordered</span>
          </div>
          <div style={{fontSize:13, fontWeight:600, marginBottom:6}}>Sitelayer ordered 12 sheets of EPS for you.</div>
          <div style={{fontSize:11.5, color:'var(--ai-ink-2)'}}>Stucco Supply Tecate · $487 · arriving Thu 8am · charged to Hillcrest</div>
        </div>
        <div style={{marginTop:10, padding:'10px 12px', background:'var(--ai-soft)', borderRadius:8, fontSize:11, color:'var(--ai-ink-3)'}}>
          AI committed cash without asking. One hallucinated order destroys trust.
        </div>
      </PhoneScreen>
    </RejectedPattern>
  );
}

function ArtRejectConfidence() {
  return (
    <RejectedPattern stamp="No % confidence">
      <PhoneScreen title="Estimate" sub="Suggestion">
        <div className="ai-stripe-card" style={{padding:'14px 16px'}}>
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
            <Spark size={12}/>
            <span style={{fontSize:13, fontWeight:600}}>Suggested rate: $4.85/sqft</span>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
            <div style={{flex:1, height:6, background:'var(--ai-soft)', borderRadius:3, overflow:'hidden'}}>
              <div style={{width:'87%', height:'100%', background:'var(--ai-spark)'}}/>
            </div>
            <span className="num" style={{fontSize:11, color:'var(--ai-ink-3)'}}>87.3% confident</span>
          </div>
          <div style={{fontSize:11, color:'var(--ai-ink-3)'}}>Model accuracy: 94.2% · σ = 0.18</div>
        </div>
      </PhoneScreen>
    </RejectedPattern>
  );
}

function ArtRejectAutoLog() {
  return (
    <RejectedPattern stamp="No agent-only daily log">
      <PhoneScreen title="Daily log" sub="Hillcrest · Apr 28">
        <div style={{padding:14, background:'#fff', border:'1px solid var(--ai-line)', borderRadius:10, fontSize:12, color:'var(--ai-ink-2)', lineHeight:1.5}}>
          <div style={{fontSize:11, color:'var(--ai-spark)', marginBottom:8, display:'flex', alignItems:'center', gap:6}}>
            <Spark size={11}/>Auto-generated · submitted to client
          </div>
          Today the crew completed approximately 80% of the east elevation EPS installation. Weather conditions were favorable with clear skies and moderate temperatures. The team worked efficiently and morale appeared high. Productivity was within expected ranges for this scope of work…
        </div>
        <div style={{marginTop:10, fontSize:11, color:'var(--ai-ink-3)', lineHeight:1.5}}>
          AI-only logs read as fake to clients. The daily log is the document that protects against scope disputes. Foreman authors; agent drafts.
        </div>
      </PhoneScreen>
    </RejectedPattern>
  );
}

// ============================================================
// Anti-list summary card
// ============================================================
function ArtAntiList() {
  const items = [
    'No chatbot, no chat box, no "Ask Sitelayer."',
    'No "AI Insights" tab. AI lives where the work lives.',
    'No vanity metrics. "47 hours saved" is a participation trophy.',
    'No auto-scheduling crews without foreman review.',
    'No auto-approving time entries.',
    'No agent-generated daily logs without explicit foreman edit.',
    'No agent that auto-orders materials or rentals.',
    'No proactive push notifications without a clear action.',
    'No numerical confidence percentages.',
    'No agent that bills the customer or sends invoices.',
  ];
  return (
    <div className="ai-doccard">
      <div className="ai-eyebrow">§08 · The anti-list</div>
      <h2 className="ai-title">What we're<br/>not building.</h2>
      <p className="ai-sub">
        Every item here will be proposed at some point. Hold the line. The escape from
        AI-bolted-on SaaS is the calm philosophy — restraint over volume, embedded over
        standalone, confidence over certainty.
      </p>
      <div style={{display:'grid', gap:6, marginTop:6}}>
        {items.map((it, i) => (
          <div key={i} style={{display:'flex', gap:8, alignItems:'flex-start', padding:'8px 10px', background:'#fff', border:'1px solid var(--ai-line)', borderRadius:8}}>
            <span style={{width:18, height:18, borderRadius:9, background:'rgba(192,70,61,.10)', color:'var(--ai-bad)', display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1}}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </span>
            <span style={{fontSize:11.5, color:'var(--ai-ink-2)', lineHeight:1.45}}>{it}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Cover artboard for the canvas
function ArtCover() {
  return (
    <div className="ai-doccard" style={{background:'#1c1816', color:'#f3ecdf', borderColor:'#2a241c'}}>
      <div className="ai-eyebrow" style={{color:'#d9904a'}}>Sitelayer · Iteration 4</div>
      <div style={{fontSize:30, fontWeight:700, letterSpacing:'-0.022em', lineHeight:1.05, marginTop:8}}>
        AI Layer · <br/>
        <span style={{color:'#d9904a'}}>visual language doc.</span>
      </div>
      <div style={{fontSize:13.5, color:'#c0b8a8', lineHeight:1.55, marginTop:14}}>
        Lock the conventions before drawing screens. Spark / stripe / agent — three
        treatments for three layers of AI presence. Every screen reads consistently;
        the calm philosophy holds.
      </div>
      <div style={{flex:1}}/>
      <div style={{display:'grid', gap:8, fontSize:11.5, color:'#c0b8a8', borderTop:'1px solid #2a241c', paddingTop:14}}>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>01</span><span>Three layers</span></div>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>02</span><span>Spark · attribution · reject · tokens</span></div>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>03</span><span>Calm by default — dormant vs signal</span></div>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>04</span><span>Empty · learning · confident</span></div>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>05</span><span>Bid accuracy · the keystone</span></div>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>06</span><span>Takeoff-to-bid agent · the demo</span></div>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>07</span><span>Why this? overlay</span></div>
        <div style={{display:'flex', gap:10}}><span style={{color:'#d9904a', fontWeight:600, width:22}}>08</span><span>What we're NOT building</span></div>
      </div>
    </div>
  );
}

Object.assign(window, {
  ArtAgentTakeoffA, ArtAgentTakeoffB, ArtAgentEmpty,
  ArtWhyThis,
  ArtRejectChat, ArtRejectAITab, ArtRejectVanity, ArtRejectAutoOrder, ArtRejectConfidence, ArtRejectAutoLog,
  ArtAntiList, ArtCover,
});
