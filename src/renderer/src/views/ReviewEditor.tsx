import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCopy, FileText, Mic, PanelRight, Trash2 } from 'lucide-react'
import { useEditor, EditorContent } from '@tiptap/react'
import { EditorState, NodeSelection } from '@tiptap/pm/state'
import type { EditorProps } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { PlaceholderChip } from '../extensions/placeholderChip'
import { SpeakerLabel } from '../extensions/speakerLabel'
import { Timestamp } from '../extensions/timestamp'
import {
  SearchHighlight,
  hasSearchHighlight,
  resolveSearchFocus,
  setSearchHighlight
} from '../extensions/searchHighlight'
import type { SessionFocus } from '../navigation/routes'
import { useAutoSave } from '../hooks/useAutoSave'
import { registerPendingEditsFlusher } from '../services/pendingEdits'
import { useSelectionToolbar } from '../hooks/useSelectionToolbar'
import { useToast } from '../hooks/useToast'
import { SelectionToolbar } from '../components/editor/SelectionToolbar'
import { BlocklistConfirmDialog } from '../components/editor/BlocklistConfirmDialog'
import { DeleteSessionDialog } from '../components/DeleteSessionDialog'
import { EditableSessionTitle } from '../components/review/EditableSessionTitle'
import { SummaryPanel } from '../components/review/SummaryPanel'
import { ReviewSidePanel } from '../components/review/ReviewSidePanel'
import { SaveStatus } from '../components/review/SaveStatus'
import { DossierBadges } from '../components/dossier/DossierBadges'
import { DocumentDateButton } from '../components/session/DocumentDateButton'
import { useLiveQuery } from '../hooks/useLiveQuery'
import { ChipActionsContext, type ChipActions } from '../contexts/ChipActionsContext'
import {
  batchRemovePlaceholder,
  anonymizeSelectionWithPropagation,
  addToBlocklistRetroactive,
  addToBlocklistFromTerm,
  changeChipTypeForEntity,
  hasChipsWithEntityId,
  extendSelectionAndExtractText,
  reconcileEntityMapWithDoc
} from '../utils/editorCommands'
import { serializeDocument } from '../../../shared/utils/serializeDocument'
import { formatPlaceholderToken } from '../../../shared/utils/formatPlaceholderToken'
import { serializeClipboardText } from '../utils/clipboardText'
import { useAnonymizationOverview } from '../hooks/useAnonymizationOverview'
import { useViewMode } from '../viewMode/useViewMode'
import { getViewMode } from '../viewMode/viewModeStore'
import { resolvePlaceholders } from '../../../shared/utils/resolvePlaceholders'
import type {
  AudioStats,
  EntityMap,
  PlaceholderSnapshot,
  PlaceholderType,
  ProcessedModelsSnapshot,
  ReviewData,
  SessionType
} from '../../../shared/types'
import type { TipTapDocument } from '../../../shared/types/TipTapDocument'
import type { DossierRef, SessionListItem } from '../../../shared/types/Dossier'
import type { Editor } from '@tiptap/core'

// Modulweit statt inline: useEditor vergleicht Extensions per Identität und
// ruft sonst bei JEDEM Render editor.setOptions() samt View-Update auf.
const EDITOR_EXTENSIONS = [
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
  Timestamp,
  SearchHighlight
]

/** #209 AK 11 — Hinweis, wenn eine Fundstelle nach einer Bearbeitung fehlt. */
export const SEARCH_HIT_GONE_TEXT = 'Die Fundstelle gibt es in der aktuellen Fassung nicht mehr.'

/** Tasten, mit denen der USER selbst scrollt — sie beenden die Markierung der Fundstelle. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

/** So lange nach dem Sprung folgt die Stelle noch dem Nachladen der Zusammenfassung darüber. */
const FOLLOW_LAYOUT_MS = 1500

/**
 * Issue #203 — the Klartext view admits no changes (AK 8). The editor is
 * read-only there and change tools are hidden; every handler that mutates
 * the document or the Sperrliste checks this as well, so nothing slips
 * through a menu or dialog that was open at the moment of the switch.
 */
function isReadOnlyView(): boolean {
  return getViewMode() === 'plain'
}

interface BlocklistUndoEntry {
  entryId: string
  entityId: string
  term: string
  placeholderType: PlaceholderType
  undone: boolean
}

/**
 * Breite der Zeile aus Textspalte und Übersicht, unter der die Übersicht (300 px)
 * der Textspalte weniger als ~420 px liessen: sie legt sich dann als
 * Überlagerung über den Text. Gemessen am Platz, nicht an der Fensterbreite —
 * die Seitenleiste ist ein- und ausklappbar.
 */
const PANEL_OVERLAY_BELOW_PX = 720
/** Hysterese: erst ab dieser Breite wird die Überlagerung wieder zur Spalte daneben (kein Flattern beim Ziehen). */
const PANEL_OVERLAY_ABOVE_PX = 760

interface ReviewEditorProps {
  sessionId: string
  /** Esc, «Zurück» nach einem Ladefehler und nach dem Löschen: zurück im Verlauf. */
  onBack: () => void
  /** #205 — Klick auf eine Dossier-Plakette im Kopf öffnet das Patientendossier. */
  onOpenDossier?: (dossierId: string) => void
  /** #209 AK 11 — Fundstelle der Suche, zu der gesprungen und die hervorgehoben wird. */
  focus?: SessionFocus
  /** Die Fundstelle ist aufgelöst — die Route verwirft sie (keine zweite Meldung). */
  onFocusConsumed?: () => void
}

function ReviewEditor({
  sessionId,
  onBack,
  onOpenDossier,
  focus,
  onFocusConsumed
}: ReviewEditorProps): React.JSX.Element {
  const toast = useToast()
  const viewMode = useViewMode()
  const isPlain = viewMode === 'plain'
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionTitle, setSessionTitle] = useState('')
  const [titleSnapshot, setTitleSnapshot] = useState<PlaceholderSnapshot | null>(null)
  const [sessionType, setSessionType] = useState<SessionType>('audio')
  const [provenance, setProvenance] = useState<ProcessedModelsSnapshot | null>(null)
  const [reviewAt, setReviewAt] = useState<string | null>(null)
  const [audioStats, setAudioStats] = useState<AudioStats | null>(null)
  // #205 — Importzeitpunkt und Dokumentdatum (PDF) für den Kopf
  const [createdAt, setCreatedAt] = useState('')
  const [documentDate, setDocumentDate] = useState<string | null>(null)
  // Auswahl der Dossiers bzw. Datumsdialog offen: Esc gehört dann ihnen
  const [assignOpen, setAssignOpen] = useState(false)
  const [dateDialogOpen, setDateDialogOpen] = useState(false)
  const [entityMap, setEntityMap] = useState<EntityMap>({})
  const [updateCounter, setUpdateCounter] = useState(0)
  const updateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounce-Timer beim Unmount aufräumen (letzter Tick würde sonst auf
  // einem unmounted Component setState aufrufen)
  useEffect(() => {
    return () => {
      if (updateDebounceRef.current !== null) clearTimeout(updateDebounceRef.current)
    }
  }, [])
  const [blocklistConfirm, setBlocklistConfirm] = useState<{
    term: string
    type: PlaceholderType
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionListItem | null>(null)
  const showDeleteDialog = deleteTarget !== null
  // Sichtbarer Zustand der Übersicht. Er bleibt beim Wechsel zwischen «daneben»
  // und «Überlagerung» erhalten; gespeichert wird nur, wenn der Nutzer daneben
  // selbst umschaltet.
  const [panelShown, setPanelShown] = useState(false)
  const [overlay, setOverlay] = useState(false)
  const overlayRef = useRef(false)
  const measuredRef = useRef(false)
  const focusAfterPanelRef = useRef<'panel' | 'toggle' | null>(null)
  const panelRowRef = useRef<HTMLDivElement | null>(null)
  const panelToggleRef = useRef<HTMLButtonElement | null>(null)
  const panelFocusRef = useRef<HTMLDivElement | null>(null)
  const saveVersionRef = useRef({ changed: 0, saved: 0 })
  const saveInflightRef = useRef<{ version: number; promise: Promise<void> } | null>(null)
  const entityMapRef = useRef<EntityMap>({})
  const editorRef = useRef<Editor | null>(null)
  const editorScrollRef = useRef<HTMLDivElement | null>(null)
  const blocklistUndoStackRef = useRef<BlocklistUndoEntry[]>([])
  const handleBatchRemoveRef = useRef<(entityId: string) => void>(() => {})
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(scrollTimerRef.current), [])
  // #209 AK 11 — hervorgehobenes Feld (Titel/Zusammenfassung) und Ansage der Fundstelle
  const [fieldHit, setFieldHit] = useState<'title' | 'summary' | null>(null)
  const [hitAnnouncement, setHitAnnouncement] = useState('')
  const summaryWrapRef = useRef<HTMLDivElement | null>(null)
  const panelShownRef = useRef(false)
  const followLayoutRef = useRef<{ scroll: () => void; until: number } | null>(null)
  const onFocusConsumedRef = useRef(onFocusConsumed)
  onFocusConsumedRef.current = onFocusConsumed

  useEffect(() => {
    window.api.settings.get('reviewPanelOpen').then((val) => {
      // In schmaler Spalte beginnt die Überlagerung geschlossen
      if (typeof val === 'boolean' && !overlayRef.current) setPanelShown(val)
    })
  }, [])

  panelShownRef.current = panelShown

  const togglePanel = useCallback(() => {
    const next = !panelShown
    setPanelShown(next)
    if (overlay) {
      focusAfterPanelRef.current = next ? 'panel' : 'toggle'
    } else {
      window.api.settings.set('reviewPanelOpen', next)
    }
  }, [overlay, panelShown])
  const closeOverlay = useCallback(() => {
    focusAfterPanelRef.current = 'toggle'
    setPanelShown(false)
  }, [])

  // Der Platz neben der Textspalte wird gemessen; erst nach dem Laden ist die
  // Zeile im DOM.
  useEffect(() => {
    const el = panelRowRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width !== 'number') return
      const next =
        width < PANEL_OVERLAY_BELOW_PX
          ? true
          : width >= PANEL_OVERLAY_ABOVE_PX
            ? false
            : overlayRef.current
      const first = !measuredRef.current
      measuredRef.current = true
      overlayRef.current = next
      setOverlay(next)
      // Erste Messung schmal: die gespeicherte Vorgabe «offen» würde sonst den Text verdecken
      if (first && next) setPanelShown(false)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading, loadError])

  // Fokus nur nach Nutzeraktion (Knopf, Esc), nicht beim Überschreiten der Schwelle.
  useEffect(() => {
    const target = focusAfterPanelRef.current
    focusAfterPanelRef.current = null
    if (target === 'panel') panelFocusRef.current?.focus()
    if (target === 'toggle') panelToggleRef.current?.focus()
  }, [panelShown])

  /** Update entityMap in both state and ref, and trigger auto-save */
  const updateEntityMap = useCallback((updated: EntityMap) => {
    entityMapRef.current = updated
    saveVersionRef.current.changed++
    setEntityMap(updated)
    setUpdateCounter((c) => c + 1)
  }, [])

  // Stabil über Renders (aus demselben Grund wie EDITOR_EXTENSIONS). Die
  // Handler lesen nur Refs und stabile Setter — daher reicht updateEntityMap
  // als einzige Dependency.
  const editorProps = useMemo(
    (): EditorProps => ({
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
                  saveVersionRef.current.changed++
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
                        placeholder: formatPlaceholderToken({
                          type: stackEntry.placeholderType,
                          number
                        }),
                        type: stackEntry.placeholderType,
                        source: 'blocklist'
                      }
                      entityMapRef.current = updated
                      setEntityMap(updated)
                      saveVersionRef.current.changed++
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
      clipboardTextSerializer: serializeClipboardText
    }),
    [updateEntityMap]
  )

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    editorProps,
    onUpdate: ({ editor: current, transaction }) => {
      // Echte Dokumentänderung (das Laden feuert wegen emitUpdate: false nicht)
      saveVersionRef.current.changed++
      // Eingefügte Chips können Entitäten zurückbringen, die seit dem Copy
      // aus der EntityMap entfernt wurden — ohne Eintrag vergäbe
      // getNextNumber ihre Nummer neu (entityId-Kollision).
      const uiEvent = transaction.getMeta('uiEvent')
      if (uiEvent === 'paste' || uiEvent === 'drop') {
        const next = reconcileEntityMapWithDoc(current.state.doc, entityMapRef.current)
        if (next !== null) updateEntityMap(next)
      }

      // Debounced: updateCounter treibt Wortzählung + Anonymisierungs-
      // Übersicht (voller Doc-Walk) — pro Tastendruck ausgeführt machte das
      // Tippen in langen Transkripten spürbar zäh. Der Autosave hängt
      // ebenfalls am Counter und debounct selbst nochmals (2 s). Dass eine
      // Änderung vor Ablauf beider Timer nicht verloren geht, sichert der
      // Änderungszähler (saveVersionRef): der Unmount-Flush speichert, solange
      // geänderter und gespeicherter Stand abweichen.
      if (updateDebounceRef.current !== null) clearTimeout(updateDebounceRef.current)
      updateDebounceRef.current = setTimeout(() => setUpdateCounter((c) => c + 1), 250)
    }
  })

  // #205 AK 5 — Patientendossiers dieser Sitzung, aktuell über die Änderungs-Events
  const dossiers = useLiveQuery<DossierRef[]>(
    () => window.api.dossiers.listForSession(sessionId),
    [
      (cb) => window.api.sessions.onChanged(() => cb()),
      (cb) => window.api.dossiers.onChanged(() => cb())
    ],
    []
  )

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
        setTitleSnapshot(data.titleSnapshot ?? null)
        setSessionType(data.sessionType)
        setEntityMap(data.entityMap)
        setProvenance(data.processedWithModels)
        setReviewAt(data.reviewAt)
        setAudioStats(data.audioStats)
        setCreatedAt(data.createdAt)
        setDocumentDate(data.documentDate)
        entityMapRef.current = data.entityMap

        // emitUpdate false: das Laden ist keine Bearbeitung — sonst feuert
        // onUpdate, der Autosave schriebe die unveränderte Sitzung zurück
        // (und markierte sie für die Suche als neu aufzubereiten).
        editor?.commands.setContent(data.document, { emitUpdate: false })

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
  // Speichert nur bei echter Änderung und höchstens einmal je Stand: Autosave-
  // Timer und Unmount-Flush dürfen beide anklopfen. Erst nach Erfolg gilt der
  // Stand als gespeichert; Änderungen während des Speicherns bleiben offen.
  const handleSave = useCallback((): Promise<void> => {
    if (!editor || editor.isDestroyed) return Promise.resolve()
    const versions = saveVersionRef.current
    const version = versions.changed
    if (version === versions.saved) return Promise.resolve()
    const inflight = saveInflightRef.current
    if (inflight && inflight.version === version) return inflight.promise
    const doc = editor.getJSON() as TipTapDocument
    const promise: Promise<void> = Promise.resolve(
      window.api.review.save(sessionId, doc, entityMapRef.current)
    )
      .then(() => {
        versions.saved = Math.max(versions.saved, version)
      })
      .finally(() => {
        if (saveInflightRef.current?.promise === promise) saveInflightRef.current = null
      })
    saveInflightRef.current = { version, promise }
    return promise
  }, [editor, sessionId])

  // Schliessen oder Wegnavigieren mit ungespeicherter Änderung (auch innerhalb
  // des 250-ms-Debounce): genau ein Flush. Deklariert vor dem destroy-Effekt,
  // damit der Editor beim Lesen noch lebt.
  const flushRef = useRef(handleSave)
  flushRef.current = handleSave
  useEffect(() => {
    return () => {
      flushRef.current().catch((err) => console.error('Flush on close failed:', err))
    }
  }, [])

  // Beenden der App: der Main-Prozess fragt vor dem Schliessen der Datenbank
  // nach (services/pendingEdits.ts) — derselbe Pfad, speichert nur bei Änderung
  useEffect(() => registerPendingEditsFlusher(() => flushRef.current()), [])

  const { saving, lastSavedAt } = useAutoSave(
    editor && !loading ? handleSave : null,
    [updateCounter],
    2000
  )

  // Issue #203 — Klartext is read-only. The same editor instance stays, so
  // the undo history and autosave are untouched; emitUpdate=false because
  // setEditable otherwise fires 'update', which would bump the autosave
  // counter — a view switch must neither change nor save the session
  // (Postcondition 1). Layout effect: applied before the switched view paints.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!isPlain, false)
  }, [editor, isPlain])

  // Dialogs that would change something close with the switch to Klartext.
  useEffect(() => {
    if (isPlain) setBlocklistConfirm(null)
  }, [isPlain])

  // Cleanup editor on unmount
  useEffect(() => {
    return () => {
      editor?.destroy()
    }
  }, [editor])

  /** Handle batch removal of all chips with the given entityId */
  const handleBatchRemove = useCallback(
    (entityId: string) => {
      if (!editor || isReadOnlyView()) return

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
      if (!editor || isReadOnlyView()) return

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
      // blocklist-originated chip. The Cmd+Z redo branch in editorProps.handleKeyDown
      // will re-add the SQLite row if the user undoes the overwrite.
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
      if (!editor || isReadOnlyView()) return
      const { from, to, empty } = editor.state.selection
      if (empty) return

      const { originalText } = extendSelectionAndExtractText(editor.state, from, to)
      if (!originalText.trim()) return
      setBlocklistConfirm({ term: originalText.trim(), type })
    },
    [editor]
  )

  /**
   * Rewrite every chip with `entityId` under a fresh entityId of `newType`,
   * single transaction = one undo step.
   *
   * If the entity was originally blocklist-sourced, the type change invalidates
   * the SQLite row (which was scoped to the *old* type). The row is deleted +
   * the undo-stack entry marked done, AND the rewritten chips are downgraded
   * to `source: 'manual'` so the chip's source-icon truthfully reflects state.
   * The user can re-add to the blocklist explicitly via the menu if desired.
   */
  const handleChipChangeType = useCallback(
    (entityId: string, newType: PlaceholderType) => {
      if (!editor || isReadOnlyView()) return

      let blocklistSourced = false
      for (const entry of blocklistUndoStackRef.current) {
        if (entry.entityId === entityId && !entry.undone) {
          blocklistSourced = true
          entry.undone = true
          window.api.blocklist.delete(entry.entryId)
        }
      }

      const result = changeChipTypeForEntity(
        editor,
        entityId,
        newType,
        entityMapRef.current,
        blocklistSourced ? 'manual' : undefined
      )
      if (!result) return

      updateEntityMap(result.entityMap)
      editor.commands.focus()
    },
    [editor, updateEntityMap]
  )

  /**
   * Add a chip's original term to the Sperrliste, then doc-wide rewrite every
   * match (text + chips) of `term` under a fresh blocklist entityId of the
   * chosen type.
   *
   * Order mirrors `handleBlocklistConfirm` (selection-flow): IPC first, then
   * doc mutation, then track for undo/redo. With this ordering Cmd+Z during
   * the IPC await affects only pre-existing edits — the chip mutation has
   * not happened yet — so no SQLite orphan can be produced by a racing undo.
   */
  const handleChipAddToBlocklist = useCallback(
    async (entityId: string, original: string, type: PlaceholderType) => {
      if (!editor || isReadOnlyView()) return
      const term = original.trim()
      if (!term) return

      // Mark the existing entry undone (it may have come from a prior blocklist
      // entry of a different type — the new entry below supersedes it).
      for (const entry of blocklistUndoStackRef.current) {
        if (entry.entityId === entityId && !entry.undone) {
          entry.undone = true
          window.api.blocklist.delete(entry.entryId)
        }
      }

      const sqlEntry = await window.api.blocklist.add(term, type)
      const result = addToBlocklistFromTerm(editor, term, type, entityMapRef.current)
      if (!result) {
        // No matches in doc — clean up the SQLite row to keep state consistent.
        window.api.blocklist.delete(sqlEntry.id)
        return
      }

      updateEntityMap(result.entityMap)
      blocklistUndoStackRef.current.push({
        entryId: sqlEntry.id,
        entityId: result.entityId,
        term,
        placeholderType: type,
        undone: false
      })
      editor.commands.focus()
    },
    [editor, updateEntityMap]
  )

  /** Handle blocklist confirm dialog — add to SQLite + retroactive scan */
  const handleBlocklistConfirm = useCallback(async () => {
    if (!editor || !blocklistConfirm || isReadOnlyView()) return
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

  /**
   * Opens the delete dialog with the current state of the session: the summary
   * may have arrived and the recording may have been removed since the editor
   * loaded, and the dialog must list what is deleted now (Issue #202, AK 3).
   */
  const handleDeleteRequest = useCallback(async () => {
    try {
      const sessions = await window.api.sessions.list()
      const current = sessions.find((s) => s.id === sessionId)
      if (current) {
        setDeleteTarget(current)
      } else {
        toast.error('Löschen fehlgeschlagen')
      }
    } catch {
      toast.error('Löschen fehlgeschlagen')
    }
  }, [sessionId, toast])

  /** Handle delete confirmation */
  const handleDeleteConfirm = useCallback(async () => {
    try {
      const ok = await window.api.sessions.delete(sessionId)
      if (ok) {
        onBack()
      } else {
        toast.error('Löschen fehlgeschlagen')
        setDeleteTarget(null)
      }
    } catch {
      toast.error('Löschen fehlgeschlagen')
      setDeleteTarget(null)
    }
  }, [sessionId, onBack, toast])

  /** Export current editor content to clipboard (US-7), in the chosen view (#203 AK 9) */
  const handleExportClipboard = useCallback(async () => {
    if (!editor) return
    try {
      const doc = editor.getJSON() as TipTapDocument
      const text = serializeDocument(doc, sessionType, getViewMode())
      await window.api.review.exportClipboard(text)
      toast.success('In Zwischenablage kopiert')
    } catch {
      toast.error('Kopieren fehlgeschlagen')
    }
  }, [editor, sessionType, toast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Ein Fenster darüber (Suche) hat Esc schon für sich genommen
      if (e.defaultPrevented) return
      if (showDeleteDialog || blocklistConfirm || assignOpen || dateDialogOpen) return
      // Die Überlagerung schliesst zuerst; erst ein zweites Esc geht zurück.
      if (overlay && panelShown) {
        closeOverlay()
        return
      }
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    onBack,
    showDeleteDialog,
    blocklistConfirm,
    assignOpen,
    dateDialogOpen,
    overlay,
    panelShown,
    closeOverlay
  ])

  // #209 AK 11 — Sprung zur Fundstelle, sobald das Dokument geladen ist (und
  // erneut, wenn eine andere Fundstelle derselben Sitzung geöffnet wird).
  // Nur Decorations und Scrollen: weder Textauswahl noch Dokumentänderung,
  // also kein Autosave und keine neue Aufbereitung für die Suche.
  useEffect(() => {
    if (!focus || loading || !editor || editor.isDestroyed) return
    const scroller = editorScrollRef.current
    const resolved = resolveSearchFocus(editor.state.doc, focus)
    onFocusConsumedRef.current?.()
    followLayoutRef.current = null
    if (hasSearchHighlight(editor.state))
      editor.view.dispatch(setSearchHighlight(editor.state, null))

    const settleFocus = (): void => {
      // Fokus in den Textbereich (ohne Auswahl): Pfeiltasten scrollen, Esc schliesst
      scroller?.focus({ preventScroll: true })
    }

    if (resolved.kind === 'missing') {
      setFieldHit(null)
      if (scroller) scroller.scrollTop = 0
      setHitAnnouncement(SEARCH_HIT_GONE_TEXT)
      toast.info(SEARCH_HIT_GONE_TEXT, { durationMs: 6000 })
      settleFocus()
      return
    }

    if (resolved.kind === 'title') {
      setFieldHit('title')
      if (scroller) scroller.scrollTop = 0
      setHitAnnouncement('Fundstelle im Titel hervorgehoben.')
      settleFocus()
      return
    }

    if (resolved.kind === 'summary') {
      setFieldHit('summary')
      const scroll = (): void => {
        const el = summaryWrapRef.current
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'start', behavior: 'instant' })
        }
      }
      scroll()
      followLayoutRef.current = { scroll, until: Date.now() + FOLLOW_LAYOUT_MS }
      setHitAnnouncement('Fundstelle in der Zusammenfassung hervorgehoben.')
      settleFocus()
      return
    }

    setFieldHit(null)
    // Die Überlagerung der Übersicht würde die Stelle verdecken
    if (overlayRef.current && panelShownRef.current) setPanelShown(false)
    editor.view.dispatch(setSearchHighlight(editor.state, resolved.spec))
    const scroll = (): void => {
      if (editor.isDestroyed) return
      const dom = editor.view.nodeDOM(resolved.scrollParagraphPos)
      if (dom instanceof HTMLElement && typeof dom.scrollIntoView === 'function') {
        dom.scrollIntoView({ block: 'center', behavior: 'instant' })
      }
    }
    scroll()
    followLayoutRef.current = { scroll, until: Date.now() + FOLLOW_LAYOUT_MS }
    setHitAnnouncement(
      `Fundstelle ${resolved.spec.style === 'semantic' ? 'ab' : 'in'} Absatz ${resolved.paragraphIndex + 1} von ${resolved.paragraphCount} hervorgehoben${
        resolved.relocated ? ', nach einer Bearbeitung wiedergefunden' : ''
      }.`
    )
    settleFocus()
    // toast ist stabil genug; der Sprung gilt pro Fundstelle (focus), nicht pro Render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, loading, editor])

  // Die Zusammenfassung über dem Text lädt nach und schiebt die Stelle nach
  // unten: kurz nach dem Sprung folgt der Scroll ihr noch
  useEffect(() => {
    const el = summaryWrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const follow = followLayoutRef.current
      if (follow && Date.now() < follow.until) follow.scroll()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading, loadError])

  // Die Markierung bleibt, bis der USER scrollt oder bearbeitet (Prototyp
  // «Fundstelle»); das Bearbeiten beendet sie im Plugin selbst
  const clearSearchHit = useCallback(() => {
    followLayoutRef.current = null
    setFieldHit(null)
    const current = editorRef.current
    if (current && !current.isDestroyed && hasSearchHighlight(current.state)) {
      current.view.dispatch(setSearchHighlight(current.state, null))
    }
  }, [])
  useEffect(() => {
    const el = editorScrollRef.current
    if (!el) return
    const onWheel = (): void => clearSearchHit()
    const onPointerDown = (e: PointerEvent): void => {
      // Klick auf die Scrollleiste selbst
      if (e.target === el) clearSearchHit()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(e.key)) return
      const target = e.target as HTMLElement | null
      if (target?.isContentEditable) return
      clearSearchHit()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', onWheel, { passive: true })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [loading, loadError, clearSearchHit])

  // Bearbeitung beendet auch die Hervorhebung von Titel bzw. Zusammenfassung
  useEffect(() => {
    if (updateCounter > 0) setFieldHit(null)
  }, [updateCounter])

  // Direkt über den ProseMirror-Doc statt countWords(editor.getJSON()):
  // getJSON() serialisierte das GESAMTE Transkript pro Neuberechnung —
  // der Doc-Walk zählt ohne die JSON-Zwischenkopie (Semantik identisch zu
  // shared/utils/countWords: Text-Wörter + placeholderChips).
  const liveWordCount = useMemo(() => {
    if (!editor || loading) return null
    let count = 0
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        count += (node.text ?? '')
          .trim()
          .split(/\s+/)
          .filter((t) => t.length > 0).length
      } else if (node.type.name === 'placeholderChip') {
        count += 1
      }
      return true
    })
    return count
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateCounter, loading, editor])

  const overviewData = useAnonymizationOverview(loading ? null : editor, updateCounter)

  const { state: selectionToolbar, hide: hideSelectionToolbar } = useSelectionToolbar({
    editor,
    enabled: !isPlain && !showDeleteDialog && !blocklistConfirm && !loading && !loadError,
    containerRef: editorScrollRef
  })

  const chipActions = useMemo<ChipActions>(
    () => ({
      onUndo: handleBatchRemove,
      onChangeType: handleChipChangeType,
      onAddToBlocklist: handleChipAddToBlocklist,
      getOccurrenceCount: (entityId: string) => {
        if (!editor) return 1
        let count = 0
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'placeholderChip' && node.attrs.entityId === entityId) {
            count++
          }
        })
        return count
      }
    }),
    [editor, handleBatchRemove, handleChipChangeType, handleChipAddToBlocklist]
  )

  // Titles hold tokens as plain text; Klartext resolves those whose meaning
  // is unchanged since the title was written (AK 4, AK 5) — against the live
  // EntityMap, so an unsaved chip change counts immediately.
  const copyLabel = isPlain ? 'Klartext kopieren' : 'Pseudonymisiert kopieren'
  const displayTitle = isPlain
    ? resolvePlaceholders(sessionTitle, entityMap, titleSnapshot)
    : sessionTitle

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
      {/* Kein Schliessen-Knopf (Epic #192): zurück über ‹ in der Titelleiste, ⌘[ oder Esc */}
      {/* Container-Query: der Kopf misst seinen eigenen Platz (Seitenleiste und Übersicht
          nehmen dem Editor Breite, die Fensterbreite sagt darüber nichts). */}
      <div className="@container border-b border-border">
        <header className="flex items-center justify-between gap-4 px-6 py-4">
          <div
            className={`flex min-w-[14rem] flex-1 items-center gap-3 ${
              fieldHit === 'title' ? 'search-hit-field' : ''
            }`}
            data-search-hit={fieldHit === 'title' ? 'true' : undefined}
          >
            {sessionType === 'audio' ? (
              <Mic className="h-5 w-5 shrink-0 text-text-tertiary" strokeWidth={1.75} aria-hidden />
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
              readOnlyText={isPlain ? displayTitle : null}
              fallback="Transkription ohne Titel"
              onSaved={(next, record) => {
                setSessionTitle(next)
                if (record) setTitleSnapshot(record.titleSnapshot)
              }}
              className="min-w-0 flex-1 text-base font-semibold text-text-primary"
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Schmaler Kopf: nur das Symbol. Die Ansicht bleibt erkennbar — Name im
              Tooltip und Screenreader, in Klartext zusätzlich der Farbakzent des
              Umschalters (Warnfarbe). */}
            <button
              className={`flex h-9 w-9 items-center justify-center gap-1.5 rounded-lg border text-sm font-semibold transition-colors @min-[40rem]:w-auto @min-[40rem]:px-4 ${
                isPlain
                  ? 'border-warning-border bg-warning-bg text-warning-text hover:bg-warning-bg/70 @min-[40rem]:border-border-strong @min-[40rem]:bg-surface-0 @min-[40rem]:text-text-secondary @min-[40rem]:hover:bg-surface-1'
                  : 'border-border-strong bg-surface-0 text-text-secondary hover:bg-surface-1'
              }`}
              onClick={handleExportClipboard}
              aria-label={copyLabel}
              title={`${copyLabel} — ${
                isPlain
                  ? 'kopiert den Text mit den Originalnamen'
                  : 'kopiert den Text mit Platzhaltern'
              }`}
            >
              <ClipboardCopy className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <span className="hidden @min-[40rem]:inline">{copyLabel}</span>
            </button>
            <button
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-0 text-text-secondary transition-colors hover:border-error-border hover:bg-error-bg hover:text-error-text"
              onClick={handleDeleteRequest}
              aria-label="Transkription löschen"
              title="Löschen"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            <button
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong transition-colors hover:bg-surface-1 ${panelShown ? 'bg-surface-2 text-text-primary' : 'bg-surface-0 text-text-secondary'}`}
              ref={panelToggleRef}
              onClick={togglePanel}
              aria-label="Übersicht ein-/ausblenden"
              aria-pressed={panelShown}
              title="Übersicht ein-/ausblenden"
            >
              <PanelRight className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </header>
        {/* #205 — Patientendossiers (AK 5) und beim PDF das Dokumentdatum (AK 18/20).
            Eingerückt auf die Titelspalte (Symbol 20 px + Abstand 12 px). */}
        <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 pb-3 pl-14 pr-6">
          {sessionType === 'pdf' && createdAt && (
            <DocumentDateButton
              session={{ id: sessionId, createdAt, documentDate }}
              sessionLabel={displayTitle.trim() || 'Transkription ohne Titel'}
              onSaved={setDocumentDate}
              onOpenChange={setDateDialogOpen}
            />
          )}
          <DossierBadges
            sessionId={sessionId}
            sessionLabel={displayTitle.trim() || 'Transkription ohne Titel'}
            dossiers={dossiers.data}
            variant="editor"
            onOpenDossier={onOpenDossier}
            onOpenChange={setAssignOpen}
          />
        </div>
      </div>

      {/* Editor + Panel row */}
      <div ref={panelRowRef} className="relative flex min-h-0 flex-1">
        <div
          ref={editorScrollRef}
          tabIndex={-1}
          data-testid="editor-scroll"
          className="editor-scroll min-w-0 flex-1 overflow-y-auto focus:outline-none"
          onScroll={(e) => {
            const el = e.currentTarget
            el.classList.add('is-scrolling')
            clearTimeout(scrollTimerRef.current)
            scrollTimerRef.current = setTimeout(() => el.classList.remove('is-scrolling'), 1500)
          }}
        >
          {/* Optional LLM-generated summary scrolls with the transcript */}
          <div
            ref={summaryWrapRef}
            className={`px-6 pt-4 [&:empty]:p-0 ${fieldHit === 'summary' ? 'search-hit-field' : ''}`}
            data-search-hit={fieldHit === 'summary' ? 'true' : undefined}
          >
            <SummaryPanel sessionId={sessionId} entityMap={entityMap} />
          </div>
          <ChipActionsContext.Provider value={chipActions}>
            <EditorContent editor={editor} />
          </ChipActionsContext.Provider>
        </div>
        <ReviewSidePanel
          isOpen={panelShown}
          overlay={overlay}
          onClose={closeOverlay}
          panelRef={panelFocusRef}
          readOnly={isPlain}
          anonymization={overviewData}
          onRevert={handleBatchRemove}
          onChangeType={handleChipChangeType}
          onAddToBlocklist={handleChipAddToBlocklist}
          provenance={provenance}
          reviewAt={reviewAt}
          audioStats={audioStats}
        />
      </div>

      {/* Floating toolbar that surfaces while a non-empty text selection exists */}
      {selectionToolbar && (
        <SelectionToolbar
          anchorRect={selectionToolbar.anchorRect}
          multiChipSelectionOnly={selectionToolbar.multiChipSelectionOnly}
          onAnonymize={(type) => {
            handleAnonymize(type)
            hideSelectionToolbar()
          }}
          onAddToBlocklist={(type) => {
            handleAddToBlocklist(type)
            hideSelectionToolbar()
          }}
          onClose={hideSelectionToolbar}
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
      {deleteTarget && (
        <DeleteSessionDialog
          session={deleteTarget}
          displayTitle={displayTitle}
          dossiers={deleteTarget.dossiers}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* #209 AK 11 — Ansage der Fundstelle (ohne Text daraus: keine Klarnamen) */}
      <div role="status" aria-live="polite" className="sr-only">
        {hitAnnouncement}
      </div>

      {/* Footer status bar */}
      <footer className="flex items-center justify-between border-t border-border px-6 py-2">
        <div className="flex items-center gap-4">
          <SaveStatus saving={saving} lastSavedAt={lastSavedAt} />
          {liveWordCount != null && (
            <span className="text-xs text-text-tertiary">
              {liveWordCount.toLocaleString('de-CH')} Wörter
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-tertiary">
          {isPlain ? (
            <span>Klartext – Bearbeiten in der pseudonymisierten Ansicht</span>
          ) : (
            <>
              <span>⌘Z Widerrufen</span>
              <span aria-hidden>·</span>
              <span>⇧⌘Z Wiederholen</span>
            </>
          )}
        </div>
      </footer>
    </div>
  )
}

// memo: die Shell rendert bei eigenen Zustandswechseln neu (Aufnahme-Start/-Stopp,
// Hinweise, Import) — der Editor hängt nur an sessionId und dem stabilen onBack.
export default memo(ReviewEditor)
