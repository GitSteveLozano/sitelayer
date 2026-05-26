import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MBanner } from './banner'

afterEach(cleanup)

describe('MBanner', () => {
  it('renders the title', () => {
    render(<MBanner title="Estimate posted" />)
    expect(screen.getByText('Estimate posted')).toBeTruthy()
  })

  it('renders optional body text', () => {
    render(<MBanner title="Synced" body="3 invoices pushed to QuickBooks" />)
    expect(screen.getByText('3 invoices pushed to QuickBooks')).toBeTruthy()
  })

  it('uses role="status" + polite aria-live for non-error tones', () => {
    const { container } = render(<MBanner tone="ok" title="Done" />)
    const banner = container.querySelector('.m-banner')!
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.getAttribute('aria-live')).toBe('polite')
    expect(banner.getAttribute('data-tone')).toBe('ok')
  })

  it('uses role="alert" + assertive aria-live for the error tone', () => {
    const { container } = render(<MBanner tone="error" title="Push failed" />)
    const banner = container.querySelector('.m-banner')!
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.getAttribute('aria-live')).toBe('assertive')
    expect(banner.getAttribute('data-tone')).toBe('error')
  })

  it('treats the default amber-warn tone as status with no data-tone attr', () => {
    // warn is the implicit default — the component strips data-tone for it.
    const { container } = render(<MBanner tone="warn" title="Heads up" />)
    const banner = container.querySelector('.m-banner')!
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.getAttribute('data-tone')).toBeNull()
  })

  it('renders the action slot when provided', () => {
    render(<MBanner tone="info" title="Update available" action={<button type="button">Reload</button>} />)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('renders a custom icon over the default', () => {
    render(<MBanner title="Custom" icon={<span data-testid="custom-icon">!</span>} />)
    expect(screen.getByTestId('custom-icon')).toBeTruthy()
  })
})
