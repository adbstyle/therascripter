import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, FocusEvent } from 'react'
import type { EntityMap, PlaceholderSnapshot } from '../../../../shared/types'
import { resolvePlaceholders } from '../../../../shared/utils/resolvePlaceholders'
import { useIsPlainView } from '../../viewMode/useViewMode'

interface Props {
  sessionId: string
  /**
   * Issue #203 — the editor's live EntityMap: in the Klartext view, tokens
   * resolve against it where their meaning is unchanged since the summary
   * was written.
   */
  entityMap?: EntityMap
}

export function SummaryPanel({ sessionId, entityMap }: Props): React.JSX.Element | null {
  const plain = useIsPlainView()
  const [text, setText] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PlaceholderSnapshot | null>(null)
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
          setSnapshot(record.textSnapshot ?? null)
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
              {plain
                ? ' Sobald das behoben ist, können Sie sie in der pseudonymisierten Ansicht nachholen.'
                : ' Sobald das behoben ist, können Sie sie hier nachholen.'}
            </p>
            {/* Nachholen ändert die Sitzung — im Klartext nicht verfügbar (#203 AK 8) */}
            {!plain && (
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2"
                onClick={regenerate}
              >
                Zusammenfassung erstellen
              </button>
            )}
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
    // Keeps the Klartext rendering (and a remount after a view switch) current
    setText(next)
    window.api.summary
      .updateText(sessionId, next)
      .then((record) => setSnapshot(record?.textSnapshot ?? null))
      .catch((err) => {
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

  const textStyle = { fontSize: '14px', lineHeight: '24px' }

  // Issue #203 — Klartext: read-only, tokens resolved where their meaning is
  // unchanged since the summary was written (AK 4, 5, 8). Plain DOM text, so
  // copying it yields exactly what is shown (AK 9).
  if (plain) {
    return (
      <section>
        <p key="read-only" className="font-semibold text-text-primary" style={textStyle}>
          {resolvePlaceholders(text, entityMap, snapshot)}
        </p>
        <hr className="mt-4 w-12 border-0 border-t border-border-strong" aria-hidden />
      </section>
    )
  }

  return (
    <section>
      <p
        key="editable"
        className="rounded-sm font-semibold text-text-primary outline-none focus:ring-1 focus:ring-primary"
        style={textStyle}
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
