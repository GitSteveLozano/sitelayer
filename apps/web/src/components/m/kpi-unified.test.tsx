import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Kpi, KpiRow } from './kpi-unified'

afterEach(cleanup)

describe('Kpi (unified)', () => {
  it('defaults to the mobile (m-kpi) class family', () => {
    const { container } = render(<Kpi label="Crew-hrs" value="42" />)
    expect(container.querySelector('.m-kpi')).toBeTruthy()
    expect(container.querySelector('.m-kpi-eyebrow')?.textContent).toBe('Crew-hrs')
    expect(container.querySelector('.m-kpi-val')?.textContent).toContain('42')
    expect(container.querySelector('.d-kpi')).toBeNull()
  })

  it('emits the desktop (d-kpi) class family when dense', () => {
    const { container } = render(<Kpi dense label="Crew-hrs" value="42" />)
    expect(container.querySelector('.d-kpi')).toBeTruthy()
    expect(container.querySelector('.d-kpi-l')?.textContent).toBe('Crew-hrs')
    expect(container.querySelector('.d-kpi-v')?.textContent).toContain('42')
    expect(container.querySelector('.m-kpi')).toBeNull()
  })

  it('passes metaTone straight through to data-tone (mobile vocab)', () => {
    const { container } = render(<Kpi label="Burn" value="$1,200" meta="Live" metaTone="green" />)
    const meta = container.querySelector('.m-kpi-meta')
    expect(meta?.textContent).toBe('Live')
    expect(meta?.getAttribute('data-tone')).toBe('green')
  })

  it('passes metaTone straight through to data-tone (desktop vocab)', () => {
    const { container } = render(<Kpi dense label="Posted" value="3" meta="Synced" metaTone="good" />)
    const meta = container.querySelector('.d-kpi-meta')
    expect(meta?.textContent).toBe('Synced')
    expect(meta?.getAttribute('data-tone')).toBe('good')
  })

  it('applies the desktop accent tone only when dense', () => {
    const { container } = render(<Kpi dense label="AI queue" value="2" tone="accent" />)
    expect(container.querySelector('.d-kpi')?.getAttribute('data-tone')).toBe('accent')
  })

  it('renders the unit span in each mode and omits it when absent', () => {
    const m = render(<Kpi label="Today" value="3" unit="sites" />)
    expect(m.container.querySelector('.m-kpi-unit')?.textContent).toContain('sites')
    cleanup()
    const d = render(<Kpi dense label="Complete" value="35" unit="%" />)
    expect(d.container.querySelector('.d-kpi-unit')?.textContent).toContain('%')
    cleanup()
    const none = render(<Kpi label="Open" value="0" />)
    expect(none.container.querySelector('.m-kpi-unit')).toBeNull()
  })
})

describe('KpiRow (unified)', () => {
  it('defaults to the mobile 2-column row', () => {
    const { container } = render(
      <KpiRow>
        <Kpi label="A" value="1" />
      </KpiRow>,
    )
    const row = container.querySelector('.m-kpi-row')
    expect(row).toBeTruthy()
    expect(row?.className).not.toContain('m-kpi-row-3')
  })

  it('adds the 3-column modifier when cols={3}', () => {
    const { container } = render(
      <KpiRow cols={3}>
        <Kpi label="A" value="1" />
      </KpiRow>,
    )
    expect(container.querySelector('.m-kpi-row')?.className).toContain('m-kpi-row-3')
  })

  it('emits the connected d-kpi-strip when dense', () => {
    const { container } = render(
      <KpiRow dense>
        <Kpi dense label="A" value="1" />
      </KpiRow>,
    )
    expect(container.querySelector('.d-kpi-strip')).toBeTruthy()
    expect(container.querySelector('.m-kpi-row')).toBeNull()
  })
})
