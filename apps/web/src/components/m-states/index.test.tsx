import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  MEmptyState,
  MErrorState,
  MOfflineHeader,
  MPermissionState,
  MSkeletonList,
  MSkeletonRow,
  MUpdateState,
} from './index'

afterEach(cleanup)

describe('MOfflineHeader', () => {
  it('renders the queued-count message with singular wording for 1', () => {
    render(<MOfflineHeader queuedCount={1} />)
    expect(screen.getByText(/1 change will sync/)).toBeTruthy()
  })

  it('pluralizes the queued-count message for more than 1', () => {
    render(<MOfflineHeader queuedCount={3} />)
    expect(screen.getByText(/3 changes will sync/)).toBeTruthy()
  })

  it('renders a Retry button only when onRetry is given, and fires it', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<MOfflineHeader queuedCount={2} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    rerender(<MOfflineHeader queuedCount={2} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('MErrorState', () => {
  it('renders title and body', () => {
    render(<MErrorState title="Sync failed" body="QuickBooks is unreachable." />)
    expect(screen.getByText('Sync failed')).toBeTruthy()
    expect(screen.getByText('QuickBooks is unreachable.')).toBeTruthy()
  })

  it('fires the primary (retry) callback', () => {
    const onPrimary = vi.fn()
    render(<MErrorState title="Oops" body="x" primaryLabel="Try again" onPrimary={onPrimary} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
  })

  it('fires the secondary callback when present', () => {
    const onSecondary = vi.fn()
    render(
      <MErrorState title="Oops" body="x" primaryLabel="Retry" secondaryLabel="Go back" onSecondary={onSecondary} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(onSecondary).toHaveBeenCalledTimes(1)
  })

  it('renders no action buttons when no labels are passed', () => {
    render(<MErrorState title="Quiet" body="No CTAs here" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('MEmptyState', () => {
  it('renders title, body, and fires the primary CTA', () => {
    const onPrimary = vi.fn()
    render(
      <MEmptyState
        title="No projects yet"
        body="Start with an address."
        primaryLabel="New project"
        onPrimary={onPrimary}
      />,
    )
    expect(screen.getByText('No projects yet')).toBeTruthy()
    expect(screen.getByText('Start with an address.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
  })

  it('renders the secondary label when provided', () => {
    render(<MEmptyState title="Empty" body="x" primaryLabel="A" secondaryLabel="Import from QuickBooks" />)
    expect(screen.getByRole('button', { name: 'Import from QuickBooks' })).toBeTruthy()
  })
})

describe('MSkeletonList / MSkeletonRow', () => {
  it('renders the default 5 skeleton rows', () => {
    const { container } = render(<MSkeletonList />)
    expect(container.querySelectorAll('.m-list-row')).toHaveLength(5)
  })

  it('renders the requested number of rows', () => {
    const { container } = render(<MSkeletonList count={3} />)
    expect(container.querySelectorAll('.m-list-row')).toHaveLength(3)
  })

  it('marks each skeleton row with aria-busy for assistive tech', () => {
    const { container } = render(<MSkeletonRow />)
    expect(container.querySelector('.m-list-row')?.getAttribute('aria-busy')).toBe('true')
  })
})

describe('MPermissionState', () => {
  it('renders title, body, and a default "Open settings" primary CTA', () => {
    const onPrimary = vi.fn()
    render(
      <MPermissionState
        title="Location needed"
        body="We use your location to auto clock-in at the jobsite."
        onPrimary={onPrimary}
      />,
    )
    expect(screen.getByText('Location needed')).toBeTruthy()
    const primary = screen.getByRole('button', { name: 'Open settings' })
    fireEvent.click(primary)
    expect(onPrimary).toHaveBeenCalledTimes(1)
  })

  it('allows overriding the primary label and rendering a secondary action', () => {
    const onSecondary = vi.fn()
    render(
      <MPermissionState
        title="Notifications"
        body="x"
        primaryLabel="Enable"
        secondaryLabel="Not now"
        onSecondary={onSecondary}
      />,
    )
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onSecondary).toHaveBeenCalledTimes(1)
  })

  it('renders a custom icon when provided', () => {
    render(<MPermissionState title="Camera" body="x" icon={<span data-testid="cam-icon">cam</span>} />)
    expect(screen.getByTestId('cam-icon')).toBeTruthy()
  })

  it('renders the WHEN ENABLED benefits list when benefits are provided', () => {
    render(
      <MPermissionState
        title="Location is off."
        body="x"
        benefits={['Auto clock-in on arrival', 'Live crew map', 'Out-of-fence alerts']}
      />,
    )
    expect(screen.getByText('When enabled')).toBeTruthy()
    expect(screen.getByText('Auto clock-in on arrival')).toBeTruthy()
    expect(screen.getByText('Live crew map')).toBeTruthy()
    expect(screen.getByText('Out-of-fence alerts')).toBeTruthy()
  })

  it('omits the benefits box when no benefits are passed', () => {
    render(<MPermissionState title="Location is off." body="x" />)
    expect(screen.queryByText('When enabled')).toBeNull()
  })
})

describe('MUpdateState', () => {
  it('renders the eyebrow, headline, body, and WHAT’S NEW list', () => {
    render(
      <MUpdateState
        title="Sitelayer got an update."
        body="Reload to keep using. Your work is safe."
        changes={['AI auto-takeoff drafts', 'Faster offline sync']}
      />,
    )
    expect(screen.getByText('● New version')).toBeTruthy()
    expect(screen.getByText('Sitelayer got an update.')).toBeTruthy()
    expect(screen.getByText("What's new")).toBeTruthy()
    expect(screen.getByText('AI auto-takeoff drafts')).toBeTruthy()
  })

  it('fires the reload (primary) and later (secondary) callbacks', () => {
    const onPrimary = vi.fn()
    const onSecondary = vi.fn()
    render(<MUpdateState title="Update" body="x" onPrimary={onPrimary} onSecondary={onSecondary} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload app' }))
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(onSecondary).toHaveBeenCalledTimes(1)
  })

  it('omits the WHAT’S NEW box when no changes are passed', () => {
    render(<MUpdateState title="Update" body="x" />)
    expect(screen.queryByText("What's new")).toBeNull()
  })
})
