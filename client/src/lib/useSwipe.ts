import { useEffect, useRef, useState } from 'react';

interface SwipeOptions {
  /** Fired when the user completes an upward swipe. */
  onSwipeUp: () => void;
  /** Minimum travel in px before a swipe counts. */
  threshold?: number;
  enabled?: boolean;
}

interface SwipeState {
  /** Live vertical offset while dragging, for the follow-the-finger transform. */
  offset: number;
  dragging: boolean;
}

/**
 * Swipe-up-to-next, the primary gesture on mobile.
 *
 * The element follows the finger so the gesture feels physical, snaps back if
 * released short of the threshold, and commits past it. A fast flick counts
 * even if it falls short of the distance threshold.
 */
export function useSwipeUp<T extends HTMLElement>(options: SwipeOptions) {
  const { onSwipeUp, threshold = 90, enabled = true } = options;

  const ref = useRef<T | null>(null);
  const [state, setState] = useState<SwipeState>({ offset: 0, dragging: false });

  // Keep the latest callback without re-binding listeners on every render.
  const handler = useRef(onSwipeUp);
  handler.current = onSwipeUp;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let startY = 0;
    let startX = 0;
    let startTime = 0;
    let tracking = false;
    let horizontal = false;

    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (!touch) return;
      startY = touch.clientY;
      startX = touch.clientX;
      startTime = performance.now();
      tracking = true;
      horizontal = false;
      setState({ offset: 0, dragging: true });
    };

    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking) return;
      const touch = event.touches[0];
      if (!touch) return;

      const dy = touch.clientY - startY;
      const dx = touch.clientX - startX;

      // Let horizontal drags through untouched (text selection, panel swipes).
      if (!horizontal && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) {
        horizontal = true;
        setState({ offset: 0, dragging: false });
        return;
      }
      if (horizontal) return;

      // Upward only; add resistance past the threshold so it feels bounded.
      const raw = Math.min(0, dy);
      const eased = raw < -threshold ? -threshold + (raw + threshold) * 0.35 : raw;
      setState({ offset: eased, dragging: true });
    };

    const onTouchEnd = (): void => {
      if (!tracking) return;
      tracking = false;

      setState((prev) => {
        const elapsed = performance.now() - startTime;
        const velocity = Math.abs(prev.offset) / Math.max(elapsed, 1); // px/ms
        const committed = Math.abs(prev.offset) >= threshold || velocity > 0.55;

        if (committed && !horizontal) {
          // Defer so the state update settles before the view swaps out.
          window.setTimeout(() => handler.current(), 0);
        }
        return { offset: 0, dragging: false };
      });
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled, threshold]);

  return { ref, offset: state.offset, dragging: state.dragging };
}
