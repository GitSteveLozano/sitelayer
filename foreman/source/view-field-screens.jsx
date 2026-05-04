/* global React, IOSDevice, SLIcons, SLPhoneStage, SLPMTab, SLPStatusBar */
const { useState: uSF2, useEffect: uEF2 } = React;
const F2Icons = window.SLIcons;
const PStage = window.SLPhoneStage;
const PMTab2 = window.SLPMTab;
const PSB = window.SLPStatusBar;

// ============================================================
// AUTO CLOCK-IN — 2 variations
// ============================================================
function ClockInTab({ data, autoClock, geofence }) {
  return (
    <>
      <div className="fld-callout">
        <div>
          <strong>Two takes on auto clock-in</strong>
          <p className="muted" style={{margin: '4px 0 0 0', fontSize: 12.5}}>
            Geofence fires when the worker is within {geofence}m of the project pin. The phone vibrates, banner appears, clock starts. Worker can correct or pause from this screen.
          </p>
        </div>
      </div>
      <div className="fld-row">
        <PStage label="A · Map-first" sub="Map dominates — visual proof you're on site. Card sits below.">
          <ClockInMapFirst data={data} geofence={geofence}/>
        </PStage>
        <PStage label="B · Status-first" sub="Big timer + crew, map is a small chip. Less visual, faster scan." badge="recommended" badgeTone="green">
          <ClockInStatusFirst data={data} geofence={geofence}/>
        </PStage>
      </div>
    </>
  );
}

function MiniMap({ inFence = true, accuracy = 'high', radius = 100, dot = {x: 50, y: 52}, dark = false }) {
  // Stylized map with geofence circle and worker dot
  const stroke = inFence ? 'var(--green)' : 'var(--red)';
  const fill = inFence ? 'rgba(60,140,75,.10)' : 'rgba(186,82,68,.12)';
  const grid = dark ? '#1f2630' : '#e8e3da';
  const land = dark ? '#10141a' : '#f1ece1';
  const road = dark ? '#2a313a' : '#d8d2c4';
  return (
    <svg viewBox="0 0 200 130" style={{width: '100%', height: '100%', display: 'block'}}>
      <rect width="200" height="130" fill={land}/>
      {/* roads */}
      <path d="M0 50 L200 60" stroke={road} strokeWidth="6" fill="none"/>
      <path d="M70 0 L80 130" stroke={road} strokeWidth="5" fill="none"/>
      <path d="M0 95 L200 100" stroke={road} strokeWidth="3" fill="none"/>
      {/* parcels */}
      <rect x="20" y="20" width="32" height="22" fill={dark ? '#1a1f26' : '#e7e1d4'} stroke={grid} strokeWidth=".5"/>
      <rect x="92" y="22" width="28" height="20" fill={dark ? '#1a1f26' : '#e7e1d4'} stroke={grid} strokeWidth=".5"/>
      <rect x="130" y="22" width="40" height="20" fill={dark ? '#1f242c' : '#ddd5c4'} stroke={grid} strokeWidth=".5"/>
      <rect x="20" y="65" width="40" height="22" fill={dark ? '#1a1f26' : '#e7e1d4'} stroke={grid} strokeWidth=".5"/>
      <rect x="115" y="65" width="60" height="22" fill={dark ? '#1f242c' : '#ddd5c4'} stroke={grid} strokeWidth=".5"/>
      {/* geofence */}
      <circle cx="100" cy="65" r="36" fill={fill} stroke={stroke} strokeWidth="1.5" strokeDasharray="3,3"/>
      <circle cx="100" cy="65" r="3" fill={stroke}/>
      <text x="100" y="62" fill={stroke} fontSize="6" textAnchor="middle" fontWeight="600" style={{letterSpacing: '.5px'}}>HILLCREST</text>
      <text x="100" y="74" fill={dark ? '#9aa3ae' : '#6a6253'} fontSize="5" textAnchor="middle">{radius}m fence</text>
      {/* worker dot */}
      <circle cx={dot.x * 2} cy={dot.y * 1.3} r="6" fill="rgba(58,108,184,.2)"/>
      <circle cx={dot.x * 2} cy={dot.y * 1.3} r="3" fill="#3a6cb8" stroke="#fff" strokeWidth="1"/>
      {accuracy !== 'high' && <circle cx={dot.x * 2} cy={dot.y * 1.3} r="14" fill="none" stroke="#3a6cb8" strokeWidth=".6" strokeDasharray="2,2" opacity=".5"/>}
    </svg>
  );
}

function ClockInMapFirst({ data, geofence }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-clock-banner">
        <div className="pmb-pulse" style={{background: 'var(--green)'}}/>
        <div>
          <strong>Clocked in automatically</strong>
          <span className="pmb-meta">7:02 AM · Hillcrest Mews</span>
        </div>
      </div>

      <div className="pmb-map">
        <MiniMap radius={geofence}/>
      </div>

      <div className="pmb-card pmb-clock-card" data-active style={{marginTop: -14, position: 'relative', zIndex: 2}}>
        <div className="row between">
          <div>
            <span className="pmb-label">Worked today</span>
            <div className="num" style={{fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums'}}>0:08:42</div>
          </div>
          <div style={{textAlign: 'right'}}>
            <span className="pmb-label">Project</span>
            <strong style={{fontSize: 13}}>Hillcrest</strong>
            <div className="pmb-meta">EPS — East elev.</div>
          </div>
        </div>
        <div className="pmb-clock-meta">
          <div><span className="pmb-label">Accuracy</span><span><span className="dot" style={{background: 'var(--green)'}}/>±8m · GPS</span></div>
          <div><span className="pmb-label">In fence</span><span>{geofence}m radius · ✓</span></div>
        </div>
        <div className="row" style={{gap: 8, marginTop: 10}}>
          <button className="pmb-btn" data-variant="ghost" style={{flex: 1, fontSize: 12}}>Pause</button>
          <button className="pmb-btn" data-variant="ghost" style={{flex: 1, fontSize: 12}}>Switch project</button>
        </div>
      </div>

      <p className="pmb-section">Crew here</p>
      <div className="pmb-crew-pills">
        {['AC','ML','TR'].map((init, i) => (
          <div key={init} className={`avatar tone-${i+1}`} style={{width: 32, height: 32}}>{init}</div>
        ))}
        <span className="pmb-meta" style={{marginLeft: 4}}>+ Ana, Marcus, Tomás</span>
      </div>

      <div className="pmb-tabbar">
        <PMTab2 label="Today" active icon={F2Icons.home}/>
        <PMTab2 label="Schedule" icon={F2Icons.cal}/>
        <PMTab2 label="Log" icon={F2Icons.receipt}/>
        <PMTab2 label="Me" icon={F2Icons.box}/>
      </div>
    </div>
  );
}

function ClockInStatusFirst({ data, geofence }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-greeting" style={{paddingBottom: 4}}>
        <p className="pmb-eyebrow"><span className="dot" style={{background: 'var(--green)'}}/>Working · Hillcrest</p>
      </div>

      <div className="pmb-clock-hero">
        <span className="pmb-label">Clocked in at 7:02 AM</span>
        <div className="num pmb-clock-hero-num">0:08:42</div>
        <span className="pmb-meta">EPS — East elevation · with Ana, Tomás</span>
      </div>

      <div className="pmb-card" style={{padding: 0, overflow: 'hidden'}}>
        <div className="pmb-mini-map-row">
          <div className="pmb-mini-map">
            <MiniMap radius={geofence}/>
          </div>
          <div style={{flex: 1, padding: '12px 14px'}}>
            <strong style={{fontSize: 13}}>On site</strong>
            <div className="pmb-meta" style={{marginBottom: 6}}>±8m accuracy · {geofence}m fence</div>
            <span className="pill" data-tone="green" style={{fontSize: 10}}><span className="dot"/>verified</span>
          </div>
        </div>
        <div className="pmb-divider"/>
        <div className="row between" style={{padding: '12px 14px'}}>
          <span className="pmb-label">Today's allocation</span>
          <span style={{fontSize: 12, fontWeight: 500}}>EPS — East</span>
        </div>
      </div>

      <div className="pmb-actions-grid" style={{marginTop: 12}}>
        <button className="pmb-action">
          {F2Icons.clock}
          <span>Take<br/>break</span>
        </button>
        <button className="pmb-action">
          {F2Icons.layers}
          <span>Switch<br/>scope</span>
        </button>
        <button className="pmb-action">
          {F2Icons.receipt}
          <span>Add<br/>note</span>
        </button>
        <button className="pmb-action" style={{color: 'var(--red)'}}>
          {F2Icons.x || F2Icons.box}
          <span>Clock<br/>out</span>
        </button>
      </div>

      <div className="pmb-tabbar">
        <PMTab2 label="Today" active icon={F2Icons.home}/>
        <PMTab2 label="Schedule" icon={F2Icons.cal}/>
        <PMTab2 label="Log" icon={F2Icons.receipt}/>
        <PMTab2 label="Me" icon={F2Icons.box}/>
      </div>
    </div>
  );
}

// ============================================================
// FAILURE STATES — 4 variations
// ============================================================
function FailureStatesTab({ data, geofence }) {
  return (
    <>
      <div className="fld-callout" data-tone="amber">
        <div>
          <strong>The moments where auto fails</strong>
          <p className="muted" style={{margin: '4px 0 0 0', fontSize: 12.5}}>
            GPS isn't perfect. Phones die. People work past the fence line. Each of these is a real situation we've seen with real customers — here's how the worker recovers without bothering the foreman.
          </p>
        </div>
      </div>
      <div className="fld-row">
        <PStage label="GPS lost" sub="Tunnel, basement, dense weather. Last known good fix shown." badge="auto-paused" badgeTone="amber">
          <FailGPS data={data} geofence={geofence}/>
        </PStage>
        <PStage label="Outside geofence" sub="Worker walked off-site for materials run" badge="prompted" badgeTone="amber">
          <FailOutside data={data} geofence={geofence}/>
        </PStage>
        <PStage label="Battery saver" sub="iOS Low Power mode kills background GPS" badge="degraded" badgeTone="red">
          <FailBattery data={data}/>
        </PStage>
        <PStage label="Foreman override" sub="Phone died — foreman entered the time on their behalf" badge="manual" badgeTone="blue">
          <FailForemanOverride data={data}/>
        </PStage>
      </div>
    </>
  );
}

function FailGPS({ data, geofence }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-banner" data-tone="amber">
        <strong>GPS unavailable</strong>
        <p>Last fix at 8:14 AM was on site. Clock kept running based on your last known location.</p>
      </div>
      <div className="pmb-map" style={{filter: 'grayscale(.4) brightness(.95)'}}>
        <MiniMap accuracy="low" dot={{x: 48, y: 50}} radius={geofence}/>
        <div className="pmb-map-overlay">
          <span className="dot" style={{background: 'var(--accent)'}}/>
          <span>Last fix · 8:14 AM</span>
        </div>
      </div>
      <div className="pmb-card pmb-clock-card" data-active style={{marginTop: -14, position: 'relative', zIndex: 2}}>
        <div className="row between">
          <div>
            <span className="pmb-label">Still running</span>
            <div className="num" style={{fontSize: 24, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--accent-ink)'}}>1:42:08</div>
          </div>
          <span className="pill" data-tone="amber"><span className="dot"/>est. only</span>
        </div>
        <p style={{margin: '8px 0 0 0', fontSize: 12, color: 'var(--ink-2)'}}>
          We'll auto-correct once GPS is back. Or confirm now:
        </p>
        <div className="row" style={{gap: 8, marginTop: 8}}>
          <button className="pmb-btn" data-variant="primary" style={{flex: 1, fontSize: 12}}>Yes, on site</button>
          <button className="pmb-btn" data-variant="ghost" style={{flex: 1, fontSize: 12}}>No — pause</button>
        </div>
      </div>
      <p className="pmb-section">Why this happens</p>
      <div className="pmb-card pmb-mini">
        <div>
          <div className="pmb-meta" style={{lineHeight: 1.5}}>
            • Heavy walls or roof block GPS signal<br/>
            • Phone in metal toolbox<br/>
            • Bad weather
          </div>
        </div>
      </div>
      <div className="pmb-tabbar">
        <PMTab2 label="Today" active icon={F2Icons.home}/>
        <PMTab2 label="Schedule" icon={F2Icons.cal}/>
        <PMTab2 label="Log" icon={F2Icons.receipt}/>
        <PMTab2 label="Me" icon={F2Icons.box}/>
      </div>
    </div>
  );
}

function FailOutside({ data, geofence }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-banner" data-tone="amber">
        <strong>You left the site at 10:42 AM</strong>
        <p>Were you on the clock for the run, or off?</p>
      </div>
      <div className="pmb-map">
        <MiniMap inFence={false} dot={{x: 76, y: 30}} radius={geofence}/>
        <div className="pmb-map-overlay" data-tone="red">
          <span className="dot" style={{background: 'var(--red)'}}/>
          <span>0.4 mi off-site · Atlas Supply</span>
        </div>
      </div>
      <div className="pmb-card" style={{marginTop: -14, position: 'relative', zIndex: 2}}>
        <span className="pmb-label">What was the run?</span>
        <div className="pmb-radio">
          <label className="pmb-radio-row" data-active>
            <input type="radio" defaultChecked name="off"/>
            <div>
              <strong>On the clock — material run</strong>
              <div className="pmb-meta">Counts toward Hillcrest hours</div>
            </div>
          </label>
          <label className="pmb-radio-row">
            <input type="radio" name="off"/>
            <div>
              <strong>Personal — pause clock</strong>
              <div className="pmb-meta">Resumes when you return</div>
            </div>
          </label>
          <label className="pmb-radio-row">
            <input type="radio" name="off"/>
            <div>
              <strong>End of day — clock out</strong>
            </div>
          </label>
        </div>
        <button className="pmb-btn" data-variant="primary" style={{width: '100%', marginTop: 8, fontSize: 12}}>Confirm</button>
      </div>
      <div className="pmb-tabbar">
        <PMTab2 label="Today" active icon={F2Icons.home}/>
        <PMTab2 label="Schedule" icon={F2Icons.cal}/>
        <PMTab2 label="Log" icon={F2Icons.receipt}/>
        <PMTab2 label="Me" icon={F2Icons.box}/>
      </div>
    </div>
  );
}

function FailBattery({ data }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-banner" data-tone="red">
        <strong>Battery saver is on</strong>
        <p>iOS will kill background GPS at 20%. Auto clock-in won't work reliably.</p>
      </div>

      <div className="pmb-card" style={{padding: 14, textAlign: 'center'}}>
        <div className="pmb-battery-ring">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="48" fill="none" stroke="var(--surface-3)" strokeWidth="8"/>
            <circle cx="60" cy="60" r="48" fill="none" stroke="var(--red)" strokeWidth="8"
              strokeDasharray={`${0.18 * 301} 301`} strokeLinecap="round"
              transform="rotate(-90 60 60)"/>
            <text x="60" y="60" textAnchor="middle" dominantBaseline="middle" fontSize="26" fontWeight="600" fill="var(--ink)" fontVariantNumeric="tabular-nums">18%</text>
            <text x="60" y="78" textAnchor="middle" fontSize="9" fill="var(--ink-2)">battery</text>
          </svg>
        </div>
        <strong style={{fontSize: 14}}>Switch to manual clock?</strong>
        <p className="pmb-meta" style={{margin: '4px 0 12px 0'}}>You'll tap to start and stop today, like the old way. We'll switch back when you're charging.</p>
        <div style={{display: 'grid', gap: 8}}>
          <button className="pmb-btn" data-variant="primary" style={{fontSize: 13}}>Switch to manual</button>
          <button className="pmb-btn" data-variant="ghost" style={{fontSize: 12}}>Open Settings → disable saver</button>
          <button className="pmb-btn" data-variant="ghost" style={{fontSize: 12, color: 'var(--ink-3)'}}>Continue anyway (risky)</button>
        </div>
      </div>

      <div className="pmb-card pmb-bulletin" style={{marginTop: 12}}>
        <span className="pmb-meta" style={{fontSize: 11.5, lineHeight: 1.5}}>
          We've seen 11% of missed-punch issues come from battery saver. We auto-detect and warn at 20% so you don't lose a day's hours.
        </span>
      </div>

      <div className="pmb-tabbar">
        <PMTab2 label="Today" active icon={F2Icons.home}/>
        <PMTab2 label="Schedule" icon={F2Icons.cal}/>
        <PMTab2 label="Log" icon={F2Icons.receipt}/>
        <PMTab2 label="Me" icon={F2Icons.box}/>
      </div>
    </div>
  );
}

function FailForemanOverride({ data }) {
  return (
    <div className="pmb">
      <PSB project="Foreman view"/>
      <div className="pmb-greeting" style={{paddingBottom: 4}}>
        <p className="pmb-eyebrow">Tomás Reyes · Mon Apr 27</p>
        <h2 style={{fontSize: 18}}>Phone died at lunch</h2>
      </div>

      <div className="pmb-card">
        <span className="pmb-label">What we know</span>
        <div className="pmb-known">
          <div><span className="pmb-known-time num">7:15 AM</span><span>Auto clock-in · Hillcrest</span></div>
          <div><span className="pmb-known-time num">12:04 PM</span><span>Last GPS fix · on site</span></div>
          <div className="pmb-known-gap">
            <span className="pmb-known-time num">12:04 — ?</span>
            <span style={{color: 'var(--accent-ink)'}}>Phone offline</span>
          </div>
          <div><span className="pmb-known-time num">3:00 PM</span><span>Crew left site (Ana's phone)</span></div>
        </div>
      </div>

      <p className="pmb-section">Override clock-out time</p>
      <div className="pmb-card">
        <div className="pmb-time-set">
          <button className="pmb-time-btn">−15</button>
          <div className="num pmb-time-display">3:00 PM</div>
          <button className="pmb-time-btn">+15</button>
        </div>
        <div className="pmb-suggest" data-active>
          <span className="dot" style={{background: 'var(--green)'}}/>
          <span style={{fontSize: 12}}>Suggested · matches Ana's "left site" event</span>
        </div>
        <textarea className="pmb-textarea" placeholder="Required note..."
          defaultValue="Phone died after lunch. Crew left at 3:00. Confirmed with Tomás at end of day."/>
        <div className="pmb-flags">
          <span className="pill" data-tone="blue" style={{fontSize: 10}}><span className="dot"/>manual override</span>
          <span className="pill" data-tone="amber" style={{fontSize: 10}}><span className="dot"/>flags for approval</span>
        </div>
        <div className="row" style={{gap: 8, marginTop: 10}}>
          <button className="pmb-btn" data-variant="ghost" style={{flex: 1, fontSize: 12}}>Cancel</button>
          <button className="pmb-btn" data-variant="primary" style={{flex: 1, fontSize: 12}}>Save · 7.8h</button>
        </div>
      </div>

      <div className="pmb-tabbar">
        <PMTab2 label="Crew" active icon={F2Icons.home}/>
        <PMTab2 label="Schedule" icon={F2Icons.cal}/>
        <PMTab2 label="Log" icon={F2Icons.receipt}/>
        <PMTab2 label="Project" icon={F2Icons.layers}/>
      </div>
    </div>
  );
}

// ============================================================
// DAILY LOG — hybrid (structured + free-text)
// ============================================================
function DailyLogTab({ data }) {
  return (
    <>
      <div className="fld-callout">
        <div>
          <strong>Daily log — hybrid form</strong>
          <p className="muted" style={{margin: '4px 0 0 0', fontSize: 12.5}}>
            Pre-fills weather, crew, scheduled work, and progress %. Foreman writes one paragraph and adds photos. Submit takes ~30 seconds at end of day.
          </p>
        </div>
      </div>
      <div className="fld-row">
        <PStage label="1 · Auto context" sub="What we already know — no typing required" badge="step 1">
          <DailyLogStep1 data={data}/>
        </PStage>
        <PStage label="2 · Progress + blockers" sub="Tap progress %, dictate or type blockers">
          <DailyLogStep2 data={data}/>
        </PStage>
        <PStage label="3 · Photos + sign-off" sub="6 photos auto-attached from today, foreman submits">
          <DailyLogStep3 data={data}/>
        </PStage>
      </div>
    </>
  );
}

function DailyLogStep1({ data }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-greeting" style={{paddingBottom: 4}}>
        <p className="pmb-eyebrow">Daily log · Hillcrest · Apr 29</p>
        <h2 style={{fontSize: 20}}>Today at a glance</h2>
      </div>

      <div className="pmb-card pmb-weather">
        <div>
          <span className="pmb-weather-icon">⛅</span>
          <strong style={{fontSize: 13}}>Partly cloudy</strong>
          <div className="pmb-meta">8 mph SW · 0" precip</div>
        </div>
        <div className="pmb-weather-temps">
          <strong className="num">64° / 51°</strong>
          <span className="pmb-meta">auto-pulled</span>
        </div>
      </div>

      <div className="pmb-card">
        <span className="pmb-label">Crew on site (3)</span>
        <div className="pmb-crew-pills" style={{margin: '6px 0 0 0'}}>
          {[{n:'AC',t:1,h:'8.4'},{n:'ML',t:2,h:'8.4'},{n:'TR',t:5,h:'8.1'}].map((c,i) => (
            <div key={i} className="pmb-crew-chip">
              <div className={`avatar tone-${c.t}`} style={{width: 24, height: 24, fontSize: 9}}>{c.n}</div>
              <span className="num" style={{fontSize: 11}}>{c.h}h</span>
            </div>
          ))}
        </div>
        <div className="pmb-meta" style={{marginTop: 6}}>24.9 crew-hours · pulled from clock</div>
      </div>

      <div className="pmb-card">
        <span className="pmb-label">Scheduled work</span>
        <div className="pmb-sched-row" data-status="done">
          <span className="pmb-check">✓</span>
          <div>
            <strong style={{fontSize: 12.5}}>EPS — East elevation</strong>
            <div className="pmb-meta">980 sqft planned · 980 done</div>
          </div>
          <span className="pill" data-tone="green" style={{fontSize: 10}}>100%</span>
        </div>
        <div className="pmb-sched-row" data-status="part">
          <span className="pmb-check" style={{background: 'var(--accent)'}}>·</span>
          <div>
            <strong style={{fontSize: 12.5}}>South elev. start</strong>
            <div className="pmb-meta">started early</div>
          </div>
          <span className="pill" data-tone="amber" style={{fontSize: 10}}>+ extra</span>
        </div>
      </div>

      <div className="pmb-step-foot">
        <span className="pmb-step-dots"><span data-active/><span/><span/></span>
        <button className="pmb-btn" data-variant="primary" style={{fontSize: 12}}>Continue →</button>
      </div>
    </div>
  );
}

function DailyLogStep2({ data }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-greeting" style={{paddingBottom: 4}}>
        <p className="pmb-eyebrow">Daily log · step 2 of 3</p>
        <h2 style={{fontSize: 20}}>Progress + blockers</h2>
      </div>

      <div className="pmb-card">
        <div className="row between" style={{marginBottom: 4}}>
          <span className="pmb-label">EPS — East elevation</span>
          <strong className="num">76 → 100%</strong>
        </div>
        <div className="pmb-progress" style={{height: 8}}>
          <div className="pmb-progress-bar" style={{width: '100%'}}/>
        </div>
        <div className="pmb-stepper-grid">
          {[25, 50, 75, 100, 'Hold', 'Done'].map((v,i) => (
            <button key={i} className="pmb-stepper" data-active={i === 3}>{typeof v === 'number' ? `${v}%` : v}</button>
          ))}
        </div>
      </div>

      <div className="pmb-card">
        <div className="row between" style={{marginBottom:6}}>
          <span className="pmb-label">Anything block the crew?</span>
          <window.SLAi.Eyebrow tone="agent">Drafted from 3 photos + voice memo</window.SLAi.Eyebrow>
        </div>
        <textarea className="pmb-textarea" rows="4"
          defaultValue="Vapor barrier delivery delayed 2 hours. Caught up before lunch. Found a soft spot near the southwest corner — need to flag for inspection before basecoat."/>
        <div className="pmb-quick-tags">
          <span className="pill" data-tone="amber" style={{fontSize: 10}}>+ delivery delay</span>
          <span className="pill" data-tone="red" style={{fontSize: 10}}>+ inspection flag</span>
          <span className="pill" data-tone="blue" style={{fontSize: 10}}>+ weather</span>
        </div>
      </div>

      <div className="pmb-card pmb-mini">
        <span className="pmb-mic">{F2Icons.clock || '🎤'}<span style={{display:'inline-block',width:8,height:8,borderRadius:9999,background:'var(--red)'}}/></span>
        <div>
          <strong style={{fontSize: 12.5}}>Or dictate it</strong>
          <div className="pmb-meta">Hands-free · 30 second cap</div>
        </div>
      </div>

      <div className="pmb-step-foot">
        <span className="pmb-step-dots"><span/><span data-active/><span/></span>
        <button className="pmb-btn" data-variant="primary" style={{fontSize: 12}}>Continue →</button>
      </div>
    </div>
  );
}

function DailyLogStep3({ data }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-greeting" style={{paddingBottom: 4}}>
        <p className="pmb-eyebrow">Daily log · step 3 of 3</p>
        <h2 style={{fontSize: 20}}>Photos + submit</h2>
      </div>

      <div className="pmb-photo-grid">
        {[1,2,3,4,5,6].map(i => (
          <div key={i} className="pmb-photo">
            <div className="pmb-photo-img" data-tone={i % 3}/>
            <span className="pmb-photo-time num">{['7:14','9:42','10:30','11:18','13:55','14:48'][i-1]}</span>
          </div>
        ))}
      </div>
      <div className="pmb-meta" style={{marginTop: 6, marginBottom: 12, paddingLeft: 14}}>6 photos auto-attached · tap to add caption</div>

      <div className="pmb-card">
        <span className="pmb-label">Sends to</span>
        <div className="pmb-recipients">
          <span className="pill" style={{fontSize: 10}}><span className="dot"/>Mike (PM)</span>
          <span className="pill" style={{fontSize: 10}}><span className="dot"/>Owner · Aspen Devs</span>
          <span className="pill" style={{fontSize: 10}}><span className="dot"/>Inspector</span>
        </div>
        <div className="pmb-divider" style={{margin: '12px 0'}}/>
        <div className="pmb-known">
          <div><span className="pmb-known-time">PDF · 1.2 MB</span><span>3 photos in body, 3 attached</span></div>
          <div><span className="pmb-known-time">Saves to</span><span>Hillcrest / Daily Logs / 04-29</span></div>
        </div>
      </div>

      <div className="pmb-step-foot">
        <span className="pmb-step-dots"><span/><span/><span data-active/></span>
        <button className="pmb-btn" data-variant="primary" style={{fontSize: 13, padding: '10px 18px'}}>Submit log</button>
      </div>
    </div>
  );
}

// ============================================================
// NOTIFICATIONS — push, SMS, banner inside app
// ============================================================
function NotificationsTab({ data }) {
  return (
    <>
      <div className="fld-callout">
        <div>
          <strong>How crew gets notified</strong>
          <p className="muted" style={{margin: '4px 0 0 0', fontSize: 12.5}}>
            Push first, SMS as fallback, in-app for confirmation. The same assignment shows up in three places, with the same actions, so workers can confirm wherever they see it first.
          </p>
        </div>
      </div>
      <div className="fld-row">
        <PStage label="Lock screen · push" sub="Lands on the lock screen — primary channel" dark>
          <PushScreen data={data}/>
        </PStage>
        <PStage label="SMS fallback" sub="If push fails or worker has notifications off" dark>
          <SmsScreen data={data}/>
        </PStage>
        <PStage label="In-app · confirmation" sub="The destination — 1-tap confirm or push back">
          <ConfirmScreen data={data}/>
        </PStage>
      </div>
    </>
  );
}

function PushScreen({ data }) {
  return (
    <div className="pmb pmb-lock">
      <div className="pmb-lock-time">
        <div className="pmb-lock-day">Monday, April 28</div>
        <div className="pmb-lock-clock num">5:42</div>
      </div>

      <div className="pmb-push">
        <div className="pmb-push-h">
          <div className="pmb-push-app"><span/></div>
          <span style={{fontSize: 11, color: 'rgba(255,255,255,.65)'}}>SITELAYER · now</span>
        </div>
        <strong style={{fontSize: 14, color: '#fff'}}>New assignment · Tue Apr 29</strong>
        <p style={{margin: '4px 0 0 0', fontSize: 13, color: 'rgba(255,255,255,.85)', lineHeight: 1.4}}>
          Caulk + flashing · Hillcrest 7:00 AM<br/>
          With Ana, Tomás · 6 hours
        </p>
        <div className="pmb-push-actions">
          <button>Confirm</button>
          <span className="pmb-push-divider"/>
          <button>Push back</button>
        </div>
      </div>

      <div className="pmb-push" style={{opacity: .6}}>
        <div className="pmb-push-h">
          <div className="pmb-push-app"><span/></div>
          <span style={{fontSize: 11, color: 'rgba(255,255,255,.65)'}}>SITELAYER · 2h ago</span>
        </div>
        <strong style={{fontSize: 13, color: '#fff'}}>Daily log submitted</strong>
        <p style={{margin: '2px 0 0 0', fontSize: 12, color: 'rgba(255,255,255,.7)'}}>Ana · Hillcrest · 8 photos</p>
      </div>

      <div className="pmb-lock-foot">
        <span className="pmb-meta">Slide up to unlock</span>
      </div>
    </div>
  );
}

function SmsScreen({ data }) {
  return (
    <div className="pmb pmb-sms">
      <div className="pmb-sms-h">
        <div className="pmb-sms-back">‹</div>
        <div className="pmb-sms-contact">
          <div className="pmb-sms-avatar"><span/></div>
          <strong style={{fontSize: 13, color: '#fff'}}>Sitelayer</strong>
          <span style={{fontSize: 10.5, color: 'rgba(255,255,255,.6)'}}>(415) 555-7104</span>
        </div>
      </div>

      <div className="pmb-sms-body">
        <div className="pmb-sms-day">Mon · 5:42 PM</div>
        <div className="pmb-sms-bubble" data-side="them">
          New assignment · Tue Apr 29<br/>
          Caulk + flashing<br/>
          Hillcrest · 7:00 AM · 6h<br/>
          With Ana &amp; Tomás
        </div>
        <div className="pmb-sms-bubble" data-side="them">
          Reply: <strong>YES</strong> to confirm, <strong>MOVE</strong> to push back, or open in app<br/>
          <span style={{color: '#3a6cb8', textDecoration: 'underline', fontSize: 12}}>sitelayer.app/a/x4f8</span>
        </div>
        <div className="pmb-sms-bubble" data-side="me">YES</div>
        <div className="pmb-sms-bubble" data-side="them">
          Confirmed for Tue 7:00 AM. Foreman notified. Reply HELP to talk to a person.
        </div>
        <div className="pmb-sms-day" style={{marginTop: 6}}>delivered</div>
      </div>

      <div className="pmb-sms-input">
        <div className="pmb-sms-field">iMessage</div>
        <div className="pmb-sms-mic">↑</div>
      </div>
    </div>
  );
}

function ConfirmScreen({ data }) {
  return (
    <div className="pmb">
      <PSB/>
      <div className="pmb-greeting" style={{paddingBottom: 4}}>
        <p className="pmb-eyebrow">Tomorrow · Tue Apr 29</p>
        <h2 style={{fontSize: 20}}>Caulk + flashing</h2>
      </div>

      <div className="pmb-card">
        <div className="pmb-known">
          <div><span className="pmb-known-time">When</span><span><strong>7:00 AM</strong> · 6 hours</span></div>
          <div><span className="pmb-known-time">Where</span><span>Hillcrest Mews</span></div>
          <div><span className="pmb-known-time">Crew</span><span>Ana · Tomás · you</span></div>
          <div><span className="pmb-known-time">Scope</span><span>South elevation, all openings</span></div>
        </div>
      </div>

      <div className="pmb-card">
        <span className="pmb-label">Notes from Ana</span>
        <p style={{margin: '6px 0 0 0', fontSize: 13, lineHeight: 1.5}}>
          "Bring the small ladder + the new caulk gun. Stone team needs the south elev. clear by 11."
        </p>
      </div>

      <div className="pmb-confirm-actions">
        <button className="pmb-btn" data-variant="primary" style={{fontSize: 14, padding: '14px'}}>
          ✓ Confirm — I'll be there
        </button>
        <button className="pmb-btn" data-variant="ghost" style={{fontSize: 13, padding: '12px'}}>
          Push back · suggest a change
        </button>
      </div>

      <div className="pmb-card pmb-bulletin" style={{marginTop: 8}}>
        <span className="pmb-meta" style={{fontSize: 11.5}}>
          Confirming sends Ana a check. Pushing back lets you suggest a new time or flag a conflict.
        </span>
      </div>

      <div className="pmb-tabbar">
        <PMTab2 label="Today" icon={F2Icons.home}/>
        <PMTab2 label="Schedule" active icon={F2Icons.cal}/>
        <PMTab2 label="Log" icon={F2Icons.receipt}/>
        <PMTab2 label="Me" icon={F2Icons.box}/>
      </div>
    </div>
  );
}

window.SLClockInTab = ClockInTab;
window.SLFailureStatesTab = FailureStatesTab;
window.SLDailyLogTab = DailyLogTab;
window.SLNotificationsTab = NotificationsTab;
