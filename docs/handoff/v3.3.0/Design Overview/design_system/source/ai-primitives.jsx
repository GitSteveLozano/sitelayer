// ai-primitives.jsx — shared atoms for the AI Layer canvas

const Spark = ({ state = "accent", size = 14 }) => (
  <span className="ai-spark-mark" data-state={state} style={{width:size, height:size}}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5z"/>
    </svg>
  </span>
);

const XIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
);

const ChevR = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg>
);

const InfoIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>
);

const MicIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>
);

// Source-attribution line. The brief flags this as a quiet branding move:
// "Drafted from 47 of your past EPS bids" beats "AI suggestion."
function Attribution({ children, sparkState = "accent" }) {
  return (
    <span className="ai-attr">
      <Spark state={sparkState} size={12}/>
      <span>{children}</span>
    </span>
  );
}

// Agent-surface review card — the canonical container for any
// multi-step AI output that requires explicit human approval.
function AgentSurface({ title, children, footer }) {
  return (
    <div className="ai-agent-surface">
      {title && <div style={{fontSize:13, fontWeight:600, marginBottom:8, marginTop:2}}>{title}</div>}
      {children}
      {footer && <div style={{marginTop:12, paddingTop:10, borderTop:'1px dashed var(--ai-line-2)'}}>{footer}</div>}
    </div>
  );
}

// Stripe card — the intelligence-layer pattern.
function StripeCard({ tone, eyebrow, title, body, attribution, dismissible = true, action }) {
  return (
    <div className="ai-stripe-card" data-tone={tone}>
      <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
        <div style={{flex:1, minWidth:0}}>
          {eyebrow && (
            <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:4}}>
              <Spark state="accent" size={12}/>
              <span style={{fontSize:10, fontWeight:700, color:'var(--ai-spark-ink)', letterSpacing:'.08em', textTransform:'uppercase'}}>{eyebrow}</span>
            </div>
          )}
          {title && <div style={{fontSize:13.5, fontWeight:600, lineHeight:1.4, marginBottom:4}}>{title}</div>}
          {body && <div style={{fontSize:12.5, color:'var(--ai-ink-2)', lineHeight:1.5}}>{body}</div>}
          {attribution && <div style={{marginTop:8}}>{attribution}</div>}
          {action && <div style={{marginTop:10}}>{action}</div>}
        </div>
        {dismissible && (
          <button className="ai-dismiss" aria-label="Dismiss"><XIcon/></button>
        )}
      </div>
    </div>
  );
}

// Annotation arrow + label, used to point at specific bits of an artboard.
function Annot({ heading, children, style }) {
  return (
    <div className="ai-annot" style={style}>
      {heading && <div className="ai-annot-h">{heading}</div>}
      <div>{children}</div>
    </div>
  );
}

// "Doc card" — used for prose-heavy intro / spec artboards.
function DocCard({ eyebrow, title, sub, children }) {
  return (
    <div className="ai-doccard">
      {eyebrow && <div className="ai-eyebrow">{eyebrow}</div>}
      {title && <h2 className="ai-title">{title}</h2>}
      {sub && <p className="ai-sub">{sub}</p>}
      <div style={{flex:1, minHeight:0, overflow:'auto'}}>
        {children}
      </div>
    </div>
  );
}

// Wrap any content as a "rejected pattern" artboard — diagonal X + stamp.
function RejectedPattern({ stamp = "Don't build", children }) {
  return (
    <div className="ai-rejected" style={{width:'100%', height:'100%', position:'relative', background:'var(--ai-paper)'}}>
      {children}
      <div className="ai-rejected-stamp">{stamp}</div>
    </div>
  );
}

// Tiny-frame "phone canvas" — used for screen-fragment artboards
// without going full ios-frame.
function PhoneScreen({ time = "9:41", title, sub, children, bg = "#fff" }) {
  return (
    <div className="ai-phone" style={{background:bg}}>
      <div className="ai-phone-bar">
        <span>{time}</span>
        <span style={{display:'flex', gap:5, alignItems:'center'}}>
          <span style={{width:14, height:8, borderRadius:1.5, border:'1px solid currentColor'}}/>
        </span>
      </div>
      {title && (
        <div className="ai-phone-topbar">
          <div style={{flex:1}}>
            <div className="h">{title}</div>
            {sub && <div style={{fontSize:11, color:'var(--ai-ink-3)', marginTop:1}}>{sub}</div>}
          </div>
        </div>
      )}
      <div style={{flex:1, minHeight:0, overflow:'auto', padding:'12px 14px'}}>
        {children}
      </div>
    </div>
  );
}

Object.assign(window, { Spark, XIcon, ChevR, InfoIcon, MicIcon, Attribution, AgentSurface, StripeCard, Annot, DocCard, RejectedPattern, PhoneScreen });
