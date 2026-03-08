import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { PlaceholderChip } from '../extensions/placeholderChip'
import { SpeakerLabel } from '../extensions/speakerLabel'
import { Timestamp } from '../extensions/timestamp'
import { useAutoSave } from '../hooks/useAutoSave'
import { useToast } from '../hooks/useToast'
import { useClickOutside } from '../hooks/useClickOutside'
import { EditorContextMenu, type ContextMenuState } from '../components/editor/EditorContextMenu'
import { BlocklistConfirmDialog } from '../components/editor/BlocklistConfirmDialog'
import { RenameDialog } from '../components/RenameDialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import {
  batchRemovePlaceholder,
  anonymizeSelection,
  addToBlocklistRetroactive,
  hasChipsWithEntityId,
  extendSelectionAndExtractText
} from '../utils/editorCommands'
import { serializeDocument } from '../../../shared/utils/serializeDocument'
import { countWords } from '../../../shared/utils/countWords'
import type { EntityMap, PlaceholderType, ReviewData, SessionType } from '../../../shared/types'
import type { TipTapDocument } from '../../../shared/types/TipTapDocument'
import type { Editor } from '@tiptap/core'

interface BlocklistUndoEntry {
  entryId: string
  entityId: string
  term: string
  placeholderType: PlaceholderType
  undone: boolean
}

interface ReviewEditorProps {
  sessionId: string
  onBack: () => void
}

export default function ReviewEditor({ sessionId, onBack }: ReviewEditorProps): React.JSX.Element {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionTitle, setSessionTitle] = useState('')
  const [sessionType, setSessionType] = useState<SessionType>('audio')
  const [_entityMap, setEntityMap] = useState<EntityMap>({})
  const [updateCounter, setUpdateCounter] = useState(0)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [blocklistConfirm, setBlocklistConfirm] = useState<{
    term: string
    type: PlaceholderType
  } | null>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const entityMapRef = useRef<EntityMap>({})
  const editorRef = useRef<Editor | null>(null)
  const blocklistUndoStackRef = useRef<BlocklistUndoEntry[]>([])
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(scrollTimerRef.current), [])

  const closeMenu = useCallback(() => setShowMenu(false), [])
  useClickOutside(menuRef, closeMenu)

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

        // Track undo/redo for blocklist operations (Cmd+Z / Cmd+Shift+Z)
        if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
          const stack = blocklistUndoStackRef.current
          if (stack.length > 0) {
            // Snapshot chip presence before ProseMirror processes the undo/redo
            const snapshot = stack.map((entry, i) => ({
              index: i,
              entityId: entry.entityId,
              hadChips: hasChipsWithEntityId(view.state.doc, entry.entityId)
            }))

            // After ProseMirror processes, compare chip presence
            queueMicrotask(() => {
              if (!editorRef.current) return
              const doc = editorRef.current.state.doc

              for (const snap of snapshot) {
                const hasChipsNow = hasChipsWithEntityId(doc, snap.entityId)
                const stackEntry = stack[snap.index]

                if (snap.hadChips && !hasChipsNow && !stackEntry.undone) {
                  // Undo: chips removed → delete blocklist entry from SQLite
                  stackEntry.undone = true
                  window.api.blocklist.delete(stackEntry.entryId)
                  const updated = { ...entityMapRef.current }
                  delete updated[stackEntry.entityId]
                  entityMapRef.current = updated
                  setEntityMap(updated)
                  setUpdateCounter((c) => c + 1)
                } else if (!snap.hadChips && hasChipsNow && stackEntry.undone) {
                  // Redo: chips reappeared → re-add blocklist entry to SQLite
                  stackEntry.undone = false
                  window.api.blocklist
                    .add(stackEntry.term, stackEntry.placeholderType)
                    .then((newEntry) => {
                      stackEntry.entryId = newEntry.id
                      // Update entityMap after entryId is set to avoid race condition
                      const number = parseInt(stackEntry.entityId.split('-').pop() ?? '0', 10)
                      const updated = { ...entityMapRef.current }
                      updated[stackEntry.entityId] = {
                        original: stackEntry.term,
                        placeholder: `[${stackEntry.placeholderType} ${number}]`,
                        type: stackEntry.placeholderType,
                        source: 'blocklist'
                      }
                      entityMapRef.current = updated
                      setEntityMap(updated)
                      setUpdateCounter((c) => c + 1)
                    })
                }
              }
            })
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

  /** Handle "Zur Sperrliste hinzufügen" from context menu — extract term and show confirm dialog */
  const handleAddToBlocklist = useCallback(
    (type: PlaceholderType) => {
      if (!editor) return
      const { from, to, empty } = editor.state.selection
      if (empty) return

      const { originalText } = extendSelectionAndExtractText(editor.state, from, to)
      if (!originalText.trim()) return
      setBlocklistConfirm({ term: originalText.trim(), type })
    },
    [editor]
  )

  /** Handle blocklist confirm dialog — add to SQLite + retroactive scan */
  const handleBlocklistConfirm = useCallback(async () => {
    if (!editor || !blocklistConfirm) return
    const { term, type } = blocklistConfirm
    setBlocklistConfirm(null)

    // 1. Add to SQLite blocklist via IPC
    const entry = await window.api.blocklist.add(term, type)

    // 2. Retroactive application in document
    const result = addToBlocklistRetroactive(editor, term, type, entityMapRef.current)
    if (result) {
      updateEntityMap(result.entityMap)

      // 3. Track for undo/redo
      blocklistUndoStackRef.current.push({
        entryId: entry.id,
        entityId: result.entityId,
        term,
        placeholderType: type,
        undone: false
      })
    }
  }, [editor, blocklistConfirm, updateEntityMap])

  /** Handle rename confirmation from 3-dot menu */
  const handleRenameConfirm = useCallback(
    async (title: string) => {
      try {
        const updated = await window.api.sessions.rename(sessionId, title)
        if (updated) {
          setSessionTitle(updated.title)
        } else {
          toast.error('Umbenennen fehlgeschlagen')
        }
      } catch {
        toast.error('Umbenennen fehlgeschlagen')
      }
      setShowRenameDialog(false)
    },
    [sessionId, toast]
  )

  /** Handle delete confirmation from 3-dot menu */
  const handleDeleteConfirm = useCallback(async () => {
    try {
      const ok = await window.api.sessions.delete(sessionId)
      if (ok) {
        onBack()
      } else {
        toast.error('Löschen fehlgeschlagen')
        setShowDeleteDialog(false)
      }
    } catch {
      toast.error('Löschen fehlgeschlagen')
      setShowDeleteDialog(false)
    }
  }, [sessionId, onBack, toast])

  /** Export current editor content to clipboard (US-7) */
  const handleExportClipboard = useCallback(async () => {
    if (!editor) return
    try {
      const doc = editor.getJSON() as TipTapDocument
      const text = serializeDocument(doc, sessionType)
      await window.api.review.exportClipboard(text)
      toast.success('In Zwischenablage kopiert')
    } catch {
      toast.error('Kopieren fehlgeschlagen')
    }
  }, [editor, sessionType, toast])

  const liveWordCount = useMemo(
    () => (editor && !loading ? countWords(editor.getJSON() as TipTapDocument) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateCounter, loading, editor]
  )

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-tertiary">Dokument wird geladen...</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-sm text-error-text">Fehler beim Laden: {loadError}</p>
        <button
          className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-1"
          onClick={onBack}
        >
          Zurück
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="titlebar-drag flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="titlebar-no-drag rounded-md px-2 py-1 text-sm text-text-tertiary hover:bg-surface-2 hover:text-text-secondary"
            onClick={onBack}
          >
            &larr; Zurück
          </button>
          <span className="text-lg" aria-hidden="true">
            {sessionType === 'audio' ? '\uD83C\uDFA4' : '\uD83D\uDCC4'}
          </span>
          <h2 className="text-lg font-semibold text-text-primary">{sessionTitle}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="titlebar-no-drag flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface-0 px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1"
            onClick={handleExportClipboard}
          >
            &#128203; Kopieren
          </button>
          <div ref={menuRef} className="titlebar-no-drag relative">
            <button
              className="flex items-center justify-center rounded-lg border border-border-strong bg-surface-0 px-3 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1"
              onClick={() => setShowMenu((prev) => !prev)}
              aria-label="Weitere Optionen"
            >
              ···
            </button>
            {showMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-border bg-surface-1 py-1 shadow-lg">
                <button
                  className="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-2"
                  onClick={() => {
                    setShowMenu(false)
                    setShowRenameDialog(true)
                  }}
                >
                  Umbenennen
                </button>
                <button
                  className="w-full px-3 py-2 text-left text-sm text-error-text hover:bg-surface-2"
                  onClick={() => {
                    setShowMenu(false)
                    setShowDeleteDialog(true)
                  }}
                >
                  Löschen
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Editor */}
      <div
        className="editor-scroll flex-1 overflow-y-auto"
        onContextMenu={handleContextMenu}
        onScroll={(e) => {
          const el = e.currentTarget
          el.classList.add('is-scrolling')
          clearTimeout(scrollTimerRef.current)
          scrollTimerRef.current = setTimeout(() => el.classList.remove('is-scrolling'), 1500)
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <EditorContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onBatchRemove={handleBatchRemove}
          onAnonymize={handleAnonymize}
          onAddToBlocklist={handleAddToBlocklist}
        />
      )}

      {/* Blocklist confirm dialog */}
      {blocklistConfirm && (
        <BlocklistConfirmDialog
          term={blocklistConfirm.term}
          type={blocklistConfirm.type}
          onConfirm={handleBlocklistConfirm}
          onCancel={() => setBlocklistConfirm(null)}
        />
      )}

      {/* Rename dialog */}
      {showRenameDialog && (
        <RenameDialog
          currentTitle={sessionTitle}
          onConfirm={handleRenameConfirm}
          onCancel={() => setShowRenameDialog(false)}
        />
      )}

      {/* Delete confirm dialog */}
      {showDeleteDialog && (
        <ConfirmDialog
          title="Sitzung löschen"
          message={`„${sessionTitle}" und alle zugehörigen Daten unwiderruflich löschen?`}
          details={['Audiodatei', 'Originaltext', 'Anonymisierter Text', 'Platzhalter-Mapping']}
          confirmLabel="Löschen"
          destructive
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}

      {/* Footer status bar */}
      <footer className="flex items-center justify-between border-t border-border px-6 py-2">
        <div className="flex items-center gap-4">
          <span className="text-xs text-text-tertiary">
            {saving
              ? 'Speichern...'
              : lastSavedAt
                ? `Gespeichert ${formatTimeAgo(lastSavedAt)}`
                : ''}
          </span>
          {liveWordCount != null && (
            <span className="text-xs text-text-tertiary">
              {liveWordCount.toLocaleString('de-CH')} Wörter
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-tertiary">
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
