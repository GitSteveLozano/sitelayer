# Steve Review Link

## Link to send

Send this over Discord:

```text
https://dev.sitelayer.sandolab.xyz/collab/steve
```

That link opens the dev Sitelayer review workspace, turns on the issue reporter,
pins the dev actor to `e2e-admin`, hides the developer role switcher, and
disables microphone capture by default.

Optional targeted link:

```text
https://dev.sitelayer.sandolab.xyz/collab/steve?target=/projects/PROJECT_ID/takeoff-canvas
```

## Message to Steve

```text
Open this in Chrome:
https://dev.sitelayer.sandolab.xyz/collab/steve

You do not need to install anything. When something looks wrong, click
"Report issue", type what is wrong, and click "Send issue".

Default mode does not ask for Mac permissions and does not use your microphone.
If you use the optional "Record page" button, it records browser page context so
we can replay what changed on screen.
```

## What Steve's Mac will ask for

- Default `Report issue`: no Mac permission prompt.
- Browser storage: required so the link can remember review mode while he clicks
  around. If Chrome blocks storage, use a normal Chrome window, not private mode.
- Optional microphone: only if he explicitly uses an audio recording path later.
- No Docker, no Homebrew, no source repo, no Tailscale, no Chrome extension.

## What the link grants

- Dev-only Sitelayer act-as: `e2e-admin`.
- Active dev company: `la-operations`.
- Feedback capture: enabled.
- DOM replay flag: enabled for explicit page recording.
- Audio capture: disabled.

This is dev-only review access. It does not grant source-code access, Cloudflare
access, Tailnet access, SSH, production data access, or Taylor's agent seats.

## What comes back

Each sent issue creates a Sitelayer capture session and finalizes into the
existing triage path. The confirmation pill shows:

- support packet id
- work item id

Those ids correlate with the `capture_session_id`, route, build SHA, request
headers, and any registered page artifacts.
