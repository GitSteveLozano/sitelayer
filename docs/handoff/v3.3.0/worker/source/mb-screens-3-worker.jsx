/* global React, MI, MTopBar, MLargeHead, MSectionH, MRow, MKpi, MPill, MBottomTabs, MQA, MAvatarGroup, MBanner, MStage */

// ============================================================
// SECTION 9 — RENTALS (mobile, contractor view)
// ============================================================

function RentalsCatalog() {
  return (
    <div className="m">
      <MTopBar back title="Rentals" sub="My equipment · 14 active"/>
      {/* Search + filter */}
      <div style={{padding:'8px 16px 10px', display:'flex', gap:8, borderBottom:'1px solid #e8e3db'}}>
        <div style={{flex:1, height:38, padding:'0 12px', background:'#f5f1ec', borderRadius:10, display:'flex', alignItems:'center', gap:8, fontSize:13, color:'#8a8278'}}>
          {MI.search} Search by tag or name
        </div>
        <button style={{width:38, height:38, background:'#fff', border:'1px solid #e8e3db', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center'}}>{MI.filter}</button>
      </div>
      {/* Status chips */}
      <div style={{display:'flex', gap:6, padding:'10px 16px', overflow:'auto', borderBottom:'1px solid #e8e3db'}}>
        <button className="m-chip" data-active="true">All <span style={{opacity:.7, marginLeft:2}}>14</span></button>
        <button className="m-chip">Out <span style={{opacity:.7, marginLeft:2}}>9</span></button>
        <button className="m-chip">Available <span style={{opacity:.7, marginLeft:2}}>3</span></button>
        <button className="m-chip">Service <span style={{opacity:.7, marginLeft:2}}>2</span></button>
      </div>
      <div className="m-body">
        <div className="m-stat-strip">
          <div>
            <div className="m-stat-strip-l">Out</div>
            <div className="m-stat-strip-v num">9</div>
          </div>
          <div>
            <div className="m-stat-strip-l">Daily revenue</div>
            <div className="m-stat-strip-v num">$1,184</div>
          </div>
          <div>
            <div className="m-stat-strip-l">Util</div>
            <div className="m-stat-strip-v num" style={{color:'#2c8a55'}}>92%</div>
          </div>
        </div>
        {[
          {n:'Scaffold A — 24×8', cat:'Scaffolding', tag:'SCF-001', s:'out', proj:'Hillcrest Mews', dur:'Day 12 of 32', rate:'$85/day'},
          {n:'Scaffold B — 18×8', cat:'Scaffolding', tag:'SCF-002', s:'out', proj:'Aspen Ridge', dur:'Day 4 of 18', rate:'$65/day'},
          {n:'Mixer M-184', cat:'Power', tag:'MIX-184', s:'available', proj:null, dur:'Last out 4 days ago', rate:'$45/day'},
          {n:'Compressor 25cf', cat:'Power', tag:'CMP-022', s:'service', proj:null, dur:'Pump replacement', rate:'$70/day'},
          {n:'Sprayer (HVLP)', cat:'Tools', tag:'SPR-005', s:'out', proj:'Greenwillow', dur:'Day 2 of 5', rate:'$55/day'},
        ].map(r => (
          <div key={r.tag} style={{margin:'10px 16px 0', background:'#fff', border:'1px solid #e8e3db', borderRadius:12, overflow:'hidden'}}>
            <div style={{padding:'12px 14px', display:'flex', gap:12, alignItems:'center'}}>
              <div style={{width:48, height:48, background: r.s === 'out' ? '#f3e9d8' : r.s === 'service' ? '#fce8de' : '#e3edd9', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
                <RentalIcon cat={r.cat}/>
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{display:'flex', alignItems:'center', gap:6}}>
                  <span style={{fontSize:14, fontWeight:600}}>{r.n}</span>
                </div>
                <div style={{fontSize:11, color:'#8a8278', marginTop:1, fontFeatureSettings:'"tnum"'}}>{r.tag} · {r.cat}</div>
                <div style={{fontSize:11, color: r.s === 'out' ? '#5b544c' : r.s === 'service' ? '#c0463d' : '#2c8a55', marginTop:4}}>
                  {r.proj && <strong>{r.proj} · </strong>}{r.dur}
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                {r.s === 'out' && <span className="m-pill" data-tone="amber" dot>out</span>}
                {r.s === 'available' && <span className="m-pill" data-tone="green" dot>avail</span>}
                {r.s === 'service' && <span className="m-pill" data-tone="red" dot>service</span>}
                <div style={{fontSize:11, color:'#8a8278', marginTop:6, fontFeatureSettings:'"tnum"'}}>{r.rate}</div>
              </div>
            </div>
          </div>
        ))}
        <div style={{height:24}}/>
      </div>
      <button className="m-fab m-fab-extended">{MI.qr}<span>Scan tag</span></button>
      <MBottomTabs active="rent"/>
    </div>
  );
}

function RentalIcon({ cat }) {
  if (cat === 'Scaffolding') return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b544c" strokeWidth="1.6"><path d="M3 5h18M3 12h18M3 19h18M7 5v14M12 5v14M17 5v14"/></svg>;
  if (cat === 'Power') return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b544c" strokeWidth="1.6"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M9 6V3M15 6V3M9 21v-3M15 21v-3"/><circle cx="12" cy="12" r="2.5"/></svg>;
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b544c" strokeWidth="1.6"><path d="M14 7l5-5 3 3-5 5M14 7l-9 9-3 7 7-3 9-9M14 7l3 3"/></svg>;
}

function RentalsScan() {
  return (
    <div className="m" style={{background:'#000'}}>
      <div style={{flex:1, position:'relative'}}>
        <div style={{position:'absolute', inset:0, background:'radial-gradient(circle at 50% 60%, #2a3038 0%, #0e1014 100%)'}}/>
        {/* QR target overlay */}
        <div style={{position:'absolute', top:'50%', left:'50%', transform:'translate(-50%, -50%)', width:200, height:200}}>
          <div style={{position:'absolute', inset:0, border:'2px solid rgba(255,255,255,.3)', borderRadius:16}}/>
          {[
            {top:0, left:0, br:'br'},
            {top:0, right:0, br:'bl'},
            {bottom:0, left:0, br:'tr'},
            {bottom:0, right:0, br:'tl'},
          ].map((c, i) => (
            <div key={i} style={{position:'absolute', ...c, width:30, height:30, [`border${(c.top !== undefined) ? 'Top' : 'Bottom'}`]: '3px solid #d9904a', [`border${(c.left !== undefined) ? 'Left' : 'Right'}`]: '3px solid #d9904a'}}/>
          ))}
          {/* scanline */}
          <div style={{position:'absolute', left:8, right:8, top:'50%', height:2, background:'linear-gradient(to right, transparent, #d9904a, transparent)', boxShadow:'0 0 16px #d9904a'}}/>
        </div>
        <div style={{position:'absolute', top:80, left:0, right:0, textAlign:'center', color:'#fff', fontSize:13}}>Point at the QR tag on the equipment</div>

        <div style={{position:'absolute', top:14, left:14}}>
          <button style={{width:36, height:36, background:'rgba(0,0,0,.4)', backdropFilter:'blur(12px)', border:'none', borderRadius:18, color:'#fff'}}>{MI.close}</button>
        </div>
      </div>
      {/* recognized sheet */}
      <div className="m-sheet" style={{borderRadius:'18px 18px 0 0'}}>
        <div className="m-sheet-grabber"/>
        <div style={{padding:'10px 16px 16px'}}>
          <div style={{display:'flex', alignItems:'center', gap:12}}>
            <div style={{width:48, height:48, background:'#f3e9d8', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center'}}>
              <RentalIcon cat="Scaffolding"/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:11, color:'#2c8a55', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>✓ Recognized</div>
              <div style={{fontSize:16, fontWeight:600, marginTop:1}}>Scaffold A — 24×8</div>
              <div style={{fontSize:11, color:'#8a8278'}}>SCF-001 · currently at Hillcrest</div>
            </div>
          </div>
          <div className="m-btn-stack" style={{marginTop:14}}>
            <button className="m-btn" data-variant="primary">Mark returned</button>
            <button className="m-btn" data-variant="ghost">Move to another job</button>
            <button className="m-btn" data-variant="quiet">Open details</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RentalsDispatch() {
  return (
    <div className="m">
      <div style={{height:52, padding:'8px 16px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #e8e3db'}}>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#5b544c'}}>Cancel</button>
        <div style={{flex:1, fontSize:17, fontWeight:600, textAlign:'center'}}>Dispatch equipment</div>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'#d9904a', fontWeight:600}}>Send</button>
      </div>
      <div className="m-body">
        <div className="m-section-h" style={{paddingTop:14}}>To</div>
        <div className="m-list-inset">
          <MRow leading={<div style={{width:32, height:32, borderRadius:8, background:'#E8A86B', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700}}>HC</div>} headline="Hillcrest Mews — Phase 4" supporting="4820 Crestline Dr · 8 mi"/>
        </div>

        <div className="m-section-h">When</div>
        <div className="m-list-inset">
          <MRow leading={MI.cal} headline="Pickup" trailing="Tue, Apr 29 · 6:30 AM"/>
          <MRow leading={MI.cal} headline="Expected return" trailing="Mon, May 26"/>
          <MRow leading={MI.time} headline="Duration" trailing="27 days"/>
        </div>

        <div className="m-section-h">Items (3)</div>
        <div className="m-list-inset">
          <RentalDispatchRow n="Scaffold A — 24×8" tag="SCF-001" rate="85"/>
          <RentalDispatchRow n="Mixer M-184" tag="MIX-184" rate="45"/>
          <RentalDispatchRow n="Sprayer (HVLP)" tag="SPR-005" rate="55"/>
        </div>
        <div style={{padding:'8px 16px'}}>
          <button className="m-btn" data-variant="ghost">+ Add equipment</button>
        </div>

        <div className="m-section-h">Cost</div>
        <div style={{padding:'0 16px'}}>
          <div style={{padding:'14px 16px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
            <div style={{display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13, color:'#5b544c'}}>
              <span>3 items × 27 days</span>
              <span style={{fontFeatureSettings:'"tnum"', color:'#1c1816'}}>$5,022</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13, color:'#5b544c'}}>
              <span>Setup + breakdown</span>
              <span style={{fontFeatureSettings:'"tnum"', color:'#1c1816'}}>$420</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', paddingTop:10, marginTop:6, borderTop:'1px solid #e8e3db'}}>
              <span style={{fontSize:13, fontWeight:600}}>Bill to project</span>
              <span style={{fontSize:20, fontWeight:700, fontFeatureSettings:'"tnum"', letterSpacing:'-0.01em'}}>$5,442</span>
            </div>
          </div>
        </div>

        <div className="m-section-h">Notify</div>
        <div className="m-list-inset">
          <MRow leading="AC" leadingTone="accent" headline="Ana Castillo · lead" supporting="Will pick up at yard"/>
          <MRow leading={MI.plus} headline="Add recipient" chev={false}/>
        </div>
        <div style={{height:30}}/>
      </div>
    </div>
  );
}

function RentalDispatchRow({ n, tag, rate }) {
  return (
    <div style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid #e8e3db'}}>
      <div style={{width:36, height:36, background:'#f3e9d8', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center'}}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5b544c" strokeWidth="1.6"><rect x="3" y="6" width="18" height="12" rx="2"/></svg>
      </div>
      <div style={{flex:1}}>
        <div style={{fontSize:14, fontWeight:500}}>{n}</div>
        <div style={{fontSize:11, color:'#8a8278'}}>{tag} · ${rate}/day</div>
      </div>
      <button style={{background:'transparent', border:'none', color:'#c0463d'}}>{MI.close}</button>
    </div>
  );
}

function RentalsUtilization() {
  return (
    <div className="m">
      <MTopBar back title="Utilization" sub="Last 30 days"/>
      <div className="m-body">
        <div className="m-kpi-row" style={{paddingTop:14}}>
          <MKpi label="Fleet util" value="92%" meta="+8 vs last mo." metaTone="green"/>
          <MKpi label="Revenue" value="$28,640" meta="14 active" metaTone=""/>
        </div>

        {/* Per-asset bar chart */}
        <div className="m-section-h">By asset</div>
        <div style={{padding:'0 16px', display:'grid', gap:6}}>
          {[
            {n:'Scaffold A', util:96, days:29, rev:2465, c:'#d9904a'},
            {n:'Scaffold B', util:94, days:28, rev:1820, c:'#d9904a'},
            {n:'Mixer M-184', util:88, days:26, rev:1170, c:'#d9904a'},
            {n:'Sprayer HVLP', util:71, days:21, rev:1155, c:'#d9904a'},
            {n:'Mixer M-090', util:62, days:18, rev:810, c:'#c98a2e'},
            {n:'Compressor 25', util:18, days:5, rev:350, c:'#c0463d'},
          ].map(a => (
            <div key={a.n} style={{padding:'10px 12px', background:'#fff', border:'1px solid #e8e3db', borderRadius:10}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6}}>
                <span style={{fontSize:12, fontWeight:500}}>{a.n}</span>
                <span style={{fontSize:11, color:'#8a8278', fontFeatureSettings:'"tnum"'}}>{a.days}d · ${a.rev.toLocaleString()}</span>
              </div>
              <div style={{display:'flex', alignItems:'center', gap:8}}>
                <div style={{flex:1, height:6, background:'#f5f1ec', borderRadius:3, overflow:'hidden'}}>
                  <div style={{width:`${a.util}%`, height:'100%', background:a.c}}/>
                </div>
                <span style={{fontSize:11, fontWeight:600, fontFeatureSettings:'"tnum"', color:a.c, minWidth:32, textAlign:'right'}}>{a.util}%</span>
              </div>
            </div>
          ))}
        </div>

        <div className="m-section-h">Underperformers</div>
        <div style={{margin:'0 16px', padding:'14px', background:'rgba(192,70,61,.06)', border:'1px solid rgba(192,70,61,.18)', borderRadius:12}}>
          <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
            <span style={{color:'#c0463d', flexShrink:0, marginTop:1}}>{MI.alert}</span>
            <div>
              <div style={{fontSize:13, fontWeight:600}}>Compressor 25cf · 18% util</div>
              <div style={{fontSize:12, color:'#5b544c', marginTop:4, lineHeight:1.45}}>Out only 5 of 30 days. Costs $40/mo. to maintain. Sell or list externally?</div>
              <div style={{display:'flex', gap:8, marginTop:10}}>
                <button className="m-btn m-btn-sm" data-variant="primary">List for sale</button>
                <button className="m-btn m-btn-sm" data-variant="ghost">Dismiss</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RentalsReturn() {
  return (
    <div className="m">
      <MTopBar back title="Return scaffold" sub="SCF-001 · Hillcrest"/>
      <div className="m-body">
        {/* Photo step */}
        <div style={{padding:'14px 16px'}}>
          <div style={{aspectRatio:'4/3', background:'linear-gradient(135deg, #4a5862 0%, #2a3038 100%)', borderRadius:14, position:'relative', overflow:'hidden'}}>
            {/* fake scaffold photo */}
            <svg viewBox="0 0 280 210" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
              <rect width="280" height="210" fill="#3a4854"/>
              <g stroke="#aea69a" strokeWidth="2" fill="none">
                <path d="M40 20v170M120 20v170M200 20v170M260 20v170"/>
                <path d="M40 60h220M40 110h220M40 160h220M40 190h220"/>
              </g>
              <rect x="0" y="180" width="280" height="30" fill="#5b544c"/>
            </svg>
            <div style={{position:'absolute', top:10, left:10, padding:'4px 10px', background:'rgba(0,0,0,.5)', backdropFilter:'blur(8px)', borderRadius:12, color:'#fff', fontSize:10, fontWeight:600}}>04/26 · 2:14 PM</div>
            <button style={{position:'absolute', bottom:10, right:10, width:38, height:38, background:'#fff', borderRadius:19, border:'none', display:'flex', alignItems:'center', justifyContent:'center'}}>{MI.cam}</button>
          </div>
        </div>

        <div className="m-section-h">Condition check</div>
        <div className="m-list-inset">
          <MRow leading={MI.check} leadingTone="green" headline="Frame intact" trailing={<span className="m-pill" data-tone="green">ok</span>} chev={false}/>
          <MRow leading={MI.check} leadingTone="green" headline="Planks accounted for (12)" trailing={<span className="m-pill" data-tone="green">ok</span>} chev={false}/>
          <MRow leading={MI.alert} leadingTone="amber" headline="Bent toe board" supporting="Tap to flag for repair" trailing={<span className="m-pill" data-tone="amber">flag</span>}/>
          <MRow leading={MI.check} leadingTone="green" headline="Cleaned" chev={false}/>
        </div>

        <div className="m-section-h">Billing</div>
        <div style={{padding:'0 16px'}}>
          <div style={{padding:'14px 16px', background:'#fff', border:'1px solid #e8e3db', borderRadius:12}}>
            <div style={{display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13}}>
              <span style={{color:'#5b544c'}}>Days out</span>
              <span style={{fontFeatureSettings:'"tnum"'}}>27 × $85</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13}}>
              <span style={{color:'#5b544c'}}>Repair charge</span>
              <span style={{fontFeatureSettings:'"tnum"', color:'#c98a2e'}}>+ $145</span>
            </div>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', paddingTop:10, marginTop:6, borderTop:'1px solid #e8e3db'}}>
              <span style={{fontSize:13, fontWeight:600}}>Total billed</span>
              <span style={{fontSize:20, fontWeight:700, fontFeatureSettings:'"tnum"'}}>$2,440</span>
            </div>
          </div>
        </div>
        <div className="m-btn-stack" style={{margin:'14px 0'}}>
          <button className="m-btn" data-variant="primary">Confirm return</button>
          <button className="m-btn" data-variant="ghost">Save as draft</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SECTION 10 — SETTINGS (mobile)
// ============================================================

function SettingsHome() {
  return (
    <div className="m">
      <MTopBar title="Settings"/>
      <div className="m-body">
        {/* Profile card */}
        <div style={{padding:'14px 16px'}}>
          <div style={{padding:'14px', background:'#fff', border:'1px solid #e8e3db', borderRadius:14, display:'flex', alignItems:'center', gap:12}}>
            <div className="m-avatar" data-size="lg" data-tone="accent">SD</div>
            <div style={{flex:1}}>
              <div style={{fontSize:15, fontWeight:600}}>Sarah Davis</div>
              <div style={{fontSize:12, color:'#8a8278'}}>Owner · Davis Stucco LLC</div>
              <div style={{fontSize:11, color:'#2c8a55', marginTop:4, display:'flex', alignItems:'center', gap:4}}>
                <span style={{width:6, height:6, borderRadius:3, background:'#2c8a55'}}/>Pro plan · billed yearly
              </div>
            </div>
            <span className="m-chev" style={{color:'#aea69a'}}>{MI.chev}</span>
          </div>
        </div>

        <div className="m-section-h">Workspace</div>
        <div className="m-list-inset">
          <MRow leading={MI.users} leadingTone="blue" headline="Team" supporting="14 members · 2 invites pending" trailing="14"/>
          <MRow leading={MI.layers} leadingTone="accent" headline="Pricing book" supporting="Materials, labor rates, margins"/>
          <MRow leading={MI.$} leadingTone="green" headline="Loaded labor cost" supporting="$54.20 / hr · base + add-ons"/>
          <MRow leading={MI.cal} headline="Working hours + holidays" supporting="Mon–Sat 7–4 · 8 holidays"/>
        </div>

        <div className="m-section-h">Integrations</div>
        <div className="m-list-inset">
          <SettingsIntegRow logo="QB" tone="green" name="QuickBooks Online" status="Connected" connected sync="Last sync 2 min ago"/>
          <SettingsIntegRow logo="GU" tone="accent" name="Gusto Payroll" status="Connected" connected sync="Last sync 1 hr ago"/>
          <SettingsIntegRow logo="GC" tone="blue" name="Google Calendar" status="Connected" connected sync="Auto-sync"/>
          <SettingsIntegRow logo="ST" name="Stripe" status="Connect" connected={false}/>
          <SettingsIntegRow logo="X" name="Xero" status="Connect" connected={false}/>
        </div>

        <div className="m-section-h">Account</div>
        <div className="m-list-inset">
          <MRow leading={MI.bell} headline="Notifications"/>
          <MRow leading={MI.lock} headline="Privacy + data"/>
          <MRow leading={MI.qr} headline="Devices" trailing="3 active"/>
          <MRow leading={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>} headline="Help + support"/>
        </div>

        <div style={{padding:'10px 16px 30px', textAlign:'center', fontSize:11, color:'#aea69a'}}>
          Sitelayer · v2.4.1 · Built Apr 28
        </div>
      </div>
      <MBottomTabs active="more"/>
    </div>
  );
}

function SettingsIntegRow({ logo, tone, name, status, connected, sync }) {
  const bg = tone === 'green' ? '#2c8a55' : tone === 'accent' ? '#d9904a' : tone === 'blue' ? '#2f6fb5' : '#5b544c';
  return (
    <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
      <div style={{width:36, height:36, background: connected ? bg : '#f5f1ec', color: connected ? '#fff' : '#5b544c', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, letterSpacing:'.04em'}}>{logo}</div>
      <div style={{flex:1}}>
        <div style={{fontSize:14, fontWeight:500}}>{name}</div>
        {sync && <div style={{fontSize:11, color:'#8a8278', marginTop:1}}>{sync}</div>}
      </div>
      {connected
        ? <span className="m-pill" data-tone="green" dot>connected</span>
        : <button className="m-btn m-btn-sm" data-variant="ghost">{status}</button>}
    </div>
  );
}

function SettingsPricing() {
  return (
    <div className="m">
      <MTopBar back title="Pricing book" action="add" actionIcon={MI.plus}/>
      <div className="m-body">
        {/* tabs */}
        <div style={{display:'flex', borderBottom:'1px solid #e8e3db', padding:'0 8px'}}>
          {[{l:'Materials', n:42, on:true}, {l:'Labor', n:6}, {l:'Equipment', n:14}].map(t => (
            <button key={t.l} style={{flex:1, padding:'12px 4px', background:'transparent', border:'none', fontFamily:'inherit', fontSize:13, fontWeight: t.on ? 600 : 400, color: t.on ? '#1c1816' : '#8a8278', borderBottom: t.on ? '2px solid #d9904a' : '2px solid transparent'}}>
              {t.l} <span style={{opacity:.6}}>{t.n}</span>
            </button>
          ))}
        </div>

        <div className="m-section-h">EIFS / Stucco</div>
        <div className="m-list-inset">
          <PricingRow code="EPS-15" n="EPS Insulation 1.5&quot;" cost="$2.85" sell="$4.85" margin="41%"/>
          <PricingRow code="EPS-20" n="EPS Insulation 2&quot;" cost="$3.40" sell="$5.65" margin="40%"/>
          <PricingRow code="BASE" n="Basecoat" cost="$1.95" sell="$3.20" margin="39%"/>
          <PricingRow code="MESH" n="Mesh (4.5oz std)" cost="$0.42" sell="$0.85" margin="51%"/>
          <PricingRow code="FIN" n="Finish Coat (acrylic)" cost="$2.55" sell="$4.10" margin="38%"/>
        </div>

        <div className="m-section-h">Stone</div>
        <div className="m-list-inset">
          <PricingRow code="STN-CULT" n="Cultured Stone" cost="$14.20" sell="$22.50" margin="37%"/>
          <PricingRow code="STN-ADH" n="Stone adhesive" cost="$5.80" sell="$9.20" margin="37%" warn/>
        </div>

        <div style={{margin:'14px 16px', padding:'14px', background:'#f7f4ef', borderRadius:12, fontSize:12, color:'#5b544c'}}>
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
            <span style={{color:'#d9904a'}}>{MI.spark}</span>
            <strong style={{color:'#1c1816'}}>3 items have a margin under 35%</strong>
          </div>
          <span>Tap any row to update sell price. We'll suggest one based on your past wins.</span>
        </div>
      </div>
    </div>
  );
}

function PricingRow({ code, n, cost, sell, margin, warn }) {
  const m = parseInt(margin);
  const tone = m >= 40 ? 'green' : m >= 35 ? 'amber' : 'red';
  return (
    <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
      <div style={{minWidth:0, flex:1}}>
        <div style={{display:'flex', alignItems:'center', gap:6}}>
          <span style={{fontSize:10, fontWeight:600, color:'#aea69a', fontFamily:'Geist Mono, monospace', letterSpacing:'.04em'}}>{code}</span>
        </div>
        <div style={{fontSize:14, fontWeight:500, marginTop:1}}>{n}</div>
        <div style={{fontSize:11, color:'#8a8278', marginTop:2, fontFeatureSettings:'"tnum"'}}>cost {cost} · sell {sell}</div>
      </div>
      <div style={{textAlign:'right'}}>
        <span className="m-pill" data-tone={tone}>{margin}</span>
        {warn && <div style={{fontSize:10, color:'#c98a2e', marginTop:4}}>↑ vendor +6%</div>}
      </div>
    </div>
  );
}

function SettingsTeam() {
  return (
    <div className="m">
      <MTopBar back title="Team" sub="14 members · 2 invites" action="add" actionIcon={MI.plus}/>
      <div className="m-body">
        {/* search */}
        <div style={{padding:'8px 16px 4px'}}>
          <div style={{height:38, padding:'0 12px', background:'#f5f1ec', borderRadius:10, display:'flex', alignItems:'center', gap:8, fontSize:13, color:'#8a8278'}}>{MI.search} Search team</div>
        </div>

        <div className="m-section-h">Office (3)</div>
        <div className="m-list-inset">
          <TeamRow n="Sarah Davis" role="Owner" tone="accent" i="SD" perms="full access"/>
          <TeamRow n="Maya Patel" role="Estimator" tone="blue" i="MP" perms="estimate, measurements, projects"/>
          <TeamRow n="Tom Reed" role="Office mgr" tone="2" i="TR" perms="time, payroll, billing"/>
        </div>

        <div className="m-section-h">Field (9)</div>
        <div className="m-list-inset">
          <TeamRow n="Ana Castillo" role="Foreman" tone="1" i="AC" perms="own crew · time, log"/>
          <TeamRow n="Marcus Lee" role="Crew" tone="2" i="ML" perms="clock-in, photos"/>
          <TeamRow n="Diego Fontana" role="Crew" tone="3" i="DF" perms="clock-in, photos"/>
          <TeamRow n="Priya Shah" role="Foreman" tone="4" i="PS" perms="own crew · time, log"/>
        </div>

        <div className="m-section-h">Pending invites (2)</div>
        <div className="m-list-inset">
          <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
            <div className="m-avatar" style={{background:'transparent', border:'1.5px dashed #aea69a', color:'#8a8278'}}>JL</div>
            <div style={{flex:1}}>
              <div style={{fontSize:14, fontWeight:500}}>Jose Limon</div>
              <div style={{fontSize:11, color:'#8a8278'}}>jose.l@…  · invited 2d ago</div>
            </div>
            <button className="m-btn m-btn-sm" data-variant="ghost">Resend</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamRow({ n, role, tone, i, perms }) {
  return (
    <div style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
      <div className="m-avatar" data-tone={tone}>{i}</div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <span style={{fontSize:14, fontWeight:500}}>{n}</span>
          <span className="m-pill" data-size="sm">{role}</span>
        </div>
        <div style={{fontSize:11, color:'#8a8278', marginTop:2}}>{perms}</div>
      </div>
      <span className="m-chev" style={{color:'#aea69a'}}>{MI.chev}</span>
    </div>
  );
}

// ============================================================
// SECTION 11 — WORKER APP (crew member view)
// ============================================================

function WorkerToday() {
  return (
    <div className="m" style={{background:'#0e0c0a', color:'#f3ecdf'}}>
      <div style={{padding:'14px 20px 8px'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <div>
            <div style={{fontSize:11, color:'#8a8278', fontWeight:500}}>Hey, Marcus</div>
            <div style={{fontSize:24, fontWeight:700, letterSpacing:'-0.02em', marginTop:2}}>Mon · April 28</div>
          </div>
          <div className="m-avatar" data-tone="2">ML</div>
        </div>
      </div>

      {/* clock-in card */}
      <div style={{padding:'14px 20px 8px'}}>
        <div style={{padding:'18px', background:'#1c1816', border:'1px solid #2a241c', borderRadius:18}}>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
            <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Today's job</div>
            <div style={{fontSize:10, color:'#8a8278', display:'flex', alignItems:'center', gap:5}}>
              <div className="m-avatar" data-size="sm" data-tone="1" style={{width:18, height:18, fontSize:9}}>AC</div>
              <span>scoped by Ana</span>
            </div>
          </div>
          <div style={{fontSize:18, fontWeight:600, marginTop:4}}>Hillcrest Mews — Phase 4</div>
          <div style={{fontSize:13, color:'#aea69a', marginTop:2}}>EPS · East elevation · 7:00 AM start</div>

          {/* big timer */}
          <div style={{margin:'18px 0 12px', textAlign:'center'}}>
            <div style={{fontSize:11, color:'#aea69a', fontWeight:500, letterSpacing:'.06em', textTransform:'uppercase'}}>Currently clocked in</div>
            <div style={{fontSize:54, fontWeight:700, fontFeatureSettings:'"tnum"', letterSpacing:'-0.025em', marginTop:4, color:'#f3ecdf'}}>4:24<span style={{fontSize:24, color:'#aea69a'}}>:18</span></div>
            <div style={{fontSize:12, color:'#aea69a', marginTop:4}}>Started 7:04 AM · break 12:30–1:00</div>
          </div>

          {/* big actions */}
          <div style={{display:'flex', gap:10}}>
            <button style={{flex:1, height:54, background:'#3a3128', border:'1px solid #4a3f33', borderRadius:14, color:'#f3ecdf', fontFamily:'inherit', fontSize:14, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:6}}>
              <span style={{width:8, height:8, background:'#c98a2e', borderRadius:2}}/>Break
            </button>
            <button style={{flex:1, height:54, background:'#7a2a23', border:'1px solid #8a3530', borderRadius:14, color:'#fff', fontFamily:'inherit', fontSize:14, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:8}}>
              <span style={{width:14, height:14, background:'#fff', borderRadius:7}}/>Clock out
            </button>
          </div>
        </div>
      </div>

      {/* Crew on site */}
      <div style={{padding:'14px 20px 6px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Crew on site (3)</div>
        <div style={{display:'flex', gap:8}}>
          {[{n:'Ana C.', i:'AC', t:1}, {n:'Marcus L. (you)', i:'ML', t:2, you:true}, {n:'Tomás R.', i:'TR', t:5}].map(c => (
            <div key={c.n} style={{flex:1, padding:'10px', background:'#1c1816', border: c.you ? '1px solid #d9904a' : '1px solid #2a241c', borderRadius:12, textAlign:'center'}}>
              <div className="m-avatar" data-tone={c.t} style={{margin:'0 auto'}}>{c.i}</div>
              <div style={{fontSize:11, color:'#aea69a', marginTop:6, lineHeight:1.2}}>{c.n}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick log */}
      <div style={{padding:'14px 20px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Quick log</div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
          {[
            {l:'Photo', i:MI.cam, t:'#d9904a'},
            {l:'Note', i:MI.edit, t:'#5b544c'},
            {l:'Issue', i:MI.alert, t:'#c0463d'},
            {l:'Materials', i:MI.layers, t:'#5b544c'},
          ].map(b => (
            <button key={b.l} style={{padding:'14px 12px', background:'#1c1816', border:'1px solid #2a241c', borderRadius:12, color:'#f3ecdf', display:'flex', alignItems:'center', gap:8, fontFamily:'inherit', fontSize:13, fontWeight:500}}>
              <span style={{color:b.t}}>{b.i}</span>{b.l}
            </button>
          ))}
        </div>
      </div>

      <div style={{flex:1}}/>
      {/* Worker bottom tabs */}
      <div style={{display:'flex', height:64, background:'#0e0c0a', borderTop:'1px solid #2a241c'}}>
        {[
          {l:'Today', i:MI.home, on:true},
          {l:'Hours', i:MI.time},
          {l:'Pay', i:MI.$},
          {l:'Crew', i:MI.users},
        ].map(t => (
          <div key={t.l} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3, color: t.on ? '#d9904a' : '#5a5346'}}>
            {t.i}
            <span style={{fontSize:10, fontWeight: t.on ? 600 : 500}}>{t.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkerHoursWeek() {
  return (
    <div className="m">
      <div style={{padding:'14px 20px 8px'}}>
        <div style={{fontSize:11, color:'#8a8278', fontWeight:500}}>This week · Apr 27–May 3</div>
        <div style={{display:'flex', alignItems:'baseline', gap:8, marginTop:4}}>
          <div style={{fontSize:42, fontWeight:700, letterSpacing:'-0.025em', fontFeatureSettings:'"tnum"', lineHeight:1}}>32.8</div>
          <div style={{fontSize:14, color:'#8a8278'}}>hours so far</div>
        </div>
        <div style={{fontSize:12, color:'#5b544c', marginTop:6}}>$1,247 gross · ~$985 take-home</div>
      </div>
      {/* Bar chart */}
      <div style={{padding:'14px 20px'}}>
        <div style={{display:'flex', alignItems:'flex-end', gap:8, height:140, padding:'0 4px'}}>
          {[
            {d:'Mon', h:8.4, fc:true},
            {d:'Tue', h:8.0, fc:true},
            {d:'Wed', h:8.2, fc:true},
            {d:'Thu', h:8.2, fc:true, today:true},
            {d:'Fri', h:0, plan:8},
            {d:'Sat', h:0},
            {d:'Sun', h:0},
          ].map(d => {
            const max = 10;
            const h = (d.h / max) * 110;
            const planH = d.plan ? (d.plan / max) * 110 : 0;
            return (
              <div key={d.d} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:6}}>
                <div style={{flex:1, width:'100%', display:'flex', alignItems:'flex-end', justifyContent:'center', position:'relative'}}>
                  {planH > 0 && <div style={{width:'70%', height:planH, border:'1.5px dashed #aea69a', borderRadius:'4px 4px 0 0', position:'absolute', bottom:0}}/>}
                  {h > 0 && <div style={{width:'70%', height:h, background: d.today ? '#d9904a' : '#1c1816', borderRadius:'4px 4px 0 0', position:'relative'}}>
                    {d.today && <div style={{position:'absolute', top:-18, left:'50%', transform:'translateX(-50%)', fontSize:10, fontWeight:600, color:'#d9904a', fontFeatureSettings:'"tnum"'}}>{d.h}</div>}
                  </div>}
                </div>
                <span style={{fontSize:10, color: d.today ? '#d9904a' : '#8a8278', fontWeight: d.today ? 600 : 500}}>{d.d}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="m-section-h">Daily entries</div>
      <div className="m-list-inset">
        {[
          {d:'Thu Apr 30 (today)', p:'Hillcrest', start:'7:04', end:'in progress', h:'4:24', live:true},
          {d:'Wed Apr 29', p:'Hillcrest', start:'7:02', end:'15:14', h:'8.2'},
          {d:'Tue Apr 28', p:'Hillcrest', start:'7:00', end:'15:00', h:'8.0'},
          {d:'Mon Apr 27', p:'Aspen Ridge', start:'7:04', end:'15:28', h:'8.4'},
        ].map(e => (
          <div key={e.d} style={{padding:'12px 14px', borderBottom:'1px solid #e8e3db', display:'flex', alignItems:'center', gap:12}}>
            <div style={{width:6, height:36, background: e.live ? '#d9904a' : '#aea69a', borderRadius:3}}/>
            <div style={{flex:1}}>
              <div style={{fontSize:13, fontWeight:600}}>{e.d}</div>
              <div style={{fontSize:11, color:'#8a8278', fontFeatureSettings:'"tnum"'}}>{e.p} · {e.start}–{e.end}</div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:18, fontWeight:600, fontFeatureSettings:'"tnum"', color: e.live ? '#d9904a' : '#1c1816'}}>{e.h}{!e.live && 'h'}</div>
              {e.live && <div style={{fontSize:9, color:'#d9904a', fontWeight:600, letterSpacing:'.04em'}}>● LIVE</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkerLogPhoto() {
  return (
    <div className="m" style={{background:'#000'}}>
      {/* photo area */}
      <div style={{flex:1, position:'relative', overflow:'hidden'}}>
        <div style={{position:'absolute', inset:0, background:'linear-gradient(180deg, #5a6470 0%, #2a3038 100%)'}}>
          <svg viewBox="0 0 280 360" width="100%" height="100%" preserveAspectRatio="none">
            <rect width="280" height="360" fill="#9c8a72"/>
            <rect x="40" y="40" width="200" height="240" fill="#e8a86b" opacity=".9"/>
            <line x1="80" y1="40" x2="80" y2="280" stroke="#a05a33" strokeWidth="2" opacity=".6"/>
            <line x1="120" y1="40" x2="120" y2="280" stroke="#a05a33" strokeWidth="2" opacity=".6"/>
          </svg>
        </div>
        {/* AI auto-tag */}
        <div style={{position:'absolute', top:14, left:14, right:14, display:'flex', flexDirection:'column', gap:6}}>
          <div style={{padding:'8px 12px', background:'rgba(217,144,74,.92)', backdropFilter:'blur(12px)', borderRadius:12, color:'#fff', fontSize:12, display:'flex', alignItems:'center', gap:8}}>
            <span>{MI.spark}</span>
            <span><strong>EPS install · East elevation</strong> · auto-tagged</span>
          </div>
        </div>
      </div>
      {/* Caption */}
      <div style={{background:'#1c1816', color:'#f3ecdf', padding:'14px 16px 18px'}}>
        <div style={{fontSize:11, color:'#aea69a', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', marginBottom:8}}>Add a note (optional)</div>
        <div style={{padding:'10px 12px', background:'#0e0c0a', border:'1px solid #2a241c', borderRadius:10, fontSize:14, color:'#aea69a', minHeight:52}}>
          Finished anchoring east wall, ~80% done with EPS today.
          <span style={{display:'inline-block', width:1.5, height:14, background:'#d9904a', verticalAlign:'middle', marginLeft:1, animation:'blink 1s infinite'}}/>
        </div>
        <div style={{display:'flex', gap:8, marginTop:12}}>
          <button style={{flex:1, height:48, background:'#d9904a', border:'none', borderRadius:12, color:'#fff', fontFamily:'inherit', fontSize:15, fontWeight:600}}>Save to log</button>
          <button style={{width:48, height:48, background:'#2a241c', border:'none', borderRadius:12, color:'#f3ecdf', display:'flex', alignItems:'center', justifyContent:'center'}}>{MI.cam}</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  RentalsCatalog, RentalsScan, RentalsDispatch, RentalsUtilization, RentalsReturn,
  SettingsHome, SettingsPricing, SettingsTeam,
  WorkerToday, WorkerHoursWeek, WorkerLogPhoto,
});
