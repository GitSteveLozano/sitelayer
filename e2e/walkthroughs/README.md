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
npm run walkthrough                       # record only — NO gemini (default)
npm run walkthrough -- --verify           # also gemini-video-verify (opt-in; uses Gemini quota)
WALKTHROUGH_VERIFY=1 npm run walkthrough   # same, via env
npm run walkthrough -- takeoff-demo        # filter by name
E2E_BASE_URL=http://localhost:3100 npm run walkthrough   # vs a local stack
```

**Gemini verification is opt-in** (`--verify` / `WALKTHROUGH_VERIFY=1`) so
routine runs don't burn the Gemini usage limits — concept proven, now we record
by default and verify on demand. With `--verify`, the runner exits non-zero if
gemini-video reports `pass:false`, so it can gate.

**Videos are kept on the external drive**, not DigitalOcean Spaces: default
`/mnt/backup/sitelayer-walkthroughs/run-<timestamp>/` (the 20T external drive),
or the gitignored `.artifacts/` if that drive isn't mounted. Override the
location with `WALKTHROUGH_VIDEO_DIR` (e.g. point it at a USB under
`/media/<user>/...`). Runs accumulate (each in its own timestamped dir) rather
than being wiped.

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
- Videos are stored locally (external drive / `WALKTHROUGH_VIDEO_DIR`), never
  uploaded to DigitalOcean Spaces. The local `.artifacts/` fallback is
  gitignored.
