import { afterEach, describe, expect, it } from 'vitest'
import { normalizeProposal, proposeNarrativeStub, resolveVoiceToLogMode } from './voice-to-log-agent.js'

const ENV_KEYS = ['VOICE_TO_LOG_MODE', 'ANTHROPIC_API_KEY', 'VOICE_TO_LOG_MODEL'] as const
const saved: Record<string, string | undefined> = {}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
    delete saved[key]
  }
})

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('resolveVoiceToLogMode', () => {
  it('defaults to dry-run with no env', () => {
    setEnv('VOICE_TO_LOG_MODE', undefined)
    setEnv('ANTHROPIC_API_KEY', undefined)
    expect(resolveVoiceToLogMode()).toBe('dry-run')
  })

  it('stays dry-run when mode=live but no key', () => {
    setEnv('VOICE_TO_LOG_MODE', 'live')
    setEnv('ANTHROPIC_API_KEY', undefined)
    expect(resolveVoiceToLogMode()).toBe('dry-run')
  })

  it('stays dry-run when key set but mode unset', () => {
    setEnv('VOICE_TO_LOG_MODE', undefined)
    setEnv('ANTHROPIC_API_KEY', 'sk-test')
    expect(resolveVoiceToLogMode()).toBe('dry-run')
  })

  it('is live only when mode=live AND key present', () => {
    setEnv('VOICE_TO_LOG_MODE', 'live')
    setEnv('ANTHROPIC_API_KEY', 'sk-test')
    expect(resolveVoiceToLogMode()).toBe('live')
  })
})

describe('proposeNarrativeStub', () => {
  it('returns low confidence for short transcripts', () => {
    const p = proposeNarrativeStub('Poured footings.')
    expect(p.confidence).toBe('low')
    expect(p.narrative).toBe('Poured footings.')
  })

  it('extracts a weather hint and schedule deviation', () => {
    const transcript =
      'Heavy rain this morning slowed us down. ' +
      'We are behind on the south wall framing. ' +
      'Crew of four worked through the afternoon once it cleared. ' +
      'Material delivery arrived on time and staging is set for tomorrow. ' +
      'Overall a productive day despite the wet start and the early delay.'
    const p = proposeNarrativeStub(transcript)
    expect(p.weather_summary).toContain('rain')
    expect(p.schedule_deviations.length).toBeGreaterThan(0)
    expect(['low', 'med', 'high']).toContain(p.confidence)
  })
})

describe('normalizeProposal', () => {
  it('clamps a bad confidence to med and falls back to the transcript', () => {
    const p = normalizeProposal({ confidence: 'wild' as never }, '  Did   stuff  today.  ')
    expect(p.confidence).toBe('med')
    expect(p.narrative).toBe('Did stuff today.')
    expect(p.weather_summary).toBeNull()
    expect(p.schedule_deviations).toEqual([])
  })

  it('keeps valid fields and caps deviations at 3', () => {
    const p = normalizeProposal(
      {
        narrative: 'Good day.',
        weather_summary: 'Sunny',
        schedule_deviations: ['a', 'b', 'c', 'd', ''],
        confidence: 'high',
        rationale: 'Clear transcript',
      },
      'raw',
    )
    expect(p.narrative).toBe('Good day.')
    expect(p.weather_summary).toBe('Sunny')
    expect(p.schedule_deviations).toEqual(['a', 'b', 'c'])
    expect(p.confidence).toBe('high')
  })
})
