# For Claude Code: How to use this handoff

You are about to implement Sitelayer in **React 18 + TypeScript + Tailwind CSS**. This document tells you exactly how to read the bundled materials and how to translate them into production code.

---

## What's in here

```
design_handoff/
├── README.md                          ← user-facing overview
├── README-FOR-CLAUDE-CODE.md          ← THIS FILE
├── SCREEN_INDEX.md                    ← every screen, what file it's documented in
│
├── design_system/                     ← READ THIS FIRST
│   ├── README.md                      ← tokens, primitives, components, AI rules
│   ├── screenshots/                   ← system-state screens (offline, error, empty, …)
│   └── source/
│       ├── mobile-tokens.css          ← the source of truth for all tokens
│       ├── mobile-primitives.jsx      ← MTopBar, MRow, MKpi, MPill, MBanner, etc.
│       └── ai-primitives.jsx          ← Spark, AiStripe, AiAgent, attribution
│
├── estimator/                         ← Owner / PM / Estimator persona
│   ├── README.md                      ← persona, flows, all screens detailed
│   ├── screenshots/                   ← 40 screen PNGs
│   └── source/                        ← .jsx reference implementations
│
├── foreman/                           ← Field-lead persona
│   ├── README.md
│   ├── screenshots/                   ← 9 screen PNGs
│   └── source/
│
├── worker/                            ← Crew-member persona
│   ├── README.md
│   ├── screenshots/                   ← 6 screen PNGs
│   └── source/
│
└── cross_persona/                     ← Loops between personas
    └── README.md                      ← sequence diagrams, shared state
```

---

## What these design files ARE and ARE NOT

**They ARE:** high-fidelity design references showing intended look, layout, copy, interaction, and behavior. Every color, spacing value, font size, and word of copy is intentional. Reproduce them faithfully.

**They ARE NOT:** production code. The bundled `.jsx` files are hand-written prototypes — single-file React without tests, types, performance optimization, or proper data layers. Use them as **specification**, not as code to copy.

Specifically:
- The `.jsx` files use plain functions and inline styles in places. Your output should use proper TypeScript types, Tailwind classes (or your existing token system), and component composition appropriate for a real app.
- Mock data is hardcoded inside components. Replace with proper data fetching (TanStack Query, SWR, or your stack's pattern).
- All "AI" surfaces (Spark icons, stripe cards, agent drafts) are visual demos. Wire them to your actual model layer.

---

## Recommended implementation order

1. **Design system first** (`design_system/README.md`)
   - Set up Tailwind tokens to mirror the CSS variables in `mobile-tokens.css`
   - Implement the ~15 primitives (MTopBar, MRow, MKpi, MPill, MBanner, MAiStripe, etc.) — these unlock everything else
   - System states (offline, error, empty, loading, permission-denied) — wire these up early; they prevent rebuild costs later

2. **Worker app** (`worker/README.md`) — smallest persona, validates the system
   - 6 screens. Dark theme. Glove-friendly tap targets. Auto clock-in is the P0 surface.

3. **Foreman app** (`foreman/README.md`) — builds on worker
   - 7 screens. Multi-site stacked home. Field intake (the receiver for worker pings).

4. **Estimator app** (`estimator/README.md`) — the bulk of the system
   - ~40 screens covering project lifecycle, schedule, time, rentals, settings.

5. **Cross-persona loops** (`cross_persona/README.md`) — wire the personas together
   - Foreman briefs → worker scope. Worker issue → foreman field intake.

---

## Stack assumptions

| Concern | Choice | Notes |
|---|---|---|
| Framework | React 18 + TypeScript | Strict mode. Hooks-only. |
| Styling | Tailwind CSS | Translate `mobile-tokens.css` to `tailwind.config.ts`. See "Token mapping" in `design_system/README.md`. |
| Mobile shell | PWA (no native) | iOS install via Safari share sheet; Android via Chrome's native install prompt. See `estimator/screenshots/pwa-*` for the install + permission flows. |
| State | Your call | Designs assume optimistic updates for time entries and field pings. |
| Data | Your call | Designs assume a single `Project` record with state transitions (drafting → sent → accepted → in-progress → done/archived) — see `estimator/README.md` § "Project state model". |
| Routing | Your call | Bottom-tab navigation on mobile (5 slots: Home, Projects, Schedule, Rentals, More). Foreman + Worker have their own tab sets. |
| Icons | Inline SVG | All icons are in `mobile-primitives.jsx` as the `MI` object. Replace with `lucide-react` if preferred — names mostly map directly. |

---

## Type stack (typography)

The mobile design uses the **Apple system font stack**, intentionally — it's a PWA that runs alongside iMessage and Safari, and the system font feels native. Don't substitute Inter or Geist on mobile.

```css
font-family: -apple-system, "SF Pro Text", BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

The desktop product (`estimator/source/desktop-index.html`) uses **Geist** for display, system font for body.

---

## Color tokens — where they live

All colors are defined in `design_system/source/mobile-tokens.css`. Two themes:
- **Light** (`:root`) — default for estimator + foreman screens
- **Dark** (`.m-dark`) — used for worker screens, capture viewfinders, splash, and a handful of hero surfaces

There is exactly one accent color: **`--m-accent: #d9904a`** (warm orange). Don't introduce a second.

---

## Interaction patterns to internalize

These patterns repeat across every persona — implement them once, reuse everywhere.

- **List rows** (`MRow`) — leading icon (32×32, optional tone), headline + supporting, trailing meta + optional chevron. Inset list group with rounded corners + 1px dividers.
- **Banners** (`MBanner`) — 4 tones: `info`, `error`, `ok`, default-amber-warn. Always have a title + body; sometimes an action.
- **AI surfaces** — see `design_system/README.md` § "AI rules". TL;DR: never invent a metaphor, always show source attribution, always be dismissible.
- **Sheets** — bottom sheets with a 4×36 grabber, rounded top corners, slide up over a 45% black scrim.
- **Empty / loading / error states** — every list view must support all three. See `design_system/screenshots/`.

---

## Copy tone

Direct. No exclamation points. No emoji. No "Awesome!" or "Let's get started!". Dollar amounts always show currency symbol; large numbers use `tabular-nums`. Time durations use `:` separator (`4:24`, not `4h 24m`) for the running clock; `4h 24m` for elapsed/budget references.

If you find yourself writing marketing copy, stop — Sitelayer talks to people in trucks who don't have time for it.

---

## When something is ambiguous

The user (the designer) should be your source of truth for ambiguity. The bundled `.jsx` files reflect the latest intent at handoff time. If a file contradicts a README, the README wins — readme is curated, source is incidental.
