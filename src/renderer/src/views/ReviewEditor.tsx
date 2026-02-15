import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { PlaceholderChip } from '../extensions/placeholderChip'
import { SpeakerLabel } from '../extensions/speakerLabel'
import { Timestamp } from '../extensions/timestamp'
import { useAutoSave } from '../hooks/useAutoSave'
import { EditorContextMenu, type ContextMenuState } from '../components/editor/EditorContextMenu'
import { batchRemovePlaceholder, anonymizeSelection } from '../utils/editorCommands'
import type { EntityMap, PlaceholderType, ReviewData, SessionType } from '../../../shared/types'
import type { TipTapDocument } from '../../../shared/types/TipTapDocument'
import type { Editor } from '@tiptap/core'

interface ReviewEditorProps {
  sessionId: string
  onBack: () => void
}

export default function ReviewEditor({ sessionId, onBack }: ReviewEditorProps): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionTitle, setSessionTitle] = useState('')
  const [sessionType, setSessionType] = useState<SessionType>('audio')
  const [_entityMap, setEntityMap] = useState<EntityMap>({})
  const [updateCounter, setUpdateCounter] = useState(0)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const entityMapRef = useRef<EntityMap>({})
  const editorRef = useRef<Editor | null>(null)

  /** Update entityMap in both state and ref, and trigger auto-save */
  const updateEntityMap = useCallback((updated: EntityMap) => {
    entityMapRef.current = updated
    setEntityMap(updated)
    setUpdateCounter((c) => c + 1)
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
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
      handleKeyDown: (view, event) => {
        // Intercept Delete/Backspace on a selected chip for batch removal
        if (event.key === 'Delete' || event.key === 'Backspace') {
          const { selection } = view.state
          if (
            selection instanceof NodeSelection &&
            selection.node.type.name === 'placeholderChip' &&
            editorRef.current
          ) {
            const entityId = selection.node.attrs.entityId as string
            const updated = batchRemovePlaceholder(
              editorRef.current,
              entityId,
              entityMapRef.current
            )
            updateEntityMap(updated)
            return true // Prevent default single-node deletion
          }
        }
        return false
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

  // Keep editorRef in sync (needed for handleKeyDown closure)
  editorRef.current = editor

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

        editor?.commands.setContent(data.document)

        // Reset undo history so initial content is not undoable
        const freshState = EditorState.create({
          doc: editor!.state.doc,
          plugins: editor!.state.plugins
        })
        editor!.view.updateState(freshState)
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

  /** Handle right-click in editor to show context menu */
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!editor) return

      event.preventDefault()

      const { state, view } = editor
      const { selection } = state

      // Check if right-clicked on a chip
      let chipInfo: ContextMenuState['chip'] = undefined
      const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })

      if (coords) {
        const node = state.doc.nodeAt(coords.pos)
        if (node?.type.name === 'placeholderChip') {
          // Count all occurrences of this entityId in the document
          const entityId = node.attrs.entityId as string
          let count = 0
          state.doc.descendants((n) => {
            if (n.type.name === 'placeholderChip' && n.attrs.entityId === entityId) {
              count++
            }
          })
          chipInfo = {
            entityId,
            type: node.attrs.type as PlaceholderType,
            number: node.attrs.number as number,
            count
          }
        }
      }

      // Check if text is selected (non-empty selection)
      const hasSelection = !selection.empty

      // Only show menu if there's something to act on
      if (!chipInfo && !hasSelection) return

      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        chip: chipInfo,
        hasSelection
      })
    },
    [editor]
  )

  /** Handle batch removal of all chips with the given entityId */
  const handleBatchRemove = useCallback(
    (entityId: string) => {
      if (!editor) return
      const updated = batchRemovePlaceholder(editor, entityId, entityMapRef.current)
      updateEntityMap(updated)
    },
    [editor, updateEntityMap]
  )

  /** Handle manual anonymization of the current selection */
  const handleAnonymize = useCallback(
    (type: PlaceholderType) => {
      if (!editor) return
      const updated = anonymizeSelection(editor, type, entityMapRef.current)
      if (updated) {
        updateEntityMap(updated)
      }
    },
    [editor, updateEntityMap]
  )

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
      <div className="flex-1 overflow-y-auto" onContextMenu={handleContextMenu}>
        <EditorContent editor={editor} />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <EditorContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onBatchRemove={handleBatchRemove}
          onAnonymize={handleAnonymize}
        />
      )}

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
