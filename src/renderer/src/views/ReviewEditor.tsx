import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { PlaceholderChip } from '../extensions/placeholderChip'
import { SpeakerLabel } from '../extensions/speakerLabel'
import { Timestamp } from '../extensions/timestamp'
import { useAutoSave } from '../hooks/useAutoSave'
import type { EntityMap, ReviewData, SessionType } from '../../../shared/types'
import type { TipTapDocument } from '../../../shared/types/TipTapDocument'

interface ReviewEditorProps {
  sessionId: string
  onBack: () => void
}

export default function ReviewEditor({
  sessionId,
  onBack
}: ReviewEditorProps): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionTitle, setSessionTitle] = useState('')
  const [sessionType, setSessionType] = useState<SessionType>('audio')
  const [_entityMap, setEntityMap] = useState<EntityMap>({})
  const [updateCounter, setUpdateCounter] = useState(0)
  const entityMapRef = useRef<EntityMap>({})

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable features not needed in review editor
        codeBlock: false,
        code: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        heading: false,
        horizontalRule: false
      }),
      PlaceholderChip,
      SpeakerLabel,
      Timestamp
    ],
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[200px] px-6 py-4'
      },
      clipboardTextSerializer: (slice) => {
        let text = ''
        slice.content.forEach((node) => {
          if (node.type.name === 'paragraph') {
            if (text.length > 0) text += '\n'
            node.content.forEach((child) => {
              if (child.type.name === 'text') {
                text += child.text ?? ''
              } else if (child.type.name === 'placeholderChip') {
                text += `[${child.attrs.type} ${child.attrs.number}]`
              } else if (child.type.name === 'speakerLabel') {
                text += `[${child.attrs.label}]:`
              } else if (child.type.name === 'timestamp') {
                text += `[${child.attrs.formatted}]`
              }
            })
          }
        })
        return text
      }
    },
    onUpdate: () => {
      setUpdateCounter((c) => c + 1)
    }
  })

  // Load review data on mount
  useEffect(() => {
    let cancelled = false

    async function loadReview(): Promise<void> {
      try {
        const data: ReviewData = await window.api.review.load(sessionId)
        if (cancelled) return

        setSessionTitle(data.sessionTitle)
        setSessionType(data.sessionType)
        setEntityMap(data.entityMap)
        entityMapRef.current = data.entityMap

        // Set TipTap content from loaded document
        editor?.commands.setContent(data.document)
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Dokument konnte nicht geladen werden')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (editor) {
      loadReview()
    }

    return () => {
      cancelled = true
    }
  }, [sessionId, editor])

  // Auto-save callback
  const handleSave = useCallback(async () => {
    if (!editor) return
    const doc = editor.getJSON() as TipTapDocument
    await window.api.review.save(sessionId, doc, entityMapRef.current)
  }, [editor, sessionId])

  const { saving, lastSavedAt } = useAutoSave(
    editor && !loading ? handleSave : null,
    [updateCounter],
    2000
  )

  // Cleanup editor on unmount
  useEffect(() => {
    return () => {
      editor?.destroy()
    }
  }, [editor])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-gray-400">Dokument wird geladen...</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-sm text-red-600">Fehler beim Laden: {loadError}</p>
        <button
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          onClick={onBack}
        >
          Zurück
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <header className="titlebar-drag flex items-center justify-between border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="titlebar-no-drag rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            onClick={onBack}
          >
            &larr; Zurück
          </button>
          <span className="text-lg" aria-hidden="true">
            {sessionType === 'audio' ? '\uD83C\uDFA4' : '\uD83D\uDCC4'}
          </span>
          <h2 className="text-lg font-semibold text-gray-900">{sessionTitle}</h2>
        </div>
      </header>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>

      {/* Footer status bar */}
      <footer className="flex items-center justify-between border-t border-gray-200 px-6 py-2">
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-400">
            {saving
              ? 'Speichern...'
              : lastSavedAt
                ? `Gespeichert ${formatTimeAgo(lastSavedAt)}`
                : ''}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span>Cmd+Z Undo</span>
          <span>Cmd+Shift+Z Redo</span>
        </div>
      </footer>
    </div>
  )
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'gerade eben'
  if (seconds < 60) return `vor ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `vor ${minutes} Min`
}
