import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Banner } from '../Banner'

describe('Banner', () => {
  test('renders title + body with default warn tone', () => {
    const { container } = render(<Banner title="Heads up">Out of EPS</Banner>)
    expect(screen.getByText('Heads up')).toBeTruthy()
    expect(screen.getByText('Out of EPS')).toBeTruthy()
    const root = container.querySelector('[role="status"]')
    expect(root).not.toBeNull()
    expect(root!.className).toContain('bg-warn-soft')
  })

  test('switches container + icon classes for the requested tone', () => {
    const { container } = render(<Banner tone="error">boom</Banner>)
    const root = container.querySelector('[role="status"]')
    expect(root!.className).toContain('bg-bad-soft')
    const iconWrap = root!.querySelector('[aria-hidden="true"]')
    expect(iconWrap).not.toBeNull()
    expect(iconWrap!.className).toContain('text-bad')
  })

  test('renders the action slot when provided', () => {
    render(
      <Banner tone="info" action={<span>act</span>}>
        body
      </Banner>,
    )
    expect(screen.getByText('act')).toBeTruthy()
  })
})
