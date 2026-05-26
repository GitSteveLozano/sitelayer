import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { MInput, MSelect, MTextarea } from './form'

// NOTE: the task brief referenced `input.tsx`, but the mobile input
// primitive (MInput) and its siblings live in `form.tsx`. This file
// sits next to that source.

afterEach(cleanup)

describe('MInput', () => {
  it('renders an input with the m-input class', () => {
    render(<MInput placeholder="Name" />)
    const el = screen.getByPlaceholderText('Name')
    expect(el.tagName).toBe('INPUT')
    expect(el.className).toContain('m-input')
  })

  it('merges a caller className alongside m-input', () => {
    render(<MInput placeholder="X" className="extra" />)
    const el = screen.getByPlaceholderText('X')
    expect(el.className).toContain('m-input')
    expect(el.className).toContain('extra')
  })

  it('forwards value/onChange and arbitrary attributes', () => {
    const onChange = vi.fn()
    render(<MInput value="abc" onChange={onChange} type="search" aria-label="Search field" />)
    const el = screen.getByLabelText('Search field') as HTMLInputElement
    expect(el.value).toBe('abc')
    expect(el.getAttribute('type')).toBe('search')
    fireEvent.change(el, { target: { value: 'abcd' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('forwards a ref to the underlying input', () => {
    const ref = createRef<HTMLInputElement>()
    render(<MInput ref={ref} placeholder="R" />)
    expect(ref.current).toBeInstanceOf(HTMLInputElement)
  })
})

describe('MTextarea', () => {
  it('renders a textarea with m-input m-textarea classes', () => {
    render(<MTextarea placeholder="Notes" />)
    const el = screen.getByPlaceholderText('Notes')
    expect(el.tagName).toBe('TEXTAREA')
    expect(el.className).toContain('m-input')
    expect(el.className).toContain('m-textarea')
  })

  it('forwards a ref', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<MTextarea ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement)
  })
})

describe('MSelect', () => {
  it('renders a select with options and m-input class', () => {
    render(
      <MSelect aria-label="Pick">
        <option value="a">A</option>
        <option value="b">B</option>
      </MSelect>,
    )
    const el = screen.getByLabelText('Pick') as HTMLSelectElement
    expect(el.tagName).toBe('SELECT')
    expect(el.className).toContain('m-input')
    expect(el.querySelectorAll('option')).toHaveLength(2)
  })

  it('fires onChange when a new option is chosen', () => {
    const onChange = vi.fn()
    render(
      <MSelect aria-label="Pick" value="a" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </MSelect>,
    )
    fireEvent.change(screen.getByLabelText('Pick'), { target: { value: 'b' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
