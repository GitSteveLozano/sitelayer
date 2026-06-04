# Capture Local GPU Media Worker Decision

Date: 2026-06-04

## Decision

Use Taylor's existing local GPU `voice-tools` Whisper service for speech-to-text.
Do not route Sitelayer capture audio through paid managed STT APIs by default,
and do not assume a Sitelayer droplet has a host-local Whisper service.

The durable shape is:

1. Browser/site capture uploads audio, replay, text, state, and screen artifacts
   to the normal Sitelayer API/storage path.
2. Droplet workers keep `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=off` unless a real
   Whisper service is provisioned on that same host.
3. Taylor's workstation runs `npm run capture:media-worker` with the target
   Sitelayer DB/storage env. That worker defaults to
   `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=local-whisper` and
   `CAPTURE_ARTIFACT_WHISPER_URL=http://127.0.0.1:5678`.
4. The media worker pulls capture artifacts from Sitelayer storage, transcribes
   audio through local `voice-tools`, writes first-class derived transcript
   artifacts, appends `context_handoff_events`, and refreshes
   `context_work_items.metadata.capture_artifact_analysis`.
5. Optional LLM enrichment uses the existing subscription-CLI seam
   (`MEDIA_UNDERSTANDING_ENGINE=gemini-cli`) after the transcript or sampled
   frames exist. The cash/API path stays opt-in.

This keeps raw STT on local hardware while preserving the existing Sitelayer
capture/session/work-item model.

## Why

The deployed dev/prod failure was not missing STT code. The worker already had a
`local-whisper` adapter and `voice-tools` already had a healthy faster-whisper
HTTP service on the workstation. The wrong assumption was reachability:

- `host.docker.internal` inside the prod/dev containers points at the droplet
  Docker host, not Taylor's workstation.
- The prod/dev droplets did not have a Whisper process on `:5678`.
- Marking a transient Whisper outage as a permanent skipped analysis consumed
  the artifact idempotency key and prevented a later successful retry.

## Boundary

`host.docker.internal:5678` is only valid for same-machine local Docker or a
host where Whisper has explicitly been provisioned. It is not a cross-host
architecture.

The remote worker default is therefore `CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE=off`.
The GPU workstation worker owns audio analysis unless and until a dedicated
private STT host exists.

## Runtime Contract

Start local Whisper:

```bash
systemctl --user start voice-tools-whisper.service
curl -fsS http://127.0.0.1:5678/health
```

Run one media-worker pass:

```bash
CAPTURE_MEDIA_WORKER_ONCE=1 \
CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH=1 \
npm run capture:media-worker
```

Run continuously:

```bash
CAPTURE_MEDIA_WORKER_INTERVAL_MS=30000 \
CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH=1 \
npm run capture:media-worker
```

The command expects the normal Sitelayer runtime env for `DATABASE_URL` and
object storage (`DO_SPACES_BUCKET`, `DO_SPACES_KEY`, `DO_SPACES_SECRET`, region
and endpoint if needed). Do not commit those values.

## Failure Policy

`CAPTURE_ARTIFACT_WHISPER_UNAVAILABLE_POLICY=retry` is the default. A connection
failure or timeout leaves the artifact unprocessed so a later media-worker pass
can retry it.

`skip` remains available only when the operator explicitly wants to record a
permanent skipped event for unreachable Whisper.

## Rejected For Now

- Managed STT APIs: rejected as default because this deployment should not add
  per-minute API billing.
- Public Whisper HTTP endpoint: rejected because capture audio can include user
  speech and issue context.
- SSH reverse tunnel as the main product path: useful for emergency debugging,
  but too brittle unless a persistent systemd tunnel plus remote bind/firewall
  policy is maintained.
- Browser extension STT: unnecessary for site-owned capture. The page can ask
  for microphone/screen permissions directly, upload the artifact, and let the
  server-side/local-GPU media worker derive transcripts.

## Open Follow-Ups

- Add a systemd user unit for `npm run capture:media-worker` on Taylor's
  workstation, sourced from a local env file outside the repo.
- Add a repair command for historical `local whisper unavailable` skipped events
  if any important sessions were already consumed by the bad droplet default.
- Decide whether `gemini-cli` enrichment should run only on Taylor's workstation
  or through a separate local CLI worker queue.
