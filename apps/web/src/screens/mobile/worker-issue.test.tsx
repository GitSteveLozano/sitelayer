import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { WorkerIssue } from './worker-issue'

describe('WorkerIssue', () => {
  it('does not present the category tile step as the final foreman send', () => {
    render(
      <MemoryRouter>
        <WorkerIssue bootstrap={null} companySlug="acme" />
      </MemoryRouter>,
    )

    const next = screen.getByRole('button', { name: /add details/i }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /send to foreman/i })).toBeNull()

    fireEvent.click(screen.getByText('Out of materials'))

    expect(screen.getByText(/NO PING SENT YET/i)).toBeTruthy()
    expect(next.disabled).toBe(false)

    fireEvent.click(next)

    expect(screen.getByText("What's wrong?")).toBeTruthy()
    expect(screen.getByRole('button', { name: /send to foreman/i })).toBeTruthy()
  })
})
