import { useRef, useEffect } from 'react'
import type { KeyboardEvent, FocusEvent } from 'react'

interface Props {
  sessionId: string
  title: string
  fallback: string
  onSaved?: (next: string) => void
  className?: string
}

export function EditableSessionTitle({
  sessionId,
  title,
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
      .then(() => onSaved?.(next))
      .catch((err) => {
        console.error('Failed to save title edit', err)
      })
  }

  const onBlur = (e: FocusEvent<HTMLHeadingElement>): void => commit(e.currentTarget)
  const onKeyDown = (e: KeyboardEvent<HTMLHeadingElement>): void => {
    if (e.key === 'Escape') {
      e.currentTarget.textContent = originalRef.current
      e.currentTarget.blur()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  return (
    <h2
      ref={setRef}
      className={`session-title outline-none focus:ring-1 focus:ring-primary rounded-sm ${className ?? ''}`}
      contentEditable
      suppressContentEditableWarning
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      aria-label="Sitzungstitel bearbeiten"
      data-placeholder={fallback}
    />
  )
}
