import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DailyLogSubmittedBanner } from './daily-log-submitted-banner'

afterEach(cleanup)

describe('DailyLogSubmittedBanner', () => {
  it('renders a green (ok) confirmation banner with formatted submitted time', () => {
    const { container } = render(<DailyLogSubmittedBanner submittedAt="2026-05-09T17:42:00.000Z" />)
    const banner = container.querySelector('.m-banner')!
    expect(banner.getAttribute('data-tone')).toBe('ok')
    // Title is "Submitted HH:MM" — HH:MM is locale/tz-formatted, so assert the prefix.
    const title = container.querySelector('.m-banner-title')!
    expect(title.textContent?.startsWith('Submitted ')).toBe(true)
    // Falls back to "Your PM will review" when no reviewer name is given.
    expect(screen.getByText(/will review/i)).toBeTruthy()
  })

  it('uses the provided reviewer name in the review copy', () => {
    render(<DailyLogSubmittedBanner submittedAt="2026-05-09T17:42:00.000Z" reviewerName="Sarah" />)
    expect(screen.getByText(/Sarah will review/i)).toBeTruthy()
  })

  it('renders the em-dash placeholder when submittedAt is null', () => {
    const { container } = render(<DailyLogSubmittedBanner submittedAt={null} />)
    const title = container.querySelector('.m-banner-title')!
    expect(title.textContent).toBe('Submitted —')
  })

  it('renders the weekly strip with one dot per log when weekLogs is provided', () => {
    const { container } = render(
      <DailyLogSubmittedBanner
        submittedAt="2026-05-09T17:42:00.000Z"
        weekLogs={[
          { occurred_on: '2026-05-04', status: 'submitted' },
          { occurred_on: '2026-05-05', status: 'draft' },
          { occurred_on: '2026-05-06', status: 'submitted' },
        ]}
      />,
    )
    expect(screen.getByText(/Week of/i)).toBeTruthy()
    // One titled day cell per entry (title carries the date + status).
    expect(container.querySelectorAll('[title]')).toHaveLength(3)
  })

  it('omits the weekly strip when weekLogs is empty or absent', () => {
    const { container } = render(<DailyLogSubmittedBanner submittedAt="2026-05-09T17:42:00.000Z" weekLogs={[]} />)
    expect(screen.queryByText(/Week of/i)).toBeNull()
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
  })
})
