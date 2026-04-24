import * as React from 'react'

import { cn } from '../../lib/utils.js'

const Checkbox = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(({ className, ...props }, ref) => (
  <input
    {...props}
    type="checkbox"
    className={cn(
      'h-4 w-4 rounded border border-input bg-background text-primary accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    ref={ref}
  />
))
Checkbox.displayName = 'Checkbox'

export { Checkbox }
