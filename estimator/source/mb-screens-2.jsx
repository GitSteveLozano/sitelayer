/* global React, MI, MTopBar, MLargeHead, MSectionH, MRow, MKpi, MPill, MBottomTabs, MQA, MAvatarGroup, MBanner, MStage */

// ============================================================
// SECTION 5 — TAKEOFF (mobile)
// ============================================================

function TakeoffList() {
  return (
    <div className="m">
      <MTopBar back title="Measurements" sub="Hillcrest Mews — Phase 4" action="add" actionIcon={MI.plus}/>
      {/* category chips */}
      <div style={{display:'flex', gap:8, padding:'10px 16px 12px', overflow:'auto', borderBottom:'1px solid #e8e3db'}}>
        <button className="m-chip" data-active="true">All <span style={{opacity:.7, marginLeft:2}}>9</span></button>
        <button className="m-chip">EPS</button>
        <button className="m-chip">Basecoat</button>
        <button className="m-chip">Finish</button>
        <button className="m-chip">Stone</button>
        <button className="m-chip">Caulk</button>
      </div>
      {/* AI LAYER · Agent surface — drafted polygons awaiting review */}
      <div style={{padding:'14px 16px 0'}}>
        <MAiAgent>
          <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
            <div style={{flex:1}}>
              <div style={{fontSize:13, fontWeight:600, marginBottom:4, lineHeight:1.35, letterSpacing:'-0.005em'}}>9 polygons drafted from <span style={{color:'var(--m-accent-ink)'}}>floor-plan-east.pdf</span>.</div>
              <div style={{fontSize:12, color:'var(--m-ink-2)', lineHeight:1.5, marginBottom:8}}>
                3 confirmed · <strong style={{color:'var(--m-ink)'}}>5 to review</strong> · 1 rejected.
              </div>
              <div style={{display:'flex', gap:8, marginBottom:8}}>
                <button style={{padding:'7px 12px', background:'var(--m-accent)', color:'#fff', border:'none', borderRadius:8, fontSize:12, fontWeight:600, fontFamily:'inherit'}}>Review draft</button>
                <button style={{padding:'7px 12px', background:'transparent', color:'var(--m-ink-2)', border:'1px solid var(--m-line)', borderRadius:8, fontSize:12, fontFamily:'inherit'}}>Skip</button>
              </div>
              <MAttribution sparkState="muted">Confirmed polygons feed your bid. Rejected ones teach the system.</MAttribution>
            </div>
          </div>
        </MAiAgent>
      </div>

      {/* total strip */}
      <div className="m-stat-strip">
        <div>
          <div className="m-stat-strip-l">Total area</div>
          <div className="m-stat-strip-v num">4,785 <span style={{fontSize:11, color:'#8a8278', fontWeight:400}}>sf</span></div>
        </div>
        <div>
          <div className="m-stat-strip-l">Bid</div>
          <div className="m-stat-strip-v num">$184,250</div>
        </div>
        <div>
          <div className="m-stat-strip-l">Items</div>
          <div className="m-stat-strip-v num">9</div>
        </div>
      </div>
      <div className="m-body" style={{padding:'4px 0'}}>
        <div className="m-section-h">East elevation</div>
        <div className="m-list-inset">
          <TakeoffRow code="EPS" color="#E8A86B" name="EPS Insulation" qty="1,284.5" unit="sf" amt="$6,230"/>
          <TakeoffRow code="BASE" color="#C77B4F" name="Basecoat" qty="1,284.5" unit="sf" amt="$4,110"/>
          <TakeoffRow code="FIN" color="#A05A33" name="Finish Coat" qty="1,284.5" unit="sf" amt="$5,266"/>
        </div>
        <div className="m-section-h">South elevation</div>
        <div className="m-list-inset">
          <TakeoffRow code="EPS" color="#E8A86B" name="EPS Insulation" qty="942.0" unit="sf" amt="$4,569"/>
          <TakeoffRow code="STONE" color="#7A8C6F" name="Cultured Stone" qty="184.0" unit="sf" amt="$4,140"/>
        </div>
        <div className="m-section-h">Detail</div>
        <div className="m-list-inset">
          <TakeoffRow code="CAULK" color="#6FA8A0" name="Caulking" qty="310.0" unit="lf" amt="$1,054"/>
          <TakeoffRow code="FLASH" color="#9C7A5B" name="Flashing" qty="142.0" unit="lf" amt="$1,264"/>
        </div>
      </div>
      <button className="m-fab m-fab-extended">
        {MI.cam}
        <span>Photo measure</span>
      </button>
      <MBottomTabs active="proj"/>
    </div>
  );
}

function TakeoffRow({ code, color, name, qty, unit, amt }) {
  return (
    <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
      <div style={{width:36, height:36, background:color, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:9, fontWeight:700, letterSpacing:'.04em', flexShrink:0}}>{code}</div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:14, fontWeight:500}}>{name}</div>
        <div style={{fontSize:11, color:'#8a8278', marginTop:1, fontFeatureSettings:'"tnum"'}}>{qty} {unit}</div>
      </div>
      <div style={{textAlign:'right'}}>
        <div style={{fontSize:13, fontWeight:600, fontFeatureSettings:'"tnum"'}}>{amt}</div>
        <span className="m-chev" style={{color:'#aea69a', display:'inline-block', marginTop:2}}>{MI.chev}</span>
      </div>
    </div>
  );
}

function TakeoffItemDetail() {
  return (
    <div className="m">
      <MTopBar back title="EPS — East elev." action="edit" actionIcon={MI.edit}/>
      <div className="m-body">
        {/* Drawing canvas */}
        <div style={{margin:'14px 16px 0', height:200, background:'#f5f1ec', borderRadius:14, position:'relative', overflow:'hidden', border:'1px solid #e8e3db'}}>
          <svg viewBox="0 0 280 200" width="100%" height="100%">
            <defs>
              <pattern id="grd" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M0 0 L20 0 M0 0 L0 20" stroke="#e8e3db" strokeWidth=".5" fill="none"/>
              </pattern>
            </defs>
            <rect width="280" height="200" fill="url(#grd)"/>
            {/* polygon outline */}
            <polygon points="40,40 240,38 244,148 38,152" fill="rgba(232,168,107,.3)" stroke="#C77B4F" strokeWidth="2"/>
            <circle cx="40" cy="40" r="4" fill="#fff" stroke="#C77B4F" strokeWidth="2"/>
            <circle cx="240" cy="38" r="4" fill="#fff" stroke="#C77B4F" strokeWidth="2"/>
            <circle cx="244" cy="148" r="4" fill="#fff" stroke="#C77B4F" strokeWidth="2"/>
            <circle cx="38" cy="152" r="4" fill="#fff" stroke="#C77B4F" strokeWidth="2"/>
            {/* dimensions */}
            <text x="140" y="32" fill="#5b544c" fontSize="10" textAnchor="middle" fontWeight="600">36' 4"</text>
            <text x="252" y="95" fill="#5b544c" fontSize="10" textAnchor="middle" fontWeight="600" transform="rotate(90 252 95)">35' 6"</text>
            {/* opening */}
            <rect x="80" y="65" width="40" height="55" fill="#fff" stroke="#aea69a" strokeWidth="1.5" strokeDasharray="3,2"/>
            <text x="100" y="95" fill="#8a8278" fontSize="8" textAnchor="middle">window</text>
          </svg>
          <div style={{position:'absolute', bottom:8, right:8, display:'flex', gap:6}}>
            <button style={{width:30, height:30, background:'#fff', border:'1px solid #e8e3db', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center'}}>＋</button>
            <button style={{width:30, height:30, background:'#fff', border:'1px solid #e8e3db', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center'}}>−</button>
          </div>
        </div>
        {/* Measurements */}
        <div className="m-section-h">Measurement</div>
        <div className="m-list-inset">
          <MRow leading={MI.ruler} headline="Gross area" trailing="1,290 sf" chev={false}/>
          <MRow leading={MI.close} leadingTone="amber" headline="Window subtraction" trailing="−5.5 sf" chev={false}/>
          <MRow leading={MI.check} leadingTone="green" headline="Net billable" trailing={<strong style={{fontFeatureSettings:'"tnum"'}}>1,284.5 sf</strong>} chev={false}/>
        </div>
        {/* Pricing */}
        <div className="m-section-h">Pricing</div>
        <div style={{margin:'0 16px', padding:'14px 16px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
          <div style={{display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:8}}>
            <span style={{color:'#5b544c'}}>Material + labor</span>
            <span style={{fontFeatureSettings:'"tnum"'}}>1,284.5 × $4.85</span>
          </div>
          <div style={{height:1, background:'#e8e3db', margin:'8px 0'}}/>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
            <span style={{fontSize:13, fontWeight:600}}>Line total</span>
            <span style={{fontSize:22, fontWeight:600, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em'}}>$6,229.83</span>
          </div>
        </div>
        {/* Photos */}
        <div className="m-section-h">Reference (3)</div>
        <div style={{padding:'0 16px', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8}}>
          {['#E8A86B', '#C77B4F', '#A05A33'].map((c, i) => (
            <div key={i} style={{aspectRatio:'1', background:`linear-gradient(135deg, ${c} 0%, ${c}aa 100%)`, borderRadius:10, position:'relative'}}>
              <div style={{position:'absolute', bottom:6, left:6, fontSize:9, color:'#fff', textShadow:'0 1px 2px rgba(0,0,0,.4)', fontWeight:500}}>04/{20+i}</div>
            </div>
          ))}
        </div>
      </div>
      <MBottomTabs active="proj"/>
    </div>
  );
}

function TakeoffPhotoMeasure() {
  return (
    <div className="m" style={{background:'#000'}}>
      {/* camera viewfinder */}
      <div style={{flex:1, position:'relative', overflow:'hidden'}}>
        {/* fake photo of building */}
        <div style={{position:'absolute', inset:0, background:'linear-gradient(to bottom, #4a5862 0%, #2a3038 60%, #1c2026 100%)'}}>
          <svg viewBox="0 0 280 500" width="100%" height="100%" preserveAspectRatio="none">
            <rect x="0" y="280" width="280" height="220" fill="#c8b89c"/>
            <rect x="40" y="100" width="200" height="200" fill="#9c8a72"/>
            <rect x="80" y="140" width="40" height="60" fill="#3a4048"/>
            <rect x="160" y="140" width="40" height="60" fill="#3a4048"/>
            <rect x="80" y="220" width="40" height="60" fill="#3a4048"/>
            <rect x="160" y="220" width="40" height="60" fill="#3a4048"/>
          </svg>
        </div>
        {/* AR overlay - corner pins */}
        <svg viewBox="0 0 280 500" style={{position:'absolute', inset:0}} preserveAspectRatio="none">
          <polygon points="40,100 240,100 240,300 40,300" fill="rgba(217,144,74,.20)" stroke="#d9904a" strokeWidth="2.5" strokeDasharray="6,3"/>
          <circle cx="40" cy="100" r="8" fill="#d9904a" stroke="#fff" strokeWidth="2"/>
          <circle cx="240" cy="100" r="8" fill="#d9904a" stroke="#fff" strokeWidth="2"/>
          <circle cx="240" cy="300" r="8" fill="#d9904a" stroke="#fff" strokeWidth="2"/>
          <circle cx="40" cy="300" r="8" fill="#d9904a" stroke="#fff" strokeWidth="2"/>
        </svg>
        {/* live measurement */}
        <div style={{position:'absolute', top:60, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,.6)', backdropFilter:'blur(12px)', padding:'8px 14px', borderRadius:18, color:'#fff', fontSize:13, fontFeatureSettings:'"tnum"'}}>
          <span style={{color:'#d9904a', marginRight:6}}>●</span>
          24'8" × 12'4" · ~304 sf
        </div>
        {/* hint */}
        <div style={{position:'absolute', top:120, left:0, right:0, textAlign:'center', color:'rgba(255,255,255,.85)', fontSize:12, padding:'0 30px'}}>Move slowly across the wall to lock corners</div>

        {/* top bar */}
        <div style={{position:'absolute', top:14, left:14, right:14, display:'flex', justifyContent:'space-between'}}>
          <button style={{width:36, height:36, background:'rgba(0,0,0,.4)', backdropFilter:'blur(12px)', border:'none', borderRadius:18, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center'}}>{MI.close}</button>
          <div style={{padding:'8px 12px', background:'rgba(0,0,0,.4)', backdropFilter:'blur(12px)', borderRadius:18, color:'#fff', fontSize:12, fontWeight:500}}>EPS · East elev.</div>
          <button style={{width:36, height:36, background:'rgba(0,0,0,.4)', backdropFilter:'blur(12px)', border:'none', borderRadius:18, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center'}}>{MI.bolt}</button>
        </div>
      </div>
      {/* bottom controls */}
      <div style={{padding:'20px 0 30px', background:'linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,0))'}}>
        <div style={{display:'flex', justifyContent:'space-around', gap:8, padding:'0 30px 14px', color:'rgba(255,255,255,.65)', fontSize:11, fontWeight:500}}>
          <span>Polygon</span>
          <span style={{color:'#fff'}}>Rectangle</span>
          <span>Linear</span>
          <span>Point</span>
        </div>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 30px'}}>
          <button style={{width:48, height:48, background:'rgba(255,255,255,.15)', backdropFilter:'blur(12px)', border:'none', borderRadius:12, color:'#fff', fontSize:11, fontWeight:600}}>Photo</button>
          <button style={{width:74, height:74, borderRadius:37, background:'#fff', border:'5px solid rgba(255,255,255,.3)', display:'flex', alignItems:'center', justifyContent:'center'}}>
            <span style={{width:54, height:54, borderRadius:14, background:'#d9904a'}}/>
          </button>
          <button style={{width:48, height:48, background:'rgba(255,255,255,.15)', backdropFilter:'blur(12px)', border:'none', borderRadius:12, color:'#fff', fontSize:11, fontWeight:600}}>Done</button>
        </div>
      </div>
    </div>
  );
}

function TakeoffSummary() {
  return (
    <div className="m">
      <MTopBar back title="Takeoff summary"/>
      <div className="m-body">
        {/* hero */}
        <div style={{padding:'14px 20px 18px', textAlign:'center', borderBottom:'1px solid #e8e3db'}}>
          <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Total exterior</div>
          <div style={{fontSize:44, fontWeight:700, letterSpacing:'-0.025em', lineHeight:1, marginTop:4, fontFeatureSettings:'"tnum"'}}>4,785 <span style={{fontSize:18, color:'#8a8278', fontWeight:500}}>sf</span></div>
          <div style={{fontSize:13, color:'#5b544c', marginTop:6}}>Across 4 elevations · 9 line items</div>
        </div>

        {/* Elevation breakdown */}
        <div className="m-section-h">By elevation</div>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          {[
            {l:'East', sf:1290, p:0.32, c:'#E8A86B'},
            {l:'South', sf:1280, p:0.28, c:'#C77B4F'},
            {l:'West', sf:1180, p:0.25, c:'#A05A33'},
            {l:'North', sf:1035, p:0.15, c:'#7A8C6F'},
          ].map(e => (
            <div key={e.l} style={{padding:'12px 14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
                <span style={{fontSize:13, fontWeight:600}}>{e.l} elevation</span>
                <span style={{fontSize:13, fontFeatureSettings:'"tnum"'}}>{e.sf.toLocaleString()} sf</span>
              </div>
              <div style={{height:6, background:'#f5f1ec', borderRadius:3, overflow:'hidden'}}>
                <div style={{width:`${e.p*100*2.5}%`, height:'100%', background:e.c, maxWidth:'100%'}}/>
              </div>
            </div>
          ))}
        </div>

        {/* Material breakdown */}
        <div className="m-section-h">By material</div>
        <div className="m-list-inset">
          <MRow leading={<span style={{width:14, height:14, borderRadius:4, background:'#E8A86B', display:'inline-block'}}/>} headline="EPS Insulation" trailing="2,226 sf" chev={false}/>
          <MRow leading={<span style={{width:14, height:14, borderRadius:4, background:'#C77B4F', display:'inline-block'}}/>} headline="Basecoat" trailing="2,226 sf" chev={false}/>
          <MRow leading={<span style={{width:14, height:14, borderRadius:4, background:'#A05A33', display:'inline-block'}}/>} headline="Finish Coat" trailing="2,226 sf" chev={false}/>
          <MRow leading={<span style={{width:14, height:14, borderRadius:4, background:'#7A8C6F', display:'inline-block'}}/>} headline="Cultured Stone" trailing="184 sf" chev={false}/>
          <MRow leading={<span style={{width:14, height:14, borderRadius:4, background:'#6FA8A0', display:'inline-block'}}/>} headline="Caulking" trailing="310 lf" chev={false}/>
          <MRow leading={<span style={{width:14, height:14, borderRadius:4, background:'#9C7A5B', display:'inline-block'}}/>} headline="Flashing" trailing="142 lf" chev={false}/>
        </div>

        <div className="m-btn-stack" style={{margin:'14px 0'}}>
          <button className="m-btn" data-variant="primary">Build estimate</button>
          <button className="m-btn" data-variant="ghost">Export PDF</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SECTION 6 — ESTIMATE (mobile)
// ============================================================

function EstimateSummary() {
  return (
    <div className="m">
      <MTopBar back title="Estimate" sub="EST-2026-184 · Draft" action="more" actionIcon={MI.share}/>
      <div className="m-body">
        {/* Hero */}
        <div style={{padding:'18px 20px 18px', background:'linear-gradient(180deg, #f7f4ef 0%, transparent 100%)', borderBottom:'1px solid #e8e3db'}}>
          <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>For Hillcrest Homes</div>
          <div style={{fontSize:18, fontWeight:600, marginTop:2, letterSpacing:'-0.01em'}}>Hillcrest Mews — Phase 4</div>
          <div style={{display:'flex', alignItems:'baseline', gap:6, marginTop:14}}>
            <span style={{fontSize:42, fontWeight:700, letterSpacing:'-0.025em', fontFeatureSettings:'"tnum"', lineHeight:1}}>$184,250</span>
          </div>
          <div style={{fontSize:13, color:'#5b544c', marginTop:6}}>4,785 sf @ $38.50 / sf · ~32 days</div>
          <div style={{display:'flex', gap:10, marginTop:14}}>
            <span className="m-pill" data-tone="green" dot>34% margin</span>
            <span className="m-pill">Net 30</span>
            <span className="m-pill">3-pmt schedule</span>
          </div>
        </div>

        {/* AI LAYER · Bid accuracy — the keystone */}
        <div style={{padding:'14px 16px 0'}}>
          <MAiStripe
            tone="warn"
            eyebrow="Heads up"
            title="EPS bids on jobs > 2,500 sf have averaged 12% under actual."
            attribution={<MAttribution>Based on <strong>7 closed jobs</strong>.</MAttribution>}
            action={
              <div style={{display:'flex', gap:8}}>
                <button style={{flex:1, padding:'8px 10px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:8, fontSize:12, fontWeight:600}}>Apply $4.85/sf</button>
                <button style={{padding:'8px 12px', background:'transparent', color:'var(--m-ink-2)', border:'1px solid var(--m-line)', borderRadius:8, fontSize:12}}>See math</button>
              </div>
            }
          >
            EPS lines on this estimate are at <span className="num" style={{fontWeight:600, color:'var(--m-ink)'}}>$4.32</span>/sf. Consider <span className="num" style={{fontWeight:600, color:'var(--m-ink)'}}>$4.85</span>/sf — adds <span className="num" style={{fontWeight:600, color:'var(--m-ink)'}}>$1,180</span> to the bid.
          </MAiStripe>
        </div>

        {/* Sections */}
        <div className="m-section-h">Line items (9)</div>
        <div className="m-list-inset">
          <EstLine name="EPS Insulation" qty="2,226 sf @ $4.85" amt="$10,796"/>
          <EstLine name="Basecoat" qty="2,226 sf @ $3.20" amt="$7,123"/>
          <EstLine name="Finish Coat" qty="2,226 sf @ $4.10" amt="$9,127"/>
          <EstLine name="Cultured Stone — feature" qty="184 sf @ $22.50" amt="$4,140"/>
          <EstLine name="Caulking + flashing" qty="452 lf @ avg $5.10" amt="$2,305"/>
        </div>

        <div className="m-section-h">Costs</div>
        <div style={{margin:'0 16px', padding:'14px 16px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
          {[
            {l:'Subtotal', v:'$33,491'},
            {l:'Materials', v:'$48,260'},
            {l:'Labor (1,250 hrs @ $38)', v:'$47,500'},
            {l:'Overhead (15%)', v:'$21,488'},
            {l:'Margin (10%)', v:'$33,512'},
          ].map(r => (
            <div key={r.l} style={{display:'flex', justifyContent:'space-between', padding:'8px 0', fontSize:13, color:'#5b544c', borderBottom:'1px dashed #e8e3db'}}>
              <span>{r.l}</span>
              <span style={{fontFeatureSettings:'"tnum"', color:'#1c1816'}}>{r.v}</span>
            </div>
          ))}
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', paddingTop:10, marginTop:6, borderTop:'2px solid #1c1816'}}>
            <span style={{fontSize:14, fontWeight:600}}>Total</span>
            <span style={{fontSize:22, fontWeight:700, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em'}}>$184,250</span>
          </div>
        </div>

        <div className="m-section-h">Send to</div>
        <div className="m-list-inset">
          <MRow leading="JM" leadingTone="blue" headline="John Marchetti" supporting="john@hillcresthomes.com"/>
          <MRow leading={MI.plus} headline="Add recipient" supporting="Owner, GC, architect" chev={false}/>
        </div>

        <div className="m-btn-stack" style={{margin:'14px 0'}}>
          <button className="m-btn" data-variant="primary">Send estimate</button>
          <button className="m-btn" data-variant="ghost">Save draft</button>
        </div>
      </div>
    </div>
  );
}

function EstLine({ name, qty, amt }) {
  return (
    <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center'}}>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:14, fontWeight:500}}>{name}</div>
        <div style={{fontSize:11, color:'#8a8278', marginTop:1, fontFeatureSettings:'"tnum"'}}>{qty}</div>
      </div>
      <div style={{fontSize:14, fontWeight:600, fontFeatureSettings:'"tnum"', textAlign:'right'}}>{amt}</div>
    </div>
  );
}

function EstimateSent() {
  return (
    <div className="m">
      <MTopBar back title="EST-2026-184" sub="Sent · Apr 19"/>
      <div className="m-body">
        {/* Status timeline */}
        <div style={{padding:'18px 20px 8px'}}>
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:14}}>
            <span style={{width:10, height:10, background:'#2c8a55', borderRadius:5, boxShadow:'0 0 0 4px rgba(44,138,85,.18)'}}/>
            <span style={{fontSize:14, fontWeight:600, color:'#2c8a55'}}>Read by client</span>
            <span style={{fontSize:11, color:'#8a8278', marginLeft:'auto'}}>2 days ago</span>
          </div>
          <div style={{borderLeft:'2px dashed #e8e3db', marginLeft:5, paddingLeft:18, paddingBottom:14, position:'relative'}}>
            {[
              {t:'Read by John Marchetti', d:'Wed Apr 22, 10:14 AM', c:'#2c8a55'},
              {t:'Estimate opened (3×)', d:'Apr 22 · Apr 24 · Apr 26', c:'#5b544c'},
              {t:'Sent to john@hillcresthomes.com', d:'Mon Apr 19, 4:42 PM', c:'#5b544c'},
              {t:'Created from takeoff', d:'Mon Apr 19, 4:30 PM', c:'#aea69a'},
            ].map((e, i) => (
              <div key={i} style={{marginBottom:12, position:'relative'}}>
                <span style={{position:'absolute', left:-25, top:4, width:8, height:8, borderRadius:4, background:'#fff', border:`2px solid ${e.c}`}}/>
                <div style={{fontSize:13, fontWeight:500}}>{e.t}</div>
                <div style={{fontSize:11, color:'#8a8278'}}>{e.d}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="m-section-h">Total quoted</div>
        <div style={{padding:'14px 16px', textAlign:'center'}}>
          <div style={{fontSize:36, fontWeight:700, fontFeatureSettings:'"tnum"', letterSpacing:'-0.025em', lineHeight:1}}>$184,250</div>
          <div style={{fontSize:12, color:'#8a8278', marginTop:4}}>4,785 sf · ~32 days</div>
        </div>

        <div className="m-btn-stack" style={{marginTop:8}}>
          <button className="m-btn" data-variant="primary">{MI.send}<span>Send nudge</span></button>
          <button className="m-btn" data-variant="ghost">Open PDF</button>
          <button className="m-btn" data-variant="quiet">Duplicate as new bid</button>
        </div>
      </div>
    </div>
  );
}

function EstimateShareSheet() {
  return (
    <div className="m" style={{position:'relative', background:'#fff'}}>
      {/* base */}
      <div style={{padding:'14px 20px', borderBottom:'1px solid #e8e3db', opacity:.4}}>
        <div style={{fontSize:18, fontWeight:600}}>EST-2026-184</div>
      </div>
      <div className="m-body" style={{opacity:.4}}/>
      {/* scrim */}
      <div style={{position:'absolute', inset:0, background:'rgba(0,0,0,.45)'}}/>
      {/* sheet */}
      <div className="m-sheet" style={{position:'absolute', left:0, right:0, bottom:0}}>
        <div className="m-sheet-grabber"/>
        <div className="m-sheet-header">
          <div className="m-sheet-title">Send estimate</div>
        </div>
        <div className="m-sheet-body">
          <div className="m-section-h" style={{paddingTop:0}}>Channel</div>
          <div className="m-list-inset">
            <MRow leading={MI.send} leadingTone="accent" headline="Email · PDF attached" supporting="john@hillcresthomes.com" trailing={<span className="m-pill" data-tone="accent">primary</span>} chev={false}/>
            <MRow leading={MI.share} leadingTone="blue" headline="Text message · web link" supporting="(403) 555-1840" chev={false}/>
            <MRow leading={MI.doc} headline="Print" supporting="System print dialog" chev={false}/>
          </div>
          <div className="m-section-h">Personalize</div>
          <div className="m-list-inset">
            <MRow leading={MI.edit} headline="Cover note" supporting="Hi John, here's the estimate we discussed…" trailing={MI.chev} chev={false}/>
            <MRow leading={MI.lock} headline="PDF protection" supporting="Off" trailing={MI.chev} chev={false}/>
            <MRow leading={MI.bell} headline="Auto-nudge after" supporting="3 days · then 7 days" trailing={MI.chev} chev={false}/>
          </div>
          <div className="m-btn-stack" style={{marginTop:14}}>
            <button className="m-btn" data-variant="primary">Send now</button>
            <button className="m-btn" data-variant="ghost">Schedule for tomorrow 9 AM</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SECTION 7 — SCHEDULE (mobile)
// ============================================================

function ScheduleDay() {
  return (
    <div className="m">
      <div style={{padding:'14px 20px 6px'}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div>
            <div style={{display:'flex', alignItems:'baseline', gap:10}}>
              <div style={{fontSize:30, fontWeight:700, letterSpacing:'-0.02em'}}>Schedule</div>
            </div>
            <div style={{fontSize:13, color:'#5b544c', marginTop:2}}>Mon, Apr 28 · 3 jobs · 18 crew</div>
          </div>
          {/* Day/Week toggle — default "Day" for foreman role */}
          <div style={{display:'inline-flex', padding:2, background:'#ece7df', borderRadius:9}}>
            <button style={{padding:'5px 12px', fontFamily:'inherit', fontSize:12, fontWeight:600, border:'none', borderRadius:7, background:'#fff', color:'#1c1816', cursor:'pointer'}}>Day</button>
            <button style={{padding:'5px 12px', fontFamily:'inherit', fontSize:12, fontWeight:500, border:'none', background:'transparent', color:'#5b544c', cursor:'pointer'}}>Week</button>
          </div>
        </div>
      </div>
      {/* day picker */}
      <div style={{display:'flex', gap:6, padding:'8px 16px 12px', overflow:'auto', borderBottom:'1px solid #e8e3db'}}>
        {[
          {d:'Sun', n:27, off:true},
          {d:'Mon', n:28, on:true},
          {d:'Tue', n:29},
          {d:'Wed', n:30},
          {d:'Thu', n:1},
          {d:'Fri', n:2},
          {d:'Sat', n:3, off:true},
        ].map(d => (
          <button key={d.d} style={{minWidth:46, padding:'8px 4px', border:'none', borderRadius:10, background: d.on ? '#1c1816' : 'transparent', color: d.on ? '#fff' : (d.off ? '#aea69a' : '#1c1816'), fontFamily:'inherit', textAlign:'center'}}>
            <div style={{fontSize:10, fontWeight:500, opacity:.7}}>{d.d}</div>
            <div style={{fontSize:18, fontWeight:600, marginTop:2, fontFeatureSettings:'"tnum"'}}>{d.n}</div>
          </button>
        ))}
      </div>
      <div className="m-body" style={{padding:'12px 0'}}>
        <div style={{padding:'0 16px', display:'grid', gap:10}}>
          {[
            {p:'Hillcrest Mews', t:'#E8A86B', sc:'EPS east elevation', cw:[{n:'AC',t:1},{n:'ML',t:2},{n:'TR',t:5}], time:'7:00 AM – 3:30 PM', conf:true, hrs:'25.5h'},
            {p:'Aspen Ridge', t:'#A05A33', sc:'Block A basecoat', cw:[{n:'PS',t:4},{n:'DF',t:3},{n:'HM',t:6},{n:'SB',t:7}], time:'7:00 AM – 4:00 PM', conf:true, hrs:'34h'},
            {p:'Greenwillow', t:'#7A8C6F', sc:'Punch list — south facade', cw:[{n:'JO',t:8}], time:'8:00 AM – 2:00 PM', conf:false, hrs:'5h'},
          ].map(j => (
            <div key={j.p} style={{padding:0, background:'#fff', border:'1px solid #e8e3db', borderRadius:14, overflow:'hidden'}}>
              <div style={{height:4, background:j.t}}/>
              <div style={{padding:'12px 14px'}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start'}}>
                  <div>
                    <div style={{fontSize:15, fontWeight:600}}>{j.p}</div>
                    <div style={{fontSize:12, color:'#5b544c', marginTop:2}}>{j.sc}</div>
                  </div>
                  {j.conf ? <span className="m-pill" data-tone="green" dot>confirmed</span> : <span className="m-pill" data-tone="amber" dot>pending</span>}
                </div>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:12}}>
                  <div style={{display:'flex'}}>
                    {j.cw.map((c, i) => (
                      <div key={i} className="m-avatar" data-size="sm" data-tone={c.t} style={{marginLeft: i === 0 ? 0 : -8, border:'2px solid #fff'}}>{c.n}</div>
                    ))}
                  </div>
                  <div style={{fontSize:12, color:'#5b544c', fontFeatureSettings:'"tnum"'}}>{j.time}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <button className="m-fab">{MI.plus}</button>
      <MBottomTabs active="sched"/>
    </div>
  );
}

function ScheduleWeek() {
  return (
    <div className="m">
      <div style={{padding:'14px 20px 6px'}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div>
            <div style={{display:'flex', alignItems:'baseline', gap:10}}>
              <div style={{fontSize:30, fontWeight:700, letterSpacing:'-0.02em'}}>Schedule</div>
            </div>
            <div style={{fontSize:13, color:'#5b544c', marginTop:2}}>Apr 27 – May 3 · 47 assignments</div>
          </div>
          {/* Day/Week toggle — default "Week" for owner role */}
          <div style={{display:'inline-flex', padding:2, background:'#ece7df', borderRadius:9}}>
            <button style={{padding:'5px 12px', fontFamily:'inherit', fontSize:12, fontWeight:500, border:'none', background:'transparent', color:'#5b544c', cursor:'pointer'}}>Day</button>
            <button style={{padding:'5px 12px', fontFamily:'inherit', fontSize:12, fontWeight:600, border:'none', borderRadius:7, background:'#fff', color:'#1c1816', cursor:'pointer'}}>Week</button>
          </div>
        </div>
      </div>
      <div style={{padding:'8px 16px 10px', borderBottom:'1px solid #e8e3db', fontSize:12, color:'#8a8278'}}>3 projects · 18 crew · 92% utilization</div>
      <div className="m-body">
        <div style={{padding:'10px 0'}}>
          {/* weekly grid: rows are days, columns are projects */}
          <div style={{padding:'0 16px', display:'grid', gridTemplateColumns:'48px 1fr 1fr 1fr', gap:6, fontSize:9, fontWeight:600, color:'#aea69a', textTransform:'uppercase', letterSpacing:'.06em', paddingBottom:8, borderBottom:'1px solid #e8e3db'}}>
            <span/>
            <span style={{textAlign:'center'}}>Hillcrest</span>
            <span style={{textAlign:'center'}}>Aspen</span>
            <span style={{textAlign:'center'}}>Greenwl.</span>
          </div>
          {[
            {d:'MON', n:28, today:true, h:[3, 4, 1]},
            {d:'TUE', n:29, h:[2, 3, 0]},
            {d:'WED', n:30, h:[3, 3, 0]},
            {d:'THU', n:1,  h:[2, 4, 0]},
            {d:'FRI', n:2,  h:[2, 4, 0]},
            {d:'SAT', n:3,  h:[0, 0, 0]},
            {d:'SUN', n:4,  h:[0, 0, 0]},
          ].map((r, i) => (
            <div key={i} style={{padding:'10px 16px', display:'grid', gridTemplateColumns:'48px 1fr 1fr 1fr', gap:6, alignItems:'center', borderBottom:'1px solid #f5f1ec', background: r.today ? 'rgba(217,144,74,.06)' : 'transparent'}}>
              <div>
                <div style={{fontSize:10, color:'#8a8278', fontWeight:600}}>{r.d}</div>
                <div style={{fontSize:18, fontWeight:600, fontFeatureSettings:'"tnum"', color: r.today ? '#d9904a' : '#1c1816'}}>{r.n}</div>
              </div>
              {r.h.map((n, j) => {
                const colors = ['#E8A86B', '#A05A33', '#7A8C6F'];
                return (
                  <div key={j} style={{height:48, borderRadius:8, background: n > 0 ? colors[j] + '22' : '#f7f4ef', border: n > 0 ? `1px solid ${colors[j]}55` : '1px solid #e8e3db', padding:'6px 8px', position:'relative'}}>
                    {n > 0 ? (
                      <>
                        <div style={{display:'flex', alignItems:'center', gap:3, marginBottom:3}}>
                          {Array.from({length: n}).map((_, k) => (
                            <span key={k} style={{width:6, height:6, borderRadius:3, background:colors[j]}}/>
                          ))}
                        </div>
                        <div style={{fontSize:9, color:'#5b544c', fontWeight:500, lineHeight:1.2}}>{n} crew</div>
                      </>
                    ) : <div style={{fontSize:9, color:'#aea69a', textAlign:'center', paddingTop:14}}>—</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="m-section-h">Capacity</div>
        <div style={{padding:'0 16px'}}>
          <div style={{padding:'14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:6}}>
              <span style={{fontSize:13, fontWeight:600}}>Crew utilization</span>
              <span style={{fontSize:18, fontWeight:600, fontFeatureSettings:'"tnum"', color:'#2c8a55'}}>92%</span>
            </div>
            <div style={{height:8, background:'#f5f1ec', borderRadius:4, overflow:'hidden', marginBottom:8}}>
              <div style={{width:'92%', background:'#2c8a55', height:'100%'}}/>
            </div>
            <div style={{fontSize:11, color:'#8a8278'}}>14 of 16 slots filled · 2 crew available Tue/Wed</div>
          </div>
        </div>
      </div>
      <MBottomTabs active="sched"/>
    </div>
  );
}

function ScheduleCreateAssignment() {
  return (
    <div className="m">
      <div style={{height:52, padding:'8px 16px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #e8e3db'}}>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#5b544c'}}>Cancel</button>
        <div style={{flex:1, fontSize:17, fontWeight:600, textAlign:'center'}}>New assignment</div>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#d9904a', fontWeight:600}}>Save</button>
      </div>
      <div className="m-body">
        <div className="m-section-h" style={{paddingTop:14}}>Project</div>
        <div className="m-list-inset">
          <div style={{padding:'12px 14px', background:'#fff', display:'flex', alignItems:'center', gap:12}}>
            <div style={{width:32, height:32, borderRadius:8, background:'#E8A86B', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700}}>HC</div>
            <div style={{flex:1}}>
              <div style={{fontSize:14, fontWeight:500}}>Hillcrest Mews — Phase 4</div>
              <div style={{fontSize:11, color:'#8a8278'}}>4820 Crestline Dr</div>
            </div>
            <span className="m-chev" style={{color:'#aea69a'}}>{MI.chev}</span>
          </div>
        </div>

        <div className="m-section-h">When</div>
        <div className="m-list-inset">
          <MRow leading={MI.cal} headline="Date" trailing="Tue, Apr 29"/>
          <MRow leading={MI.time} headline="Start" trailing="7:00 AM"/>
          <MRow leading={MI.time} headline="End" trailing="3:30 PM"/>
        </div>

        <div className="m-section-h">Scope</div>
        <div style={{padding:'0 16px'}}>
          <div style={{padding:'14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
            <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>From takeoff</div>
            <div style={{fontSize:14, fontWeight:500, marginTop:6}}>EPS — East elevation</div>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:8, fontSize:12, color:'#5b544c'}}>
              <span>1,284.5 sf @ 145 sf/hr</span>
              <strong style={{color:'#2c8a55', fontFeatureSettings:'"tnum"'}}>≈ 8.9 crew-hrs</strong>
            </div>
            <div style={{padding:'10px', background:'#f7f4ef', borderRadius:8, marginTop:10, fontSize:11, color:'#5b544c', display:'flex', alignItems:'flex-start', gap:8}}>
              <span style={{color:'#d9904a', flexShrink:0}}>{MI.spark}</span>
              <span>Suggesting <strong>3 crew × 3 hours</strong> based on past pace at this elevation type. Adjust if you've got reasons to push harder.</span>
            </div>
          </div>
        </div>

        <div className="m-section-h">Crew (3)</div>
        <div className="m-list-inset">
          <div style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #e8e3db'}}>
            <div className="m-avatar" data-tone="1">AC</div>
            <div style={{flex:1}}><strong style={{fontSize:14}}>Ana Castillo</strong><div style={{fontSize:11, color:'#8a8278'}}>Lead · 32.5h this week</div></div>
            <button style={{background:'transparent', border:'none', color:'#c0463d'}}>{MI.close}</button>
          </div>
          <div style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #e8e3db'}}>
            <div className="m-avatar" data-tone="2">ML</div>
            <div style={{flex:1}}><strong style={{fontSize:14}}>Marcus Lee</strong><div style={{fontSize:11, color:'#8a8278'}}>Crew · 30h this week</div></div>
            <button style={{background:'transparent', border:'none', color:'#c0463d'}}>{MI.close}</button>
          </div>
          <div style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:10}}>
            <div className="m-avatar" data-tone="5">TR</div>
            <div style={{flex:1}}><strong style={{fontSize:14}}>Tomás Reyes</strong><div style={{fontSize:11, color:'#8a8278'}}>Crew · 24h this week · light week</div></div>
            <button style={{background:'transparent', border:'none', color:'#c0463d'}}>{MI.close}</button>
          </div>
        </div>
        <div style={{padding:'8px 16px'}}>
          <button className="m-btn" data-variant="ghost">+ Add crew</button>
        </div>

        <div className="m-section-h">Notify</div>
        <div className="m-list-inset">
          <MRow leading={MI.bell} headline="Push notification" supporting="Tonight at 5 PM" trailing={<span className="m-pill" data-tone="accent">on</span>} chev={false}/>
          <MRow leading={MI.send} headline="SMS fallback" supporting="If push fails" trailing={<span className="m-pill" data-tone="accent">on</span>} chev={false}/>
        </div>
        <div style={{height:24}}/>
      </div>
    </div>
  );
}

// ============================================================
// SECTION 8 — TIME (mobile)
// ============================================================

// TimeApprovalQueue removed — superseded by ProjectCrewOwner (project-scoped)
// and TimeQueueAllProjects (cross-project). Both live in mb-screens-crew.jsx.

function TimeBurden() {
  return (
    <div className="m">
      <MTopBar back title="Labor cost" sub="this week"/>
      {/* Scope picker — portfolio or single project */}
      <div style={{display:'flex', gap:6, padding:'10px 16px', borderBottom:'1px solid #e8e3db', overflowX:'auto', background:'#fff'}}>
        {[
          {l:'Portfolio', v:'$54.20', avg:true},
          {l:'Hillcrest', c:'#E8A86B', v:'$54.20', on:true},
          {l:'Aspen Ridge', c:'#A05A33', v:'$56.10'},
          {l:'Greenwillow', c:'#7A8C6F', v:'$51.80'},
        ].map(c => (
          <button key={c.l} style={{
            flex:'0 0 auto', padding:'6px 11px', borderRadius:18,
            background: c.on ? '#1c1816' : '#fff',
            color: c.on ? '#fff' : '#5b544c',
            border: c.on ? 'none' : '1px solid #e8e3db',
            fontFamily:'inherit', fontSize:12, fontWeight:500,
            display:'inline-flex', alignItems:'center', gap:6,
            whiteSpace:'nowrap',
          }}>
            {c.c && <span style={{width:6, height:6, borderRadius:3, background:c.c}}/>}
            {c.avg && <span style={{color:c.on?'#aea69a':'#aea69a', fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em'}}>avg</span>}
            {c.l}
          </button>
        ))}
      </div>
      <div className="m-body">
        {/* Hero */}
        <div style={{padding:'18px 20px 18px', textAlign:'center', borderBottom:'1px solid #e8e3db'}}>
          <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>True hourly cost</div>
          <div style={{fontSize:42, fontWeight:700, letterSpacing:'-0.025em', lineHeight:1, marginTop:6, fontFeatureSettings:'"tnum"'}}>$54.20</div>
          <div style={{fontSize:13, color:'#5b544c', marginTop:6}}>vs base rate $38.00 · <span style={{color:'#c0463d', fontWeight:600}}>+42.6% loaded</span></div>
        </div>

        {/* Stack visualization */}
        <div style={{padding:'18px 16px 8px'}}>
          <div style={{display:'flex', flexDirection:'column-reverse', gap:0, borderRadius:10, overflow:'hidden', border:'1px solid #e8e3db'}}>
            {[
              {l:'Base wage', v:38.00, c:'#1c1816'},
              {l:'Payroll tax (FICA, FUTA)', v:4.85, c:'#5b544c'},
              {l:'Workers comp', v:3.42, c:'#c98a2e'},
              {l:'Health + benefits', v:5.20, c:'#2f6fb5'},
              {l:'PTO accrual', v:1.55, c:'#7A8C6F'},
              {l:'Truck/tools per hr', v:1.18, c:'#A05A33'},
            ].map((b, i) => (
              <div key={i} style={{display:'flex', alignItems:'center', padding:'10px 14px', background:'#fff', borderTop: i > 0 ? '1px solid #e8e3db' : 'none'}}>
                <span style={{width:6, height:24, background:b.c, borderRadius:3, marginRight:12}}/>
                <div style={{flex:1, fontSize:13}}>{b.l}</div>
                <div style={{fontSize:13, fontWeight:600, fontFeatureSettings:'"tnum"'}}>${b.v.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Project rollup */}
        <div className="m-section-h">This week's totals</div>
        <div className="m-list-inset">
          <MRow leading={MI.users} headline="Crew-hours" trailing={<strong style={{fontFeatureSettings:'"tnum"'}}>187.5h</strong>} chev={false}/>
          <MRow leading={MI.$} headline="Base labor" trailing={<span style={{fontFeatureSettings:'"tnum"'}}>$7,125</span>} chev={false}/>
          <MRow leading={MI.layers} headline="Loaded add-ons" trailing={<span style={{fontFeatureSettings:'"tnum"', color:'#c0463d'}}>+$3,038</span>} chev={false}/>
          <MRow leading={MI.bolt} leadingTone="accent" headline="Loaded total" trailing={<strong style={{fontFeatureSettings:'"tnum"'}}>$10,163</strong>} chev={false}/>
        </div>

        <div style={{margin:'14px 16px', padding:'14px', background:'#f7f4ef', borderRadius:12, fontSize:12, color:'#5b544c', lineHeight:1.5}}>
          <strong style={{color:'#1c1816'}}>Why this matters:</strong> bidding at base $38/hr leaves you 30% short on margin. Loaded $54/hr is the number to use in estimates.
        </div>
      </div>
    </div>
  );
}

function TimeLiveVsBudget() {
  return (
    <div className="m">
      <MTopBar back title="Live vs budget" sub="this week"/>
      {/* Scope picker — portfolio or single project */}
      <div style={{display:'flex', gap:6, padding:'10px 16px', borderBottom:'1px solid #e8e3db', overflowX:'auto', background:'#fff'}}>
        {[
          {l:'Portfolio', avg:true, on:true},
          {l:'Hillcrest', c:'#E8A86B'},
          {l:'Aspen Ridge', c:'#A05A33'},
          {l:'Greenwillow', c:'#7A8C6F'},
        ].map(c => (
          <button key={c.l} style={{
            flex:'0 0 auto', padding:'6px 11px', borderRadius:18,
            background: c.on ? '#1c1816' : '#fff',
            color: c.on ? '#fff' : '#5b544c',
            border: c.on ? 'none' : '1px solid #e8e3db',
            fontFamily:'inherit', fontSize:12, fontWeight:500,
            display:'inline-flex', alignItems:'center', gap:6,
            whiteSpace:'nowrap',
          }}>
            {c.c && <span style={{width:6, height:6, borderRadius:3, background:c.c}}/>}
            {c.avg && <span style={{color:c.on?'#aea69a':'#aea69a', fontSize:9, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em'}}>all</span>}
            {c.l}
          </button>
        ))}
      </div>
      <div className="m-body">
        <div className="m-kpi-row" style={{paddingTop:14}}>
          <MKpi label="Spent" value="$10,163" meta="of $24,500" metaTone=""/>
          <MKpi label="Pace" value="1.18×" unit="" meta="ahead of plan" metaTone="green"/>
        </div>

        {/* Burndown */}
        <div style={{padding:'18px 16px 8px'}}>
          <div style={{padding:'14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:14}}>
            <div style={{fontSize:13, fontWeight:600, marginBottom:14}}>Hours burndown</div>
            <svg viewBox="0 0 280 120" style={{width:'100%', height:120}}>
              {/* grid */}
              <line x1="0" y1="20" x2="280" y2="20" stroke="#e8e3db" strokeDasharray="2,3" strokeWidth=".5"/>
              <line x1="0" y1="60" x2="280" y2="60" stroke="#e8e3db" strokeDasharray="2,3" strokeWidth=".5"/>
              <line x1="0" y1="100" x2="280" y2="100" stroke="#e8e3db" strokeWidth=".5"/>
              {/* planned (dashed) */}
              <polyline points="10,100 60,84 110,68 160,52 210,36 260,20" fill="none" stroke="#aea69a" strokeWidth="1.5" strokeDasharray="4,3"/>
              {/* actual */}
              <polyline points="10,100 60,80 110,58 160,38" fill="none" stroke="#d9904a" strokeWidth="2.5"/>
              <circle cx="160" cy="38" r="4" fill="#d9904a"/>
              {/* ribbon */}
              <polygon points="10,100 60,80 110,58 160,38 160,52 110,68 60,84 10,100" fill="rgba(217,144,74,.10)"/>
              {/* labels */}
              <text x="10" y="116" fill="#aea69a" fontSize="9">Day 1</text>
              <text x="160" y="116" fill="#d9904a" fontSize="9" fontWeight="600">Today · 18</text>
              <text x="260" y="116" fill="#aea69a" fontSize="9" textAnchor="end">Day 32</text>
            </svg>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:10, paddingTop:10, borderTop:'1px solid #e8e3db', fontSize:11}}>
              <div style={{display:'flex', alignItems:'center', gap:6}}>
                <span style={{width:12, height:2, background:'#d9904a'}}/><span style={{color:'#5b544c'}}>Actual</span>
              </div>
              <div style={{display:'flex', alignItems:'center', gap:6}}>
                <span style={{width:12, height:1, background:'#aea69a', borderTop:'1px dashed'}}/><span style={{color:'#5b544c'}}>Planned</span>
              </div>
              <strong style={{color:'#2c8a55', fontFeatureSettings:'"tnum"'}}>+24h ahead</strong>
            </div>
          </div>
        </div>

        {/* By scope */}
        <div className="m-section-h">By scope</div>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          {[
            {s:'EPS — East', a:84, b:96, t:'green'},
            {s:'EPS — South', a:68, b:72, t:'green'},
            {s:'Basecoat', a:24, b:50, t:'amber'},
            {s:'Stone feature', a:11.5, b:14, t:'green'},
          ].map(s => {
            const pct = (s.a / s.b) * 100;
            return (
              <div key={s.s} style={{padding:'12px 14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
                  <span style={{fontSize:13, fontWeight:500}}>{s.s}</span>
                  <span style={{fontSize:12, color:'#5b544c', fontFeatureSettings:'"tnum"'}}>{s.a}h / {s.b}h plan</span>
                </div>
                <div style={{height:6, background:'#f5f1ec', borderRadius:3, overflow:'hidden'}}>
                  <div style={{width:`${pct}%`, height:'100%', background: s.t === 'green' ? '#2c8a55' : '#c98a2e'}}/>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <MBottomTabs active="sched"/>
    </div>
  );
}

function TimeForemanEntry() {
  return (
    <div className="m">
      <div style={{height:52, padding:'8px 16px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #e8e3db'}}>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#5b544c'}}>Cancel</button>
        <div style={{flex:1, fontSize:17, fontWeight:600, textAlign:'center'}}>Crew time · Mon</div>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#d9904a', fontWeight:600}}>Submit</button>
      </div>
      <div className="m-body">
        <div style={{padding:'14px 20px 4px'}}>
          <div style={{fontSize:13, color:'#8a8278'}}>Hillcrest Mews — Phase 4</div>
          <div style={{fontSize:18, fontWeight:600, marginTop:2}}>4 crew · 8.5h day · 7:00–15:30</div>
        </div>

        {/* Bulk-confirm banner — does the work for the foreman */}
        <div style={{margin:'10px 16px 4px', padding:'12px 14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:11, display:'flex', alignItems:'center', gap:11}}>
          <span style={{width:34, height:34, borderRadius:8, background:'rgba(44,138,85,0.12)', color:'#2c8a55', display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>{MI.bolt}</span>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:13, fontWeight:600}}>3 match GPS · ready to submit</div>
            <div style={{fontSize:11, color:'#8a8278', marginTop:1}}>One needs your eyes (Tomás)</div>
          </div>
          <button className="m-btn m-btn-sm" data-variant="primary">Confirm 3</button>
        </div>

        {/* Tap-to-confirm rows — the captured times are the source of truth */}
        <div className="m-section-h">Crew (4)</div>
        <div style={{padding:'0 16px', display:'grid', gap:8}}>
          {[
            {n:'Ana Castillo', i:'AC', t:1, hrs:'8.4', span:'7:02–15:24 · 30m lunch', match:true},
            {n:'Marcus Lee', i:'ML', t:2, hrs:'8.4', span:'7:04–15:26 · 30m lunch', match:true},
            {n:'Tomás Reyes', i:'TR', t:5, hrs:'8.0', span:'7:08–15:00 · 45m lunch', match:false},
            {n:'Sara Bouchard', i:'SB', t:7, hrs:'7.5', span:'8:00–15:30 · 30m lunch', match:true},
          ].map(p => (
            <div key={p.n} style={{
              padding:'11px 13px',
              background:'#fff',
              border:`1px solid ${p.match ? '#e8e3db' : '#ecd9b8'}`,
              borderRadius:11,
              display:'flex', alignItems:'center', gap:11,
            }}>
              <div className="m-avatar" data-size="sm" data-tone={p.t}>{p.i}</div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:13.5, fontWeight:600, display:'flex', alignItems:'center', gap:6}}>
                  {p.n}
                  {p.match && <span style={{color:'#2c8a55', fontSize:11}}>✓</span>}
                  {!p.match && <span style={{fontSize:9.5, fontWeight:700, padding:'1px 6px', borderRadius:8, background:'#fbeacf', color:'#8a5a1a', textTransform:'uppercase', letterSpacing:'.05em'}}>review</span>}
                </div>
                <div style={{fontSize:11, color:'#8a8278', marginTop:1, fontFeatureSettings:'"tnum"'}}>{p.span}</div>
              </div>
              <div style={{textAlign:'right', flexShrink:0}}>
                <div style={{fontSize:18, fontWeight:600, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em', lineHeight:1}}>{p.hrs}<span style={{fontSize:11, color:'#8a8278', fontWeight:400}}>h</span></div>
                <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:11, color:'#8a8278', padding:0, marginTop:3, cursor:'pointer'}}>Edit</button>
              </div>
            </div>
          ))}
        </div>

        {/* Totals card */}
        <div className="m-section-h">Day total</div>
        <div style={{padding:'0 16px'}}>
          <div style={{padding:'14px 16px', background:'#1c1816', color:'#f3ecdf', borderRadius:14}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
              <span style={{fontSize:13, color:'#aea69a'}}>Crew-hours</span>
              <span style={{fontSize:24, fontWeight:600, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em'}}>32.3h</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginTop:8, paddingTop:10, borderTop:'1px solid #2a241c'}}>
              <span style={{fontSize:13, color:'#aea69a'}}>Loaded cost</span>
              <span style={{fontSize:18, fontWeight:600, fontFeatureSettings:'"tnum"'}}>$1,750</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  TakeoffList, TakeoffItemDetail, TakeoffPhotoMeasure, TakeoffSummary,
  EstimateSummary, EstimateSent, EstimateShareSheet,
  ScheduleDay, ScheduleWeek, ScheduleCreateAssignment,
  TimeBurden, TimeLiveVsBudget, TimeForemanEntry,
});
