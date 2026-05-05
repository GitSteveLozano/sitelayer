import clsx, { type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Class-name composition. Match v1's helper signature. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
