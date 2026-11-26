import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from './ui'

/**
 * Drag handle for a resizable pane.
 *
 * The pointer is captured on the handle itself, so a fast drag that outruns the
 * cursor keeps resizing instead of dropping the gesture the moment it leaves
 * the 6px strip.
 */
export function Splitter({
  orientation = 'horizontal',
  onResize,
  onDoubleClick
}: {
  /** `horizontal` splits top/bottom; `vertical` splits left/right. */
  orientation?: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  onDoubleClick?: () => void
}): ReactNode {
  const [dragging, setDragging] = useState(false)
  const last = useRef(0)

  const handleMove = useCallback(
    (event: PointerEvent) => {
      const position = orientation === 'horizontal' ? event.clientY : event.clientX
      const delta = position - last.current
      last.current = position
      if (delta !== 0) onResize(delta)
    },
    [onResize, orientation]
  )

  useEffect(() => {
    if (!dragging) return
    const stop = (): void => setDragging(false)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging, handleMove])

  const isHorizontal = orientation === 'horizontal'

  return (
    <div
      role="separator"
      aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        last.current = isHorizontal ? e.clientY : e.clientX
        setDragging(true)
      }}
      className={cx(
        'group relative shrink-0 touch-none',
        isHorizontal ? 'h-1.5 w-full cursor-row-resize' : 'h-full w-1.5 cursor-col-resize'
      )}
    >
      {/* A thin line normally, brand-tinted while grabbed — the hit area stays
          6px so it is actually catchable. */}
      <div
        className={cx(
          'absolute rounded-full transition-colors duration-[var(--duration-fast)]',
          isHorizontal
            ? 'top-1/2 right-0 left-0 h-px -translate-y-1/2 group-hover:h-0.5'
            : 'top-0 bottom-0 left-1/2 w-px -translate-x-1/2 group-hover:w-0.5',
          dragging ? 'bg-[var(--accent)]' : 'bg-[var(--border)] group-hover:bg-[var(--accent)]'
        )}
      />
    </div>
  )
}

/** Clamps a pane size to a sensible range while dragging. */
export function clampSize(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
