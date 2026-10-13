import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, FocusEvent } from 'react'

interface Props {
  sessionId: string
}

export function SummaryPanel({ sessionId }: Props): React.JSX.Element | null {
  const [text, setText] = useState<string | null>(null)
  // #168 — warum die Zusammenfassung fehlt; 'running' nach «Zusammenfassung erstellen»
  const [missing, setMissing] = useState<'tool-blocked' | 'running' | null>(null)
  const [refetchCounter, setRefetchCounter] = useState(0)
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
          setMissing(null)
          return
        }
        setText(null)
        return window.api.summary.missingReason(sessionId).then((reason) => {
          if (!cancelled) setMissing(reason)
        })
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
  }, [sessionId, refetchCounter])

  // Review-Ungating: der Editor kann offen sein, während die Summarization
  // im Hintergrund noch läuft — bei ihrem task:completed nachladen.
  useEffect(() => {
    return window.api.tasks.onCompleted((data) => {
      if (data.sessionId === sessionId && data.taskType === 'summarization') {
        setRefetchCounter((c) => c + 1)
      }
    })
  }, [sessionId])

  // Ein gescheiterter Versuch (z. B. Werkzeug weiterhin blockiert) meldet sich hier
  useEffect(() => {
    return window.api.summary.onChanged((changed) => {
      if (changed === sessionId) setRefetchCounter((c) => c + 1)
    })
  }, [sessionId])

  if (text === null) {
    if (missing === null) return null
    const regenerate = (): void => {
      setMissing('running')
      window.api.summary
        .regenerate(sessionId)
        .then((started) => {
          if (!started) setRefetchCounter((c) => c + 1)
        })
        .catch(() => setRefetchCounter((c) => c + 1))
    }
    return (
      <section role="status" className="space-y-2 text-sm text-text-secondary">
        {missing === 'running' ? (
          <p>Die Zusammenfassung wird erstellt…</p>
        ) : (
          <>
            <p>
              Die Zusammenfassung fehlt, weil macOS ein Werkzeug von Therascript blockiert hat.
              Sobald das behoben ist, können Sie sie hier nachholen.
            </p>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2"
              onClick={regenerate}
            >
              Zusammenfassung erstellen
            </button>
          </>
        )}
        <hr className="mt-4 w-12 border-0 border-t border-border-strong" aria-hidden />
      </section>
    )
  }

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
