// ============================================================
// ai-desktop.jsx — Sitelayer desktop AI Layer atoms.
//
// Tier 1 — inline atom: Spark icon + Attribution
// Tier 2 — stripe card: density-aware (inline banner OR rail card)
// Tier 3 — agent surface: soft-tint panel with explicit approval foot
//
// Same vocabulary as ai-primitives.jsx (the doc canvas) and the
// mobile primitives. Different visual chrome only.
// ============================================================

const SLAi = (() => {

  // ---- Spark icon. The "this is AI" tell. Tooltip on hover.
  function SparkIcon({ size = 12, state = 'accent', tooltip }) {
    return (
      <span className="sl-ai-spark" data-state={state} title={tooltip || undefined}
        style={{width: size, height: size}}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          width="100%" height="100%">
          <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5z"/>
        </svg>
      </span>
    );
  }
  // Convenience alias — `Spark` reads cleaner inline.
  function Spark(props) { return <SparkIcon {...props}/>; }

  // ---- Attribution line. Always names the data moat.
  function Attribution({ children, sparkState = 'accent', muted }) {
    return (
      <span className="sl-ai-attr" data-muted={muted ? 'true' : 'false'}>
        <SparkIcon state={sparkState} size={11}/>
        <span>{children}</span>
      </span>
    );
  }

  // ---- Eyebrow above an intelligence-layer card or a section.
  function Eyebrow({ tone, children }) {
    return (
      <span className="sl-ai-eyebrow" data-tone={tone || 'accent'}>
        <SparkIcon state={tone === 'warn' ? 'strong' : 'accent'} size={10}/>
        {children}
      </span>
    );
  }

  // ---- Stripe card. The canonical Tier 2 surface.
  // tone: accent | warn | info | muted
  // density: inline (full-width banner) | rail (narrow side card)
  function Stripe({ tone, eyebrow, title, children, attribution, action,
                    density = 'inline', onDismiss, style }) {
    return (
      <div className="sl-ai-stripe" data-tone={tone || 'accent'}
        data-density={density} style={style}>
        <div className="sl-ai-stripe-body">
          {eyebrow && (
            <div className="sl-ai-stripe-eyebrow">
              <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
            </div>
          )}
          {title && <div className="sl-ai-stripe-title">{title}</div>}
          {children && <div className="sl-ai-stripe-text">{children}</div>}
          {attribution && <div className="sl-ai-stripe-attr">
            {typeof attribution === 'string'
              ? <Attribution muted>{attribution}</Attribution>
              : attribution}
          </div>}
        </div>
        {onDismiss !== false && (
          <button className="sl-ai-dismiss" aria-label="Dismiss" onClick={onDismiss}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        )}
        {action && <div className="sl-ai-stripe-foot">{action}</div>}
      </div>
    );
  }

  // ---- Agent surface (Tier 3). For drafted artifacts awaiting human review.
  // Two shapes:
  //   1. Items list — pass `items: [{id, label, meta}]` and the card renders
  //      a checkable list with primary/secondary/tertiary actions in the foot.
  //   2. Free-form — pass `children` for custom body content.
  // Both share the soft-tint panel + "Agent draft" pill header.
  function Agent({
    eyebrow, title, subtitle, density = 'card',
    items, primaryLabel, secondaryLabel, tertiaryLabel,
    primaryAction, secondaryAction, attribution, sources, children, style,
  }) {
    return (
      <div className="sl-ai-agent" data-density={density} style={style}>
        <div className="sl-ai-agent-head">
          <div className="sl-ai-agent-pill">
            <SparkIcon size={10}/>{eyebrow || 'Agent draft · review before sending'}
          </div>
          {(title || subtitle) && (
            <div className="sl-ai-agent-titles">
              {title && <div className="sl-ai-agent-title">{title}</div>}
              {subtitle && <div className="sl-ai-agent-sub">{subtitle}</div>}
            </div>
          )}
        </div>

        {items && (
          <ul className="sl-ai-agent-items">
            {items.map(it => (
              <li key={it.id} className="sl-ai-agent-item">
                <span className="sl-ai-agent-item-tick" aria-hidden="true">○</span>
                <div className="sl-ai-agent-item-body">
                  <div className="sl-ai-agent-item-label">{it.label}</div>
                  {it.meta && <div className="sl-ai-agent-item-meta">{it.meta}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}

        {children && <div className="sl-ai-agent-body">{children}</div>}

        {(attribution || sources) && (
          <div className="sl-ai-agent-attr">
            <Attribution muted>
              {attribution || <>Drafted from <strong>{sources}</strong>.</>}
            </Attribution>
          </div>
        )}

        <div className="sl-ai-agent-foot">
          {tertiaryLabel && (
            <button className="btn" data-variant="ghost"
              onClick={primaryAction?.onTertiary}>{tertiaryLabel}</button>
          )}
          <span style={{flex:1}}/>
          {secondaryLabel && (
            <button className="btn"
              onClick={secondaryAction?.onClick}>{secondaryLabel}</button>
          )}
          {primaryLabel && (
            <button className="btn" data-variant="primary"
              onClick={primaryAction?.onClick}>{primaryLabel}</button>
          )}
        </div>
      </div>
    );
  }

  // ---- Priority card. The "What needs you" cards on the Projects landing.
  // Sized for a 3-up grid; carries the same calm/warn vocabulary as Stripe
  // but with more affordance — clickable as a whole, single primary action.
  function PriorityCard({ tone = 'info', eyebrow, title, body, action,
                          attribution, onClick }) {
    return (
      <div className="sl-ai-priority" data-tone={tone}>
        <div className="sl-ai-priority-head">
          <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
        </div>
        <div className="sl-ai-priority-title">{title}</div>
        <p className="sl-ai-priority-body">{body}</p>
        {attribution && (
          <div className="sl-ai-priority-attr">
            <Attribution muted>{attribution}</Attribution>
          </div>
        )}
        <div className="sl-ai-priority-foot">
          <button className="btn" data-variant="primary" onClick={onClick}>
            {action || 'Open'}
          </button>
        </div>
      </div>
    );
  }

  // ---- Inline anomaly chip — for table rows / list items.
  function AnomalyChip({ kind, children }) {
    return (
      <span className="sl-ai-anomaly" data-kind={kind || 'warn'}>
        <SparkIcon state="strong" size={10}/>
        {children}
      </span>
    );
  }

  return {
    Spark, SparkIcon, Attribution, Eyebrow,
    Stripe, Agent, PriorityCard, AnomalyChip,
  };
})();

window.SLAi = SLAi;
