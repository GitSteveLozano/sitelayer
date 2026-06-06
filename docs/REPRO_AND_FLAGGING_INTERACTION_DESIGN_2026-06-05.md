# Reproduction & Issue-Flagging Interaction Design — 2026-06-05

Status: implemented (first slice) + roadmap.

Audience: this is the "how do people flag problems and how do we reproduce
them" design. Primary user is **Steve** (a non-technical reviewer on a Mac, no
install, one Discord link) and, by extension, any pilot reviewer or the operator.

Related: `docs/STEVE_FEEDBACK_CAPTURE_WORKFLOW.md`,
`docs/OPT_IN_CAPTURE_LADDER_2026-06-04.md`, `docs/STEVE_REVIEW_LINK.md`.

## The gap this closes

The capture spine already let Steve type an issue, narrate audio, share screen
video, and record an rrweb DOM replay — all no-install, all finalizing into the
`context_work_items` triage queue. Three things were missing for the operator's
ask ("easy to flag, easy to specify start/end conditions so we can reproduce"):

1. **No way to bracket a reproduction.** The rrweb recorder ran from "start"
   to "stop" with no user-marked _start condition_, _the-bug-is-here moments_,
   or _end condition_. `clip_boundary` existed in the type union but was unused.
2. **No keyboard path.** Zero hotkeys anywhere in the web app — a reviewer
   reproducing a bug had to break flow and mouse over to a dock.
3. **No on-site opt-in.** The recording level was fixed by the invite link;
   the user could not dial capture up or down from inside the app.

## The model: a reproduction is a bracket

A **reproduction bracket** is the unit of "specify start/end conditions." It is
not a new table — it rides the existing `capture_session → events → artifacts →
finalize` spine (no migration):

```
Start reproduction ──▶ [ do the thing ] ──▶ Mark · Mark · Mark ──▶ End & report
        │                                          │                    │
   start condition:                          repro.mark events     end condition:
   - repro_start state snapshot              (offset_ms + label)    - repro_end state snapshot
   - repro.bracket_started event                                   - repro.bracket_ended event
   - rrweb replay starts (if level allows)                         - rrweb replay stops
                                                                    - repro_bracket summary artifact
                                                                    - finalize → context_work_item
```

The `repro_bracket` artifact is small structured JSON that ties the window
together so triage (and an agent) can reconstruct the repro without watching the
whole replay:

```json
{
  "artifact_type": "capture.repro_bracket",
  "started_at": "...",
  "ended_at": "...",
  "duration_ms": 19000,
  "window_ms": { "start": 0, "end": 19000, "relative_to": "repro_started" },
  "start_condition": { "note": "about to push the estimate", "snapshot_reason": "repro_start" },
  "end_condition": { "note": "estimate total doubled", "snapshot_reason": "repro_end" },
  "marks": [{ "offset_ms": 4000, "label": "total looks wrong", "at": "..." }],
  "replay": { "enabled": true, "event_count": 142 }
}
```

Consent: `buildReproBracketConsentScope({domReplay})` allows the typed note,
registered state snapshots, the `repro_bracket` artifact, and (opt-in) rrweb.
It never implies audio or screen video — those stay on their own explicit
controls. Server enforcement: `capture-consent-policy.ts` allows `repro_bracket`
under an explicit-or-registered-artifacts grant.

## The opt-in ladder, on the site

`capture-level.ts` is the strictly-additive ladder the user climbs from inside
the dock (persisted in `localStorage['sitelayer.capture-level']`, clamped to the
device's real capabilities):

| Level    | Adds                             | Prompt?             | Maps to ladder doc |
| -------- | -------------------------------- | ------------------- | ------------------ |
| `note`   | typed note + auto state snapshot | none                | L1                 |
| `replay` | + rrweb DOM replay (clicks/page) | none                | L3 (DOM)           |
| `audio`  | + microphone narration           | mic, once           | L2                 |
| `screen` | + screen video                   | screen picker, once | L4                 |

Default position is **the highest tier the device supports** (so the dock keeps
offering everything it did before — no regression to the Steve link, which
intends rich capture). The user can dial _down_ to reduce capture or _up_ where
a stored preference is lower. A phone never sees `screen` (no `getDisplayMedia`);
the rung is hidden, not offered-then-failing.

> Roadmap note: a _low_ default (start at `note`, climb up) is the right shape
> for general pilot users who are not on a review link. That is a config flag on
> the seed, deferred until there is a non-reviewer cohort, because flipping the
> default would change the current reviewer UX. Tracked here, not built.

## Desktop hotkeys (opt-in)

`capture-hotkeys.ts` — off by default, desktop-only (`(hover:hover) and
(pointer:fine)`), toggled by the "Shortcuts" checkbox in the dock. Bindings use
`Mod+Shift+<digit>` precisely because that space is unbound in Chrome/Firefox/
Safari (unlike devtools `I/J/C`, web-console `K`, responsive-mode `M`):

| Shortcut   | Action                          |
| ---------- | ------------------------------- |
| ⌘/Ctrl ⇧ 1 | Open the report dock + focus it |
| ⌘/Ctrl ⇧ 2 | Start / stop a reproduction     |
| ⌘/Ctrl ⇧ 3 | Mark this moment                |

The single highest-value one is **Mark** (⌘⇧3): hands stay on the keyboard
reproducing the bug, one keypress drops a timestamped marker.

## Form-factor matrix

A good UI here is responsive _by intent_, not just by constraint:

| Surface | Dock shape                                     | Hotkeys              | Screen video                      | Notes                                                    |
| ------- | ---------------------------------------------- | -------------------- | --------------------------------- | -------------------------------------------------------- |
| Desktop | floating card, bottom-right                    | yes (opt-in)         | yes                               | full ladder; hint tooltip on the Shortcuts toggle        |
| Tablet  | floating card / bottom-sheet (<520px)          | only with a keyboard | yes if `getDisplayMedia`          | touch-first; larger targets                              |
| Mobile  | full-width **bottom sheet**, safe-area padding | no                   | hidden (`getDisplayMedia` absent) | note + replay + audio; reproduce + mark are the headline |

`getDisplayMedia` is desktop-only on the major mobile browsers, so the `screen`
rung and the "Record screen" button are capability-gated off on phones rather
than shown and failing.

## All the ways to flag / reproduce (interaction inventory)

Shipped now:

- **Type an issue** → one work item (existing).
- **Reproduce a bug** → start/mark/end bracket → `repro_bracket` + replay (new).
- **Label a mark** inline ("the total is wrong here") while reproducing (new).
- **Record voice** narration (existing, gated by level).
- **Record screen** video (existing, gated by level + capability).
- **Keyboard**: flag / start-stop repro / mark (new, opt-in, desktop).
- **One Discord link** seeds review mode + auto-opens the dock (existing).
- **Signed `/feedback?token=` portal** for logged-out prod reviewers (existing).
- **Watch the reproduction back**: operator-side in-app rrweb player with the
  `repro_bracket` summary and seek-to-mark, in the work-request triage view (new
  — `ReproReplayPanel` inside `CaptureMediaPanel`).

Deferred (designed, not built — listed so coverage isn't mistaken for complete):

- **L5 live assist** (WebRTC screen-share with operator marks) — infra
  (signaling/TURN/operator viewer) is a separate build.
- **Low-default opt-in seed** for non-reviewer pilot cohorts (see note above) —
  intentionally not built: the dock today is enabled only in review/collab
  contexts, so there is no cohort that wants a low default yet. Add the seed flag
  when one exists rather than shipping unused config.
- **Native/mobile screen video** (ReplayKit/MediaProjection) — only if web
  capture proves insufficient.

## Where it lives

- `apps/web/src/lib/repro-bracket.ts` — the controller (dependency-injected,
  unit-tested).
- `apps/web/src/lib/capture-level.ts` — the opt-in ladder.
- `apps/web/src/lib/capture-hotkeys.ts` — the shortcut layer.
- `apps/web/src/lib/capture-policy.ts` — `buildReproBracketConsentScope` +
  `repro_bracket` artifact kind.
- `apps/api/src/capture-consent-policy.ts` — server allow-list for
  `repro_bracket`.
- `apps/web/src/components/capture/AuthenticatedFeedbackDock.tsx` — the capture
  surface.
- `apps/web/src/lib/repro-replay.ts` — parsers/formatters + the lazy rrweb
  Replayer loader.
- `apps/web/src/components/work-requests/ReproReplayPanel.tsx` — the operator-side
  viewer (summary + in-app playback + seek-to-mark), mounted by
  `CaptureMediaPanel.tsx`.
