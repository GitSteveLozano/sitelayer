# Steve Review Link

Workflow recommendation and option comparison:
`docs/STEVE_FEEDBACK_CAPTURE_WORKFLOW.md`.

## Link to send

Send this over Discord:

```text
https://dev.sitelayer.sandolab.xyz/collab/steve
```

That link opens the dev Sitelayer review workspace, turns on the issue reporter,
pins the dev actor to `e2e-admin`, hides the developer role switcher, and
**records the microphone by default** so Steve can talk through what he sees.
Everything is captured in his browser (`getUserMedia` / `getDisplayMedia` /
`MediaRecorder`); nothing is installed.

To send a **mic-off** link (screen + interaction replay only, no audio), append
`?audio=0`:

```text
https://dev.sitelayer.sandolab.xyz/collab/steve?audio=0
```

Optional targeted link (drop him on a specific screen — e.g. the takeoff
canvas; Steve reviews on a desktop Mac, so use the desktop est-canvas route):

```text
https://dev.sitelayer.sandolab.xyz/collab/steve?target=/desktop/canvas/PROJECT_ID
```

(The old `?target=/projects/PROJECT_ID/takeoff-canvas` form still works — the
v1 takeoff canvas was retired 2026-06-12 and that URL now redirects to the
consolidated est-canvas editor for the viewport, keeping query params. See
`docs/TAKEOFF_CANVAS_CONSOLIDATION_PLAN.md`.)

## Message to Steve

```text
Open this in Chrome:
https://dev.sitelayer.sandolab.xyz/collab/steve

You do not need to install anything. When something looks wrong, click
"Report issue", say or type what is wrong, and click "Send issue".

The first time you record, Chrome will ask to use your microphone (so you can
talk through the problem) and, if you use "Record page", to share your screen.
Click Allow. If you'd rather not use the mic at all, tell me and I'll send you a
no-audio link.
```

## What Steve's Mac will ask for

- Microphone: prompted by Chrome the first time he records (mic-on by default;
  send the `?audio=0` link to suppress it).
- Screen share: prompted by Chrome only if he uses "Record page".
- Browser storage: required so the link can remember review mode while he clicks
  around. If Chrome blocks storage, use a normal Chrome window, not private mode.
- No Docker, no Homebrew, no source repo, no Tailscale, no Chrome extension.

## What the link grants

- Dev-only Sitelayer act-as: `e2e-admin`.
- Active dev company: `e2e-fixtures`.
- Feedback capture: enabled.
- DOM replay flag: enabled for explicit page recording.
- Audio capture: enabled by default (opt out with `?audio=0`).

This is dev-only review access. It does not grant source-code access, Cloudflare
access, Tailnet access, SSH, production data access, or Taylor's agent seats.

## Prod (real customer) path — not `/collab/steve`

`/collab/steve` only works on dev/demo: it pins a dev `act-as` identity, which
the API **ignores in prod** (`apps/api/src/auth.ts`, `tier === 'prod'`), and the
dev role-switcher branch is dead-code-eliminated from the production bundle. So
do **not** send `/collab/steve` to a production user.

For a real, logged-out collaborator in prod, use the **signed feedback-invite
portal** instead: mint an invite token (`feedback_invites`, served at
`/feedback?token=…`, `apps/api/src/routes/feedback-invites.ts` +
`apps/web/src/screens/feedback/FeedbackInviteEntry.tsx`). The signed token _is_ the auth
(`authority: signed_feedback_invite_token`) — still browser-only, nothing to
install — and it round-trips through the same capture-session → work-item path.
Requires `FEEDBACK_INVITE_SECRET` set in the prod env.

## What comes back

Each sent issue creates a Sitelayer capture session and finalizes into the
existing triage path. The confirmation pill shows:

- support packet id
- work item id

Those ids correlate with the `capture_session_id`, route, build SHA, request
headers, and any registered page artifacts.
