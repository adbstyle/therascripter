# Sperrliste (Blocklist)

## Overview

The Sperrliste supplements Therascript's automatic NER detection with user-defined terms that should always be anonymized. While flair NER catches most names, locations, and dates automatically, the Sperrliste handles recurring terms that the model may miss or that are domain-specific to a particular practice. Every term in the Sperrliste is matched against all future anonymization runs and can also be applied retroactively in the Review Editor.

The Sperrliste is accessible in Settings under the "Sperrliste" tab.

## Entity Types

Blocklist entries can be assigned any of the 7 placeholder types:

| Type | Label | Description |
|---|---|---|
| `PERSON` | Person | Patient names, family members, referring physicians |
| `ORT` | Ort | Locations, addresses, cities |
| `DATUM` | Datum | Dates |
| `KONTAKT` | Kontakt | Phone numbers, email addresses, insurance numbers |
| `ORGANISATION` | Organisation | Institutions, clinics, employers |
| `MEDIZINISCH` | Medizinisch | Medical terms (blocklist/manual only, not detected by NER) |
| `SONSTIGES` | Sonstiges | Miscellaneous terms |

Note that `ORGANISATION` entities are only recognized through the Sperrliste or manual anonymization -- flair NER `ORG` entities are deliberately ignored (institutions are out of scope for automatic detection).

## CRUD Operations

### Adding an Entry

The "Eintrag hinzufügen" button in the Sperrliste tab opens a modal dialog (`BlocklistDialog`) with two fields:

- **Begriff (Term):** Free text input, 1-200 characters. Trimmed on submit. Required.
- **Platzhaltertyp (Placeholder Type):** Dropdown with all 7 types. Defaults to `PERSON`.

Validation: the submit button is disabled when the term is empty or exceeds 200 characters. The backend validates the same constraints via Zod schema (`BlocklistAddSchema`): `term` must be a string of 1-200 characters, `placeholderType` must be one of the 7 valid enum values.

### Editing an Entry

Each entry in the table has a "Bearbeiten" link that opens the same `BlocklistDialog` in edit mode, pre-filled with the current term and type. The entry's `id` is preserved; only `term` and `placeholder_type` are updated in the database. The `created_at` timestamp is not modified.

### Deleting an Entry

The "Löschen" link opens a `ConfirmDialog` asking the user to confirm removal. The dialog shows the term in quotation marks. Deletion removes the row from the database. Existing placeholder chips in already-processed sessions are not affected -- deletion only prevents future matching.

## Quick-Add from Review Editor

When text is selected in the Review Editor and the user right-clicks, the context menu (`EditorContextMenu`) shows two sections:

1. **"Anonymisieren als..."** -- one-time anonymization of the selection (5 types: PERSON, ORT, DATUM, KONTAKT, ORGANISATION).
2. **"Zur Sperrliste hinzufügen..."** -- adds the term to the blocklist for persistent anonymization (all 7 types available).

Selecting a type from the blocklist section triggers the following flow:

1. A `BlocklistConfirmDialog` appears, showing the selected term, the chosen type, and a note: "Der Begriff wird in zukünftigen Sitzungen automatisch anonymisiert und retroaktiv im aktuellen Dokument ersetzt."
2. On confirmation, the term is persisted to the SQLite blocklist via `blocklist:add` IPC.
3. The `addToBlocklistRetroactive` function performs retroactive replacement in the current document (see below).
4. The action is pushed onto a blocklist undo stack for undo/redo support.

## Retroactive Re-Anonymization

When a term is added via quick-add, `addToBlocklistRetroactive` (`src/renderer/src/utils/editorCommands.ts`) performs the following in a single ProseMirror transaction (one undo step):

1. **Replaces the current selection** with a `placeholderChip` node (source: `blocklist`).
2. **Scans all text nodes** in the document for additional matches of the same term, using case-insensitive comparison with Umlaut normalization.
3. **Replaces all matches** with chips sharing the same `entityId` and placeholder number.
4. Matching respects **word boundaries** -- "Müller" will not match inside "Müllerstrasse".

All replacements use the same `entityId` (e.g., `person-4`), so they share a single entry in the `entityMap` and display the same placeholder number.

## Umlaut Normalization

Blocklist matching uses bidirectional Umlaut normalization (`src/shared/utils/blocklist-matching.ts`) to handle Swiss-German and standard German spelling variants:

| Character | Normalized form |
|---|---|
| ä | ae |
| ö | oe |
| ü | ue |
| ß | ss |

Both the search term and the document text are normalized to the same form before comparison. This means a blocklist entry "Müller" will match "Mueller" in the text, and vice versa.

The `normalizeWithPositionMap` function builds a position map from normalized positions back to original positions, accounting for the length difference when a single character (e.g., ä) expands to two characters (ae). This ensures that replacement ranges map correctly back to the original document text.

Matching is also case-insensitive: both sides are lowercased before comparison.

## Database Schema

The blocklist is stored in the `blocklist` table, created in `src/main/db/migrations/001-initial-schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS blocklist (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    placeholder_type TEXT NOT NULL CHECK(placeholder_type IN (
        'PERSON', 'ORT', 'DATUM', 'KONTAKT',
        'ORGANISATION', 'MEDIZINISCH', 'SONSTIGES'
    )),
    created_at TEXT DEFAULT (datetime('now'))
);
```

- **id:** UUID v4, generated by `BlocklistRepository.create()` via `crypto.randomUUID()`.
- **term:** The exact term as entered by the user (1-200 characters).
- **placeholder_type:** One of the 7 valid placeholder types, enforced by a CHECK constraint.
- **created_at:** ISO 8601 timestamp, set on creation.

The repository (`src/main/db/repositories/BlocklistRepository.ts`) provides `findAll`, `findById`, `create`, `update`, and `delete` methods. All IPC handlers (`src/main/ipc/blocklist-handlers.ts`) validate incoming arguments with Zod schemas before passing them to the repository.

## Key Source Files

| File | Purpose |
|---|---|
| `src/main/db/repositories/BlocklistRepository.ts` | Database CRUD operations |
| `src/main/ipc/blocklist-handlers.ts` | IPC handler registration (list, add, update, delete) |
| `src/shared/validation/blocklist-schemas.ts` | Zod schemas for input validation |
| `src/shared/utils/blocklist-matching.ts` | Umlaut normalization and word-boundary matching |
| `src/renderer/src/components/BlocklistManager.tsx` | Settings UI: table with add/edit/delete |
| `src/renderer/src/components/BlocklistDialog.tsx` | Add/edit modal dialog |
| `src/renderer/src/components/editor/EditorContextMenu.tsx` | Right-click context menu with quick-add |
| `src/renderer/src/components/editor/BlocklistConfirmDialog.tsx` | Confirmation dialog for quick-add |
| `src/renderer/src/utils/editorCommands.ts` | `addToBlocklistRetroactive` logic |
