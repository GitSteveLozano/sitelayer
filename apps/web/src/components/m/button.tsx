import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type MButtonProps = {
  variant?: 'primary' | 'ghost' | 'quiet'
  size?: 'sm' | 'md'
  children: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>

export function MButton({ variant = 'primary', size = 'md', className, children, ...rest }: MButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`m-btn${size === 'sm' ? ' m-btn-sm' : ''}${className ? ` ${className}` : ''}`}
      data-variant={variant}
    >
      {children}
    </button>
  )
}

export function MButtonRow({ children }: { children: ReactNode }) {
  return <div className="m-btn-row">{children}</div>
}

export function MButtonStack({ children }: { children: ReactNode }) {
  return <div className="m-btn-stack">{children}</div>
}
