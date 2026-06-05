import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CaptureArtifactSummary } from '@/lib/api/capture-sessions'
import type { RrwebReplayerLike } from '@/lib/repro-replay'
import { ReproReplayPanel } from './ReproReplayPanel'

afterEach(cleanup)

function artifact(kind: string, id: string): CaptureArtifactSummary {
  return {
    id,
    kind,
    content_type: 'application/json',
    byte_size: 100,
    duration_ms: null,
    pii_level: 'internal',
    access_policy: 'support_only',
    created_at: null,
  }
}

const SUMMARY_JSON = JSON.stringify({
  artifact_type: 'capture.repro_bracket',
  route_path: '/projects/p1',
  duration_ms: 19000,
  start_condition: { note: 'about to push the estimate' },
  end_condition: { note: 'the total doubled' },
  marks: [{ offset_ms: 4000, label: 'total looks wrong', at: null }],
  replay: { enabled: true, event_count: 12 },
})

const RRWEB_JSON = JSON.stringify({
  artifact_type: 'capture.rrweb_replay',
  event_count: 2,
  events: [{ type: 2 }, { type: 3 }],
})

function blobFetcherFor(map: Record<string, string>): (sessionId: string, artifactId: string) => Promise<Blob> {
  return vi.fn(async (_sessionId: string, artifactId: string) => new Blob([map[artifactId] ?? '{}']))
}

describe('ReproReplayPanel', () => {
  it('renders the reproduction summary with start/problem/marks', async () => {
    render(
      <ReproReplayPanel
        captureSessionId="s1"
        reproArtifact={artifact('repro_bracket', 'repro-1')}
        fetchBlob={blobFetcherFor({ 'repro-1': SUMMARY_JSON })}
      />,
    )

    await waitFor(() => expect(screen.getByText('about to push the estimate')).toBeTruthy())
    expect(screen.getByText('the total doubled')).toBeTruthy()
    // Mark chip shows its offset + label.
    expect(screen.getByRole('button', { name: /00:04 · total looks wrong/i })).toBeTruthy()
  })

  it('plays the rrweb replay and enables seeking to marks', async () => {
    const play = vi.fn()
    const fakeReplayer: RrwebReplayerLike = { play, pause: vi.fn(), destroy: vi.fn() }
    const createReplayer = vi.fn(async (_events: unknown[], _root: HTMLElement) => fakeReplayer)

    render(
      <ReproReplayPanel
        captureSessionId="s1"
        reproArtifact={artifact('repro_bracket', 'repro-1')}
        rrwebArtifact={artifact('rrweb', 'rrweb-1')}
        fetchBlob={blobFetcherFor({ 'repro-1': SUMMARY_JSON, 'rrweb-1': RRWEB_JSON })}
        createReplayer={createReplayer}
      />,
    )

    // Mark is present but not seekable until the replay is playing.
    const markBeforePlay = await screen.findByRole('button', { name: /00:04 · total looks wrong/i })
    expect(markBeforePlay).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: /play reproduction/i }))

    await waitFor(() => expect(createReplayer).toHaveBeenCalledTimes(1))
    // createReplayer got the parsed event array.
    expect(createReplayer.mock.calls[0]![0]).toEqual([{ type: 2 }, { type: 3 }])
    expect(play).toHaveBeenCalledTimes(1) // auto-play on load

    // Now the mark seeks into the replay.
    const markAfterPlay = await screen.findByRole('button', { name: /00:04 · total looks wrong/i })
    await waitFor(() => expect(markAfterPlay).toHaveProperty('disabled', false))
    fireEvent.click(markAfterPlay)
    expect(play).toHaveBeenCalledWith(4000)
  })

  it('renders nothing without artifacts', () => {
    const { container } = render(<ReproReplayPanel captureSessionId="s1" />)
    expect(container.firstChild).toBeNull()
  })
})
