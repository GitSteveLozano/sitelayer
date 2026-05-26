import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SVGProps } from 'react'
import { MBottomTabs, type MBottomTabSpec } from './bottom-tabs'

afterEach(cleanup)

// Minimal stand-in for the lucide icon components the real tabs use.
function StubIcon(props: SVGProps<SVGSVGElement> & { size?: number }) {
  const { size, ...rest } = props
  return <svg data-testid="tab-icon" width={size} height={size} {...rest} />
}

const tabs: MBottomTabSpec[] = [
  { id: 'today', label: 'Today', Icon: StubIcon },
  { id: 'projects', label: 'Projects', Icon: StubIcon },
  { id: 'crew', label: 'Crew', Icon: StubIcon, badge: 2 },
  { id: 'me', label: 'Me', Icon: StubIcon, badge: null },
]

describe('MBottomTabs', () => {
  it('renders one labelled button per tab inside a Primary nav', () => {
    const { container } = render(<MBottomTabs tabs={tabs} activeId="today" onSelect={() => {}} />)
    const nav = container.querySelector('nav.m-bottombar')!
    expect(nav.getAttribute('aria-label')).toBe('Primary')
    for (const tab of tabs) {
      expect(screen.getByRole('button', { name: tab.label })).toBeTruthy()
    }
  })

  it('marks only the active tab with data-active', () => {
    const { container } = render(<MBottomTabs tabs={tabs} activeId="projects" onSelect={() => {}} />)
    const buttons = Array.from(container.querySelectorAll('.m-bottombar-tab'))
    const active = buttons.filter((b) => b.getAttribute('data-active') === 'true')
    expect(active).toHaveLength(1)
    expect(active[0]?.textContent).toContain('Projects')
  })

  it('calls onSelect with the tapped tab id', () => {
    const onSelect = vi.fn()
    render(<MBottomTabs tabs={tabs} activeId="today" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Crew' }))
    expect(onSelect).toHaveBeenCalledWith('crew')
  })

  it('renders a badge when a positive count is present and none for null/0', () => {
    const { container } = render(<MBottomTabs tabs={tabs} activeId="today" onSelect={() => {}} />)
    const badges = container.querySelectorAll('.m-tab-badge')
    // Only the "Crew" tab has badge: 2; "me" has null which renders nothing.
    expect(badges).toHaveLength(1)
    expect(badges[0]?.textContent).toBe('2')
  })
})
