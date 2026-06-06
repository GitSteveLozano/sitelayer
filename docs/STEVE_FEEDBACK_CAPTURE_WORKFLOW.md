# Steve Feedback Capture Workflow

Date: 2026-06-04
Status: recommendation

Related docs:

- `docs/OPT_IN_CAPTURE_LADDER_2026-06-04.md`
- `docs/CONTEXT_HANDOFF_CAPTURE_ARCHITECTURE_2026-06-02.md`
- `docs/USAGE_CAPTURE_IMPLEMENTATION.md`

## Recommendation

Use one Discord-delivered Sitelayer link as the default Steve workflow:

```text
https://dev.sitelayer.sandolab.xyz/collab/steve
```

Discord should be the delivery and notification channel, not the feedback
capture surface. The link should open Sitelayer in Steve review mode, open the
`Report issue` dock, create or reuse one `capture_session_id`, and let Steve
send a typed report with no install, no terminal, no source checkout, and no OS
permission prompt. Page context should attach automatically where possible:
route, build SHA, request ids, product trace, registered page artifacts, and a
short DOM replay buffer. Pixel screenshots should be treated as a richer tier,
not a blocker for the default link.

Short term: no-install web-only, plus a small prewarm change so the session id
exists before Steve starts clicking around.

Long term: keep the same link and add a capability ladder:

1. Web-only capture for every reviewer.
2. Private Web Store tester extension for one-click visible-tab screenshots and
   richer browser context.
3. Native helper only when desktop-wide or mobile-native screen video is worth
   the install and OS permissions.

Do not use an unpacked extension for Steve except as a developer-only smoke
test. It is too fragile and too technical for the target user.

Do not use Chrome Web Store trusted testers if the requirement is "no Google
review." Private/trusted-tester visibility limits who can install the listing,
but Chrome Web Store items still go through the same review path. If source code
must not go through Google review, the extension tier must be either skipped or
self-hosted through managed Chrome enterprise policy. That self-hosted path is
not a good Steve default unless Steve's machine is managed by us.

## Implemented Status

The P0 no-install path now has code and browser-smoke coverage:

- `AuthenticatedFeedbackDock` prewarms a Steve-mode text issue
  `capture_session_id` when the issue dock opens.
- `Send issue` reuses that prewarmed feedback session instead of minting an
  unrelated one.
- The text issue session metadata and consent scope live in
  `apps/web/src/lib/feedback-text-issue.ts`, which is the first extraction point
  for a future shared capture widget.
- Optional in-browser screen recording now uses `getDisplayMedia()` plus
  `MediaRecorder`, uploads a `video` artifact named `screen-video.webm`, and
  finalizes through the same support packet / work item path. This requires the
  user's explicit browser screen picker and is not the default Steve path.
- `npm run capture:steve-smoke` opens `/collab/steve?target=/m-preview`, mocks
  the capture API, proves no microphone permission is requested, proves one
  prewarmed UUID is reused through submit/finalize, and verifies the Steve local
  storage flags remain while the active session is cleared after receipt.

The public feedback-invite path now has the same no-plugin capture spine:

- `/feedback?token=...` resolves a signed feedback invite, strips the token from
  the URL, and creates `feedback_invite` portal capture sessions without Clerk.
- Text issue submission finalizes to `context_work_items` through the existing
  support packet path.
- If the invite allows `state`, the page uploads a sanitized `state_snapshot`
  JSON artifact before finalization.
- Feedback-invite state upload now also runs the shared
  `capture-state-providers` registry through a token-bound portal upload
  adapter, so route/page-specific providers can attach richer state without
  Clerk or an authenticated upload path.
- The existing estimate/rental portal `IssueReporter` uses the same pattern for
  registered state providers, so public portal pages do not fall back to the
  authenticated capture artifact endpoint.
- Estimate and rental portal pages now register production state providers:
  estimate state captures review mode, totals, line counts, and validation
  presence; rental state captures filters, cart shape, catalog counts, and
  reservation status. Both exclude contact/signature/freeform reason text and
  avoid serializing the raw share token.
- If the invite allows `audio`, the page exposes an explicit `Record audio`
  control that uses the browser microphone prompt, uploads an `audio` artifact,
  and finalizes the same work item.
- If the invite allows `screen`, the page exposes an explicit `Record screen`
  control that uses the browser screen picker, uploads a `video` artifact, and
  finalizes the same work item.
- Company admins can mint and copy these signed reviewer links from Settings ->
  External reviewers.

## Current State To Reuse

`docs/STEVE_REVIEW_LINK.md` already defines the Discord-ready link and message.
`/collab/steve` stores review-mode flags, pins the dev actor/company, enables
feedback, enables replay, disables audio, and redirects to the target route.

The authenticated dock already has the core Steve UX:

- Steve mode renames the button to `Report issue` and the placeholder to
  `What is wrong?`.
- `Send issue` creates a feedback capture session, uploads registered page
  artifacts, finalizes to the work-item path, and shows the support packet and
  work item ids.
- `Record page` can start the same controller with audio disabled and optional
  rrweb replay.

The capture backend already does the important correlation work:

- `capture_session_id` is carried through auth headers and capture APIs.
- Finalization creates one support packet, one context work item, one handoff
  event, and a `session.finalized` lifecycle event.
- The analyzer can mark capture evidence ready and, behind feature flags,
  enqueue Mesh dispatch with the same `capture_session_id`.

## Short-Term UX

Message sent to Steve:

```text
Open this in Chrome:
https://dev.sitelayer.sandolab.xyz/collab/steve

When something looks wrong, type what is wrong and click Send issue.
You do not need to install anything.
```

Steve flow:

1. Click the Discord link.
2. Sitelayer opens the review workspace and the `Report issue` panel.
3. Steve types a plain-English issue, for example "This takeoff number looks
   wrong" or "I expected this button to show the next job".
4. Steve clicks `Send issue`.
5. The UI shows `Sent` plus the support packet id and work item id.

Default permissions:

- No extension install.
- No microphone.
- No native screen-record prompt.
- No Discord OAuth.
- Browser storage only, so the review link can remember Steve mode while he
  navigates.

Optional no-install richer path:

1. Steve clicks `Record page` for DOM replay and structured page context, or
   `Record screen` for browser screen video.
2. For screen video, Chrome shows the normal screen/window/tab picker.
3. Steve clicks `Stop`.
4. The same work item gets the typed note, route context, registered artifacts,
   and either an rrweb replay artifact or a `video` artifact.

For Steve, keep these buttons secondary. The primary happy path is typed issue
first, context attached automatically. Screen video is for reviewers who
explicitly want richer evidence and are comfortable with the browser picker.

## Local Dev Quickstart (collaborator testing on their own machine)

A collaborator can exercise the full capture → support-packet path locally with
no Clerk org, no mesh, and no operator credentials. See
`docs/ONBOARDING_DEVELOPER.md` §5a for the long form. Short version:

1. **DB must be at the rebaselined lineage.** A brand-new `docker compose up`
   stack is already correct (`docker/postgres/init/*.sql` applies migrations
   `007`/`009`/`010` on first boot). An **existing** local volume from before the
   rebaseline is stale and will 500 on `/api/session`
   (`column "first_run_completed_at" does not exist`) and 500/403 on the
   `app_issue` capture routes. Fix by wiping the compose volume
   (`docker compose down -v && docker compose up --build`) or, for a persistent
   dev-tier DB, `RESET_DEV_DB_CONFIRM=1 scripts/reset-dev-db.sh`.
2. **Enable the dock.** `/collab/steve` does it automatically — it writes
   `sitelayer.auth-feedback-enabled = 'true'` and redirects with
   `?capture_feedback=1`. Outside that route, set the same localStorage key or
   append `?capture_feedback=1` to any in-app URL.
3. **Superadmin path is free in non-prod.** When `APP_TIER !== 'prod'`, the dev
   RoleSwitcher identity satisfies `app_issue.*` (tier-gated relaxation), so the
   collaborator can finalize + read + download an issue without any Clerk/mesh
   credentials. Never reachable in prod (gated on the tier).
4. **End-to-end check.** `docker compose up` (fresh DB) → `npm run dev` →
   open `/collab/steve` → **Reproduce a bug**, drive a real workflow transition
   (e.g. approve a rental billing run; each commit stamps a `workflow.transition`
   mark with the canonical `payload.event_ref`), End & report → then
   `GET /api/support-packets/:id` shows `agent_prompt` with statechart anchors +
   incident timeline, and the artifact downloads.

## Short-Term Data Flow

Recommended flow:

```text
Discord message
  -> /collab/steve?target=...
  -> Steve review mode flags
  -> prewarm capture session
  -> active capture_session_id attached to requests and trace
  -> typed issue or page recording
  -> capture_artifacts upload
  -> POST /api/capture-sessions/:id/finalize
  -> support_debug_packets
  -> context_work_items
  -> context_handoff_events
  -> optional artifact analysis
  -> optional Mesh work dispatch
```

The important short-term behavior is prewarming. Steve mode now creates the
`capture_session_id` when the issue dock opens, before Steve sends the issue.
This gives navigation and workflow events a stable join key instead of only
creating one at final submission. The prewarmed session carries metadata like:

```json
{
  "source": "discord_link",
  "collab_mode": "steve",
  "capture_profile": "review_session",
  "target_route": "/desktop"
}
```

Then `Send issue` finalizes the active session instead of minting a fresh one.
If the user closes the tab without sending anything, leave the session as open
until retention cleanup or explicitly discard it on idle timeout.

For DOM replay, use a short Steve-mode ring buffer only after consent implied by
the review link. Attach the last 60 to 120 seconds to `Send issue` when
`capture_replay=1`. Keep the existing privacy defaults and strengthen them
before production: mask sensitive customer, money, and project fields with
`data-capture-private` or route-level allowlists.

## Automatic Screenshot Reality

No-install web cannot silently take a reliable screenshot of the current tab or
desktop. Browser screen capture uses `getDisplayMedia()`, which requires a user
activation and permission prompt, and the user chooses the screen/window/tab.
That is too much friction for the default Steve path.

For web-only default, prefer DOM replay plus registered structured artifacts. It
is lower friction and already fits Sitelayer's capture store.

For reviewers who want video, Sitelayer can now use the same browser mechanism
as web meeting tools: `navigator.mediaDevices.getDisplayMedia()` returns a
screen/window/tab `MediaStream`, and `MediaRecorder` records that stream into a
file upload. This is a good optional evidence tier because it still requires no
extension or native helper, but it always involves an explicit browser picker.

For real pixel screenshots, use the browser extension tier. A Chrome extension
invoked by Steve can use `activeTab` and `tabs.captureVisibleTab()` to capture
the active visible tab. It still should be user-gesture based, scoped to the
current tab, and attached to the active `capture_session_id`.

## Options Comparison

| Option                             | Steve friction                                                             | Capture quality                                                                                                                        | Correlation                                                               | Operational fit                                      | Verdict                                        |
| ---------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| No-install web-only                | Best. One Discord link.                                                    | Typed issue, route, trace, registered artifacts, optional DOM replay, optional user-approved screen video. No silent pixel screenshot. | Strong; Steve-mode text issues now prewarm and reuse one session id.      | Implemented with unit and Playwright smoke coverage. | Default short-term path.                       |
| Web Store private tester extension | Medium. Install once from Chrome Web Store link.                           | Visible-tab screenshot, injected DOM context, selected richer artifacts.                                                               | Strong if page mints upload token and extension posts to same session id. | Best extension distribution for nontechnical pilot.  | Long-term optional enhancer.                   |
| Unpacked extension                 | High. Download zip, Chrome developer mode, load unpacked, update manually. | Same technical capability as extension.                                                                                                | Strong in theory.                                                         | Fragile and looks unprofessional.                    | Developer smoke only, not Steve.               |
| Native helper                      | Highest. Installer plus OS permissions.                                    | Best: desktop-wide screenshots/video, native app context, mobile ReplayKit/MediaProjection path.                                       | Strong if it speaks capture-session protocol.                             | Useful after product proves need.                    | Long-term only for high-fidelity screen video. |

## Extension Tier

Use a Manifest V3 extension named `Sitelayer Capture Companion` and publish it
as a private/trusted-tester Web Store item only if Google review is acceptable.
If Google review is not acceptable, use a self-hosted CRX only on managed Chrome
profiles where enterprise policy can force-install or allow-list the extension.
For unmanaged personal machines, skip the extension tier and keep the web-only
path as the default.

Minimum permissions:

- `activeTab`
- `scripting`
- `storage`
- `tabs` only if needed for metadata beyond activeTab

Avoid broad host permissions by default. The page should mint a short-lived
capture upload token, scoped to one company, one `capture_session_id`, allowed
artifact kinds, and an expiration window. The extension receives it through an
explicit page handshake, captures the visible tab, and uploads:

```json
{
  "kind": "screenshot",
  "capture_session_id": "...",
  "metadata": {
    "source": "browser_extension",
    "surface": "visible_tab",
    "tab_url_path": "/projects/...",
    "device_pixel_ratio": 2
  }
}
```

UX when extension is installed:

1. Steve opens the same Discord link.
2. The dock says `Screenshot ready` only after the extension confirms.
3. On `Send issue`, Sitelayer includes screenshot, DOM replay if enabled, typed
   note, route, and structured artifacts.

UX when extension is missing:

1. The dock works normally.
2. Do not block `Send issue`.
3. If richer capture is needed, show a single `Install capture helper` action
   that opens the Web Store listing.

## External Agent Surfaces

These tools can help a collaborator test a live browser, but they do not replace
Sitelayer's capture-session protocol or local work-item queue.

### sitelayer-collab

`/home/taylorsando/projects/sitelayer-collab` is a working git-as-bus channel:
Steve-side findings land in `inbox/`, operator ingest turns them into projectkit
handoffs, and `handoffs/` can carry paste-ready tasks back to Steve's agent. Use
it as an async collaborator channel, not as the product issue board. The
canonical Sitelayer board remains `context_work_items`; any finding from the
collab repo should be mirrored into a feedback invite/capture session or a
company-scoped work item before it drives product triage.

### OpenAI

ChatGPT agent has a hosted visual browser for online tasks. It is useful if the
collaborator already has ChatGPT access and can point an agent at a public
Sitelayer URL, but it is not our local Chrome profile, not our capture protocol,
and its screenshots/history live inside the ChatGPT agent task. OpenAI also has
a Computer Use API tool where our code must supply the browser/desktop
environment, screenshots, and action loop. That is an automation backend, not a
zero-install user feedback surface.

### Anthropic

Claude Code is viable for a collaborator who keeps their own Claude
subscription and local checkout. Anthropic's computer-use API can drive a
browser or desktop through screenshots, keyboard, and mouse, but the developer
must build and run the environment and action loop. Claude remote connectors are
better for public/cloud services; Claude desktop extensions are for local files,
localhost, desktop apps, or OS-level access and only work in Claude Desktop and
Claude Code.

### Google/Chrome

Chrome DevTools for agents is the closest official alternative to our
browser-bridge for browser testing. It exposes Chrome DevTools through MCP to
Gemini CLI, Claude Code, Codex, and other coding agents. The auto-connect mode
can attach an agent to the user's already-open Chrome profile and tabs after
remote debugging and an explicit browser permission step. That is useful for a
technical collaborator debugging an authenticated Sitelayer page, but it gives
the agent broad access to that browser profile and is not a customer-grade
feedback intake flow.

## Native Helper Tier

Native helper is for cases the web and extension layers cannot cover:

- mobile screen video through ReplayKit or MediaProjection;
- desktop-wide screen recording outside the browser tab;
- multi-window workflows;
- richer local file or OS context.

The helper should not become the default Steve workflow. If used, it should
still be launched from the same Sitelayer link and speak the same protocol:

```text
capture_session_id
  + artifact kind
  + consent scope
  + retention policy
  + upload token
  + work item finalization
```

For Chrome desktop integration, native messaging is the right bridge between a
Web Store extension and an installed helper, but it requires an installer to
place OS-specific native messaging manifests. That makes it a long-term path.

## Discord Integration

Short term, Discord is just where Taylor sends the link. Do not require Steve
to authorize a Discord app.

Long term, add a small Sitelayer-side invite generator:

```text
POST /api/feedback-invites
  -> target_route
  -> reviewer_ref = "steve"
  -> source = "discord"
  -> expires_at
  -> allowed_capture_modes
```

It returns one URL for Discord. If a Discord bot or webhook is added later, use
it only for receipts:

```text
Steve issue received
work_item_id: ...
support_packet_id: ...
capture_session_id: ...
route: ...
```

The receipt should be posted after Sitelayer creates the work item. Discord
should not be the system of record.

## Implementation Plan

P0, no-install:

1. Done: keep `docs/STEVE_REVIEW_LINK.md` as the operational send-this-link
   doc.
2. Done: add Steve-mode prewarm so `/collab/steve` or the dock creates one active
   `capture_session_id` before navigation events matter.
3. Done: make `Send issue` finalize the active Steve-mode session.
4. Attach the last short DOM replay buffer to typed issue submissions when
   `capture_replay=1`, with audio still disabled.
5. Done for the no-replay default: add tests that prove one Steve link opens
   the dock, prewarms one `capture_session_id`, reuses it through submit, emits
   the issue event, finalizes with support/work item ids, and never requests
   microphone access.
6. Done: add optional in-browser screen recording for reviewers who click
   `Record screen`; upload the resulting `video` artifact into the same
   finalized feedback episode.

P1, operational polish:

1. Add invite records or metadata for `source=discord`, `target_route`, and
   `reviewer_ref`.
2. Add optional Discord receipt posting after work item creation.
3. Add a review dashboard filter for Steve feedback by `collab_mode=steve` or
   `source=discord_link`.

P2, extension:

1. Build the capture companion as Manifest V3 with `activeTab` and
   `captureVisibleTab`.
2. Publish through the Web Store private/trusted-tester path.
3. Add web-page detection and graceful fallback.
4. Upload visible-tab screenshots to the existing capture artifact route.

P3, native:

1. Add native helper only if browser capture is not enough.
2. Use native messaging for desktop helper launch from the extension.
3. Use native mobile capture APIs for mobile screen video.

## Sources Checked

- Chrome custom extension publishing modes, including unlisted/private/trusted
  testers:
  https://support.google.com/chrome/a/answer/2714278
- Chrome `activeTab` permission:
  https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- Chrome `tabs.captureVisibleTab()`:
  https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome native messaging:
  https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Browser screen capture user activation and permission behavior:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- Screen capture for recording or WebRTC sharing:
  https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API/Using_Screen_Capture
- Browser media recording:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- Discord OAuth2, if identity is ever needed:
  https://docs.discord.com/developers/platform/oauth2-and-permissions
- rrweb canvas replay caveat:
  https://rrweb.com/docs/recipes/canvas
