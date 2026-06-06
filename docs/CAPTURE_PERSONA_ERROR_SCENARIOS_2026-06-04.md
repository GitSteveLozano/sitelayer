# Capture Persona And Error Scenarios - 2026-06-04

Status: working implementation checklist.

Related:

- `docs/OPT_IN_CAPTURE_LADDER_2026-06-04.md`
- `docs/STEVE_FEEDBACK_CAPTURE_WORKFLOW.md`
- `docs/USAGE_CAPTURE_IMPLEMENTATION.md`

## Person Paths

| Person                          | Entry point                                       | Expected consent                                       | Evidence produced                                                                       | Ease-of-use rule                                                   |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Public/no-friction user         | Normal site or portal link.                       | None by default. Trace only with explicit debug grant. | Usually none. If trace is granted, low-PII route/event beacons without query strings.   | Never show a media prompt or capture panel on first page load.     |
| Pilot user                      | Portal link with `capture_invite`.                | Mic on `Start`; optional replay through explicit flag. | Portal capture session, started/stopped events, audio, optional replay/state snapshots. | Keep the pill visible only when invited; give friendly retry copy. |
| Product/dev reviewer            | Steve/review link into authenticated app.         | Text issue plus registered state/artifact snapshots.   | Prewarmed session, issue event, state/canvas artifacts, support packet, work item.      | Text issue must work without microphone or screen permission.      |
| Maximum-permission collaborator | Authenticated capture dock.                       | Audio, optional replay, optional screen video.         | Audio/replay/video/state/canvas artifacts and final work item.                          | Each richer stream starts only after an explicit user action.      |
| External developer              | Work item, exported packet, repo/local setup.     | Separate from product-user consent.                    | Handoff packet exports, GitHub links, imported reference captures if needed.            | Do not require full Control Plane/browser-bridge for basic review. |
| Trusted agent operator          | `/work`, support packet, dispatch/import scripts. | Acts on already-consented evidence.                    | Dispatch events, callback events, capture-review imports, analysis metadata.            | Operators need clear evidence status before dispatching work.      |

## Error Handling Matrix

| Failure                           | Current/fixed behavior                                                                                                               | Tracking status                                                             | Next improvement                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Mic denied or unavailable         | UI now maps permission/device errors to friendly retry copy. Controller discards the server capture session if recorder start fails. | No work item unless user retries or submits text. Server discard is called. | Add `recording_start_failed` event when a session existed and discard succeeded or failed.          |
| Screen picker cancelled           | Screen session is not created before picker success; UI maps `AbortError` to cancel/retry copy.                                      | No event/work item because no session exists.                               | Treat cancel as neutral UI state instead of red error where possible.                               |
| Upload/network failure            | Audio/replay stop path queues replayable failures. Text issue and screen video still fail inline.                                    | Work item is created only after queued replay finalizes.                    | Add queueing for text issue and screen-video uploads or a manual retry receipt.                     |
| Consent mismatch `403`            | API enforces event class and artifact kind. UI now shows the server message instead of a raw request path.                           | Rejected event/artifact is not inserted.                                    | Add client-side preflight validation so bad providers are skipped before upload.                    |
| Finalized/discarded stale session | API returns `409`; local discard/finalize already clears active session on success.                                                  | Finalized creates support packet/work item; discarded creates lifecycle.    | On `409`, clear stale local state and show “start a new report” or existing receipt when available. |
| Portal invite missing             | Portal reporter stays hidden unless invite and share token exist.                                                                    | No event/work item.                                                         | Optional disabled/help copy for invited test links that lost `capture_invite`.                      |
| State provider failure            | New state provider registry catches failures and continues. Existing artifact providers also continue.                               | Provider failure is currently local-only.                                   | Append low-PII provider failure event or include provider status in finalization metadata.          |
| Analyzer/transcription disabled   | Submission still succeeds. Worker marks readiness according to enabled modes.                                                        | Work item can exist without transcript/video analysis.                      | Surface analysis-disabled flags in work item evidence status.                                       |
| Future live share failure         | Not implemented. Current screen capture is recorded upload, not WebRTC.                                                              | No live-share tracking yet.                                                 | Define `signaling_failed`, `ice_failed`, `operator_disconnected`, and local-recording fallback.     |

## Implementation State

Done in the current Sitelayer slice:

- Shared capture consent builders for authenticated, portal, text issue, and
  screen recording.
- Server-side consent enforcement for authenticated and portal event/artifact
  append paths.
- Trace consent leaf module split from beacon sending so capability policy no
  longer depends on the emitter.
- State-provider registry that uploads sanitized `state_snapshot` artifacts.
- Authenticated and portal stop paths ask registered state providers for
  snapshots before finalization.
- Friendly capture error copy for browser permission/cancel/API errors.
- Start-failure cleanup so microphone denial after session creation discards
  the server session best-effort.

## Next Work

1. Add low-PII failure events for provider failures and recorder-start failures.
2. Add stale-session recovery on capture `409` responses.
3. Queue or retry text issue and screen-video submissions.
4. Add visible evidence status on work items: raw media present, transcript
   disabled/pending/ready, replay present, provider failures.
5. Add a chunked screen recorder and `video_clip_manifest`.
6. Design L5 live share states and fallback events before implementing WebRTC.
