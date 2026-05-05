/**
 * Mobile form primitives. Thin wrappers around raw HTML form elements
 * with the m-* class system. Lives in components/m/ so it picks up the
 * no-restricted-syntax ESLint exception (raw <input> / <textarea> /
 * <select> are legitimate at the primitive layer).
 *
 * Views should use these instead of raw HTML so the visual treatment
 * stays consistent across the persona screens.
 */
import { forwardRef } from 'react'
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export type MInputProps = InputHTMLAttributes<HTMLInputElement>

export const MInput = forwardRef<HTMLInputElement, MInputProps>(({ className, ...rest }, ref) => (
  <input ref={ref} {...rest} className={`m-input${className ? ` ${className}` : ''}`} />
))
MInput.displayName = 'MInput'

export type MTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export const MTextarea = forwardRef<HTMLTextAreaElement, MTextareaProps>(({ className, ...rest }, ref) => (
  <textarea ref={ref} {...rest} className={`m-input m-textarea${className ? ` ${className}` : ''}`} />
))
MTextarea.displayName = 'MTextarea'

export type MSelectProps = SelectHTMLAttributes<HTMLSelectElement>

export const MSelect = forwardRef<HTMLSelectElement, MSelectProps>(({ className, children, ...rest }, ref) => (
  <select ref={ref} {...rest} className={`m-input${className ? ` ${className}` : ''}`}>
    {children}
  </select>
))
MSelect.displayName = 'MSelect'
