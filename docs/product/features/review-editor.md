# Review Editor

The Review Editor is Therascript's document editing view where users inspect, correct, and refine the anonymized transcript before exporting. It is built on TipTap (a ProseMirror wrapper) with three custom node extensions that represent anonymized entities, speaker diarization labels, and time markers as atomic inline nodes.

## TipTap Foundation

The editor uses `@tiptap/react` with `StarterKit` as a base, deliberately disabling features not needed for transcript review: code blocks, blockquotes, lists, headings, and horizontal rules. This leaves basic paragraph and text editing intact while keeping the toolbar-free interface minimal.

All three custom nodes are defined as **atomic inline nodes** (`atom: true`, `inline: true`, `group: 'inline'`). Atomic nodes behave as indivisible units within ProseMirror — the cursor moves around them rather than into them, they cannot be partially selected, and they are treated as a single entity for undo/redo. This is essential because placeholder chips, speaker labels, and timestamps must not be editable as free text: their content is derived from structured attributes, not user keystrokes.

Each extension uses `ReactNodeViewRenderer` to delegate rendering to a React component (NodeView), giving full control over appearance and interaction while ProseMirror manages the document model.

## Custom Extensions

### placeholderChip

Represents an anonymized entity in the transcript. Each chip replaces a piece of sensitive text (a name, location, date, etc.) with a typed, numbered placeholder.

**Node attributes:**

| Attribute  | Type   | Default    | Description                                                                 |
|------------|--------|------------|-----------------------------------------------------------------------------|
| `entityId` | string | `''`       | Unique identifier linking all occurrences of the same entity (e.g. `person-3`) |
| `type`     | string | `'PERSON'` | One of the 7 placeholder types: PERSON, ORT, DATUM, KONTAKT, ORGANISATION, MEDIZINISCH, SONSTIGES |
| `number`   | number | `1`        | Sequential number within the type (e.g. PERSON 1, PERSON 2)                |
| `source`   | string | `'ner'`    | How the entity was detected: `ner` (automatic NER), `blocklist`, or `manual` |
| `original` | string | `''`       | The original sensitive text that was replaced                               |

**Rendering:** The `PlaceholderChipView` component renders each chip as a color-coded inline badge showing the type and number (e.g. "PERSON 1") plus a small source icon. Each of the 7 types has a distinct background/text color combination defined via Tailwind theme tokens (`bg-chip-person-bg`, `bg-chip-ort-bg`, etc.). When selected in ProseMirror, the chip shows a ring highlight.

**Tooltip on hover:** Hovering over a chip reveals a fixed-position tooltip (portaled to `document.body`) displaying the original sensitive text. The tooltip is positioned above the chip by default, falling back to below when there is insufficient space above. Horizontal clamping prevents the tooltip from overflowing the viewport edges.

**Source indicators:** A small emoji icon on each chip indicates the detection source:
- NER (automatic): robot icon
- Blocklist: book icon
- Manual: pencil icon

### speakerLabel

Marks the beginning of a speaker turn in audio transcripts, produced by the diarization pipeline.

**Node attributes:**

| Attribute | Type   | Default      | Description                                |
|-----------|--------|--------------|--------------------------------------------|
| `speaker` | string | `'A'`        | Internal speaker identifier (A, B, C, ...) |
| `label`   | string | `'Person A'` | Display label shown to the user            |

**Rendering:** The `SpeakerLabelView` component renders the label in the format `[Person A]:` using semibold secondary-color text. The node is non-editable (`contentEditable={false}`).

### timestamp

Marks a point in time within the audio transcript, anchoring text to the original recording timeline.

**Node attributes:**

| Attribute   | Type   | Default      | Description                              |
|-------------|--------|--------------|------------------------------------------|
| `seconds`   | number | `0`          | Time offset in seconds from recording start |
| `formatted` | string | `'00:00:00'` | Pre-formatted display string (HH:MM:SS) |

**Rendering:** The `TimestampView` component renders timestamps as `[00:12:34]` in a monospace font at a smaller size, using tertiary text color. Non-editable.

## Editor Header

The header bar contains:

- **Back button** ("Zurück"): Returns to the session dashboard. Triggers a session list refresh.
- **Session icon**: Microphone for audio sessions, document icon for PDF sessions.
- **Session title**: Displayed as a heading.
- **Copy button** ("Kopieren"): Exports the anonymized document to the system clipboard (see Clipboard Export below).
- **Three-dot menu** ("Weitere Optionen"): A dropdown with two actions:
  - **Umbenennen** (Rename): Opens a rename dialog to change the session title.
  - **Löschen** (Delete): Opens a destructive confirmation dialog. Deleting removes the audio file, original text, anonymized text, and placeholder mapping. On confirmation, navigates back to the dashboard.

## Context Menu

Right-clicking inside the editor opens a custom context menu with actions that depend on what was clicked:

### On a placeholder chip (right-click on chip)

- **Rückgängig machen** (Undo anonymization): Removes all chips in the document that share the same `entityId` and restores each to its original text. The subtitle shows the chip identity and occurrence count (e.g. "Macht alle [PERSON 1] im Text rückgängig (3 Vorkommen)"). All replacements happen in a single ProseMirror transaction, so they form one undo step.

### On selected text (text selection + right-click)

- **Anonymisieren als...** (Anonymize as): A submenu with 5 entity types (Person, Ort, Datum, Kontakt, Organisation). Selecting one replaces the selection with a new placeholder chip of that type, assigned the next available number. If the selection overlaps existing chips, it auto-extends to encompass them and extracts the combined original text. Decision #151 limits manual anonymization to these 5 types (MEDIZINISCH and SONSTIGES are excluded).

- **Zur Sperrliste hinzufügen...** (Add to blocklist): A submenu with all 7 entity types. Selecting one opens a confirmation dialog (`BlocklistConfirmDialog`) showing the term, the chosen type, and a note that the term will be automatically anonymized in future sessions and retroactively applied in the current document. On confirmation:
  1. The term is added to the SQLite blocklist via IPC.
  2. The current selection is replaced with a chip.
  3. All other occurrences of the term in the document are found (case-insensitive, with bidirectional Umlaut normalization and whole-word matching) and replaced with chips sharing the same `entityId`.
  4. All replacements happen in a single transaction.
  5. The operation is tracked on an undo stack so that Cmd+Z correctly removes the blocklist entry from SQLite when the chips are undone, and Cmd+Shift+Z re-adds it on redo.

Both sections appear when right-clicking a chip while text is also selected, separated by a divider.

The context menu closes on Escape, on click outside, or after selecting an action. Position is automatically adjusted to stay within the viewport.

### Keyboard shortcut for chip removal

Pressing Delete or Backspace when a placeholder chip is selected (ProseMirror NodeSelection) triggers batch removal of all chips with the same `entityId`, identical to the context menu's "Rückgängig machen" action.

## Clipboard Export

The "Kopieren" button in the header exports the full document as anonymized plain text to the system clipboard via the `review:exportClipboard` IPC channel (which calls `clipboard.writeText` in the main process).

The serialization logic (`serializeDocument`) converts the TipTap JSON document to plain text:
- **Placeholder chips** become their bracket notation: `[PERSON 1]`, `[ORT 2]`, etc.
- **Speaker labels** become `[Person A]:` (audio sessions only; omitted for PDF sessions).
- **Timestamps** become `[00:12:34]` (audio sessions only; omitted for PDF sessions).
- **Regular text** is preserved as-is.
- Paragraphs are joined with newlines.

A toast notification confirms success ("In Zwischenablage kopiert") or reports failure.

The editor also has a custom `clipboardTextSerializer` for partial copy (Cmd+C on a selection), which uses the same bracket notation for chips, speaker labels, and timestamps within the copied range.

## Undo / Redo

Standard ProseMirror undo/redo is available via **Cmd+Z** (undo) and **Cmd+Shift+Z** (redo). These keyboard shortcuts are displayed in the footer status bar.

The initial document content loaded from disk is not undoable — the editor resets its undo history after loading by creating a fresh `EditorState` with the loaded document but empty history.

Blocklist quick-add operations receive special undo/redo handling: when chips from a blocklist addition are undone, the corresponding SQLite blocklist entry is deleted. When they are redone, the entry is re-added. This keeps the blocklist database in sync with the document state across undo/redo cycles.

## Auto-Save

The editor auto-saves to disk 2 seconds after the last edit (debounced via `useAutoSave`). The save writes the TipTap JSON document to the filesystem and updates the entity map in SQLite. The footer status bar shows the current save state: "Speichern..." while saving, or "Gespeichert vor Xs" / "Gespeichert gerade eben" after completion.

## Navigation

The Review Editor is not a routed page — it is rendered conditionally in `App.tsx` when `currentView` is `'review'` and a `reviewSessionId` is set. Users enter the editor by clicking a session card that is in `review` status on the Session Dashboard. This sets the view state and passes the session ID as a prop.

Exiting happens via the "Zurück" button in the header, which resets `reviewSessionId` to null, switches the view back to `'sessions'`, and triggers a session list refresh. Navigation into the review editor is disabled during active recording.

## Backend (Main Process)

The `ReviewService` class handles loading and saving:

- **Load** (`review:load`): Reads the anonymized TipTap JSON document from the filesystem path stored in the session record. Only sessions in `review` status can be loaded. Returns the document, entity map, session type, and title.
- **Save** (`review:save`): Writes the TipTap JSON document back to disk (pretty-printed) and updates the entity map in the database.
- **Export to clipboard** (`review:exportClipboard`): Writes the provided plain text string to the system clipboard.

All IPC arguments are validated with Zod schemas (`ReviewLoadSchema`, `ReviewSaveSchema`, `ReviewExportClipboardSchema`).
