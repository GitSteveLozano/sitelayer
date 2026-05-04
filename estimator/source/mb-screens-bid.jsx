/* global React, MI, MTopBar, MAttribution, MSpark */

// ============================================================
// SECTION 5 — ESTIMATE (a view on the project, not a separate record)
//
// Simplified model after pushback:
// - The project IS the estimate until the client accepts. No "bid"
//   record, no "promotion" event, no v1/v2 versioning ceremony,
//   no first-class alternates as a record type.
// - Project states: Drafting → Sent → Accepted → In progress → Done
//   (or → Archived w/ loss reason).
// - "Send to client" is an action on the project. Accept flips state.
// - Worksheet (internal) and Proposal (client view) are tabs on the
//   project's Estimate area. Optional add-ons are just line items
//   with an optional flag.
// ============================================================

// ---------- chrome ----------
function EstStateStrip({ state }) {
  const stages = [
    { k: 'draft', l: 'Drafting' },
    { k: 'sent',  l: 'Sent' },
    { k: 'acc',   l: 'Accepted' },
    { k: 'go',    l: 'In progress' },
  ];
  const idx = stages.findIndex(s => s.k === state);
  return (
    <div style={{display:'flex', gap:0, padding:'10px 14px', background:'#fff', borderBottom:'1px solid var(--m-line)', alignItems:'center'}}>
      {stages.map((s, i) => {
        const done = i < idx, cur = i === idx;
        return (
          <React.Fragment key={s.k}>
            <div style={{display:'flex', alignItems:'center', gap:5}}>
              <span style={{width: cur?8:6, height: cur?8:6, borderRadius:'50%',
                background: done?'var(--m-ink-3)':cur?'var(--m-accent)':'var(--m-line-2)',
                boxShadow: cur?'0 0 0 3px rgba(217,144,74,0.18)':'none'}}/>
              <span style={{fontSize:10.5, fontWeight: cur?700:500,
                color: cur?'var(--m-accent-ink)':done?'var(--m-ink-2)':'var(--m-ink-4)',
                textTransform:'uppercase', letterSpacing:'.05em'}}>{s.l}</span>
            </div>
            {i < stages.length - 1 && <div style={{flex:1, height:1, background: i<idx?'var(--m-ink-3)':'var(--m-line)', margin:'0 8px'}}/>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function EstTabs({ active }) {
  return (
    <div style={{display:'flex', padding:'0 14px', background:'#fff', borderBottom:'1px solid var(--m-line)'}}>
      {[{k:'work', l:'Worksheet', sub:'Internal'},{k:'prop', l:'Proposal', sub:'Client view'}].map(t => (
        <div key={t.k} style={{flex:1, padding:'11px 0 9px', textAlign:'center',
          borderBottom: active===t.k?'2px solid var(--m-accent)':'2px solid transparent', marginBottom:-1}}>
          <div style={{fontSize:13.5, fontWeight: active===t.k?700:500, color: active===t.k?'var(--m-ink)':'var(--m-ink-3)'}}>{t.l}</div>
          <div style={{fontSize:10, color:'var(--m-ink-4)', marginTop:1, textTransform:'uppercase', letterSpacing:'.05em'}}>{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

function SectionH({label, right}){
  return (
    <div style={{padding:'14px 16px 8px', display:'flex', alignItems:'baseline', justifyContent:'space-between'}}>
      <span style={{fontSize:11, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em'}}>{label}</span>
      {right && <span style={{fontSize:10.5, color:'var(--m-ink-3)'}}>{right}</span>}
    </div>
  );
}

// ============================================================
// 1 · WORKSHEET — internal numbers, plain line items
// ============================================================
function BidWorksheet() {
  return (
    <div className="m">
      <MTopBar back title="Hillcrest Mews · Phase 4" sub="Estimate · Drafting" action="more" actionIcon={MI.more}/>
      <EstStateStrip state="draft"/>
      <EstTabs active="work"/>

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', borderBottom:'1px solid var(--m-line)', background:'var(--m-card-soft)'}}>
        <Stat l="Cost" v="$121k" sub="materials + labor"/>
        <Stat l="Price" v="$184k" hi/>
        <Stat l="Margin" v="34%" sub="$63,250"/>
      </div>

      <div style={{padding:'10px 14px 0'}}>
        <div style={{padding:'9px 11px', background:'rgba(217,144,74,0.07)', border:'1px solid rgba(217,144,74,0.20)', borderRadius:9, display:'flex', gap:8, alignItems:'flex-start'}}>
          <MSpark state="muted" size={11}/>
          <div style={{flex:1, fontSize:11.5, color:'var(--m-ink-2)', lineHeight:1.45}}>
            Wall assembly is at $4.32/sf — your usual is $4.85. <span style={{color:'var(--m-accent-ink)', fontWeight:600}}>+$1,180 if applied</span>.
          </div>
        </div>
      </div>

      <div className="m-body" style={{padding:'10px 0 0'}}>
        <SectionH label="Materials" right="From measurements"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <WorkLine name="Wall assembly" qty="2,226 sf" cost="$3.20" price="$4.85" total="$10,796"/>
          <WorkLine name="Stone veneer accent" qty="184 sf" cost="$15.10" price="$22.50" total="$4,140" flag/>
          <WorkLine name="Sealant + flashing" qty="452 lf" cost="$3.40" price="$5.10" total="$2,305"/>
        </div>

        <SectionH label="Labor" right="1,250 hrs"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <WorkLine name="Crew · 5 incl. foreman" qty="1,250 hrs" cost="$32" price="$48" total="$60,000"/>
        </div>

        <SectionH label="Rentals" right="Optional"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <WorkLine name="Scaffold · 32 days" qty="32 days" cost="$120" price="$180" total="$5,760"/>
          <WorkLine name="Lift · 4 days" qty="4 days" cost="$240" price="$360" total="$1,440"/>
        </div>

        <SectionH label="Optional add-ons" right="Client opts in on Proposal"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:6}}>
          <WorkLine name="Premium finish + 10-yr warranty" qty="—" cost="$9,400" price="$14,200" total="$14,200" optional/>
          <WorkLine name="Covered entry · 220 sf" qty="—" cost="$5,580" price="$8,450" total="$8,450" optional/>
        </div>

        <div style={{padding:'18px 14px'}}>
          <button style={{width:'100%', padding:'13px', background:'var(--m-accent)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit'}}>Review Proposal →</button>
          <div style={{fontSize:11, color:'var(--m-ink-3)', textAlign:'center', marginTop:8, lineHeight:1.5}}>
            Worksheet stays internal. The client only sees the Proposal.
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({l,v,sub,hi}){
  return (
    <div style={{padding:'12px 14px', borderRight:'1px solid var(--m-line)', background: hi?'rgba(217,144,74,0.08)':'transparent'}}>
      <div style={{fontSize:10, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em'}}>{l}</div>
      <div style={{fontSize:18, fontWeight:700, fontFamily:'ui-monospace,monospace', letterSpacing:'-0.01em', marginTop:2, color: hi?'var(--m-accent-ink)':'var(--m-ink)'}}>{v}</div>
      {sub && <div style={{fontSize:10, color:'var(--m-ink-3)', marginTop:1}}>{sub}</div>}
    </div>
  );
}

function WorkLine({ name, qty, cost, price, total, flag, optional }) {
  return (
    <div style={{padding:'11px 12px', background:'#fff', border: optional?'1px dashed var(--m-line-2)':'1px solid var(--m-line)', borderRadius:10, borderLeft: flag?'3px solid #d9904a':undefined, paddingLeft: flag?10:12}}>
      <div style={{display:'flex', alignItems:'flex-start', gap:8, marginBottom:5}}>
        <div style={{flex:1, minWidth:0}}>
          <div style={{display:'flex', alignItems:'center', gap:6, flexWrap:'wrap'}}>
            <span style={{fontSize:13, fontWeight:600, lineHeight:1.3}}>{name}</span>
            {optional && <span style={{fontSize:9, fontWeight:700, color:'var(--m-ink-3)', background:'var(--m-card-soft)', padding:'1px 6px', borderRadius:4, textTransform:'uppercase', letterSpacing:'.05em'}}>Optional</span>}
          </div>
          <div style={{fontSize:10.5, color:'var(--m-ink-3)', marginTop:1}}>{qty}</div>
        </div>
        <div style={{fontSize:13, fontWeight:600, fontFamily:'ui-monospace,monospace'}}>{total}</div>
      </div>
      <div style={{display:'flex', alignItems:'center', gap:8, fontSize:10.5, fontFamily:'ui-monospace,monospace'}}>
        <span style={{color:'var(--m-ink-3)'}}>cost <span style={{color:'var(--m-ink-2)'}}>{cost}</span></span>
        <span style={{color:'var(--m-ink-4)'}}>→</span>
        <span style={{color:'var(--m-ink-3)'}}>price <span style={{color:'var(--m-ink-2)'}}>{price}</span></span>
      </div>
    </div>
  );
}

// ============================================================
// 2 · PROPOSAL — client-facing view
// ============================================================
function BidProposal() {
  return (
    <div className="m">
      <MTopBar back title="Hillcrest Mews · Phase 4" sub="Estimate · Drafting" action="more" actionIcon={MI.more}/>
      <EstStateStrip state="draft"/>
      <EstTabs active="prop"/>

      <div className="m-body" style={{padding:'0 0 14px'}}>
        <div style={{padding:'10px 14px', background:'rgba(47,111,181,0.06)', borderBottom:'1px solid var(--m-line)', display:'flex', alignItems:'center', gap:8}}>
          <span style={{color:'#2f6fb5', display:'flex'}}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" width="16" height="16"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
          </span>
          <span style={{fontSize:11.5, color:'var(--m-ink-2)', flex:1}}>Preview · what John will see.</span>
        </div>

        <div style={{padding:'20px 20px 16px', background:'linear-gradient(180deg, #f7f4ef 0%, transparent 100%)', borderBottom:'1px solid var(--m-line)'}}>
          <div style={{fontSize:11, color:'var(--m-ink-3)', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Prepared for</div>
          <div style={{fontSize:18, fontWeight:600, marginTop:2, letterSpacing:'-0.01em'}}>Hillcrest Mews — Phase 4</div>
          <div style={{display:'flex', alignItems:'baseline', gap:6, marginTop:14}}>
            <span style={{fontSize:42, fontWeight:700, letterSpacing:'-0.025em', fontFamily:'ui-monospace,monospace', lineHeight:1}}>$184,250</span>
          </div>
          <div style={{fontSize:13, color:'var(--m-ink-2)', marginTop:6}}>~32 working days · Net 30</div>
        </div>

        <div style={{padding:'14px 14px 0'}}>
          <div style={{padding:'14px', background:'#fff', border:'1px solid rgba(217,144,74,0.40)', borderRadius:12, boxShadow:'0 0 0 4px rgba(217,144,74,0.08)'}}>
            <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
              <MSpark state="accent" size={12}/>
              <span style={{fontSize:10.5, fontWeight:700, color:'var(--m-accent-ink)', textTransform:'uppercase', letterSpacing:'.07em'}}>Heads up · before you send</span>
            </div>
            <div style={{fontSize:13.5, fontWeight:600, lineHeight:1.4, marginBottom:6}}>
              Similar jobs over 2,500 sf have averaged <strong style={{color:'var(--m-accent-ink)'}}>12% under actual</strong>.
            </div>
            <div style={{fontSize:12, color:'var(--m-ink-2)', lineHeight:1.5, marginBottom:10}}>
              Wall lines are at <span style={{fontFamily:'ui-monospace,monospace', fontWeight:600, color:'var(--m-ink)'}}>$4.32</span>/sf. Try <span style={{fontFamily:'ui-monospace,monospace', fontWeight:600, color:'var(--m-ink)'}}>$4.85</span>/sf — adds <span style={{fontFamily:'ui-monospace,monospace', fontWeight:600, color:'var(--m-ink)'}}>$1,180</span>.
            </div>
            <div style={{display:'flex', gap:8}}>
              <button style={{flex:1, padding:'9px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:8, fontSize:12, fontWeight:600, fontFamily:'inherit'}}>Apply $4.85/sf</button>
              <button style={{padding:'9px 12px', background:'transparent', color:'var(--m-ink-2)', border:'1px solid var(--m-line)', borderRadius:8, fontSize:12, fontFamily:'inherit'}}>Why?</button>
            </div>
          </div>
        </div>

        <SectionH label="Scope of work"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:8}}>
          <ProposalLine title="Wall assembly · 2,226 sf" desc="Insulation, basecoat, and finish coat across all elevations" amt="$27,046"/>
          <ProposalLine title="Stone veneer accent · 184 sf" desc="Cultured stone feature wall at main entry" amt="$4,140"/>
          <ProposalLine title="Sealant + flashing · 452 lf" desc="Joints, transitions, weatherproofing" amt="$2,305"/>
          <ProposalLine title="Labor · ~32 working days" desc="Crew of 5 including foreman" amt="$60,000"/>
        </div>

        <SectionH label="Optional add-ons" right="Toggle to include"/>
        <div style={{padding:'0 14px', display:'flex', flexDirection:'column', gap:8}}>
          <ProposalAlt title="Premium finish + 10-yr warranty" desc="Higher-grade system, manufacturer-backed" amt="$14,200" included/>
          <ProposalAlt title="Covered entry · 220 sf" desc="Adds 6 days to schedule" amt="$8,450"/>
        </div>

        <SectionH label="Payment"/>
        <div style={{padding:'0 14px'}}>
          <div style={{padding:'12px 14px', background:'#fff', border:'1px solid var(--m-line)', borderRadius:11}}>
            <Term label="On signing (30%)" v="$55,275"/>
            <Term label="At substantial (40%)" v="$73,700"/>
            <Term label="On punch (30%)" v="$55,275"/>
            <div style={{height:1, background:'var(--m-line)', margin:'8px 0'}}/>
            <div style={{display:'flex', justifyContent:'space-between', fontSize:13.5, fontWeight:700}}>
              <span>Total</span><span style={{fontFamily:'ui-monospace,monospace'}}>$184,250</span>
            </div>
          </div>
        </div>

        <div style={{padding:'18px 14px 0'}}>
          <button style={{width:'100%', padding:'14px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:8}}>
            {MI.send}<span>Send to client</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ProposalLine({ title, desc, amt }) {
  return (
    <div style={{padding:'12px 14px', background:'#fff', border:'1px solid var(--m-line)', borderRadius:10, display:'flex', gap:10, alignItems:'flex-start'}}>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:13.5, fontWeight:600, lineHeight:1.3}}>{title}</div>
        <div style={{fontSize:11.5, color:'var(--m-ink-3)', marginTop:3, lineHeight:1.45}}>{desc}</div>
      </div>
      <div style={{fontSize:14, fontWeight:700, fontFamily:'ui-monospace,monospace'}}>{amt}</div>
    </div>
  );
}

function ProposalAlt({ title, desc, amt, included }) {
  return (
    <div style={{padding:'12px 14px', background: included?'#fff':'rgba(0,0,0,0.02)', border:'1px dashed var(--m-line-2)', borderRadius:10, display:'flex', gap:10, alignItems:'flex-start'}}>
      <div style={{width:18, height:18, borderRadius:5, background: included?'var(--m-accent)':'transparent', border: included?'none':'1.5px solid var(--m-line-2)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1}}>
        {included && <span style={{fontSize:11, fontWeight:700}}>✓</span>}
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:13.5, fontWeight:600, lineHeight:1.3, color: included?'var(--m-ink)':'var(--m-ink-2)'}}>{title}</div>
        <div style={{fontSize:11.5, color:'var(--m-ink-3)', marginTop:3, lineHeight:1.45}}>{desc}</div>
      </div>
      <div style={{textAlign:'right'}}>
        <div style={{fontSize:14, fontWeight:700, fontFamily:'ui-monospace,monospace', color: included?'var(--m-ink)':'var(--m-ink-3)'}}>{amt}</div>
        <div style={{fontSize:9.5, color: included?'#2c8a55':'var(--m-ink-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.05em', marginTop:1}}>{included?'+ included':'Add'}</div>
      </div>
    </div>
  );
}

function Term({label, v}){
  return (
    <div style={{display:'flex', justifyContent:'space-between', padding:'6px 0', fontSize:12.5}}>
      <span style={{color:'var(--m-ink-3)'}}>{label}</span>
      <span style={{color:'var(--m-ink-2)', fontFamily:'ui-monospace,monospace'}}>{v}</span>
    </div>
  );
}

// ============================================================
// 3 · SEND CONFIRMATION SHEET
// ============================================================
function BidSendSheet() {
  return (
    <div className="m" style={{position:'relative', background:'#fff'}}>
      <div style={{padding:'14px 20px', borderBottom:'1px solid var(--m-line)', opacity:.35}}>
        <div style={{fontSize:18, fontWeight:600}}>Hillcrest Mews · Phase 4</div>
      </div>
      <div style={{flex:1, opacity:.35}}/>
      <div style={{position:'absolute', inset:0, background:'rgba(20,16,10,0.45)'}}/>

      <div style={{position:'absolute', left:0, right:0, bottom:0, background:'#fff', borderRadius:'18px 18px 0 0', padding:'14px 18px 22px', boxShadow:'0 -8px 24px rgba(0,0,0,0.18)'}}>
        <div style={{width:38, height:4, background:'var(--m-line-2)', borderRadius:2, margin:'0 auto 14px'}}/>
        <div style={{fontSize:17, fontWeight:700, marginBottom:4, letterSpacing:'-0.01em'}}>Send estimate?</div>
        <div style={{fontSize:12.5, color:'var(--m-ink-2)', lineHeight:1.5, marginBottom:14}}>
          John will receive the proposal and can accept or request changes. You can keep editing after sending.
        </div>

        <div style={{padding:'12px 14px', background:'var(--m-card-soft)', borderRadius:10, marginBottom:14}}>
          <div style={{fontSize:10.5, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6}}>To</div>
          <div style={{display:'flex', alignItems:'center', gap:8}}>
            <div style={{width:26, height:26, borderRadius:'50%', background:'#2f6fb5', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:600}}>JM</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13, fontWeight:600}}>John Marchetti</div>
              <div style={{fontSize:11, color:'var(--m-ink-3)'}}>john@hillcresthomes.com · Email + SMS</div>
            </div>
          </div>
        </div>

        <button style={{width:'100%', padding:'14px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:8, marginBottom:8}}>
          {MI.send}<span>Send</span>
        </button>
        <button style={{width:'100%', padding:'12px', background:'transparent', color:'var(--m-ink-2)', border:'1px solid var(--m-line)', borderRadius:11, fontSize:13.5, fontFamily:'inherit'}}>Keep editing</button>
      </div>
    </div>
  );
}

// ============================================================
// 4 · SENT — viewed, accept/decline CTAs
// ============================================================
function BidSent() {
  return (
    <div className="m">
      <MTopBar back title="Hillcrest Mews · Phase 4" sub="Estimate · Sent 4 days ago" action="more" actionIcon={MI.more}/>
      <EstStateStrip state="sent"/>
      <EstTabs active="prop"/>

      <div className="m-body" style={{padding:'0'}}>
        <div style={{padding:'14px 16px', background:'rgba(47,111,181,0.06)', borderBottom:'1px solid var(--m-line)'}}>
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:3}}>
            <span style={{width:8, height:8, borderRadius:'50%', background:'#2f6fb5', boxShadow:'0 0 0 4px rgba(47,111,181,0.18)'}}/>
            <span style={{fontSize:13, fontWeight:700, color:'#2f6fb5'}}>Viewed by client · 3×</span>
          </div>
          <div style={{fontSize:11.5, color:'var(--m-ink-2)', paddingLeft:18}}>Last opened 14 hrs ago · spent 4m on the proposal</div>
        </div>

        <div style={{padding:'18px 20px', textAlign:'center', borderBottom:'1px solid var(--m-line)'}}>
          <div style={{fontSize:11, color:'var(--m-ink-3)', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase'}}>Sent</div>
          <div style={{fontSize:36, fontWeight:700, fontFamily:'ui-monospace,monospace', letterSpacing:'-0.025em', lineHeight:1, marginTop:4}}>$184,250</div>
          <div style={{fontSize:11.5, color:'var(--m-ink-3)', marginTop:5}}>Apr 19, 4:42 PM</div>
        </div>

        <div style={{padding:'14px 16px 6px', fontSize:11, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em'}}>Activity</div>
        <div style={{padding:'4px 16px', borderLeft:'2px solid var(--m-line)', marginLeft:24}}>
          {[
            {t:'Viewed alternates section', d:'14 hrs ago', c:'#2f6fb5'},
            {t:'Opened proposal · 4m', d:'2 days ago', c:'#2f6fb5'},
            {t:'Sent to john@hillcresthomes.com', d:'Apr 19, 4:42 PM', c:'var(--m-ink-3)'},
            {t:'Estimate drafted', d:'Apr 19, 4:30 PM', c:'var(--m-ink-4)'},
          ].map((e,i) => (
            <div key={i} style={{position:'relative', padding:'8px 0 8px 18px'}}>
              <span style={{position:'absolute', left:-6, top:11, width:9, height:9, borderRadius:5, background:'#fff', border:`2px solid ${e.c}`}}/>
              <div style={{fontSize:13, fontWeight:500}}>{e.t}</div>
              <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>{e.d}</div>
            </div>
          ))}
        </div>

        <div style={{padding:'16px 14px 18px', display:'flex', flexDirection:'column', gap:8}}>
          <button style={{width:'100%', padding:'13px', background:'#2c8a55', color:'#fff', border:'none', borderRadius:11, fontSize:13.5, fontWeight:600, fontFamily:'inherit'}}>Mark accepted · ready to start</button>
          <button style={{width:'100%', padding:'12px', background:'transparent', color:'var(--m-ink-2)', border:'1px solid var(--m-line)', borderRadius:11, fontSize:13, fontFamily:'inherit'}}>Edit + resend</button>
          <button style={{width:'100%', padding:'10px', background:'transparent', color:'var(--m-ink-3)', border:'none', fontSize:12, fontFamily:'inherit'}}>Mark lost / archived</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 5 · ACCEPTED — pre-launch checklist (was the handoff screen)
// ============================================================
function BidAccepted() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="Hillcrest Mews · Phase 4" sub="Accepted · ready to start" action="more" actionIcon={MI.more}/>
      <EstStateStrip state="acc"/>

      <div style={{padding:'14px 16px', background:'rgba(44,138,85,0.06)', borderBottom:'1px solid var(--m-line)', display:'flex', alignItems:'center', gap:10}}>
        <div style={{width:30, height:30, borderRadius:8, background:'rgba(44,138,85,0.14)', color:'#2c8a55', display:'flex', alignItems:'center', justifyContent:'center'}}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M5 12l5 5L20 7"/></svg>
        </div>
        <div style={{flex:1}}>
          <div style={{fontSize:11, fontWeight:600, color:'#2c8a55', textTransform:'uppercase', letterSpacing:'.06em'}}>Accepted Apr 22</div>
          <div style={{fontSize:12, color:'var(--m-ink-2)', marginTop:1}}>$184,250 · target start May 6</div>
        </div>
      </div>

      <div style={{padding:'16px 16px 12px', background:'#fff', borderBottom:'1px solid var(--m-line)'}}>
        <div style={{fontSize:11, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6}}>Before kickoff</div>
        <div style={{display:'flex', alignItems:'baseline', gap:10, marginBottom:10}}>
          <span style={{fontSize:30, fontWeight:700, fontFamily:'ui-monospace,monospace', letterSpacing:'-0.02em'}}>3<span style={{color:'var(--m-ink-3)', fontWeight:500}}>/9</span></span>
          <span style={{fontSize:11.5, color:'var(--m-ink-3)'}}>Targeting May 6 start</span>
        </div>
        <div style={{height:5, background:'var(--m-card-soft)', borderRadius:3, overflow:'hidden'}}>
          <div style={{width:'33%', height:'100%', background:'var(--m-accent)'}}/>
        </div>
      </div>

      <div className="m-body" style={{padding:'12px 0 14px'}}>
        <CheckGroup title="Materials">
          <Check label="EPS panels · 4-week lead time" sub="Order by Apr 25 to hit May 6" hot done/>
          <Check label="Specialty mix · 2-week lead" sub="Order by May 8"/>
          <Check label="Stone veneer · accent wall" sub="Local stock confirmed"/>
        </CheckGroup>

        <CheckGroup title="Crew">
          <Check label="Foreman assigned" done/>
          <Check label="Crew commits · 4 of 4" sub="Mike, Jose, Dani, Ahmad confirmed"/>
          <Check label="Sub · stone install" sub="Castelli Stone · re-confirm last quote" warn/>
        </CheckGroup>

        <CheckGroup title="Approvals">
          <Check label="Permits required?" sub="Tap to mark required / not required" hot/>
          <Check label="HOA / architect signoff"/>
          <Check label="Client kickoff call"/>
        </CheckGroup>

        <div style={{padding:'14px 16px 0'}}>
          <button style={{width:'100%', padding:'13px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit'}}>Start work · flip to In progress</button>
          <div style={{fontSize:11, color:'var(--m-ink-3)', textAlign:'center', marginTop:8, lineHeight:1.5}}>
            Available once crew + materials are ✓.
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckGroup({title, children}){
  return (
    <div style={{padding:'12px 16px 6px'}}>
      <div style={{fontSize:11, fontWeight:700, color:'var(--m-ink-2)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8}}>{title}</div>
      <div style={{display:'flex', flexDirection:'column', gap:6}}>{children}</div>
    </div>
  );
}

function Check({label, sub, done, warn, hot}){
  const tone = done ? {bg:'rgba(44,138,85,0.10)', fg:'#2c8a55', border:'rgba(44,138,85,0.25)'}
              : warn ? {bg:'rgba(217,144,74,0.10)', fg:'var(--m-accent-ink)', border:'rgba(217,144,74,0.30)'}
              : {bg:'#fff', fg:'var(--m-ink-3)', border:'var(--m-line)'};
  return (
    <div style={{display:'flex', alignItems:'flex-start', gap:11, padding:'10px 12px', background:'#fff', border:`1px solid ${hot?'var(--m-accent)':'var(--m-line)'}`, borderRadius:10, borderLeft: hot?'3px solid var(--m-accent)':undefined, paddingLeft: hot?10:12}}>
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
// 6 · ARCHIVE w/ LOSS REASON — feeds AI
// ============================================================
function BidArchiveSheet() {
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
        <div style={{fontSize:14, fontWeight:600}}>Hillcrest Mews · Phase 4</div>
      </div>
      <div style={{position:'absolute', inset:0, background:'rgba(20,16,10,0.45)'}}/>

      <div style={{position:'absolute', left:0, right:0, bottom:0, top:60, background:'#fff', borderRadius:'18px 18px 0 0', padding:'14px 18px 18px', overflow:'auto'}}>
        <div style={{width:38, height:4, background:'var(--m-line-2)', borderRadius:2, margin:'0 auto 14px'}}/>
        <div style={{fontSize:17, fontWeight:700, marginBottom:4, letterSpacing:'-0.01em'}}>Archive this estimate?</div>
        <div style={{fontSize:12.5, color:'var(--m-ink-2)', lineHeight:1.5, marginBottom:14}}>
          Tell us why so we can sharpen future estimates. Stays internal.
        </div>

        <div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:14}}>
          {reasons.map((r, i) => (
            <button key={r.l} style={{textAlign:'left', padding:'11px 13px', background: i===0?'rgba(217,144,74,0.08)':'#fff', border: i===0?'1.5px solid var(--m-accent)':'1px solid var(--m-line)', borderRadius:10, fontFamily:'inherit', cursor:'pointer'}}>
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
            Loss reasons feed the estimate-accuracy AI. <strong style={{color:'var(--m-ink)'}}>3 of your last 8 losses</strong> cited price.
          </div>
        </div>

        <button style={{width:'100%', padding:'13px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:11, fontSize:14, fontWeight:600, fontFamily:'inherit', marginBottom:8}}>Archive · save reason</button>
        <button style={{width:'100%', padding:'11px', background:'transparent', color:'var(--m-ink-2)', border:'1px solid var(--m-line)', borderRadius:11, fontSize:13, fontFamily:'inherit'}}>Cancel</button>
      </div>
    </div>
  );
}

Object.assign(window, {
  BidWorksheet,
  BidProposal,
  BidSendSheet,
  BidSent,
  BidAccepted,
  BidArchiveSheet,
});
