import { useEffect, useRef, useState } from 'react'
import { createCompany, type CompaniesResponse } from '../api.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { toastError, toastSuccess } from './ui/toast.js'

type CompanySwitcherProps = {
  companies: CompaniesResponse['companies']
  activeSlug: string
  onSelect: (slug: string) => void
  onCreated?: () => void
}

// Compact dropdown switcher for the auth header. Returns null for users with a
// single membership so it stays out of the way.
export function CompanySwitcher({ companies, activeSlug, onSelect, onCreated }: CompanySwitcherProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false)
        setCreating(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  if (!companies.length) return null
  if (companies.length === 1 && !creating) {
    // Hide entirely when only one membership exists (no switching needed)
    return null
  }

  const active = companies.find((entry) => entry.slug === activeSlug) ?? companies[0]

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedSlug = slug.trim().toLowerCase()
    const trimmedName = name.trim()
    if (!trimmedSlug || !trimmedName) {
      toastError('Company details required', 'Both slug and name are required.')
      return
    }
    try {
      setBusy(true)
      const response = await createCompany({ slug: trimmedSlug, name: trimmedName }, activeSlug)
      toastSuccess('Company created', response.company.name)
      onSelect(response.company.slug)
      setCreating(false)
      setSlug('')
      setName('')
      setOpen(false)
      onCreated?.()
    } catch (caught: unknown) {
      toastError('Could not create company', caught instanceof Error ? caught.message : 'Unknown error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        data-testid="company-switcher-toggle"
      >
        <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {active?.name ?? activeSlug}
        </span>
        <span aria-hidden="true" style={{ opacity: 0.6, marginLeft: 6 }}>
          ▾
        </span>
      </Button>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 240,
            background: 'var(--surface, #0f172a)',
            color: 'var(--foreground, #e2e8f0)',
            border: '1px solid rgba(148, 163, 184, 0.35)',
            borderRadius: 8,
            padding: 6,
            boxShadow: '0 12px 32px rgba(15, 23, 42, 0.4)',
            zIndex: 50,
          }}
        >
          {creating ? (
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 4 }}>
              <Input
                aria-label="Company slug"
                placeholder="acme-construction"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
              />
              <Input
                aria-label="Company name"
                placeholder="Acme Construction"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <ul
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                {companies.map((company) => {
                  const isActive = company.slug === activeSlug
                  return (
                    <li key={company.id}>
                      <Button
                        type="button"
                        variant={isActive ? 'secondary' : 'ghost'}
                        size="sm"
                        style={{ width: '100%', justifyContent: 'flex-start' }}
                        onClick={() => {
                          onSelect(company.slug)
                          setOpen(false)
                        }}
                      >
                        <span style={{ flex: 1, textAlign: 'left' }}>{company.name}</span>
                        {isActive ? (
                          <span aria-hidden="true" style={{ opacity: 0.7 }}>
                            ✓
                          </span>
                        ) : null}
                      </Button>
                    </li>
                  )
                })}
              </ul>
              <div style={{ borderTop: '1px solid rgba(148, 163, 184, 0.2)', marginTop: 6, paddingTop: 6 }}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => setCreating(true)}
                >
                  + Create company
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
