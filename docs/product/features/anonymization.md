# Anonymization

## Overview

Therascript anonymizes transcripts and imported PDFs using a three-layer hybrid pipeline: flair NER (neural named entity recognition for German), regex pattern matching, and the user-managed Sperrliste (blocklist). Identified entities are replaced with numbered, type-specific placeholders such as `[PERSON 1]` or `[ORT 2]`. The result is a TipTap JSON document where each placeholder is an atomic `placeholderChip` node that the therapist can review, undo, or augment in the Review Editor.

All anonymization runs locally on-device. No data leaves the machine.

## Entity Types

There are 7 user-visible placeholder types, defined in `src/shared/types/EntityMap.ts` as the `PlaceholderType` union:

| Type | Description | Example original | Example placeholder |
|---|---|---|---|
| `PERSON` | Names of people | Dr. Müller, Herr Schmidt | `[PERSON 1]` |
| `ORT` | Locations, cities, addresses | Zürich, Bahnhofstrasse 42 | `[ORT 1]` |
| `DATUM` | Dates (especially birth dates) | geb. 15.03.1985 | `[DATUM 1]` |
| `KONTAKT` | Contact details: phone, email, AHV, insurance, case numbers | +41 79 123 45 67, info@example.ch | `[KONTAKT 1]` |
| `ORGANISATION` | Institutions and organizations | Kantonsspital Winterthur | `[ORGANISATION 1]` |
| `MEDIZINISCH` | Medical terms (blocklist/manual only) | — | `[MEDIZINISCH 1]` |
| `SONSTIGES` | Miscellaneous entities (flair MISC + blocklist/manual) | — | `[SONSTIGES 1]` |

### Placeholder format

Placeholders follow the pattern `[TYPE NUMBER]` where the number is type-specific and monotonically increasing (gaps are not filled, per Decision #140). For example, three detected persons produce `[PERSON 1]`, `[PERSON 2]`, `[PERSON 3]`. The number counter is independent per type.

Entity IDs follow the pattern `type-number` in lowercase, e.g. `person-1`, `ort-2`.

## Recognition Pipeline

`AnonymizationService` (`src/main/ml/AnonymizationService.ts`) orchestrates the full pipeline. The three recognition layers run in this order:

### 1. flair NER (Python sidecar)

The Python sidecar (`ner_service.py`) loads the `flair/ner-german-large` model and runs NER on all transcript segments. It outputs entities with flair types (`PER`, `LOC`, `ORG`, `MISC`) plus character spans and confidence scores.

**Type mapping** (in `entity-merger.ts`, `mapNerType`):

| flair type | Therascript type | Notes |
|---|---|---|
| `PER` | `PERSON` | |
| `LOC` | `ORT` | |
| `MISC` | `SONSTIGES` | |
| `ORG` | *(ignored)* | See section below |

The sidecar runs as a subprocess via `nice -n 10` (QoS, NFR-23) with a 5-minute timeout. Thread count is capped at 4 (`OMP_NUM_THREADS`, `MKL_NUM_THREADS`). Progress is reported via `[PROGRESS] <percent>` lines on stderr.

### 2. Regex engine

`runRegexEngine` (`src/main/ml/regex-patterns.ts`) applies 10 pattern definitions against every transcript segment:

| Pattern | Regex type | Maps to |
|---|---|---|
| Swiss phone (+41/0xx) | `TELEFON` | `KONTAKT` |
| International phone (+country code) | `TELEFON` | `KONTAKT` |
| AHV number (756.xxxx.xxxx.xx) | `AHV` | `KONTAKT` |
| Email address | `EMAIL` | `KONTAKT` |
| Swiss PLZ + city (8001 Zürich) | `PLZ_ORT` | `ORT` |
| Birth date with context (geb. DD.MM.YYYY) | `GEBURTSDATUM` | `DATUM` |
| Standalone full date (DD.MM.YYYY) | `DATUM_STANDALONE` | `DATUM` |
| Insurance/case number | `VERSICHERUNG` | `KONTAKT` |
| Case/dossier number | `FALL_NR` | `KONTAKT` |
| Swiss street address (Xstrasse NN) | `STRASSE` | `KONTAKT` |

Overlapping regex matches are deduplicated: earlier and longer matches win.

### 3. Sperrliste (blocklist)

The user-managed blocklist is loaded from SQLite via `BlocklistRepository.findAll()`. Each entry has a `term` and a `placeholderType`. Blocklist matching uses:

- **Case-insensitive** comparison
- **Bidirectional Umlaut normalization** (see below)
- **Longest-match-first** ordering: entries are sorted by term length descending before scanning
- **Whole-word boundary** checking

## Entity Merging and Priority

`mergeEntities` (`src/main/ml/entity-merger.ts`) combines all three sources with a strict priority order:

```
NER (highest) > Blocklist > Regex (lowest)
```

Entities are added in priority order. When a lower-priority entity overlaps with an already-added higher-priority entity, the lower-priority entity is skipped. This is a first-come-wins strategy by priority tier.

All entities -- regardless of source -- must pass a whole-word boundary check (`isWholeWord` from `src/shared/utils/blocklist-matching.ts`). This prevents partial matches like "Müller" inside "Müllerstrasse".

The `source` field on each entity tracks its origin: `'ner'` (includes both flair NER and regex detections), `'blocklist'`, or `'manual'` (added by the therapist in the Review Editor).

## Longest-Match-First Strategy

Blocklist entries are sorted by term length descending before scanning (`sortByLengthDesc` in `entity-merger.ts`). This ensures that longer, more specific terms are matched before shorter substrings. For example:

- Blocklist contains "Peter Schmidt" and "Schmidt"
- Text: "Herr Peter Schmidt kam zur Sitzung"
- "Peter Schmidt" is matched first (longer) and occupies positions 5-19
- "Schmidt" would overlap with the existing match and is skipped

Without this ordering, "Schmidt" could match first, leaving "Peter" unprotected.

## Umlaut Normalization

German text contains umlauts (ä, ö, ü, ß) that may appear in their expanded form (ae, oe, ue, ss) in transcriptions or user input. Therascript applies bidirectional normalization so that both forms match each other.

**Normalization rules** (`normalizeUmlaut` in `src/shared/utils/blocklist-matching.ts`):

| Character | Normalized form |
|---|---|
| ä | ae |
| ö | oe |
| ü | ue |
| ß | ss |

Both the search term and the text being searched are normalized to the expanded form before comparison. This means:

- Blocklist term "Müller" matches text "Mueller" and vice versa
- Blocklist term "Strasse" matches text "Straße"

Because normalization changes string length (ü becomes 2 characters), `normalizeWithPositionMap` builds a position map from normalized indices back to original text positions. This ensures that character spans in the original text remain accurate after matching in the normalized domain.

## flair ORG Entities: Ignored

flair's `ORG` entity type is deliberately ignored in the entity merger (`mapNerType` returns `null` for `ORG`). This is documented as Decision #5/#158.

**Rationale**: Organization names in therapy transcripts are highly context-dependent. A therapist might mention institutions that are not identifying (e.g. a well-known hospital) or use abbreviations that flair misclassifies. Rather than producing false positives, Therascript requires the therapist to add institutions explicitly via the Sperrliste or manual selection in the Review Editor, where they are assigned the `ORGANISATION` type.

## Coreference Resolution

After merging, `resolveCoreferences` (`src/main/ml/coreference-resolver.ts`) groups `PERSON` entities that refer to the same individual. This handles name variants such as:

- "Dr. Müller", "Herr Müller", "Müller" -- all grouped together
- "Prof. Dr. Weber", "Weber" -- grouped

**How it works**:

1. Strip title prefixes (Herr, Frau, Dr., Prof., Hr., Fr.) iteratively
2. Compare canonical names: a single-part name matches as the surname in a multi-part name (e.g. "Müller" matches "Peter Müller")
3. Group all matching variants and assign the longest variant as the canonical representative
4. All entities in a group share the same `canonicalText`, which causes `buildEntityMap` to assign them the same `entityId` and placeholder number

## EntityMap Construction

`buildEntityMap` (`src/main/ml/entity-map-builder.ts`) creates the mapping from entity IDs to placeholder metadata.

- Processes entities in order of first appearance
- Uses type-specific counters: each `PlaceholderType` has its own numbering starting at 1
- Coreference groups (entities sharing the same `canonicalText`) get the same `entityId` -- only the first occurrence increments the counter
- The resulting `EntityMap` is a dictionary keyed by `entityId` (e.g. `"person-1"`) with values containing `original`, `placeholder`, `type`, and `source`

## TipTap Document Generation

`buildTipTapDocument` (`src/main/ml/tiptap-builder.ts`) converts the transcript segments plus entity data into a TipTap-compatible JSON document.

### Document structure

```
doc
  paragraph (per segment)
    [timestamp]           -- only in multi-speaker transcripts
    [text: " "]
    [speakerLabel]        -- only in multi-speaker transcripts
    [text: " "]
    [text | placeholderChip]...
```

### Node types

- **`text`**: Plain text node for non-entity text spans
- **`placeholderChip`**: Atomic node replacing an entity occurrence. Attributes:
  - `entityId`: e.g. `"person-1"`
  - `type`: the `PlaceholderType`
  - `number`: the type-specific number
  - `source`: `"ner"`, `"blocklist"`, or `"manual"`
  - `original`: the original text that was replaced (stored for undo/reveal)
- **`speakerLabel`**: Speaker attribution (multi-speaker only), e.g. "Person A"
- **`timestamp`**: Time marker in `HH:MM:SS` format

### How text is replaced

`findEntityOccurrences` locates all entity spans in a segment by matching merged entities to their segment index and character positions. `buildInlineNodes` then walks through the segment text left to right, emitting `text` nodes for gaps between entities and `placeholderChip` nodes at entity positions. Overlapping occurrences are removed (earlier/longer wins).

The generated TipTap document is saved as JSON to `~/.therascript/` and the path is stored in the session record alongside the `EntityMap`.

## Retroactive Re-Anonymization

When a therapist adds a term to the Sperrliste from the Review Editor (quick-add), all existing occurrences of that term in the current document are replaced retroactively.

`addToBlocklistRetroactive` (`src/renderer/src/utils/editorCommands.ts`) handles this:

1. The current text selection becomes the first replacement (auto-extended to include any overlapping chips)
2. A full scan of all text nodes in the document finds additional matches using:
   - Case-insensitive comparison
   - Umlaut normalization (same `normalizeWithPositionMap` logic as the main pipeline)
   - Whole-word boundary enforcement
3. All matches (initial selection + retroactive finds) are replaced with `placeholderChip` nodes sharing the same `entityId`
4. Everything happens in a single ProseMirror transaction, so the entire operation is one undo step

The therapist can also manually anonymize any selected text via `anonymizeSelection`, choosing the placeholder type. This creates a `manual`-sourced chip. Conversely, `batchRemovePlaceholder` removes all chips with a given `entityId`, restoring the original text -- also as a single undo step.

## Source Files

| File | Purpose |
|---|---|
| `src/main/ml/AnonymizationService.ts` | Pipeline orchestrator (task executor) |
| `src/main/ml/regex-patterns.ts` | 10 regex patterns for structured data |
| `src/main/ml/entity-merger.ts` | Merge NER + regex + blocklist with priority |
| `src/main/ml/coreference-resolver.ts` | Group PERSON name variants |
| `src/main/ml/entity-map-builder.ts` | Assign entity IDs and placeholders |
| `src/main/ml/tiptap-builder.ts` | Build TipTap JSON document |
| `src/shared/types/EntityMap.ts` | `PlaceholderType`, `EntitySource`, `EntityMap` types |
| `src/shared/types/NerTypes.ts` | `NerEntity`, `RegexEntity`, `MergedEntity`, `BlocklistEntry` |
| `src/shared/types/TipTapDocument.ts` | TipTap document and node type definitions |
| `src/shared/utils/blocklist-matching.ts` | Umlaut normalization, whole-word check, position mapping |
| `src/renderer/src/utils/editorCommands.ts` | Manual anonymization, batch removal, retroactive blocklist |
