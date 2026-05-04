# Design System

Everything in this folder is shared by all three personas. Read this **before** any persona README — every screen is built on these tokens and primitives.

---

## Files

| File | Purpose |
|---|---|
| [`source/mobile-tokens.css`](./source/mobile-tokens.css) | All design tokens (colors, radii, shadows, type, spacing) + CSS classes for primitives. **Source of truth.** |
| [`source/mobile-primitives.jsx`](./source/mobile-primitives.jsx) | React components: `MTopBar`, `MLargeHead`, `MSectionH`, `MRow`, `MKpi`, `MPill`, `MBottomTabs`, `MQA`, `MAvatarGroup`, `MBanner`, plus the `MI` icon set. |
| [`source/ai-primitives.jsx`](./source/ai-primitives.jsx) | AI surface atoms: `Spark`, `Attribution`, `AiStripe`, `AiAgent`, `AiEyebrow`. |
| [`screenshots/`](./screenshots/) | The 5 system states: offline, error, empty, loading, permission-denied. |

---

## Color tokens

Light theme (`:root`):

| Token | Value | Used for |
|---|---|---|
| `--m-sand` | `#f5f1ec` | App backgrounds in some sections |
| `--m-sand-2` | `#ebe6df` | Slightly darker sand for inset surfaces |
| `--m-bg` | `#ffffff` | Default page background |
| `--m-card` | `#ffffff` | Card surfaces |
| `--m-card-soft` | `#f7f4ef` | Quiet card variant; quick-action buttons; pill backgrounds |
| `--m-line` | `#e8e3db` | Hairline dividers, card borders |
| `--m-line-2` | `#d8d2c7` | Stronger borders (inputs, outlined buttons) |
| `--m-ink` | `#1c1816` | Primary text |
| `--m-ink-2` | `#5b544c` | Secondary text |
| `--m-ink-3` | `#8a8278` | Tertiary text, eyebrows, supporting copy |
| `--m-ink-4` | `#aea69a` | Quaternary — chevrons, disabled |
| `--m-accent` | `#d9904a` | **The one accent.** Brand orange. CTAs, active states, AI accent. |
| `--m-accent-ink` | `#b46e2c` | Darker variant for text on accent-soft backgrounds |
| `--m-accent-soft` | `rgba(217,144,74,0.10)` | Accent-tinted backgrounds |
| `--m-green` | `#2c8a55` | Success, confirmed, on-time |
| `--m-red` | `#c0463d` | Errors, destructive actions, blockers |
| `--m-amber` | `#c98a2e` | Warnings, "needs review" |
| `--m-blue` | `#2f6fb5` | Info, links in some contexts |

Dark theme (`.m-dark`) — used by Worker screens, splash, and capture viewfinders:

| Token | Value |
|---|---|
| `--m-bg` | `#0e0c0a` |
| `--m-card` | `#18140f` |
| `--m-card-soft` | `#1f1a13` |
| `--m-line` | `#2a241c` |
| `--m-line-2` | `#3a3329` |
| `--m-ink` | `#f3ecdf` |
| `--m-ink-2` | `#c0b8a8` |
| `--m-ink-3` | `#8e8676` |
| `--m-ink-4` | `#5a5346` |

The accent (`--m-accent: #d9904a`) is the same in both themes.

---

## Tailwind translation

```ts
// tailwind.config.ts
extend: {
  colors: {
    sand:      { DEFAULT: '#f5f1ec', 2: '#ebe6df' },
    card:      { DEFAULT: '#ffffff', soft: '#f7f4ef' },
    line:      { DEFAULT: '#e8e3db', 2: '#d8d2c7' },
    ink:       { DEFAULT: '#1c1816', 2: '#5b544c', 3: '#8a8278', 4: '#aea69a' },
    accent:    { DEFAULT: '#d9904a', ink: '#b46e2c' },
    success:   '#2c8a55',
    danger:    '#c0463d',
    warning:   '#c98a2e',
    info:      '#2f6fb5',
  },
  borderRadius: {
    sm:  '8px',
    DEFAULT: '12px',
    lg: '18px',
    xl: '24px',
  },
  fontFamily: {
    sans: ['-apple-system', 'SF Pro Text', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
    display: ['-apple-system', 'SF Pro Display', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
    mono: ['ui-monospace', 'SF Mono', 'JetBrains Mono', 'Menlo', 'monospace'],
  },
  fontFeatureSettings: {
    tabular: '"tnum"',
  },
},
```

For dark mode, pair `dark:` with the dark token equivalents (or use a CSS variable strategy — both work).

---

## Spacing & radius

- **4px grid** throughout. All paddings and gaps are multiples of 4.
- **Border radius scale:** `8px` (small chips), `12px` (cards, inputs — default), `18px` (sheets), `24px` (bottom-sheet top corners).
- **Cards:** `padding: 14px 16px`, `border: 1px solid var(--m-line)`, `border-radius: 12px`. Don't use shadows on light theme cards — use the hairline border only.

---

## Typography scale

| Class | Size | Weight | Line height | Letter spacing | Used for |
|---|---|---|---|---|---|
| `m-h-display` | 30px | 700 | 1.05 | -0.02em | Large titles (Today, project name) |
| `m-h1` (in topbar) | 17px | 600 | 1.2 | -0.01em | Top-bar titles |
| `m-sheet-title` | 18px | 600 | — | -0.01em | Bottom-sheet titles |
| Body | 15px | 400 | 1.4 | — | Default |
| `m-l-headline` | 15px | 500 | — | — | List row primary text |
| `m-kpi-val` | 24px | 600 | 1 | -0.02em | KPI numbers |
| `m-l-supporting` | 12px | 400 | — | — | List row secondary |
| `m-section-h` | 11px | 600 | — | 0.06em (uppercase) | Section eyebrows |
| `m-pill` | 11px | 500 | — | — | Pills/badges |

All numeric values use `font-feature-settings: "tnum"` — apply a `.num` class or wrap in a `<span>` with that class.

---

## Primitives

Each primitive is a React component in `mobile-primitives.jsx`. Their CSS classes are in `mobile-tokens.css`. Reproduce them as proper TypeScript components.

### MTopBar
```
<MTopBar
  back?         /* show back chevron */
  title         /* required */
  sub?          /* small secondary line under title */
  eyebrow?      /* uppercase 10px label above title */
  action?       /* aria-label string */
  actionIcon?   /* icon node */
  onBack?       /* () => void */
  onAction?     /* () => void */
/>
```
52px min-height, 1px bottom border. Back button is 36×36 circular hit target.

### MLargeHead
iOS-style large title. Used as the hero on most home/list screens. 30px display weight 700, optional 14px subtitle. Optional `right` slot for an avatar or button.

### MSectionH
Section eyebrow with optional `link` action on the right. 11px uppercase 0.06em letter-spacing.

### MRow
The workhorse list row. Leading icon (32×32 with tone variants), headline + supporting, trailing slot for meta/badge, optional chevron.

```
<MRow
  leading={icon}
  leadingTone="accent" | "green" | "red" | "amber" | "blue" | undefined
  headline="..."
  supporting="..."
  trailing={node}
  badge={node}
  chev={true}
/>
```

Wrap multiple rows in `.m-list-inset` for a rounded card group, or `.m-list-plain` for full-bleed.

### MKpi
Tile in a KPI strip. Eyebrow (10px uppercase) + value (24px tabular) + optional unit + optional meta line with tone.

```
<MKpi label="LIVE" value="$1,232" meta="22.7 crew-hrs" />
```

### MPill
Inline status badge. 11px, optional tones (`accent`, `green`, `red`, `amber`, `blue`), optional dot.

### MBottomTabs
The 5-tab bottom bar. Icons 22×22, 10px label, accent for active. Tabs adapt per persona — see persona READMEs for the actual sets.

### MBanner
Inline alert. 4 tones (`info`, `error`, `ok`, default-amber). Title + body + optional action slot.

### MAvatarGroup
Stacked avatars with -8px overlap. Up to `max`, then a `+N` overflow chip.

### MQA
Quick-action button — used in 4-up grids. 36×36 icon tile + 11px label below.

---

## AI surface rules

The AI layer has its own rules — see `source/ai-primitives.jsx` for the components. The principles:

1. **One icon: the Spark.** Never use sparkles, magic wands, lightning, or robots. The 5-pointed spark in `MI.spark` is the only AI marker.
2. **Confidence is ordinal, not numeric.** No "87% confident". Use Spark intensity (`dim` / `muted` / `accent` / `strong`) or copy ("Likely…", "Worth checking…").
3. **Always cite the source.** Every AI suggestion shows attribution: "Based on **7 closed jobs**." Build trust by showing the data moat.
4. **Always dismissible.** Every `MAiStripe` carries a close button. AI is offered, never imposed.
5. **Three layers, three containers:**
   - **Eyebrow** (`MAiEyebrow`) — inline mention inside an existing card. The lightest touch.
   - **Stripe** (`MAiStripe`) — accented left-border card. The standard intelligence surface.
   - **Agent** (`MAiAgent`) — dashed border + soft tint. Reserved for autonomous multi-step output that needs explicit human approval. Always labeled "Agent draft · review before sending".
6. **Calm by default.** The dashboard does not surface AI when nothing is wrong. See the `db-calm-default` screen.

---

## System states

Every list, every detail, every async operation must have all of these states wired:

| State | Screen | Notes |
|---|---|---|
| Offline | `screenshots/st-offline.png` | Show a header banner + queued count. Mutations enqueue to local storage; sync when online. |
| Error | `screenshots/st-error.png` | Specific to the integration that failed (e.g., "QuickBooks lost auth"). Retry CTA + "Reconnect" link. |
| Empty | `screenshots/st-empty.png` | First-run state. One CTA, no decorative illustrations beyond the existing iconography. |
| Loading | `screenshots/st-loading.png` | Skeleton that matches the **real** layout. No spinners on list views. |
| Permission denied | `screenshots/st-perm.png` | Used when location/notifications are blocked. Explains *why* we need it, then deep-links to Settings. |

---

## What we don't have

These are intentional gaps the user wants left to your judgment in implementation:

- **Form validation patterns** — designs show happy paths. Use your stack's standard validation; show inline 12px red text below fields.
- **Toast / snackbar** — designs use banners (in-flow) and sheets (modal). If you need a transient confirm, use the bottom-of-screen toast pattern from your stack.
- **Confirmation dialogs** — only "Delete" needs a confirm. Everything else uses optimistic update + an Undo banner for 5 seconds.
