# Sitelayer — Design Handoff

A complete design specification for **Sitelayer**, a financial-operations app for small-to-mid construction shops. Built for **3 personas** (Estimator/Owner, Foreman, Worker) on **2 form factors** (desktop + mobile PWA).

This bundle is everything needed to implement the product faithfully in production code.

---

## Start here

| Audience | Read this first |
|---|---|
| **Engineering / Claude Code** | [`README-FOR-CLAUDE-CODE.md`](./README-FOR-CLAUDE-CODE.md) — stack assumptions, recommended order, copy tone, what these files are and aren't |
| **Anyone touching pixels** | [`design_system/README.md`](./design_system/README.md) — tokens, primitives, AI rules |
| **Product / new contributors** | The persona READMEs in order: worker → foreman → estimator |

---

## Folder map

```
design_handoff/
│
├── README.md                          ← you are here
├── README-FOR-CLAUDE-CODE.md          ← developer orientation
├── SCREEN_INDEX.md                    ← every screen, where it's documented
│
├── design_system/
│   ├── README.md                      ← tokens, primitives, AI rules
│   ├── screenshots/                   ← system states (offline, error, empty, …)
│   └── source/                        ← .css + .jsx source of truth
│
├── worker/                            ← Crew member (mobile, dark theme)
│   ├── README.md
│   ├── screenshots/                   ← 6 screens
│   └── source/
│
├── foreman/                           ← Site lead (mobile, light theme)
│   ├── README.md
│   ├── screenshots/                   ← 7 screens
│   └── source/
│
├── estimator/                         ← Owner / PM / Estimator (desktop + mobile)
│   ├── README.md
│   ├── screenshots/                   ← ~25 desktop screens
│   ├── mobile-screens.md              ← mobile companion subset
│   └── source/
│
└── cross_persona/
    └── README.md                      ← how the personas talk to each other
```

---

## What's in each persona README

Every persona doc follows the same structure:

1. **Who they are** — the human, their context, when they open the app
2. **Form factor** — device, theme, density expectations
3. **Tab structure** — the persistent navigation
4. **Flows** — 2-4 ASCII flow diagrams of the critical paths
5. **Screens** — every screen, with screenshot inline + layout breakdown + interactions + edge cases + copy notes
6. **State** — what the app reads and what it writes (with notes on cross-persona effects)
7. **Non-goals** — what NOT to build for this persona

---

## The three personas at a glance

|  | Worker | Foreman | Estimator |
|---|---|---|---|
| **Device** | Mobile only | Mobile primary, tablet OK | Desktop primary, mobile companion |
| **Theme** | Dark | Light | Light |
| **Tab count** | 4 | 5 | Sidebar (8 sections) |
| **Screen count** | 6 | 7 | ~40 (desktop) + ~12 (mobile) |
| **Writes that matter** | Time entries, field events, photos | Briefs, hours approval, daily logs | Estimates, projects, schedule, invoices |
| **Reads from other personas** | Briefs (foreman) | Estimates (estimator), field events (workers) | Daily logs (foreman), approved hours |
| **Approves** | Nothing | Hours, blockers | Final payroll batch, change orders |

---

## Design principles (one page)

1. **Calm by default.** Don't manufacture urgency. The dashboard is quiet when nothing's wrong.
2. **One accent color.** Warm orange `#d9904a`. Don't introduce a second.
3. **AI is offered, never imposed.** Always dismissible, always cites sources, never uses confidence percentages.
4. **Worker invisibility.** A worker should think about the app as little as possible. Auto clock-in is the proof.
5. **Foreman is the filter.** Workers don't ping the office; they ping the foreman. The foreman triages.
6. **Field-friendly first.** Glove-friendly tap targets. Big numbers. Short copy. No exclamation points. No emoji.
7. **System fonts on mobile.** It's a PWA — Apple system font on iOS, Roboto on Android. Native feel matters.
8. **Tabular numbers everywhere.** Money, hours, percentages. Use `font-feature-settings: "tnum"`.
9. **No filler content.** If a section feels empty, that's a layout problem to solve, not a content gap to fill.
10. **The data is the moat.** Show the source of every AI suggestion. "Based on 7 closed jobs" is more persuasive than confidence scores.

---

## Implementation summary

If you only read one paragraph: implement the design system primitives first, build the worker app to validate them, then layer foreman on top, then build estimator. Use Tailwind tokens that mirror `mobile-tokens.css`. Keep the AI surface minimal until real data exists. Wire offline support into the mobile mutation paths from day one — workers lose connectivity constantly.

---

## Out of scope (not in this bundle)

These are deliberately not specified:
- Backend API contract (the data model is implied by the writes documented per persona)
- Authentication flow (signed-link client portal aside, login is your stack's standard)
- Native iOS/Android apps (PWA only — see `estimator/screenshots/pwa-*`)
- Marketing site
- Admin / superuser tooling
- Data migration tooling
- Test plans

Everything else — every screen, every state, every interaction the user touches — is in this bundle.
