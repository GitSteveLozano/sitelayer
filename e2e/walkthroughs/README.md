# Deterministic walkthroughs (video + gemini-video verification)

A **walkthrough** is a deterministic, scripted drive through a sitelayer flow that
**records a video** and then has **gemini-video** watch that recording and verify,
step by step, that the walkthrough behaved as expected.

```
Playwright spec (deterministic, XState/seed- or demo-driven)
        │  records video (always on)
        ▼
   video.webm  +  walkthrough-steps.json (the expected narrative)
        │  run-walkthrough.mjs → ffmpeg → mp4
        ▼
   gemini-video (gemini CLI, $0 OAuth) → {steps:[{n,visible,note}], pass, summary}
```

## Run

```bash
npm run walkthrough                                   # all walkthroughs vs dev
E2E_BASE_URL=http://localhost:3100 npm run walkthrough  # vs a local stack
npm run walkthrough takeoff-demo                        # filter by name
WALKTHROUGH_SKIP_GEMINI=1 npm run walkthrough           # record only, no verify
```

The runner exits non-zero if gemini-video reports `pass:false`, so it can gate.

## Why this is deterministic

Determinism comes from the driven states being reproducible: either a **public
client-side demo** (`/demo/takeoff-preview-3d`, no auth/backend) or a seeded
**XState posture** via the `?seed=<name>` affordance
(`apps/web/src/machines/takeoff-session-seeds.ts`: `drawing-polygon`,
`calibrating`, `ai-reviewing`, …) with API mocks à la
`e2e/tests/takeoff-preview.smoke.spec.ts`. Same seed + same event sequence ⇒
same states ⇒ same video ⇒ a stable gemini-video verdict.

## Add a walkthrough

1. Drop `e2e/walkthroughs/<name>.walkthrough.spec.ts`.
2. Drive a deterministic flow; pause ~2.5–3s per step so the video shows it.
3. `export const WALKTHROUGH_STEPS = [{ n, action, expect }, …]` and write it to
   `walkthrough-steps.json` in `testInfo.outputDir` (see `takeoff-demo`).

`video: 'on'` is forced by `e2e/walkthroughs/walkthrough.config.ts`. These specs
are excluded from the e2e gate (`testIgnore: '**/walkthroughs/**'` in the root
`playwright.config.ts`) — they are a tool, not a merge gate.

## Notes

- gemini-video rides the **$0 OAuth subscription** (the runner unsets
  `GEMINI_API_KEY` so the CLI uses OAuth, matching the worker's gemini-cli media
  adapter). The local-GPU `gemma4-12b-vision` path is fragile on multi-frame
  video; gemini-cli is the reliable verifier here.
- Artifacts land in `e2e/walkthroughs/.artifacts/` (gitignored).
