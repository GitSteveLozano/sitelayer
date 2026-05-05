/* global React, MI, MTopBar, MAttribution, MAiAgent, MSpark */

// ============================================================
// SECTION 14 — PROJECT CREATION
// Two-tier model: required = Client + Archetype. Everything else
// progressively disclosed inline on the project page itself.
// Three entry paths converge on the same Create sheet, pre-filled
// differently. Same flow on iOS + Android.
// ============================================================

// ---------- shared bits ----------
function NewBtn({ icon, label, sub, primary }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:12, padding:'12px 14px',
      background: primary ? 'var(--m-accent)' : '#fff',
      color: primary ? '#fff' : 'var(--m-ink)',
      border: primary ? '1px solid var(--m-accent)' : '1px solid var(--m-line)',
      borderRadius: 12,
    }}>
      <div style={{width:34, height:34, borderRadius:10, background: primary ? 'rgba(255,255,255,0.18)' : 'var(--m-card-soft)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, color: primary ? '#fff' : 'var(--m-accent-ink)'}}>{icon}</div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:14, fontWeight:600, lineHeight:1.2}}>{label}</div>
        {sub && <div style={{fontSize:11, color: primary ? 'rgba(255,255,255,0.78)' : 'var(--m-ink-3)', marginTop:2, lineHeight:1.35}}>{sub}</div>}
      </div>
      <span style={{color: primary ? 'rgba(255,255,255,0.7)' : 'var(--m-ink-4)'}}>{MI.chev}</span>
    </div>
  );
}

function FieldRow({ label, value, placeholder, required, ai, locked, optional }) {
  return (
    <div style={{padding:'13px 16px', borderBottom:'1px solid var(--m-line)', display:'flex', alignItems:'center', gap:10, background:'#fff'}}>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontSize:11, fontWeight:600, color: required ? 'var(--m-accent-ink)' : 'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3, display:'flex', alignItems:'center', gap:4}}>
          {label}
          {required && <span style={{fontSize:10}}>·</span>}
          {required && <span style={{fontSize:10, fontWeight:500, color:'var(--m-accent-ink)'}}>required</span>}
          {optional && <span style={{fontSize:10, fontWeight:500, color:'var(--m-ink-4)', textTransform:'none', letterSpacing:0}}>· add later</span>}
          {ai && <MSpark state="accent" size={10}/>}
        </div>
        {value
          ? <div style={{fontSize:14, color:'var(--m-ink)', lineHeight:1.3}}>{value}</div>
          : <div style={{fontSize:14, color:'var(--m-ink-4)', lineHeight:1.3}}>{placeholder}</div>}
      </div>
      {locked
        ? <span style={{color:'var(--m-ink-4)'}}>{MI.lock}</span>
        : <span style={{color:'var(--m-ink-4)'}}>{MI.chev}</span>}
    </div>
  );
}

// ============================================================
// 1 · ENTRY POINTS — three paths to one create sheet
// ============================================================
function ProjectCreateEntry() {
  return (
    <div className="m" style={{background:'var(--m-bg)'}}>
      <MTopBar back title="New project"/>
      <div className="m-body" style={{padding:'18px 16px 16px', display:'flex', flexDirection:'column', gap:14}}>
        {/* Single primary path */}
        <NewBtn primary icon={MI.plus} label="Start blank" sub="Client + type. About ten seconds."/>

        {/* Templates — past projects you can clone */}
        <div>
          <div style={{fontSize:10.5, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.07em', padding:'4px 4px 8px'}}>Start from a template</div>
          <div style={{display:'flex', flexDirection:'column', gap:1, background:'var(--m-line)', borderRadius:8, overflow:'hidden'}}>
            <div style={{fontSize:13, padding:'11px 12px', background:'#fff', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <span>Strip-mall stucco · 4 phases</span><span style={{fontSize:11, color:'var(--m-ink-3)'}}>used 6×</span>
            </div>
            <div style={{fontSize:13, padding:'11px 12px', background:'#fff', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <span>Single-family repair · T&M</span><span style={{fontSize:11, color:'var(--m-ink-3)'}}>used 3×</span>
            </div>
            <div style={{fontSize:13, padding:'11px 12px', background:'#fff', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <span>Service call · 1-day</span><span style={{fontSize:11, color:'var(--m-ink-3)'}}>used 11×</span>
            </div>
          </div>
        </div>

        {/* QB pull — only path that brings in external data */}
        <div>
          <div style={{fontSize:10.5, fontWeight:700, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.07em', padding:'4px 4px 8px'}}>Or import</div>
          <button style={{padding:'12px', display:'flex', alignItems:'center', gap:10, border:'1px solid var(--m-line)', borderRadius:10, background:'#fff', fontFamily:'inherit', textAlign:'left', cursor:'pointer', width:'100%'}}>
            <span style={{width:30, height:30, borderRadius:7, background:'var(--m-card-soft)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--m-ink-2)'}}>{MI.sync}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:13, fontWeight:600}}>Pull from QuickBooks</div>
              <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:1}}>3 customer:job records not yet linked</div>
            </div>
            <span style={{color:'var(--m-ink-4)'}}>{MI.chev}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 2 · CREATE SHEET — minimum viable: Client + Archetype only
// ============================================================
function ProjectCreateSheet() {
  return (
    <div className="m" style={{background:'#f0eee9'}}>
      <div style={{padding:'14px 16px 8px', display:'flex', alignItems:'center', borderBottom:'1px solid var(--m-line)', background:'#f0eee9'}}>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, color:'var(--m-ink-2)'}}>Cancel</button>
        <div style={{flex:1, textAlign:'center', fontSize:15, fontWeight:600}}>New project</div>
        <button style={{background:'transparent', border:'none', fontFamily:'inherit', fontSize:14, fontWeight:600, color:'var(--m-ink-4)'}}>Create</button>
      </div>
      <div className="m-body" style={{padding:'8px 0'}}>
        <div style={{padding:'14px 16px 8px', fontSize:11, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.07em'}}>Required</div>
        <div style={{borderTop:'1px solid var(--m-line)', borderBottom:'1px solid var(--m-line)'}}>
          <FieldRow label="Client" required placeholder="Choose or add a client"/>
          <FieldRow label="Project type" required placeholder="Fixed-bid · T&M · Service · Rental · Internal"/>
        </div>
        <div style={{padding:'18px 16px 8px', fontSize:11, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.07em'}}>Add now or later</div>
        <div style={{borderTop:'1px solid var(--m-line)', borderBottom:'1px solid var(--m-line)'}}>
          <FieldRow label="Project name" optional placeholder="Auto: client name + month"/>
          <FieldRow label="Site address" optional placeholder="Used for geofence & weather" ai/>
          <FieldRow label="Foreman" optional placeholder="Assign later"/>
          <FieldRow label="Start date" optional placeholder="TBD"/>
        </div>
        <div style={{padding:'14px 16px 0'}}>
          <div style={{fontSize:11, color:'var(--m-ink-3)', lineHeight:1.5, padding:'10px 12px', background:'rgba(217,144,74,0.08)', borderRadius:8, display:'flex', gap:8, alignItems:'flex-start'}}>
            <MSpark state="muted" size={11}/>
            <span>Add an address and we'll suggest a project type and budget range from photos & past work.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 4 · QB DEDUPE / CONFLICT — fuzzy match modal
// ============================================================
function ProjectCreateQBDedupe() {
  return (
    <div className="m" style={{background:'#f0eee9', position:'relative'}}>
      {/* dim background = create sheet behind */}
      <div style={{padding:'14px 16px 8px', display:'flex', alignItems:'center', borderBottom:'1px solid var(--m-line)', opacity:0.5}}>
        <span style={{fontSize:14, color:'var(--m-ink-3)'}}>Cancel</span>
        <div style={{flex:1, textAlign:'center', fontSize:15, fontWeight:600, color:'var(--m-ink-3)'}}>New project</div>
        <span style={{fontSize:14, color:'var(--m-ink-4)'}}>Create</span>
      </div>
      <div style={{padding:'12px 0', opacity:0.4}}>
        <FieldRow label="Client" value="Acme Holdngs" required/>
      </div>

      {/* sheet */}
      <div style={{position:'absolute', left:8, right:8, bottom:8, background:'#fff', border:'1px solid var(--m-line)', borderRadius:14, padding:'18px 16px 14px', boxShadow:'0 12px 32px rgba(50,40,30,0.18)'}}>
        <div style={{display:'flex', alignItems:'flex-start', gap:10, marginBottom:12}}>
          <div style={{width:32, height:32, borderRadius:9, background:'rgba(47,111,181,0.10)', color:'#2f6fb5', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>{MI.sync}</div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:14, fontWeight:600, marginBottom:2}}>Match this customer?</div>
            <div style={{fontSize:12, color:'var(--m-ink-2)', lineHeight:1.45}}>QuickBooks has a customer that's almost the same name.</div>
          </div>
        </div>

        <div style={{padding:'10px 12px', background:'var(--m-card-soft)', borderRadius:9, marginBottom:8, border:'1px solid var(--m-line)'}}>
          <div style={{fontSize:10, fontWeight:600, color:'var(--m-ink-3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4}}>You typed</div>
          <div style={{fontSize:13.5, fontWeight:500}}>Acme Holdngs</div>
        </div>

        <div style={{padding:'10px 12px', background:'#fff', borderRadius:9, marginBottom:12, border:'1px solid var(--m-accent)', boxShadow:'0 0 0 3px rgba(217,144,74,0.10)'}}>
          <div style={{fontSize:10, fontWeight:600, color:'var(--m-accent-ink)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4, display:'flex', alignItems:'center', gap:6}}>
            <MSpark state="accent" size={10}/> In QuickBooks · 92% match
          </div>
          <div style={{fontSize:13.5, fontWeight:500}}>Acme Holdings, LLC</div>
          <div style={{fontSize:11, color:'var(--m-ink-3)', marginTop:2}}>4 jobs · last invoice Mar 14</div>
        </div>

        <div style={{display:'flex', flexDirection:'column', gap:8}}>
          <button style={{padding:'12px', background:'var(--m-ink)', color:'#fff', border:'none', borderRadius:10, fontSize:13.5, fontWeight:600, fontFamily:'inherit'}}>Link to Acme Holdings, LLC</button>
          <button style={{padding:'12px', background:'transparent', color:'var(--m-ink-2)', border:'1px solid var(--m-line)', borderRadius:10, fontSize:13.5, fontFamily:'inherit'}}>Create as new customer</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
Object.assign(window, {
  ProjectCreateEntry,
  ProjectCreateSheet,
  ProjectCreateQBDedupe,
});
