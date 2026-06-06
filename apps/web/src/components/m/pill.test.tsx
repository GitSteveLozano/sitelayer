import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MChip, MChipRow, MPill } from './pill'

afterEach(cleanup)

describe('MPill', () => {
  it('renders children inside an m-pill span', () => {
    const { container } = render(<MPill>Active</MPill>)
    const pill = container.querySelector('.m-pill')
    expect(pill).toBeTruthy()
    expect(pill?.tagName).toBe('SPAN')
    expect(pill?.textContent).toBe('Active')
  })

  it('reflects the tone via data-tone', () => {
    const { container } = render(<MPill tone="green">Paid</MPill>)
    expect(container.querySelector('.m-pill')?.getAttribute('data-tone')).toBe('green')
  })

  it('renders a leading dot when dot is set', () => {
    const { container } = render(
      <MPill tone="red" dot>
        Overdue
      </MPill>,
    )
    expect(container.querySelector('.m-dot')).toBeTruthy()
  })

  it('omits the dot by default', () => {
    const { container } = render(<MPill tone="amber">Pending</MPill>)
    expect(container.querySelector('.m-dot')).toBeNull()
  })
})

describe('MChip', () => {
  it('renders a button with the chip label', () => {
    render(<MChip>Active</MChip>)
    expect(screen.getByRole('button', { name: /Active/ })).toBeTruthy()
  })

  it('marks active chips via data-active and leaves inactive unset', () => {
    const { container } = render(
      <>
        <MChip active>On</MChip>
        <MChip>Off</MChip>
      </>,
    )
    const [on, off] = Array.from(container.querySelectorAll('.m-chip'))
    expect(on?.getAttribute('data-active')).toBe('true')
    expect(off?.getAttribute('data-active')).toBeNull()
  })

  it('sets data-outline when outline is requested', () => {
    const { container } = render(<MChip outline>Outlined</MChip>)
    expect(container.querySelector('.m-chip')?.getAttribute('data-outline')).toBe('true')
  })

  it('renders the count when provided', () => {
    render(<MChip count={7}>Awaiting</MChip>)
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('fires onClick when tapped', () => {
    const onClick = vi.fn()
    render(<MChip onClick={onClick}>Tap</MChip>)
    fireEvent.click(screen.getByRole('button', { name: 'Tap' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('MChipRow', () => {
  it('wraps children in m-chip-row', () => {
    const { container } = render(
      <MChipRow>
        <MChip>One</MChip>
      </MChipRow>,
    )
    const row = container.querySelector('.m-chip-row')
    expect(row).toBeTruthy()
    expect(row?.querySelector('.m-chip')).toBeTruthy()
  })
})
