import { useRef, useEffect } from 'react'
import type { KeyboardEvent, FocusEvent } from 'react'
import type { SummaryRecord } from '../../../../shared/types/IpcApi'

interface Props {
  sessionId: string
  title: string
  /**
   * Issue #203 — set in the Klartext view: shown instead of the editable
   * title, read-only (AK 8). null/undefined: the editable title.
   */
  readOnlyText?: string | null
  fallback: string
  /** `record` carries the title's new token snapshot (#203). */
  onSaved?: (next: string, record: SummaryRecord | null) => void
  className?: string
}

export function EditableSessionTitle({
  sessionId,
  title,
  readOnlyText,
  fallback,
  onSaved,
  className
}: Props): React.JSX.Element {
  // The DOM text content is always the actual title (empty string if user cleared it).
  // The fallback is shown via CSS ::before from data-placeholder, never as real text —
  // this avoids accidentally promoting the fallback string to a real title when the user
  // focuses + blurs an empty field.
  //
  // We deliberately render the h2 with NO React-controlled child. The `title` text is
  // written imperatively via the useEffect below. If we used `{title}` as JSX child,
  // the reconciler would clobber the user's draft any time the parent re-renders with
  // a new `title` prop while the field is focused. Imperative writes give us a single
  // gate (focus check) to decide whether to overwrite.
  const ref = useRef<HTMLHeadingElement | null>(null)
  const originalRef = useRef(title)

  useEffect(() => {
    originalRef.current = title
    if (ref.current && document.activeElement !== ref.current) {
      ref.current.textContent = title
    }
  }, [title])

  // First-mount paint: ref is set after the empty render but before useEffect can
  // run synchronously, so populate textContent here too. Without this the h2 shows
  // the CSS placeholder briefly even when title is non-empty.
  const setRef = (el: HTMLHeadingElement | null): void => {
    ref.current = el
    if (el && document.activeElement !== el && el.textContent !== title) {
      el.textContent = title
    }
  }

  const commit = (el: HTMLElement): void => {
    const next = (el.textContent ?? '').trim()
    if (next === originalRef.current) return
    originalRef.current = next
    window.api.summary
      .updateTitle(sessionId, next)
      .then((record) => onSaved?.(next, record ?? null))
      .catch((err) => {
        console.error('Failed to save title edit', err)
      })
  }

  const onBlur = (e: FocusEvent<HTMLHeadingElement>): void => {
    // Focused state had `overflow-x: auto` (so the user could edit past the
    // visible width); contentEditable auto-scrolls to keep the caret visible.
    // On blur the CSS reverts to the two-line clamp (= overflow: hidden), but the
    // browser preserves scrollLeft through that transition — without this
    // reset the filled state would render the middle of the title with
    // ellipsis on the right, looking like a rendering bug. Resetting here
    // restores the expected "start of title + …" view.
    e.currentTarget.scrollLeft = 0
    commit(e.currentTarget)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLHeadingElement>): void => {
    if (e.key === 'Escape') {
      // Nur die Bearbeitung abbrechen — Esc darf nicht bis zum Editor
      // durchdringen, der damit sonst zurück im Verlauf ginge
      e.stopPropagation()
      e.currentTarget.textContent = originalRef.current
      e.currentTarget.blur()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  if (readOnlyText != null) {
    const empty = readOnlyText.trim().length === 0
    return (
      <h2
        key="read-only"
        className={`session-title line-clamp-2 min-h-9 break-words rounded-lg border border-transparent px-4 py-[7px] leading-5 ${className ?? ''}`}
        title={empty ? undefined : readOnlyText}
      >
        {empty ? <span className="text-text-tertiary">{fallback}</span> : readOnlyText}
      </h2>
    )
  }

  return (
    <h2
      key="editable"
      ref={setRef}
      // Standard inline-edit-title pattern (Linear/Notion/Figma):
      // - Filled (default): looks like a plain bold heading. Wraps to at most
      //   two lines (line-clamp-2, ellipsis after that) so a narrow editor
      //   column does not cut the title after a few words; the transparent
      //   border reserves space so focus does not shift the layout.
      // - Focused: the clamp is lifted so the user edits the whole title; the
      //   border becomes primary (the only other visual change).
      // The contentEditable element shows a text caret on hover by
      // default — that is the discoverability hint, no extra hover chrome
      // needed.
      className={`session-title line-clamp-2 min-h-9 break-words rounded-lg border border-transparent px-4 py-[7px] leading-5 outline-none transition-colors focus:line-clamp-none focus:border-primary ${className ?? ''}`}
      contentEditable
      suppressContentEditableWarning
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      aria-label="Titel bearbeiten"
      data-placeholder={fallback}
    />
  )
}
