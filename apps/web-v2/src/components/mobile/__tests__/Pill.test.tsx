import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Pill } from '../Pill'

// Render-level smoke for the Pill primitive. Exercises the tone-driven
// className map (which is exactly what the post-cutover token-drift
// polish PRs were chasing in eyeball review) without needing the full
// app shell.

describe('Pill', () => {
  test('renders children with default tone', () => {
    render(<Pill>label</Pill>)
    const node = screen.getByText('label')
    expect(node.dataset.tone).toBe('default')
    expect(node.className).toContain('bg-card-soft')
    expect(node.className).toContain('text-ink-2')
  })

  test('applies the className for the requested tone', () => {
    render(<Pill tone="accent">accent</Pill>)
    const node = screen.getByText('accent')
    expect(node.dataset.tone).toBe('accent')
    expect(node.className).toContain('bg-accent-soft')
    expect(node.className).toContain('text-accent-ink')
  })

  test('renders the dot when withDot is set', () => {
    const { container } = render(
      <Pill tone="good" withDot>
        on
      </Pill>,
    )
    const dot = container.querySelector('span[aria-hidden="true"]')
    expect(dot).not.toBeNull()
  })
})
