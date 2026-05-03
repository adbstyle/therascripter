import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCopy, FileText, Mic, PanelRight, Trash2, X } from 'lucide-react'
import { useEditor, EditorContent } from '@tiptap/react'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { PlaceholderChip } from '../extensions/placeholderChip'
import { SpeakerLabel } from '../extensions/speakerLabel'
import { Timestamp } from '../extensions/timestamp'
import { useAutoSave } from '../hooks/useAutoSave'
import { useToast } from '../hooks/useToast'
import { EditorContextMenu, type ContextMenuState } from '../components/editor/EditorContextMenu'
import { BlocklistConfirmDialog } from '../components/editor/BlocklistConfirmDialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { EditableSessionTitle } from '../components/review/EditableSessionTitle'
import { SummaryPanel } from '../components/review/SummaryPanel'
import { ReviewSidePanel } from '../components/review/ReviewSidePanel'
import {
  batchRemovePlaceholder,
  anonymizeSelectionWithPropagation,
  addToBlocklistRetroactive,
  hasChipsWithEntityId,
  extendSelectionAndExtractText,
  reconcileEntityMapWithDoc
} from '../utils/editorCommands'
import { serializeDocument } from '../../../shared/utils/serializeDocument'
import { countWords } from '../../../shared/utils/countWords'
import { useAnonymizationOverview } from '../hooks/useAnonymizationOverview'
import type {
  EntityMap,
  PlaceholderType,
  ProcessedModelsSnapshot,
  ReviewData,
  SessionType
} from '../../../shared/types'
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
  const [provenance, setProvenance] = useState<ProcessedModelsSnapshot | null>(null)
  const [reviewAt, setReviewAt] = useState<string | null>(null)
  const [_entityMap, setEntityMap] = useState<EntityMap>({})
  const [updateCounter, setUpdateCounter] = useState(0)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [blocklistConfirm, setBlocklistConfirm] = useState<{
    term: string
    type: PlaceholderType
  } | null>(null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const entityMapRef = useRef<EntityMap>({})
  const editorRef = useRef<Editor | null>(null)
  const blocklistUndoStackRef = useRef<BlocklistUndoEntry[]>([])
  const handleBatchRemoveRef = useRef<(entityId: string) => void>(() => {})
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(scrollTimerRef.current), [])

  useEffect(() => {
    window.api.settings.get('reviewPanelOpen').then((val) => {
      if (typeof val === 'boolean') setPanelOpen(val)
    })
  }, [])

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev
      window.api.settings.set('reviewPanelOpen', next)
      return next
    })
  }, [])

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
        class: 'focus:outline-none min-h-[200px] px-6 py-4'
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
            handleBatchRemoveRef.current(entityId)
            return true // Prevent default single-node deletion
          }
        }

        // Track undo/redo for blocklist operations (Cmd+Z / Cmd+Shift+Z / Cmd+Y).
        // toLowerCase covers Cmd+Shift+Z (Shift makes event.key === 'Z' on macOS).
        // 'y' covers Cmd+Y, the alternative redo binding from TipTap StarterKit's
        // UndoRedo extension — and the natural redo on German QWERTZ keyboards.
        const key = event.key.toLowerCase()
        if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
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

          // Always-on EntityMap reconciliation: covers manual-flag overwrites
          // whose chips reappear after undo (rebuild direction) AND orphaned
          // entries left behind after a manual-flag overwrite was undone
          // (prune direction). FIFO ordering means the blocklist
          // reconciliation above runs first, so this microtask observes the
          // correct post-reconciliation state.
          queueMicrotask(() => {
            if (!editorRef.current) return
            const next = reconcileEntityMapWithDoc(
              editorRef.current.state.doc,
              entityMapRef.current
            )
            if (next !== null) updateEntityMap(next)
          })
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
        setProvenance(data.processedWithModels)
        setReviewAt(data.reviewAt)
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

      // Detect AK 12: selection spans multiple chips with no neutral text.
      let selectionSpansMultipleChipsOnly = false
      if (hasSelection) {
        let chipCount = 0
        let hasNonWhitespaceText = false
        state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
          if (node.type.name === 'placeholderChip') {
            const nodeEnd = pos + node.nodeSize
            if (pos >= selection.from && nodeEnd <= selection.to) {
              chipCount++
            }
          } else if (node.isText) {
            const text = node.text ?? ''
            const start = Math.max(pos, selection.from) - pos
            const end = Math.min(pos + node.nodeSize, selection.to) - pos
            if (text.slice(start, end).trim().length > 0) {
              hasNonWhitespaceText = true
            }
          }
        })
        selectionSpansMultipleChipsOnly = chipCount >= 2 && !hasNonWhitespaceText
      }

      // Only show menu if there's something to act on
      if (!chipInfo && !hasSelection) return

      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        chip: chipInfo,
        hasSelection,
        selectionSpansMultipleChipsOnly
      })
    },
    [editor]
  )

  /** Handle batch removal of all chips with the given entityId */
  const handleBatchRemove = useCallback(
    (entityId: string) => {
      if (!editor) return

      // Sync blocklist undo stack: mark matching entries as undone + delete from SQLite
      for (const entry of blocklistUndoStackRef.current) {
        if (entry.entityId === entityId && !entry.undone) {
          entry.undone = true
          window.api.blocklist.delete(entry.entryId)
        }
      }

      const updated = batchRemovePlaceholder(editor, entityId, entityMapRef.current)
      updateEntityMap(updated)

      // Refocus editor so Cmd+Z undo works immediately after sidebar action
      editor.commands.focus()
    },
    [editor, updateEntityMap]
  )
  handleBatchRemoveRef.current = handleBatchRemove

  /** Handle manual anonymization of the current selection with auto-propagation */
  const handleAnonymize = useCallback(
    (type: PlaceholderType) => {
      if (!editor) return

      const result = anonymizeSelectionWithPropagation(editor, type, entityMapRef.current)
      if (!result) return

      // Orphan cleanup: remove EntityMap entries whose chips were overwritten and
      // have no remaining occurrences in the post-dispatch document.
      const cleaned: EntityMap = { ...result.entityMap }
      for (const oldId of result.overwrittenEntityIds) {
        if (!hasChipsWithEntityId(editor.state.doc, oldId)) {
          delete cleaned[oldId]
        }
      }

      // Sync blocklistUndoStackRef so SQLite stays consistent when overwriting a
      // blocklist-originated chip. The Cmd+Z redo branch at lines 156-175 will
      // re-add the SQLite row if the user undoes the overwrite.
      for (const entry of blocklistUndoStackRef.current) {
        if (result.overwrittenEntityIds.has(entry.entityId) && !entry.undone) {
          entry.undone = true
          window.api.blocklist.delete(entry.entryId)
        }
      }

      updateEntityMap(cleaned)
      editor.commands.focus()
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showDeleteDialog || contextMenu || blocklistConfirm) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, showDeleteDialog, contextMenu, blocklistConfirm])

  const liveWordCount = useMemo(
    () => (editor && !loading ? countWords(editor.getJSON() as TipTapDocument) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateCounter, loading, editor]
  )

  const overviewData = useAnonymizationOverview(editor, updateCounter)

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
      <header className="titlebar-drag flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {sessionType === 'audio' ? (
            <Mic
              className="h-5 w-5 shrink-0 text-text-tertiary"
              strokeWidth={1.75}
              aria-hidden
            />
          ) : (
            <FileText
              className="h-5 w-5 shrink-0 text-text-tertiary"
              strokeWidth={1.75}
              aria-hidden
            />
          )}
          <EditableSessionTitle
            sessionId={sessionId}
            title={sessionTitle}
            fallback="Transkription ohne Titel"
            onSaved={setSessionTitle}
            className="min-w-0 flex-1 text-base font-semibold text-text-primary"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="titlebar-no-drag flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface-0 px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1"
            onClick={handleExportClipboard}
          >
            <ClipboardCopy className="h-4 w-4" strokeWidth={2} aria-hidden />
            Kopieren
          </button>
          <button
            className="titlebar-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-0 text-text-secondary transition-colors hover:border-error-border hover:bg-error-bg hover:text-error-text"
            onClick={() => setShowDeleteDialog(true)}
            aria-label="Transkription löschen"
            title="Löschen"
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </button>
          <button
            className={`titlebar-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong transition-colors hover:bg-surface-1 ${panelOpen ? 'bg-surface-2 text-text-primary' : 'bg-surface-0 text-text-secondary'}`}
            onClick={togglePanel}
            aria-label="Seitenleiste anzeigen"
            aria-pressed={panelOpen}
            title="Seitenleiste"
          >
            <PanelRight className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </button>
          <button
            className="titlebar-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-0 text-text-secondary transition-colors hover:bg-surface-1"
            onClick={onBack}
            aria-label="Editor schließen"
            title="Schließen (Esc)"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        </div>
      </header>

      {/* Editor + Panel row */}
      <div className="flex min-h-0 flex-1">
        <div
          className="editor-scroll min-w-0 flex-1 overflow-y-auto"
          onContextMenu={handleContextMenu}
          onScroll={(e) => {
            const el = e.currentTarget
            el.classList.add('is-scrolling')
            clearTimeout(scrollTimerRef.current)
            scrollTimerRef.current = setTimeout(() => el.classList.remove('is-scrolling'), 1500)
          }}
        >
          {/* Optional LLM-generated summary scrolls with the transcript */}
          <div className="px-6 pt-4 [&:empty]:p-0">
            <SummaryPanel sessionId={sessionId} />
          </div>
          <EditorContent editor={editor} />
        </div>
        <ReviewSidePanel
          isOpen={panelOpen}
          anonymization={overviewData}
          onRevert={handleBatchRemove}
          provenance={provenance}
          reviewAt={reviewAt}
        />
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

      {/* Delete confirm dialog */}
      {showDeleteDialog && (
        <ConfirmDialog
          title="Transkription löschen"
          message={`„${sessionTitle}" und alle zugehörigen Daten unwiderruflich löschen?`}
          details={['Audiodatei', 'Originaltext', 'Pseudonymisierter Text', 'Platzhalter-Mapping']}
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
