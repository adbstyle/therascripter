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
    window.api.summary
      .get(sessionId)
      .then((record) => {
        if (cancelled) return
        if (record && record.text && record.text.length > 0) {
          setText(record.text)
          originalRef.current = record.text
        } else {
          setText(null)
        }
      })
      .catch((err) => {
        // IPC failure (DB closed during shutdown, schema drift, etc.) — degrade
        // to the no-summary state instead of leaving an unhandled rejection. The
        // panel will render nothing, identical to the "no summary exists" path.
        console.error('summary.get failed', err)
        if (!cancelled) setText(null)
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
    <section>
      <p
        className="rounded-sm font-semibold text-text-primary outline-none focus:ring-1 focus:ring-primary"
        style={{ fontSize: '14px', lineHeight: '24px' }}
        contentEditable
        suppressContentEditableWarning
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {text}
      </p>
      <hr className="mt-4 w-12 border-0 border-t border-border-strong" aria-hidden />
    </section>
  )
}
