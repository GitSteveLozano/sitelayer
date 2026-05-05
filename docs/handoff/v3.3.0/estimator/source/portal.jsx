/* global React, ReactDOM, SITELAYER_DATA */
const { useState, useMemo, useEffect } = React;
const DATA = window.SITELAYER_DATA;

// ---------- helpers ----------
const fmt$ = n => '$' + Math.round(n).toLocaleString();
const fmt$k = n => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : '$' + Math.round(n);
const addDays = (mmdd, n) => {
  const [m, d] = mmdd.split('/').map(Number);
  const dt = new Date(2026, m - 1, d + n);
  return String(dt.getMonth() + 1).padStart(2, '0') + '/' + String(dt.getDate()).padStart(2, '0');
};
const todayMmdd = '04/27';

// availability: owned + drift − out − in repair
function availFor(sku) {
  const c = DATA.catalog.find(c => c.sku === sku);
  if (!c) return 0;
  const out = DATA.dispatches.filter(d => d.sku === sku && d.status !== 'returned').reduce((s, d) => s + d.qty, 0);
  const wo = DATA.workOrders.filter(w => w.sku === sku && w.status !== 'closed').reduce((s, w) => s + w.qty, 0);
  return Math.max(0, c.owned + (c.drift || 0) - out - wo);
}

// listed inventory: SKUs with idleQty>0 — what L&A has put on the marketplace
const LISTED = DATA.catalog
  .map(c => ({ ...c, available: availFor(c.sku), listRate: Math.round(c.daily * 0.85) }))
  .filter(c => c.available > 0);

// ---------- ICONS ----------
const Icon = {
  cart: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 4h2l3 12h12l3-9H6"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M4 12l5 5 11-12"/></svg>,
  search: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.5-3.5"/></svg>,
  cal: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>,
  truck: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 7h12v10H2zM14 10h5l3 4v3h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>,
  back: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 6-6 6 6 6"/></svg>,
  spark: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>,
};

// ---------- PROVIDER (mock business that owns inventory) ----------
const PROVIDER = {
  name: 'L&A Construction',
  city: 'Lakewood, CO',
  rating: 4.8,
  jobs: 142,
  badge: 'SiteLayer verified',
};

// ---------- ROOT ----------
function Portal() {
  const [route, setRoute] = useState('browse'); // browse | item | cart | schedule | confirm
  const [activeSku, setActiveSku] = useState(null);
  const [cart, setCart] = useState([]); // [{sku, qty}]
  const [start, setStart] = useState(addDays(todayMmdd, 3));
  const [end, setEnd] = useState(addDays(todayMmdd, 17));

  function addToCart(sku, qty = 1) {
    setCart(prev => {
      const i = prev.findIndex(l => l.sku === sku);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: Math.min(availFor(sku), next[i].qty + qty) };
        return next;
      }
      return [...prev, { sku, qty }];
    });
  }
  function setCartQty(sku, qty) {
    setCart(prev => prev.map(l => l.sku === sku ? { ...l, qty } : l).filter(l => l.qty > 0));
  }
  function removeFromCart(sku) {
    setCart(prev => prev.filter(l => l.sku !== sku));
  }

  const cartTotal = cart.reduce((s, l) => {
    const c = LISTED.find(x => x.sku === l.sku);
    return s + (c ? c.listRate * l.qty : 0);
  }, 0);
  const days = (() => {
    const [sm, sd] = start.split('/').map(Number);
    const [em, ed] = end.split('/').map(Number);
    return (em * 31 + ed) - (sm * 31 + sd);
  })();

  return (
    <div className="px-shell">
      <PortalNav cartCount={cart.reduce((s, l) => s + l.qty, 0)} setRoute={setRoute} route={route}/>

      {route === 'browse' && (
        <Browse onOpen={(sku) => { setActiveSku(sku); setRoute('item'); }} cart={cart} addToCart={addToCart}/>
      )}
      {route === 'item' && activeSku && (
        <ItemPage sku={activeSku} cart={cart} addToCart={addToCart} setRoute={setRoute}/>
      )}
      {route === 'cart' && (
        <Cart cart={cart} setCartQty={setCartQty} removeFromCart={removeFromCart} setRoute={setRoute}
              start={start} end={end} setStart={setStart} setEnd={setEnd} cartTotal={cartTotal} days={days}/>
      )}
      {route === 'schedule' && (
        <Schedule cart={cart} start={start} end={end} setRoute={setRoute} cartTotal={cartTotal} days={days}/>
      )}
      {route === 'confirm' && (
        <Confirm cart={cart} start={start} end={end} cartTotal={cartTotal} days={days}/>
      )}
    </div>
  );
}

// ---------- NAV ----------
function PortalNav({ cartCount, setRoute, route }) {
  return (
    <header className="px-nav">
      <div className="px-nav-inner">
        <a className="px-brand" href="#" onClick={(e) => { e.preventDefault(); setRoute('browse'); }}>
          <span className="px-mark"/>
          <div>
            <strong>L&amp;A Rentals</strong>
            <span>Powered by SiteLayer</span>
          </div>
        </a>
        <nav className="px-nav-links">
          <a className="px-link" data-active={route === 'browse'} onClick={() => setRoute('browse')}>Browse</a>
          <a className="px-link">My orders</a>
          <a className="px-link">Invoices</a>
          <a className="px-link">Help</a>
        </nav>
        <div className="px-nav-right">
          <a className="px-link" style={{display: 'flex', alignItems: 'center', gap: 6}}>
            <span className="px-avatar">JM</span>
            <span style={{fontSize: 13, fontWeight: 500}}>Mendez Builders</span>
          </a>
          <button className="px-cart-btn" onClick={() => setRoute('cart')}>
            {Icon.cart}
            {cartCount > 0 && <span className="px-cart-dot">{cartCount}</span>}
          </button>
        </div>
      </div>
    </header>
  );
}

// ---------- BROWSE ----------
function Browse({ onOpen, cart, addToCart }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const cats = ['All', 'Scaffold', 'Power', 'Lift'];
  const filtered = LISTED.filter(c =>
    (cat === 'All' || c.category === cat) &&
    (!q || (c.sku + ' ' + c.name).toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <main className="px-main">
      {/* Hero */}
      <section className="px-hero">
        <div className="px-hero-text">
          <p className="px-eyebrow">Marketplace · Lakewood + Front Range</p>
          <h1>Rent scaffold &amp; equipment from contractors near you.</h1>
          <p className="px-hero-sub">
            Inventory listed by working contractors who own and maintain it. Book a delivery window — same dispatch / return / billing as a rental yard, no membership.
          </p>
          <div className="px-hero-stats">
            <span><strong className="num">{LISTED.length}</strong> SKUs listed</span>
            <span><strong className="num">{LISTED.reduce((s, c) => s + c.available, 0)}</strong> units available</span>
            <span><strong className="num">{PROVIDER.rating}</strong>★ provider rating</span>
          </div>
        </div>
        <div className="px-hero-card">
          <div className="px-provider">
            <div className="px-provider-mark">L&amp;A</div>
            <div>
              <p className="px-eyebrow" style={{margin: 0}}>{PROVIDER.badge}</p>
              <strong style={{fontSize: 15}}>{PROVIDER.name}</strong>
              <p className="px-muted" style={{margin: '2px 0 0', fontSize: 12}}>{PROVIDER.city} · {PROVIDER.jobs} jobs · ★ {PROVIDER.rating}</p>
            </div>
          </div>
          <div className="px-provider-meta">
            <div><span className="px-muted">Free delivery</span><strong>≤ 25 mi</strong></div>
            <div><span className="px-muted">Min rental</span><strong>3 days</strong></div>
            <div><span className="px-muted">Net terms</span><strong>Net-15</strong></div>
          </div>
        </div>
      </section>

      {/* Filter bar */}
      <div className="px-filter">
        <div className="px-search">
          {Icon.search}
          <input placeholder="Search SKU, equipment name…" value={q} onChange={e => setQ(e.target.value)}/>
        </div>
        <div className="px-cats">
          {cats.map(c => (
            <button key={c} className="px-cat" data-active={cat === c} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
      </div>

      {/* Catalog grid */}
      <div className="px-grid">
        {filtered.map(c => {
          const inCart = cart.find(l => l.sku === c.sku);
          return (
            <article key={c.sku} className="px-card" onClick={() => onOpen(c.sku)}>
              <div className="px-card-img" data-cat={c.category}>
                <CategoryGlyph cat={c.category}/>
                <span className="px-avail">{c.available} avail</span>
              </div>
              <div className="px-card-body">
                <div className="px-card-h">
                  <div>
                    <strong>{c.name}</strong>
                    <span className="mono px-muted" style={{fontSize: 11}}>{c.sku}</span>
                  </div>
                  <span className="px-cat-pill">{c.category}</span>
                </div>
                <div className="px-card-foot">
                  <div>
                    <span className="num px-rate">{fmt$(c.listRate)}</span>
                    <span className="px-muted" style={{fontSize: 12}}>/day</span>
                    <span className="px-strike num">{fmt$(c.daily)}</span>
                  </div>
                  <button className="px-btn" data-variant={inCart ? 'soft' : 'primary'}
                          onClick={(e) => { e.stopPropagation(); addToCart(c.sku); }}>
                    {inCart ? <>{Icon.check} Added · {inCart.qty}</> : <>+ Add</>}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}

function CategoryGlyph({ cat }) {
  if (cat === 'Scaffold') {
    return (
      <svg viewBox="0 0 100 80" width="100%" height="100%" style={{padding: 14}}>
        <g stroke="currentColor" strokeWidth="2" fill="none">
          <rect x="20" y="14" width="60" height="56"/>
          <line x1="20" y1="32" x2="80" y2="32"/>
          <line x1="20" y1="50" x2="80" y2="50"/>
          <line x1="35" y1="14" x2="35" y2="70"/>
          <line x1="50" y1="14" x2="50" y2="70"/>
          <line x1="65" y1="14" x2="65" y2="70"/>
          {/* X-bracing on top section */}
          <line x1="20" y1="14" x2="35" y2="32"/>
          <line x1="35" y1="14" x2="20" y2="32"/>
          <line x1="65" y1="50" x2="80" y2="68"/>
          <line x1="80" y1="50" x2="65" y2="68"/>
        </g>
      </svg>
    );
  }
  if (cat === 'Power') {
    return (
      <svg viewBox="0 0 100 80" width="100%" height="100%" style={{padding: 14}}>
        <g stroke="currentColor" strokeWidth="2" fill="none">
          <rect x="22" y="22" width="56" height="36" rx="4"/>
          <circle cx="34" cy="40" r="8"/>
          <circle cx="34" cy="40" r="3" fill="currentColor"/>
          <rect x="48" y="30" width="22" height="6"/>
          <rect x="48" y="40" width="22" height="6"/>
          <line x1="40" y1="58" x2="40" y2="68"/>
          <line x1="60" y1="58" x2="60" y2="68"/>
          <line x1="32" y1="68" x2="68" y2="68"/>
        </g>
      </svg>
    );
  }
  // Lift
  return (
    <svg viewBox="0 0 100 80" width="100%" height="100%" style={{padding: 14}}>
      <g stroke="currentColor" strokeWidth="2" fill="none">
        <rect x="20" y="60" width="60" height="12" rx="2"/>
        <circle cx="32" cy="72" r="3"/>
        <circle cx="68" cy="72" r="3"/>
        <rect x="34" y="14" width="32" height="14"/>
        <line x1="38" y1="28" x2="42" y2="60"/>
        <line x1="62" y1="28" x2="58" y2="60"/>
        <line x1="38" y1="36" x2="62" y2="44"/>
        <line x1="38" y1="44" x2="62" y2="36"/>
        <line x1="38" y1="52" x2="62" y2="52"/>
      </g>
    </svg>
  );
}

// ---------- ITEM PAGE ----------
function ItemPage({ sku, cart, addToCart, setRoute }) {
  const c = LISTED.find(x => x.sku === sku);
  const [qty, setQty] = useState(1);
  if (!c) return null;
  const inCart = cart.find(l => l.sku === sku);

  return (
    <main className="px-main">
      <button className="px-back" onClick={() => setRoute('browse')}>{Icon.back} Back to browse</button>
      <div className="px-item">
        <div className="px-item-img" data-cat={c.category}>
          <CategoryGlyph cat={c.category}/>
        </div>
        <div className="px-item-body">
          <span className="px-cat-pill" style={{alignSelf: 'flex-start'}}>{c.category}</span>
          <h1 style={{margin: '8px 0 4px'}}>{c.name}</h1>
          <p className="mono px-muted" style={{margin: 0}}>{c.sku} · {c.available} units available</p>

          <div className="px-rate-row">
            <span className="num px-rate-big">{fmt$(c.listRate)}</span>
            <span className="px-muted">per day</span>
            <span className="px-strike num">{fmt$(c.daily)} list</span>
            <span className="px-savings">SiteLayer marketplace · 15% off</span>
          </div>

          <div className="px-spec">
            <div><span className="px-muted">Replacement</span><strong className="num">{fmt$k(c.replacement)}</strong></div>
            <div><span className="px-muted">Delivery</span><strong>$0 ≤ 25 mi</strong></div>
            <div><span className="px-muted">Min rental</span><strong>3 days</strong></div>
            <div><span className="px-muted">Last serviced</span><strong className="num">{c.lastCount}</strong></div>
          </div>

          <div className="px-qty-row">
            <div className="px-qty">
              <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
              <span className="num">{qty}</span>
              <button onClick={() => setQty(Math.min(c.available, qty + 1))}>+</button>
            </div>
            <button className="px-btn px-btn-lg" data-variant="primary" onClick={() => { addToCart(sku, qty); setRoute('browse'); }}>
              Add {qty} to cart · {fmt$(c.listRate * qty)}/day
            </button>
            {inCart && <span className="px-muted" style={{fontSize: 12}}>{inCart.qty} already in cart</span>}
          </div>

          <div className="px-included">
            <strong style={{fontSize: 13, marginBottom: 6, display: 'block'}}>Included</strong>
            <ul>
              <li>{Icon.check} Pre-rental inspection &amp; condition photos</li>
              <li>{Icon.check} Delivery within 25 mi · scheduled window</li>
              <li>{Icon.check} 24-hr swap on damaged or DOA items</li>
              <li>{Icon.check} Invoice via SiteLayer · syncs to your QuickBooks</li>
            </ul>
          </div>
        </div>
      </div>
    </main>
  );
}

// ---------- CART + SCHEDULE ----------
function Cart({ cart, setCartQty, removeFromCart, setRoute, start, end, setStart, setEnd, cartTotal, days }) {
  if (cart.length === 0) {
    return (
      <main className="px-main">
        <div className="px-empty">
          <h2>Your cart is empty.</h2>
          <p className="px-muted">Add items from the marketplace to get started.</p>
          <button className="px-btn" data-variant="primary" onClick={() => setRoute('browse')}>Browse equipment</button>
        </div>
      </main>
    );
  }
  return (
    <main className="px-main">
      <button className="px-back" onClick={() => setRoute('browse')}>{Icon.back} Continue browsing</button>
      <h1 style={{margin: '14px 0 18px'}}>Review &amp; schedule</h1>

      <div className="px-cart-grid">
        <div>
          <div className="px-cart-list">
            {cart.map(l => {
              const c = LISTED.find(x => x.sku === l.sku);
              return (
                <div key={l.sku} className="px-cart-row">
                  <div className="px-cart-img" data-cat={c.category}><CategoryGlyph cat={c.category}/></div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <strong>{c.name}</strong>
                    <p className="mono px-muted" style={{margin: '2px 0', fontSize: 11}}>{c.sku}</p>
                    <span className="num" style={{fontSize: 13, fontWeight: 600}}>{fmt$(c.listRate)}<span className="px-muted">/day</span></span>
                    <span className="px-muted" style={{fontSize: 12, marginLeft: 8}}>· {c.available} avail</span>
                  </div>
                  <div className="px-qty">
                    <button onClick={() => setCartQty(l.sku, Math.max(0, l.qty - 1))}>−</button>
                    <span className="num">{l.qty}</span>
                    <button onClick={() => setCartQty(l.sku, Math.min(c.available, l.qty + 1))}>+</button>
                  </div>
                  <div style={{textAlign: 'right', minWidth: 100}}>
                    <span className="num" style={{fontWeight: 600}}>{fmt$(c.listRate * l.qty)}</span>
                    <span className="px-muted" style={{fontSize: 11}}>/day line</span>
                    <button className="px-link" style={{display: 'block', marginTop: 4, fontSize: 11}} onClick={() => removeFromCart(l.sku)}>Remove</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="px-window">
            <div className="px-window-h">
              {Icon.cal}
              <div>
                <strong>Rental window</strong>
                <p className="px-muted" style={{margin: '2px 0 0', fontSize: 12}}>Pick start and end. We'll confirm a delivery window within 24 hours.</p>
              </div>
            </div>
            <div className="px-window-grid">
              <label>
                <span className="px-muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>Start</span>
                <input value={start} onChange={e => setStart(e.target.value)} placeholder="MM/DD"/>
              </label>
              <label>
                <span className="px-muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>End</span>
                <input value={end} onChange={e => setEnd(e.target.value)} placeholder="MM/DD"/>
              </label>
              <div className="px-window-out">
                <span className="px-muted" style={{fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em'}}>Duration</span>
                <strong className="num">{days} days</strong>
              </div>
            </div>
            <DateStrip start={start} end={end}/>
          </div>
        </div>

        <aside className="px-summary">
          <h3 style={{margin: '0 0 12px', fontSize: 14}}>Order summary</h3>
          <div className="px-sum-row"><span>Daily total</span><span className="num">{fmt$(cartTotal)}</span></div>
          <div className="px-sum-row"><span>× {days} days</span><span className="num">{fmt$(cartTotal * days)}</span></div>
          <div className="px-sum-row"><span>Delivery</span><span className="num" style={{color: 'var(--green)'}}>Free</span></div>
          <div className="px-sum-row"><span>Damage waiver (8%)</span><span className="num">{fmt$(cartTotal * days * 0.08)}</span></div>
          <hr style={{border: 'none', borderTop: '1px solid var(--line)', margin: '12px 0'}}/>
          <div className="px-sum-row" style={{fontSize: 17, fontWeight: 600}}>
            <span>Estimated total</span>
            <span className="num">{fmt$(cartTotal * days * 1.08)}</span>
          </div>
          <p className="px-muted" style={{fontSize: 11, margin: '10px 0 14px'}}>Net-15 terms · billed at cycle close · cancel free up to 24 hr before delivery.</p>
          <button className="px-btn px-btn-lg" data-variant="primary" style={{width: '100%'}} onClick={() => setRoute('schedule')}>
            Continue to delivery →
          </button>
        </aside>
      </div>
    </main>
  );
}

function DateStrip({ start, end }) {
  const days = (() => {
    const out = [];
    const [sm, sd] = start.split('/').map(Number);
    const [em, ed] = end.split('/').map(Number);
    const startDay = new Date(2026, sm - 1, sd);
    const endDay = new Date(2026, em - 1, ed);
    // Show 3 days before to 3 after
    for (let i = -3; i <= 0; i++) {
      const d = new Date(2026, sm - 1, sd + i);
      out.push({ d, kind: 'before' });
    }
    let cursor = new Date(startDay);
    while (cursor <= endDay) {
      out.push({ d: new Date(cursor), kind: 'window' });
      cursor.setDate(cursor.getDate() + 1);
    }
    for (let i = 1; i <= 3; i++) {
      const d = new Date(endDay);
      d.setDate(d.getDate() + i);
      out.push({ d, kind: 'after' });
    }
    return out;
  })();
  return (
    <div className="px-strip">
      {days.map((x, i) => (
        <div key={i} className="px-strip-day" data-kind={x.kind} data-edge={x.kind === 'window' && (i === days.findIndex(y => y.kind === 'window') || i === days.length - 1 - [...days].reverse().findIndex(y => y.kind === 'window')) ? 'true' : undefined}>
          <span className="px-strip-dow">{['S','M','T','W','T','F','S'][x.d.getDay()]}</span>
          <span className="num px-strip-num">{x.d.getDate()}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- SCHEDULE ----------
function Schedule({ cart, start, end, setRoute, cartTotal, days }) {
  const [delivery, setDelivery] = useState('mon-am');
  const [pickup, setPickup] = useState('end-am');
  const [addr, setAddr] = useState('1840 Wadsworth Blvd, Lakewood CO 80214');
  const [job, setJob] = useState('Riverbend — Phase 2');
  const [contact, setContact] = useState('Jorge Mendez · 720-555-0184');
  const [notes, setNotes] = useState('Site access via west gate. Foreman on site after 7am.');

  const deliveryWindows = [
    { id: 'mon-am', label: 'Mon Apr 30', sub: '7–10am', date: start, slot: '7–10am' },
    { id: 'mon-pm', label: 'Mon Apr 30', sub: '12–3pm', date: start, slot: '12–3pm' },
    { id: 'tue-am', label: 'Tue May 1',  sub: '7–10am', date: addDays(start, 1), slot: '7–10am' },
    { id: 'tue-pm', label: 'Tue May 1',  sub: '12–3pm', date: addDays(start, 1), slot: '12–3pm' },
  ];
  const pickupWindows = [
    { id: 'end-am', label: end, sub: '7–10am' },
    { id: 'end-pm', label: end, sub: '12–3pm' },
    { id: 'after-am', label: addDays(end, 1), sub: '7–10am' },
  ];

  return (
    <main className="px-main">
      <button className="px-back" onClick={() => setRoute('cart')}>{Icon.back} Back to cart</button>
      <h1 style={{margin: '14px 0 6px'}}>Delivery &amp; pickup</h1>
      <p className="px-muted" style={{margin: '0 0 22px'}}>Pick a delivery window. L&amp;A confirms within 2 hours and you'll get a text when the driver leaves the yard.</p>

      <div className="px-sched-grid">
        <div>
          <section className="px-block">
            <h3 className="px-block-h">Job site</h3>
            <label className="px-field">
              <span>Address</span>
              <input value={addr} onChange={e => setAddr(e.target.value)}/>
            </label>
            <label className="px-field">
              <span>Job name</span>
              <input value={job} onChange={e => setJob(e.target.value)}/>
            </label>
            <label className="px-field">
              <span>On-site contact</span>
              <input value={contact} onChange={e => setContact(e.target.value)}/>
            </label>
            <label className="px-field">
              <span>Site notes (gate codes, access)</span>
              <textarea rows="2" value={notes} onChange={e => setNotes(e.target.value)}/>
            </label>
          </section>

          <section className="px-block">
            <h3 className="px-block-h">Delivery window</h3>
            <div className="px-slots">
              {deliveryWindows.map(w => (
                <button key={w.id} className="px-slot" data-active={delivery === w.id} onClick={() => setDelivery(w.id)}>
                  <strong>{w.label}</strong>
                  <span>{w.sub}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="px-block">
            <h3 className="px-block-h">Pickup window</h3>
            <div className="px-slots">
              {pickupWindows.map(w => (
                <button key={w.id} className="px-slot" data-active={pickup === w.id} onClick={() => setPickup(w.id)}>
                  <strong>{w.label}</strong>
                  <span>{w.sub}</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <aside className="px-summary">
          <h3 style={{margin: '0 0 12px', fontSize: 14}}>Booking summary</h3>
          <div className="px-sum-row"><span>{cart.length} items</span><span className="num">{cart.reduce((s,l)=>s+l.qty,0)} units</span></div>
          <div className="px-sum-row"><span>Window</span><span>{start} → {end}</span></div>
          <div className="px-sum-row"><span>Daily</span><span className="num">{fmt$(cartTotal)}</span></div>
          <div className="px-sum-row"><span>Days</span><span className="num">{days}</span></div>
          <hr style={{border: 'none', borderTop: '1px solid var(--line)', margin: '10px 0'}}/>
          <div className="px-sum-row" style={{fontSize: 17, fontWeight: 600}}>
            <span>Estimated</span>
            <span className="num">{fmt$(cartTotal * days * 1.08)}</span>
          </div>
          <p className="px-muted" style={{fontSize: 11, margin: '10px 0 14px'}}>Net-15 · final billed at cycle close · L&amp;A confirms in &lt;2 hr.</p>
          <button className="px-btn px-btn-lg" data-variant="primary" style={{width: '100%'}} onClick={() => setRoute('confirm')}>
            Confirm booking
          </button>
        </aside>
      </div>
    </main>
  );
}

// ---------- CONFIRM ----------
function Confirm({ cart, start, end, cartTotal, days }) {
  const orderId = 'BK-' + Math.floor(Math.random() * 9000 + 1000);

  return (
    <main className="px-main">
      <div className="px-confirm">
        <div className="px-confirm-icon">{Icon.check}</div>
        <p className="px-eyebrow">Booking received · {orderId}</p>
        <h1 style={{margin: '8px 0 6px'}}>You're booked.</h1>
        <p className="px-muted" style={{maxWidth: 500, margin: '0 auto 22px'}}>
          L&amp;A is reviewing your request and will confirm the delivery window within 2 hours.
          You'll get a text at the contact on file.
        </p>

        <div className="px-confirm-card">
          <div className="px-confirm-row">
            <span className="px-muted">Window</span>
            <strong className="num">{start} → {end} <span className="px-muted">· {days}d</span></strong>
          </div>
          <div className="px-confirm-row">
            <span className="px-muted">Items</span>
            <strong>{cart.reduce((s,l)=>s+l.qty,0)} units · {cart.length} SKUs</strong>
          </div>
          <div className="px-confirm-row">
            <span className="px-muted">Estimated total</span>
            <strong className="num">{fmt$(cartTotal * days * 1.08)}</strong>
          </div>
          <div className="px-confirm-row">
            <span className="px-muted">Provider</span>
            <strong>L&amp;A Construction · ★ 4.8</strong>
          </div>
        </div>

        <div className="px-confirm-steps">
          <div className="px-step" data-on>
            <span className="px-step-dot">{Icon.check}</span>
            <strong>Booking received</strong>
            <span className="px-muted">Just now</span>
          </div>
          <div className="px-step">
            <span className="px-step-dot">2</span>
            <strong>L&amp;A confirms</strong>
            <span className="px-muted">≤ 2 hours</span>
          </div>
          <div className="px-step">
            <span className="px-step-dot">3</span>
            <strong>Delivery</strong>
            <span className="px-muted">{start}</span>
          </div>
          <div className="px-step">
            <span className="px-step-dot">4</span>
            <strong>Pickup &amp; invoice</strong>
            <span className="px-muted">{end}</span>
          </div>
        </div>

        <div className="row" style={{justifyContent: 'center', gap: 8, marginTop: 18}}>
          <button className="px-btn">View order</button>
          <button className="px-btn" data-variant="primary">Add to calendar</button>
        </div>
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Portal/>);
