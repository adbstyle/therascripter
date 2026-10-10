import { Node, mergeAttributes } from '@tiptap/core'
import { clipboardNodeText } from '../utils/clipboardText'
import { chipClipboardPlugin } from './chipClipboard'

/**
 * Schema and serialization of the transcript's atom nodes, without NodeViews.
 * The Review Editor extends them with React NodeViews (placeholderChip.ts,
 * speakerLabel.ts, timestamp.ts); `createTestEditor` uses them as they are,
 * so tests run against the production schema and clipboard behavior.
 *
 * `renderHTML` only feeds serialization — chiefly the text/html flavor of
 * Cmd+C — and renders each node as its visible text token.
 */

export const PlaceholderChipNode = Node.create({
  name: 'placeholderChip',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      entityId: { default: '' },
      type: { default: 'PERSON' },
      number: { default: 1 },
      source: { default: 'ner' },
      // The clear name: neither rendered to nor read from HTML, so it never
      // reaches the clipboard; chipClipboardPlugin restores it on paste.
      original: { default: '', rendered: false, parseHTML: () => '' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="placeholderChip"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'placeholderChip' }, HTMLAttributes),
      clipboardNodeText(node)
    ]
  },

  addProseMirrorPlugins() {
    return [chipClipboardPlugin()]
  }
})

export const SpeakerLabelNode = Node.create({
  name: 'speakerLabel',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      speaker: { default: 'A' },
      label: { default: 'Person A' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="speakerLabel"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'speakerLabel' }, HTMLAttributes),
      clipboardNodeText(node)
    ]
  }
})

export const TimestampNode = Node.create({
  name: 'timestamp',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      seconds: { default: 0 },
      formatted: { default: '00:00:00' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="timestamp"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'timestamp' }, HTMLAttributes),
      clipboardNodeText(node)
    ]
  }
})
