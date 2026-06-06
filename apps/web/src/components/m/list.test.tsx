import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MListInset, MListPlain, MListRow } from './list'

afterEach(cleanup)

describe('MListRow', () => {
  it('renders headline and supporting copy', () => {
    render(<MListRow headline="Acme Tower" supporting="Acme Builders · DRY" />)
    expect(screen.getByText('Acme Tower')).toBeTruthy()
    expect(screen.getByText('Acme Builders · DRY')).toBeTruthy()
  })

  it('renders as a plain div (not a button) when there is no onTap', () => {
    const { container } = render(<MListRow headline="Static" />)
    const row = container.querySelector('.m-list-row')!
    expect(row.tagName).toBe('DIV')
    expect(row.getAttribute('data-tap')).toBeNull()
  })

  it('renders as a button and fires onTap when tappable', () => {
    const onTap = vi.fn()
    render(<MListRow headline="Tap me" onTap={onTap} />)
    const row = screen.getByRole('button', { name: /Tap me/ })
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('data-tap')).toBe('true')
    fireEvent.click(row)
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('renders leading content with its tone', () => {
    const { container } = render(<MListRow headline="With leading" leading={<span>L</span>} leadingTone="green" />)
    const leading = container.querySelector('.m-l-leading')
    expect(leading).toBeTruthy()
    expect(leading?.getAttribute('data-tone')).toBe('green')
  })

  it('renders trailing and badge content', () => {
    render(<MListRow headline="Row" trailing={<span>4.5h</span>} badge={<span data-testid="badge">3</span>} />)
    expect(screen.getByText('4.5h')).toBeTruthy()
    expect(screen.getByTestId('badge')).toBeTruthy()
  })

  it('renders the chevron when chev is set', () => {
    const { container } = render(<MListRow headline="Nav" chev onTap={() => {}} />)
    expect(container.querySelector('.m-chev')).toBeTruthy()
  })

  it('omits the chevron by default', () => {
    const { container } = render(<MListRow headline="No chev" />)
    expect(container.querySelector('.m-chev')).toBeNull()
  })
})

describe('MListInset / MListPlain', () => {
  it('MListInset wraps children in m-list-inset', () => {
    const { container } = render(
      <MListInset>
        <MListRow headline="A" />
      </MListInset>,
    )
    const inset = container.querySelector('.m-list-inset')
    expect(inset).toBeTruthy()
    expect(inset?.querySelector('.m-list-row')).toBeTruthy()
  })

  it('MListPlain wraps children in m-list-plain', () => {
    const { container } = render(
      <MListPlain>
        <MListRow headline="A" />
      </MListPlain>,
    )
    expect(container.querySelector('.m-list-plain')).toBeTruthy()
  })
})
