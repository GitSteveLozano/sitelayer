import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MKpi, MKpiRow } from './kpi'

afterEach(cleanup)

describe('MKpi', () => {
  it('renders label and value', () => {
    render(<MKpi label="Crew-hrs" value="42" />)
    expect(screen.getByText('Crew-hrs')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('renders the unit next to the value', () => {
    const { container } = render(<MKpi label="Today" value="3" unit="sites" />)
    expect(container.querySelector('.m-kpi-unit')?.textContent).toContain('sites')
  })

  it('renders the meta line with its tone when provided', () => {
    const { container } = render(<MKpi label="Burn" value="$1,200" meta="Live" metaTone="green" />)
    const meta = container.querySelector('.m-kpi-meta')
    expect(meta?.textContent).toBe('Live')
    expect(meta?.getAttribute('data-tone')).toBe('green')
  })

  it('omits the meta line when not provided', () => {
    const { container } = render(<MKpi label="Open" value="0" />)
    expect(container.querySelector('.m-kpi-meta')).toBeNull()
  })

  it('omits the unit span when no unit is given', () => {
    const { container } = render(<MKpi label="Open" value="5" />)
    expect(container.querySelector('.m-kpi-unit')).toBeNull()
  })
})

describe('MKpiRow', () => {
  it('defaults to a 2-column row (no -3 modifier)', () => {
    const { container } = render(
      <MKpiRow>
        <MKpi label="A" value="1" />
      </MKpiRow>,
    )
    const row = container.querySelector('.m-kpi-row')!
    expect(row.className).not.toContain('m-kpi-row-3')
  })

  it('adds the 3-column modifier when cols={3}', () => {
    const { container } = render(
      <MKpiRow cols={3}>
        <MKpi label="A" value="1" />
      </MKpiRow>,
    )
    expect(container.querySelector('.m-kpi-row')!.className).toContain('m-kpi-row-3')
  })
})
