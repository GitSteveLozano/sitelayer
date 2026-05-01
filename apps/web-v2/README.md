# `@sitelayer/web-v2` — Phase 0 substrate

The next-generation Sitelayer web client. Mobile-first PWA, role-aware,
AI-Layer-ready. Lives alongside `apps/web/` until Phase 5 cutover.

See `docs/adr/0002-web-v2-rebuild.md` for the rebuild rationale and
phasing.

## Status

**Phase 0 — substrate only.** No feature work. The shell boots, the
five tabs route, the AI primitives are locked, and the PWA installs.
Every screen is a placeholder pointing at its design ID in
`Mobile.html`.

## Dev

```sh
# from repo root
npm install                          # installs the web-v2 workspace
npm run dev:web-v2                   # vite dev on :3100
```

`apps/web/` (v1) continues on :3000 — the two are independent.

### Required env

Configured in the repo's root `.env*` (see `envDir` in `vite.config.ts`).
All optional in Phase 0 — the shell boots without any of them.

| Var                          | When needed                          |
| ---------------------------- | ------------------------------------ |
| `VITE_CLERK_PUBLISHABLE_KEY` | When you want auth flows wired       |
| `VITE_SENTRY_DSN`            | Production / preview error reporting |
| `VITE_SENTRY_ENVIRONMENT`    | Tier label in Sentry                 |
| `VITE_SENTRY_RELEASE`        | Set by deploy workflow               |

### Persona preview

The Home and Time tabs render different content per persona. Until
Clerk org membership is wired (Phase 1), flip personas in dev with:

```js
// in the browser console
localStorage.setItem('sitelayer.v2.role-override', 'foreman')
```

Values: `owner`, `foreman`, `worker`. Remove the key to fall back to
the Clerk membership (or default `worker`).

## Layout

```
apps/web-v2/
├── public/icons/            PWA icons (svg)
├── src/
│   ├── App.tsx              Provider stack + router
│   ├── main.tsx             Bootstrap (Sentry first, SW register)
│   ├── instrument.ts        Sentry init
│   ├── styles/
│   │   ├── tokens.css       Design tokens (canonical)
│   │   └── globals.css      Tailwind directives + base
│   ├── components/
│   │   ├── ai/              AI Layer primitives (locked)
│   │   ├── nav/             BottomTabBar, DesktopSideRail, tabs registry
│   │   └── shell/           AppShell, PlaceholderScreen
│   ├── routes/              One file per top-level tab
│   ├── lib/
│   │   ├── auth.tsx         Clerk wiring
│   │   ├── role.ts          useRole() — owner / foreman / worker
│   │   ├── permissions.ts   Geolocation + Notification permission hooks
│   │   ├── cn.ts            Tailwind class merge
│   │   └── (future) sentry.ts (lazy facade lands in Phase 5)
│   └── pwa/register.ts      vite-plugin-pwa registration shim
├── index.html
├── vite.config.ts
├── tailwind.config.cjs
├── postcss.config.cjs
└── tsconfig.json
```

## What's explicitly not here yet

- Real screens. Every route is a `<PlaceholderScreen/>` pointing at the
  design ID it will replace.
- Service-worker background sync for offline mutations.
- Push subscription / payload handling.
- Geofence policy logic.
- Any API calls. TanStack Query is wired but unused.
- Tests. The `test` script runs `tsc --noEmit` (matches v1 convention).
  Unit tests land alongside their phase.

## AI Layer primitives

`src/components/ai/` is the locked visual language for AI surfaces.
**Don't bypass these primitives at the call site.** The hard rules they
encode (per `AI Layer.html`) are:

- Confidence is **ordinal** (`Spark` state), never a numeric percent.
- Every AI value carries an `Attribution` that names its source.
- `Dismiss` is signal, not deletion — record dismissals server-side
  for the cohort model.
- The AI mark is the brand amber. Never red.

## Cutover path

Phase 5 ends with traffic moved from `apps/web/` to `apps/web-v2/` via
the reverse proxy. Until then, the two coexist; only additive API
endpoints / migrations land while v1 is in production.
