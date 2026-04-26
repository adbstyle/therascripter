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
  const ref = useRef<HTMLHeadingElement | null>(null)
  const originalRef = useRef(title)

  useEffect(() => {
    originalRef.current = title
    if (ref.current && document.activeElement !== ref.current) {
      ref.current.textContent = title
    }
  }, [title])

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
      ref={ref}
      className={`session-title outline-none focus:ring-1 focus:ring-primary rounded-sm ${className ?? ''}`}
      contentEditable
      suppressContentEditableWarning
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      aria-label="Sitzungstitel bearbeiten"
      data-placeholder={fallback}
    >
      {title}
    </h2>
  )
}
