/* global React */
// ─────────────────────────────────────────────────────────────
// Mobile primitives — shared icons + UI building blocks
// ─────────────────────────────────────────────────────────────

const MI = {
  back:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M15 18l-6-6 6-6"/></svg>,
  more:    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>,
  grid:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>,
  plus:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="20" height="20"><path d="M12 5v14M5 12h14"/></svg>,
  search:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="20" height="20"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>,
  filter:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="20" height="20"><path d="M3 6h18M6 12h12M10 18h4"/></svg>,
  chev:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="14" height="14"><path d="M9 6l6 6-6 6"/></svg>,
  close:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="20" height="20"><path d="M6 6l12 12M18 6L6 18"/></svg>,
  check:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M5 12l5 5L20 7"/></svg>,
  // Tabs
  home:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M3 11l9-7 9 7v9a2 2 0 01-2 2h-4v-7H10v7H6a2 2 0 01-2-2v-9z"/></svg>,
  proj:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M9 6V4h6v2"/></svg>,
  time:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  cog:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1A2 2 0 014.2 17l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1A2 2 0 117 4.2l.1.1a1.7 1.7 0 001.8.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1A2 2 0 1119.8 7l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>,
  cal:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>,
  layers:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5M3 18l9 5 9-5"/></svg>,
  receipt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>,
  box:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>,
  sync:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5"/></svg>,
  bell:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M6 16V11a6 6 0 1112 0v5l1.5 2.5h-15L6 16zM10 21h4"/></svg>,
  alert:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M12 3l10 18H2L12 3zM12 10v5M12 18v.01"/></svg>,
  cam:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M3 7h4l2-3h6l2 3h4v13H3V7z"/><circle cx="12" cy="13" r="4"/></svg>,
  pin:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M12 22s8-7 8-13a8 8 0 10-16 0c0 6 8 13 8 13z"/><circle cx="12" cy="9" r="3"/></svg>,
  user:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>,
  users:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19a6 6 0 0112 0M15 19a4 4 0 016-3.4"/></svg>,
  play:    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M7 4l14 8-14 8V4z"/></svg>,
  pause:   <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M6 4h5v16H6zM13 4h5v16h-5z"/></svg>,
  trash:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>,
  edit:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M16 4l4 4-12 12H4v-4L16 4z"/></svg>,
  share:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M12 3v13M7 8l5-5 5 5M5 21h14"/></svg>,
  send:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>,
  wifi:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M2 9a16 16 0 0120 0M5 13a11 11 0 0114 0M8 17a6 6 0 018 0M12 21h.01"/></svg>,
  wifioff: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M2 2l20 20M5 13a11 11 0 0114 0M8 17a6 6 0 018 0M12 21h.01"/></svg>,
  download:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M12 4v12M7 11l5 5 5-5M5 21h14"/></svg>,
  doc:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M14 3H6v18h12V7l-4-4zM14 3v4h4M9 12h6M9 16h4"/></svg>,
  ruler:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M3 8l5-5 13 13-5 5L3 8zM7 7l1 1M10 4l1 1M13 7l1 1M16 10l1 1M10 10l1 1M13 13l1 1M7 13l1 1"/></svg>,
  truck:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>,
  $:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M12 3v18M16 7H9.5a2.5 2.5 0 000 5h5a2.5 2.5 0 010 5H7"/></svg>,
  bolt:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" width="22" height="22"><path d="M13 2L3 14h7v8l10-12h-7V2z"/></svg>,
  spark:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="22" height="22"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5z"/></svg>,
  lock:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>,
  bat:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="22" height="22"><rect x="3" y="8" width="16" height="9" rx="2"/><path d="M19 11v3M7 12h6"/></svg>,
  sliders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="22" height="22"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h14M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/></svg>,
  qr:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14h1M14 20h3M20 17v4"/></svg>,
  filterFunnel: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M3 5h18l-7 9v6l-4-2v-4L3 5z"/></svg>,
};

// Top App Bar
function MTopBar({ back, title, sub, eyebrow, action, actionIcon, large, onBack, onAction }) {
  return (
    <div className="m-topbar">
      {back && (
        <button className="m-topbar-back" onClick={onBack}>{MI.back}</button>
      )}
      <div className="m-topbar-title">
        {eyebrow && <div className="m-topbar-eyebrow">{eyebrow}</div>}
        <div className="m-h1">{title}</div>
        {sub && <div className="m-sub">{sub}</div>}
      </div>
      {action && (
        <button className="m-topbar-action" onClick={onAction} aria-label={action}>
          {actionIcon || MI.more}
        </button>
      )}
    </div>
  );
}

// Large title (iOS pattern)
function MLargeHead({ title, sub, right }) {
  return (
    <div className="m-largehead">
      <div className="m-largehead-row">
        <div>
          <div className="m-h-display">{title}</div>
          {sub && <div className="m-h-sub">{sub}</div>}
        </div>
        {right}
      </div>
    </div>
  );
}

// Section header
function MSectionH({ children, link, onLink }) {
  return (
    <div className="m-section-h">
      <div className="m-section-h-row">
        <span>{children}</span>
        {link && <a className="m-link" onClick={onLink}>{link}</a>}
      </div>
    </div>
  );
}

// List row
function MRow({ leading, leadingTone, headline, supporting, trailing, badge, chev = true }) {
  return (
    <div className="m-list-row" data-tap="true">
      {leading && <div className="m-l-leading" data-tone={leadingTone}>{leading}</div>}
      <div className="m-l-body">
        <div className="m-l-headline">{headline}</div>
        {supporting && <div className="m-l-supporting">{supporting}</div>}
      </div>
      <div className="m-l-trailing">
        {trailing}
        {badge}
        {chev && <span className="m-chev">{MI.chev}</span>}
      </div>
    </div>
  );
}

// KPI tile
function MKpi({ label, value, unit, meta, metaTone }) {
  return (
    <div className="m-kpi">
      <div className="m-kpi-eyebrow">{label}</div>
      <div className="m-kpi-val num">{value}{unit && <span className="m-kpi-unit">{unit}</span>}</div>
      {meta && <div className="m-kpi-meta" data-tone={metaTone}>{meta}</div>}
    </div>
  );
}

// Pill
function MPill({ children, tone, dot }) {
  return (
    <span className="m-pill" data-tone={tone}>
      {dot && <span className="m-dot"/>}
      {children}
    </span>
  );
}

// Bottom tabs (iOS pattern)
function MBottomTabs({ active = 'home', onChange }) {
  const tabs = [
    { id: 'home',    label: 'Home',     icon: MI.home },
    { id: 'proj',    label: 'Projects', icon: MI.proj },
    { id: 'sched',   label: 'Schedule', icon: MI.cal  },
    { id: 'rent',    label: 'Rentals',  icon: MI.box  },
    { id: 'more',    label: 'More',     icon: MI.grid },
  ];
  return (
    <div className="m-bottombar">
      {tabs.map(t => (
        <button key={t.id} className="m-bottombar-tab" data-active={active === t.id} onClick={() => onChange?.(t.id)}>
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// Quick-action button
function MQA({ icon, label, onClick }) {
  return (
    <button className="m-qa" onClick={onClick}>
      <span className="m-qa-icon">{icon}</span>
      <span className="m-qa-label">{label}</span>
    </button>
  );
}

// Avatar group
function MAvatarGroup({ items, max = 4 }) {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <div style={{display:'flex'}}>
      {shown.map((a, i) => (
        <div key={i} className="m-avatar" data-size="sm" data-tone={(i % 4) + 1}
          style={{marginLeft: i === 0 ? 0 : -8, border: '2px solid var(--m-bg)'}}>
          {a}
        </div>
      ))}
      {rest > 0 && (
        <div className="m-avatar" data-size="sm" style={{marginLeft: -8, border: '2px solid var(--m-bg)', background:'var(--m-card-soft)', color:'var(--m-ink-3)'}}>+{rest}</div>
      )}
    </div>
  );
}

// Banner
function MBanner({ tone, title, children, action }) {
  const icon = tone === 'error' ? MI.alert : tone === 'ok' ? MI.check : tone === 'info' ? MI.bell : MI.alert;
  return (
    <div className="m-banner" data-tone={tone}>
      <span className="m-banner-icon">{icon}</span>
      <div className="m-banner-body">
        {title && <div className="m-banner-title">{title}</div>}
        <div className="m-banner-text">{children}</div>
      </div>
      {action}
    </div>
  );
}

// Wrap a phone screen with an artboard sub-label (used inside DCArtboard)
function MStage({ label, children }) {
  return <>{children}<div className="mb-stage-label">{label}</div></>;
}

// ============================================================
// AI LAYER atoms — shared across mobile screens
// ============================================================

// Spark icon — confidence is ordinal, not numeric
function MSpark({ state = "accent", size = 12 }) {
  return (
    <span className="m-spark" data-state={state} style={{width:size, height:size}}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="100%" height="100%">
        <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5z"/>
      </svg>
    </span>
  );
}

// Source attribution — show the data moat quietly
// e.g. <MAttribution>Based on <strong>7 closed jobs</strong>.</MAttribution>
function MAttribution({ children, sparkState = "accent" }) {
  return (
    <span className="m-ai-attr">
      <MSpark state={sparkState} size={11}/>
      <span>{children}</span>
    </span>
  );
}

// Eyebrow above an intelligence-layer card — replaces "Heads up" labels
function MAiEyebrow({ tone, children }) {
  return (
    <span className="m-ai-eyebrow" data-tone={tone}>
      <MSpark state={tone === "warn" ? "strong" : "accent"} size={11}/>
      {children}
    </span>
  );
}

// Stripe card — the canonical intelligence-layer container.
// Always dismissible; always carries source attribution.
function MAiStripe({ tone, eyebrow, title, children, attribution, action, onDismiss = true }) {
  return (
    <div className="m-ai-stripe" data-tone={tone}>
      <div style={{display:'flex', alignItems:'flex-start', gap:10}}>
        <div style={{flex:1, minWidth:0}}>
          {eyebrow && <div style={{marginBottom:5}}><MAiEyebrow tone={tone}>{eyebrow}</MAiEyebrow></div>}
          {title && <div style={{fontSize:13.5, fontWeight:600, lineHeight:1.4, marginBottom:5, letterSpacing:'-0.005em'}}>{title}</div>}
          {children && <div style={{fontSize:12, color:'var(--m-ink-2)', lineHeight:1.5}}>{children}</div>}
          {attribution && <div style={{marginTop:8}}>{attribution}</div>}
        </div>
        {onDismiss && (
          <button className="m-ai-dismiss" aria-label="Dismiss">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        )}
      </div>
      {action && <div style={{marginTop:11, paddingTop:10, borderTop:'1px dashed var(--m-line-2)'}}>{action}</div>}
    </div>
  );
}

// Agent surface — distinct dashed border + soft tint.
// Only for autonomous multi-step output that requires explicit human approval.
function MAiAgent({ children }) {
  return <div className="m-ai-agent">{children}</div>;
}

Object.assign(window, {
  MI, MTopBar, MLargeHead, MSectionH, MRow, MKpi, MPill,
  MBottomTabs, MQA, MAvatarGroup, MBanner, MStage,
  MSpark, MAttribution, MAiEyebrow, MAiStripe, MAiAgent,
});
