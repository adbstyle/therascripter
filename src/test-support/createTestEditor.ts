import { Editor } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import {
  PlaceholderChipNode,
  SpeakerLabelNode,
  TimestampNode
} from '../renderer/src/extensions/transcriptNodes'
import type { TipTapDocument } from '../shared/types/TipTapDocument'
import type { EntitySource, PlaceholderType } from '../shared/types'

export interface ChipAttrs {
  entityId: string
  type: PlaceholderType
  number: number
  source: EntitySource
  original: string
}

export interface ChipSnapshot extends ChipAttrs {
  pos: number
  nodeSize: number
}

export interface TestEditorHandle {
  editor: Editor
  insertText: (pos: number, text: string) => void
  insertChip: (pos: number, attrs: ChipAttrs) => void
  setSelection: (from: number, to: number) => void
  getChips: () => ChipSnapshot[]
  destroy: () => void
}

export interface CreateTestEditorOptions {
  initialDoc?: TipTapDocument
  handleKeyDown?: (view: EditorView, event: KeyboardEvent) => boolean | void
  /** Session the editor belongs to — scopes chip restoration on paste. */
  sessionId?: string
}

export function createTestEditor(
  initialDocOrOptions?: TipTapDocument | CreateTestEditorOptions
): TestEditorHandle {
  const opts: CreateTestEditorOptions =
    initialDocOrOptions && 'type' in initialDocOrOptions
      ? { initialDoc: initialDocOrOptions }
      : (initialDocOrOptions ?? {})

  const editorConfig: ConstructorParameters<typeof Editor>[0] = {
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
      PlaceholderChipNode.configure({ getSessionId: () => opts.sessionId ?? 'test-session' }),
      SpeakerLabelNode,
      TimestampNode
    ],
    content: opts.initialDoc ?? { type: 'doc', content: [{ type: 'paragraph' }] }
  }
  if (opts.handleKeyDown) {
    editorConfig.editorProps = { handleKeyDown: opts.handleKeyDown }
  }
  const editor = new Editor(editorConfig)

  const insertText = (pos: number, text: string): void => {
    const tr = editor.state.tr.insertText(text, pos)
    editor.view.dispatch(tr)
  }

  const insertChip = (pos: number, attrs: ChipAttrs): void => {
    const node = editor.state.schema.nodes.placeholderChip.create(attrs)
    const tr = editor.state.tr.insert(pos, node)
    editor.view.dispatch(tr)
  }

  const setSelection = (from: number, to: number): void => {
    editor.commands.setTextSelection({ from, to })
  }

  const getChips = (): ChipSnapshot[] => {
    const chips: ChipSnapshot[] = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'placeholderChip') {
        chips.push({
          pos,
          nodeSize: node.nodeSize,
          entityId: node.attrs.entityId as string,
          type: node.attrs.type as PlaceholderType,
          number: node.attrs.number as number,
          source: node.attrs.source as EntitySource,
          original: node.attrs.original as string
        })
      }
    })
    return chips
  }

  const destroy = (): void => editor.destroy()

  return { editor, insertText, insertChip, setSelection, getChips, destroy }
}
