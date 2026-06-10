import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ElevationPicker } from './elevation-picker'

afterEach(cleanup)

// The chips carry unique visible text; query by text (the chip <button> is the
// nearest button ancestor of that text node).
const chip = (label: string): HTMLButtonElement => screen.getByText(label).closest('button') as HTMLButtonElement

describe('ElevationPicker', () => {
  it('renders a chip per elevation tag', () => {
    render(<ElevationPicker value={null} onChange={() => {}} />)
    for (const tag of ['none', 'east', 'south', 'west', 'north', 'roof', 'other']) {
      expect(chip(tag)).toBeTruthy()
    }
  })

  it('emits the tag on click, and null for "none"', () => {
    const onChange = vi.fn()
    render(<ElevationPicker value={null} onChange={onChange} />)
    fireEvent.click(chip('north'))
    expect(onChange).toHaveBeenCalledWith('north')
    fireEvent.click(chip('none'))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('marks the active chip via aria-pressed — "none" maps to a null value', () => {
    const { rerender } = render(<ElevationPicker value={null} onChange={() => {}} />)
    expect(chip('none').getAttribute('aria-pressed')).toBe('true')
    expect(chip('roof').getAttribute('aria-pressed')).toBe('false')

    rerender(<ElevationPicker value="roof" onChange={() => {}} />)
    expect(chip('roof').getAttribute('aria-pressed')).toBe('true')
    expect(chip('none').getAttribute('aria-pressed')).toBe('false')
  })
})
