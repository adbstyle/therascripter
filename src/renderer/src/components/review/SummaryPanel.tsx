import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, FocusEvent } from 'react'

interface Props {
  sessionId: string
}

export function SummaryPanel({ sessionId }: Props): React.JSX.Element | null {
  const [text, setText] = useState<string | null>(null)
  const originalRef = useRef<string>('')

  useEffect(() => {
    let cancelled = false
    window.api.summary.get(sessionId).then((record) => {
      if (cancelled) return
      if (record && record.text && record.text.length > 0) {
        setText(record.text)
        originalRef.current = record.text
      } else {
        setText(null)
      }
    })
    return (): void => {
      cancelled = true
    }
  }, [sessionId])

  if (text === null) return null

  const commit = (el: HTMLElement): void => {
    const next = (el.textContent ?? '').trim()
    if (next === originalRef.current) return
    originalRef.current = next
    window.api.summary.updateText(sessionId, next).catch((err) => {
      console.error('Failed to save summary edit', err)
    })
  }

  const onBlur = (e: FocusEvent<HTMLParagraphElement>): void => commit(e.currentTarget)
  const onKeyDown = (e: KeyboardEvent<HTMLParagraphElement>): void => {
    if (e.key === 'Escape') {
      e.currentTarget.textContent = originalRef.current
      e.currentTarget.blur()
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1 px-4 py-3">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
        Zusammenfassung
      </h2>
      <p
        className="rounded-sm text-sm leading-relaxed text-text-primary outline-none focus:ring-1 focus:ring-primary"
        contentEditable
        suppressContentEditableWarning
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {text}
      </p>
    </section>
  )
}
