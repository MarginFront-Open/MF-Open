import { format as fnsFormat } from 'date-fns'
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a date string
 * @param dateString - The date string to format
 * @param formatString - The format string to use (default: MMM d, yyyy)
 * @returns Formatted date string
 */
export function formatDate(
  dateString: string,
  formatString = 'MMM d, yyyy'
): string {
  try {
    const date = new Date(dateString)
    return fnsFormat(date, formatString)
  } catch (error) {
    console.error('Error formatting date:', error)
    return dateString
  }
}
