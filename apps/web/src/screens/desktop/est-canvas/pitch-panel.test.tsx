import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PitchPanel } from './mobile-components'

afterEach(cleanup)

describe('PitchPanel', () => {
  it('renders the rise/run inputs with the current values', () => {
    render(<PitchPanel rise="6" run="12" onRise={() => {}} onRun={() => {}} factor={1.118} />)
    expect((screen.getByLabelText('Pitch rise') as HTMLInputElement).value).toBe('6')
    expect((screen.getByLabelText('Pitch run') as HTMLInputElement).value).toBe('12')
  })

  it('shows the slope multiplier (×factor)', () => {
    render(<PitchPanel rise="6" run="12" onRise={() => {}} onRun={() => {}} factor={1.118} />)
    expect(screen.getByText('×1.118')).toBeTruthy()
  })

  it('shows ×1.000 when flat (factor 1)', () => {
    render(<PitchPanel rise="" run="12" onRise={() => {}} onRun={() => {}} factor={1} />)
    expect(screen.getByText('×1.000')).toBeTruthy()
  })

  it('edits rise/run through the callbacks', () => {
    const onRise = vi.fn()
    const onRun = vi.fn()
    render(<PitchPanel rise="" run="12" onRise={onRise} onRun={onRun} factor={1} />)
    fireEvent.change(screen.getByLabelText('Pitch rise'), { target: { value: '8' } })
    expect(onRise).toHaveBeenCalledWith('8')
    fireEvent.change(screen.getByLabelText('Pitch run'), { target: { value: '24' } })
    expect(onRun).toHaveBeenCalledWith('24')
  })

  it('applies a roof preset (rise=N, run=12) on click', () => {
    const onRise = vi.fn()
    const onRun = vi.fn()
    render(<PitchPanel rise="" run="12" onRise={onRise} onRun={onRun} factor={1} />)
    fireEvent.click(screen.getByRole('button', { name: '8/12' }))
    expect(onRise).toHaveBeenCalledWith('8')
    expect(onRun).toHaveBeenCalledWith('12')
  })
})
