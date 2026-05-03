import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'

const TRIGGER_DELAY_MS = 150

export interface SelectionToolbarState {
  /** Bounding rect of the current text selection in viewport coordinates. */
  anchorRect: DOMRect
  /** True when selection is exclusively two-or-more chips with no neutral text. */
  multiChipSelectionOnly: boolean
}

interface UseSelectionToolbarOptions {
  editor: Editor | null
  /** When false (e.g. dialog open, editor unmounted), the toolbar stays hidden. */
  enabled: boolean
  /**
   * Element to attach the selection listeners to. Falls back to the document
   * if not provided. Scoped listeners avoid noise from selections outside the
   * editor (e.g. UI text the user happens to drag-highlight).
   */
  containerRef: React.RefObject<HTMLElement | null>
}

/**
 * Tracks the current editor selection and exposes an anchor for a floating
 * toolbar. Returns null while the toolbar should stay hidden:
 *  - selection is empty / collapsed
 *  - selection has no non-whitespace text characters AND no fully-contained chips
 *  - selection lies entirely inside a single placeholder chip (chip menu owns it)
 *
 * Triggers fire on `mouseup` / `keyup` after a 150 ms debounce. Any `keydown`
 * that is not Shift/Cmd/Ctrl/Alt cancels a pending trigger AND hides an open
 * toolbar — typing replaces the selection, so showing the toolbar would only
 * cause a stutter.
 */
export function useSelectionToolbar({
  editor,
  enabled,
  containerRef
}: UseSelectionToolbarOptions): {
  state: SelectionToolbarState | null
  hide: () => void
} {
  const [state, setState] = useState<SelectionToolbarState | null>(null)
  const triggerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!editor || !enabled) {
      setState(null)
      return
    }

    const target = containerRef.current ?? document
    const cancelPending = (): void => {
      if (triggerTimerRef.current) {
        clearTimeout(triggerTimerRef.current)
        triggerTimerRef.current = null
      }
    }

    const compute = (): void => {
      cancelPending()
      const next = readSelection(editor)
      setState(next)
    }

    const scheduleCompute = (): void => {
      cancelPending()
      triggerTimerRef.current = setTimeout(compute, TRIGGER_DELAY_MS)
    }

    const handleMouseUp = (): void => scheduleCompute()
    const handleKeyUp = (e: KeyboardEvent): void => {
      // Only Shift+Arrow / Shift+Home/End change the selection range. Other
      // keys are noise for selection-tracking purposes.
      if (e.shiftKey || e.key === 'Shift') scheduleCompute()
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Typing replaces the selection — cancel a pending trigger and hide
      // the toolbar so it does not flash for the duration of one keystroke.
      // Modifiers / navigation keys do not replace selection.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key === 'Escape' || e.key.length === 1) {
        cancelPending()
        setState(null)
      }
    }

    target.addEventListener('mouseup', handleMouseUp as EventListener)
    target.addEventListener('keyup', handleKeyUp as EventListener)
    target.addEventListener('keydown', handleKeyDown as EventListener)

    return () => {
      cancelPending()
      target.removeEventListener('mouseup', handleMouseUp as EventListener)
      target.removeEventListener('keyup', handleKeyUp as EventListener)
      target.removeEventListener('keydown', handleKeyDown as EventListener)
    }
  }, [editor, enabled, containerRef])

  const hide = (): void => setState(null)

  return { state, hide }
}

function readSelection(editor: Editor): SelectionToolbarState | null {
  const { state } = editor
  const { selection } = state
  if (selection.empty) return null

  // Walk the range once: count chips fully inside the selection vs. text length.
  let chipCount = 0
  let nonWhitespaceLen = 0
  state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name === 'placeholderChip') {
      const nodeEnd = pos + node.nodeSize
      if (pos >= selection.from && nodeEnd <= selection.to) chipCount++
    } else if (node.isText) {
      const text = node.text ?? ''
      const start = Math.max(pos, selection.from) - pos
      const end = Math.min(pos + node.nodeSize, selection.to) - pos
      const slice = text.slice(start, end)
      // Count non-whitespace characters only — pure-whitespace selections do
      // not warrant a toolbar.
      for (const ch of slice) if (!/\s/.test(ch)) nonWhitespaceLen++
    }
  })

  // Selection has neither real text nor any chip → nothing to act on.
  if (nonWhitespaceLen === 0 && chipCount === 0) return null

  // Selection sits entirely inside a single chip → chip menu owns this case.
  if (nonWhitespaceLen === 0 && chipCount === 1) return null

  const rect = readDomSelectionRect()
  if (!rect) return null

  const multiChipSelectionOnly = chipCount >= 2 && nonWhitespaceLen === 0
  return { anchorRect: rect, multiChipSelectionOnly }
}

function readDomSelectionRect(): DOMRect | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  // jsdom and collapsed ranges return zero-size rects — skip those.
  if (rect.width === 0 && rect.height === 0) return null
  return rect
}
