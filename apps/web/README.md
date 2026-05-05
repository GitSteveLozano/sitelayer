# `@sitelayer/web`

The single Sitelayer web client. It is a mobile-first PWA with role-aware routing, mounted from `apps/web/`.

See `docs/adr/0002-web-rebuild.md` and `docs/adr/0003-retire-apps-web-no-customers.md` for the history behind collapsing to one web app.

## Dev

```sh
npm install
npm run dev:web
```

Vite serves the app on port 3100.

## Layout

```text
apps/web/
├── public/icons/
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/
│   ├── lib/
│   ├── machines/
│   ├── routes/
│   ├── screens/
│   │   └── mobile/
│   ├── styles/
│   └── pwa/
├── index.html
├── vite.config.ts
├── tailwind.config.cjs
├── postcss.config.cjs
└── tsconfig.json
```

New app screens belong under `src/screens/`. The canonical mobile shell screens live under `src/screens/mobile/`; specialized full-screen routes use the existing feature folders under `src/screens/`.

## Checks

```sh
npm run typecheck --workspace @sitelayer/web
npm run test --workspace @sitelayer/web
npm run build --workspace @sitelayer/web
npm run web:bundle-budget
```
