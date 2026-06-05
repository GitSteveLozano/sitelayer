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

Optional targeted link (drop him on a specific screen):

```text
https://dev.sitelayer.sandolab.xyz/collab/steve?target=/projects/PROJECT_ID/takeoff-canvas
```

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

## What comes back

Each sent issue creates a Sitelayer capture session and finalizes into the
existing triage path. The confirmation pill shows:

- support packet id
- work item id

Those ids correlate with the `capture_session_id`, route, build SHA, request
headers, and any registered page artifacts.
