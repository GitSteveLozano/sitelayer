// ai-keystone.jsx — §05 Bid accuracy card (two variants) · §06 placeholder

// ============================================================
// §05a · Bid accuracy card — Variant A (inline ribbon)
// Lives inline on EstimateSummary above the line items.
// ============================================================
function ArtBidAccuracyA() {
  return (
    <PhoneScreen title="Estimate" sub="Hillcrest Mews · Draft">
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:12}}>
        <div>
          <div className="ai-eyebrow">Total</div>
          <div className="num" style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em'}}>$ 47,820</div>
        </div>
        <div style={{fontSize:11, color:'var(--ai-ink-3)'}}>14 line items</div>
      </div>

      <div className="ai-stripe-card" data-tone="warn" style={{padding:'12px 14px'}}>
        <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
          <div style={{flex:1, minWidth:0}}>
            <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:5}}>
              <Spark state="strong" size={12}/>
              <span style={{fontSize:10, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase', color:'#8a5a14'}}>Heads up</span>
            </div>
            <div style={{fontSize:13, fontWeight:600, marginBottom:5, letterSpacing:'-0.005em', lineHeight:1.4}}>
              Your EPS bids on jobs over 2,500 sqft have averaged 12% under actual.
            </div>
            <div style={{fontSize:11.5, color:'var(--ai-ink-2)', lineHeight:1.5, marginBottom:8}}>
              Consider <span className="num" style={{fontWeight:600, color:'var(--ai-ink)'}}>$4.85</span>/sqft instead of <span className="num" style={{fontWeight:600, color:'var(--ai-ink)'}}>$4.32</span>/sqft.
            </div>
            <Attribution>Based on <strong>7 closed jobs</strong>.</Attribution>
          </div>
          <button className="ai-dismiss"><XIcon/></button>
        </div>
        <div style={{display:'flex', gap:8, marginTop:11, paddingTop:10, borderTop:'1px dashed var(--ai-line-2)'}}>
          <button style={{flex:1, padding:'8px 10px', background:'var(--ai-ink)', color:'#fff', border:'none', borderRadius:7, fontSize:11.5, fontWeight:600}}>Apply $4.85</button>
          <button style={{padding:'8px 10px', background:'transparent', color:'var(--ai-ink-2)', border:'1px solid var(--ai-line)', borderRadius:7, fontSize:11.5}}>See math</button>
        </div>
      </div>

      <div style={{marginTop:14}}>
        <div className="ai-eyebrow" style={{marginBottom:8}}>Line items</div>
        {[
          {n:'EPS install · east', q:'2,840 sqft', r:'$4.32', t:'$12,269', flag:true},
          {n:'Basecoat', q:'2,840 sqft', r:'$1.10', t:'$3,124'},
          {n:'Finish coat', q:'2,840 sqft', r:'$1.85', t:'$5,254'},
        ].map((l, i) => (
          <div key={i} style={{display:'flex', alignItems:'center', gap:10, padding:'10px 0', borderBottom:'1px solid var(--ai-line)'}}>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:12.5, fontWeight:600, display:'flex', alignItems:'center', gap:6}}>
                {l.n}
                {l.flag && <Spark state="dim" size={10}/>}
              </div>
              <div className="num" style={{fontSize:10.5, color:'var(--ai-ink-3)', marginTop:2}}>{l.q} · {l.r}</div>
            </div>
            <div className="num" style={{fontSize:12.5, fontWeight:600}}>{l.t}</div>
          </div>
        ))}
      </div>
    </PhoneScreen>
  );
}

// ============================================================
// §05b · Bid accuracy card — Variant B (per-line inline)
// Tighter — the suggestion lives ON the affected line, not above the table.
// ============================================================
function ArtBidAccuracyB() {
  return (
    <PhoneScreen title="Estimate" sub="Hillcrest Mews · Draft">
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:12}}>
        <div>
          <div className="ai-eyebrow">Total</div>
          <div className="num" style={{fontSize:22, fontWeight:700, letterSpacing:'-0.02em'}}>$ 47,820</div>
        </div>
        <div style={{fontSize:11, color:'var(--ai-ink-3)'}}>14 line items</div>
      </div>

      <div className="ai-eyebrow" style={{marginBottom:8}}>Line items</div>
      {/* Affected line, expanded inline */}
      <div style={{padding:'12px 12px', background:'#fff', border:'1px solid var(--ai-line)', borderLeft:'3px solid var(--ai-warn)', borderRadius:8, marginBottom:8}}>
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:12.5, fontWeight:600}}>EPS install · east</div>
            <div className="num" style={{fontSize:10.5, color:'var(--ai-ink-3)', marginTop:2}}>2,840 sqft · $4.32</div>
          </div>
          <div className="num" style={{fontSize:12.5, fontWeight:600}}>$12,269</div>
        </div>
        <div style={{marginTop:9, paddingTop:9, borderTop:'1px dashed var(--ai-line-2)', display:'flex', gap:10, alignItems:'flex-start'}}>
          <Spark state="strong" size={12}/>
          <div style={{flex:1, fontSize:11.5, color:'var(--ai-ink-2)', lineHeight:1.5}}>
            Bids at this scope have averaged <strong style={{color:'var(--ai-ink)'}}>12% under</strong> actual.
            Try <span className="num" style={{color:'var(--ai-ink)', fontWeight:600}}>$4.85</span>?
            <div style={{marginTop:6, display:'flex', gap:6}}>
              <button style={{padding:'4px 10px', background:'var(--ai-ink)', color:'#fff', border:'none', borderRadius:6, fontSize:11, fontWeight:600}}>Apply</button>
              <button style={{padding:'4px 10px', background:'transparent', color:'var(--ai-ink-3)', border:'1px solid var(--ai-line)', borderRadius:6, fontSize:11}}>Keep</button>
            </div>
            <div style={{marginTop:6}}><Attribution sparkState="muted">From <strong>7 closed jobs</strong>.</Attribution></div>
          </div>
        </div>
      </div>
      {[
        {n:'Basecoat', q:'2,840 sqft', r:'$1.10', t:'$3,124'},
        {n:'Finish coat', q:'2,840 sqft', r:'$1.85', t:'$5,254'},
        {n:'Caulk', q:'410 lf', r:'$2.10', t:'$861'},
      ].map((l, i) => (
        <div key={i} style={{display:'flex', alignItems:'center', gap:10, padding:'10px 0', borderBottom:'1px solid var(--ai-line)'}}>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:12.5, fontWeight:600}}>{l.n}</div>
            <div className="num" style={{fontSize:10.5, color:'var(--ai-ink-3)', marginTop:2}}>{l.q} · {l.r}</div>
          </div>
          <div className="num" style={{fontSize:12.5, fontWeight:600}}>{l.t}</div>
        </div>
      ))}
    </PhoneScreen>
  );
}

// ============================================================
// §05c · Closeout view — bid vs actual
// ============================================================
function ArtBidCloseout() {
  const lines = [
    { n: 'EPS install', bid: 11200, actual: 10384, delta: -7.3 },
    { n: 'Basecoat',    bid: 3124,  actual: 3257,  delta: +4.3 },
    { n: 'Finish coat', bid: 5254,  actual: 5099,  delta: -3.0 },
    { n: 'Caulk',       bid: 861,   actual: 1051,  delta: +22.1 },
  ];
  return (
    <PhoneScreen title="Closeout" sub="Aspen Ridge · Project complete">
      <div className="ai-eyebrow" style={{marginBottom:6}}>Bid accuracy</div>
      <div style={{padding:'14px 16px', background:'#fff', border:'1px solid var(--ai-line)', borderRadius:12}}>
        <div style={{fontSize:13, fontWeight:600, marginBottom:10, lineHeight:1.4, display:'flex', alignItems:'flex-start', gap:8}}>
          <Spark size={13}/>
          <span>EPS came in <span className="num" style={{color:'var(--ai-good)'}}>7% under</span>, caulk <span className="num" style={{color:'var(--ai-bad)'}}>22% over</span>. The caulk pattern matches your last 3 jobs.</span>
        </div>
        <div style={{marginTop:12, paddingTop:10, borderTop:'1px dashed var(--ai-line-2)'}}>
          {lines.map(l => {
            const pos = l.delta < 0;
            return (
              <div key={l.n} style={{display:'grid', gridTemplateColumns:'1fr auto 60px', gap:10, alignItems:'center', padding:'7px 0'}}>
                <div style={{fontSize:12, fontWeight:500}}>{l.n}</div>
                <div className="num" style={{fontSize:11, color:'var(--ai-ink-3)'}}>${l.bid.toLocaleString()} → ${l.actual.toLocaleString()}</div>
                <div className="num" style={{fontSize:12, fontWeight:600, color: pos ? 'var(--ai-good)' : 'var(--ai-bad)', textAlign:'right'}}>{pos?'':'+'}{l.delta}%</div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{marginTop:12, padding:'10px 12px', background:'var(--ai-spark-soft)', borderRadius:8, fontSize:11.5, color:'var(--ai-ink-2)', lineHeight:1.5, display:'flex', gap:8, alignItems:'flex-start'}}>
        <Spark size={12}/>
        <span>Saved to <strong style={{color:'var(--ai-ink)'}}>your bidding history</strong>. Next EPS bid &gt; 2,500 sqft will reference this.</span>
      </div>
    </PhoneScreen>
  );
}

// ============================================================
// §05d · Portfolio "Estimating insights"
// ============================================================
function ArtPortfolioInsights() {
  const insights = [
    { tone:'warn', n:'EPS bids run 8% under on jobs > 2,500 sqft', src:'7 jobs', conf:'strong' },
    { tone:'warn', n:'Caulk consistently overestimated by 22%', src:'14 jobs', conf:'strong' },
    { tone:null,   n:'Travel time absent from 60% of recent bids', src:'18 bids · last 90d', conf:'accent' },
    { tone:null,   n:'Greenwillow-area jobs trend on-budget', src:'5 jobs', conf:'dim' },
  ];
  return (
    <PhoneScreen title="Estimating insights" sub="Patterns across closed projects">
      <div style={{padding:'12px 14px', background:'var(--ai-spark-soft)', borderRadius:10, marginBottom:12, fontSize:11.5, color:'var(--ai-spark-ink)', lineHeight:1.45}}>
        <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:4}}>
          <Spark state="strong" size={12}/>
          <span style={{fontWeight:700, letterSpacing:'.05em', textTransform:'uppercase', fontSize:10}}>Sitelayer is learning</span>
        </div>
        <span style={{color:'var(--ai-ink-2)'}}>The longer you use Sitelayer, the sharper your bids get. Patterns ripen with every closeout.</span>
      </div>
      <div style={{display:'grid', gap:8}}>
        {insights.map((i, idx) => (
          <div key={idx} className="ai-stripe-card" data-tone={i.tone} style={{padding:'12px 14px'}}>
            <div style={{display:'flex', alignItems:'flex-start', gap:8}}>
              <div style={{marginTop:2}}><Spark state={i.conf} size={12}/></div>
              <div style={{flex:1}}>
                <div style={{fontSize:12.5, fontWeight:600, lineHeight:1.4}}>{i.n}</div>
                <div className="ai-attr" style={{marginTop:5}}><strong>{i.src}</strong></div>
              </div>
              <ChevR size={14}/>
            </div>
          </div>
        ))}
      </div>
    </PhoneScreen>
  );
}

Object.assign(window, { ArtBidAccuracyA, ArtBidAccuracyB, ArtBidCloseout, ArtPortfolioInsights });
