/**
 * Safe localStorage wrapper that handles SSR
 * Works on both client and server without typeof window checks
 */
export const storage = {
  /**
   * Get item from localStorage
   * @param key - The key to retrieve
   * @returns The value or null if not found or running on server
   */
  getItem: (key: string): string | null => {
    if (typeof window === 'undefined') return null
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },

  /**
   * Set item in localStorage
   * @param key - The key to set
   * @param value - The value to store
   */
  setItem: (key: string, value: string): void => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(key, value)
    } catch {
      // Silently fail if localStorage is not available
    }
  },

  /**
   * Remove item from localStorage
   * @param key - The key to remove
   */
  removeItem: (key: string): void => {
    if (typeof window === 'undefined') return
    try {
      localStorage.removeItem(key)
    } catch {
      // Silently fail if localStorage is not available
    }
  },

  /**
   * Clear all items from localStorage
   */
  clear: (): void => {
    if (typeof window === 'undefined') return
    try {
      localStorage.clear()
    } catch {
      // Silently fail if localStorage is not available
    }
  },
}
