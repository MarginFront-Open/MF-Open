/**
 * Swipe Navigation Hook
 * Enables touch gesture navigation between onboarding steps
 */
import { useCallback, useEffect, useRef, useState, RefObject } from 'react'

export interface UseSwipeNavigationOptions {
  /**
   * Minimum swipe distance to trigger navigation (in pixels)
   * @default 50
   */
  threshold?: number

  /**
   * Maximum time for swipe gesture (in milliseconds)
   * @default 500
   */
  maxSwipeTime?: number

  /**
   * Callback when user swipes left (next step)
   */
  onSwipeLeft?: () => void

  /**
   * Callback when user swipes right (previous step)
   */
  onSwipeRight?: () => void

  /**
   * Whether swipe navigation is enabled
   * @default true
   */
  enabled?: boolean

  /**
   * Whether to allow swiping left (next)
   * @default true
   */
  canSwipeLeft?: boolean

  /**
   * Whether to allow swiping right (back)
   * @default true
   */
  canSwipeRight?: boolean
}

export interface UseSwipeNavigationReturn {
  /**
   * Ref to attach to the swipeable container
   */
  containerRef: RefObject<HTMLDivElement | null>

  /**
   * Current swipe offset (for animation)
   */
  swipeOffset: number

  /**
   * Whether a swipe is currently in progress
   */
  isSwiping: boolean

  /**
   * Current swipe direction
   */
  swipeDirection: 'left' | 'right' | null

  /**
   * Touch event handlers (for manual attachment)
   */
  handlers: {
    onTouchStart: (e: React.TouchEvent | TouchEvent) => void
    onTouchMove: (e: React.TouchEvent | TouchEvent) => void
    onTouchEnd: (e: React.TouchEvent | TouchEvent) => void
  }
}

export function useSwipeNavigation(
  options: UseSwipeNavigationOptions = {}
): UseSwipeNavigationReturn {
  const {
    threshold = 50,
    maxSwipeTime = 500,
    onSwipeLeft,
    onSwipeRight,
    enabled = true,
    canSwipeLeft = true,
    canSwipeRight = true,
  } = options

  const containerRef = useRef<HTMLDivElement>(null)

  // Swipe state
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(
    null
  )

  // Touch tracking refs
  const touchStartX = useRef<number>(0)
  const touchStartY = useRef<number>(0)
  const touchStartTime = useRef<number>(0)
  const isHorizontalSwipe = useRef<boolean | null>(null)

  const handleTouchStart = useCallback(
    (e: React.TouchEvent | TouchEvent) => {
      if (!enabled) return

      const touch = e.touches[0]
      touchStartX.current = touch.clientX
      touchStartY.current = touch.clientY
      touchStartTime.current = Date.now()
      isHorizontalSwipe.current = null
      setIsSwiping(true)
    },
    [enabled]
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent | TouchEvent) => {
      if (!enabled || !isSwiping) return

      const touch = e.touches[0]
      const deltaX = touch.clientX - touchStartX.current
      const deltaY = touch.clientY - touchStartY.current

      // Determine swipe direction on first significant movement
      if (isHorizontalSwipe.current === null) {
        const absX = Math.abs(deltaX)
        const absY = Math.abs(deltaY)

        if (absX > 10 || absY > 10) {
          isHorizontalSwipe.current = absX > absY
        }
      }

      // Only track horizontal swipes
      if (isHorizontalSwipe.current) {
        // Limit swipe range and apply resistance at edges
        const maxSwipe = 150
        const resistance = 0.5

        let constrainedOffset = deltaX
        if (deltaX > 0 && !canSwipeRight) {
          constrainedOffset = deltaX * 0.2 // Strong resistance
        } else if (deltaX < 0 && !canSwipeLeft) {
          constrainedOffset = deltaX * 0.2 // Strong resistance
        } else if (Math.abs(deltaX) > maxSwipe) {
          const sign = deltaX > 0 ? 1 : -1
          constrainedOffset =
            sign * (maxSwipe + (Math.abs(deltaX) - maxSwipe) * resistance)
        }

        setSwipeOffset(constrainedOffset)
        setSwipeDirection(deltaX > 0 ? 'right' : 'left')

        // Prevent vertical scroll while horizontal swiping
        e.preventDefault()
      }
    },
    [enabled, isSwiping, canSwipeLeft, canSwipeRight]
  )

  const handleTouchEnd = useCallback(
    (_e: React.TouchEvent | TouchEvent) => {
      if (!enabled) return

      const deltaX = swipeOffset
      const swipeTime = Date.now() - touchStartTime.current

      // Check if swipe meets threshold and time requirements
      const isValidSwipe =
        Math.abs(deltaX) >= threshold &&
        swipeTime <= maxSwipeTime &&
        isHorizontalSwipe.current

      if (isValidSwipe) {
        if (deltaX < 0 && canSwipeLeft && onSwipeLeft) {
          // Swipe left -> next step
          onSwipeLeft()
        } else if (deltaX > 0 && canSwipeRight && onSwipeRight) {
          // Swipe right -> previous step
          onSwipeRight()
        }
      }

      // Reset state
      setSwipeOffset(0)
      setIsSwiping(false)
      setSwipeDirection(null)
      isHorizontalSwipe.current = null
    },
    [
      enabled,
      swipeOffset,
      threshold,
      maxSwipeTime,
      canSwipeLeft,
      canSwipeRight,
      onSwipeLeft,
      onSwipeRight,
    ]
  )

  // Attach event listeners to container
  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    // Use passive: false to allow preventDefault
    const touchMoveOptions = { passive: false }

    container.addEventListener('touchstart', handleTouchStart as EventListener)
    container.addEventListener(
      'touchmove',
      handleTouchMove as EventListener,
      touchMoveOptions
    )
    container.addEventListener('touchend', handleTouchEnd as EventListener)

    return () => {
      container.removeEventListener(
        'touchstart',
        handleTouchStart as EventListener
      )
      container.removeEventListener(
        'touchmove',
        handleTouchMove as EventListener
      )
      container.removeEventListener('touchend', handleTouchEnd as EventListener)
    }
  }, [enabled, handleTouchStart, handleTouchMove, handleTouchEnd])

  return {
    containerRef,
    swipeOffset,
    isSwiping,
    swipeDirection,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  }
}

export default useSwipeNavigation
