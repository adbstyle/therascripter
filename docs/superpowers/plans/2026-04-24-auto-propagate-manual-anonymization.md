# Auto-Propagate Manual Anonymization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user manually flags a text as an anonymization placeholder in the Review Editor, all identical occurrences of that text in the same document are automatically flagged with the same type and number in a single operation. Implements GitHub issue #42.

**Architecture:** Extend the existing anonymization helpers in `src/renderer/src/utils/editorCommands.ts`. The new `anonymizeSelectionWithPropagation()` function replaces the current `anonymizeSelection()` call path and internally reuses the scan/match logic already proven in `addToBlocklistRetroactive()` (text-node descent, `normalizeUmlaut` + `normalizeWithPositionMap` + `isWholeWord` from `src/shared/utils/blocklist-matching.ts`, single-transaction replacement). The new function additionally walks `placeholderChip` nodes to satisfy the overwrite requirement (AK 9), cleans up orphaned EntityMap entries, and stores `source: 'manual'`. No SQLite write — the auto-propagation is session-scoped only.

**Design decision — reuse, don't refactor.** `addToBlocklistRetroactive()` already implements 90% of the required mechanics. We extract a shared internal helper `collectIdenticalOccurrences()` that both flows call, then build `anonymizeSelectionWithPropagation()` as the thin wrapper for the manual-flag path. `addToBlocklistRetroactive()` keeps its current signature and behavior (blocklist still works exactly as today). No behavior change for NER, Sperrliste, or drag-and-drop PDF import.

**Design decision — overwrite semantics are explicit and destructive.** Per the confirmed requirements (AK 9/10), when the auto-scan finds existing placeholder chips whose `original` attribute matches the selection's normalized form, those chips are replaced with new chips of the new type/entityId — the old chips' EntityMap entries are garbage-collected in the same transaction if no chips with that entityId remain. This is the same destructive pattern the user already experiences with manual deletion via `batchRemovePlaceholder()`, just batched.

**Design decision — extend the existing Cmd+Z watcher, do not hook `onUpdate`.** Because the feature does not write to SQLite, we do not need a new undo stack — but we DO need EntityMap recovery after undo/redo, because overwritten entries are deleted eagerly (Task 4) and restored chips otherwise have no EntityMap representation. The recovery runs inside the **existing** `handleKeyDown` Cmd+Z/Shift+Z microtask at [ReviewEditor.tsx:128-180](src/renderer/src/views/ReviewEditor.tsx#L128-L180), NOT in `onUpdate`. Hooking `onUpdate` is rejected because it fires on every keystroke (O(n) doc walk per keypress on long sessions) and races synchronously with `handleAnonymize`'s own `updateEntityMap` call. The Cmd+Z hook runs only on undo/redo and reuses the established `queueMicrotask` pattern from commit `1bbdd0d`.

**UI flow:** No new UI surface. The user right-clicks a selection, picks a type from "Anonymisieren als...", and the existing context-menu path now runs the propagation. The Anonymisierungs-Panel on the right re-derives its counts from the EntityMap (via `useAnonymizationOverview`) and will correctly show `CH-3014 3x` without any panel change. A new menu-item disable rule prevents the "Anonymisieren als..."-section from firing when the selection spans multiple chips with no neutral text (AK 12). Single-chip-same-type is a silent no-op (AK 11), handled inside the function.

**Tech Stack:** Pure renderer-side change. TypeScript, TipTap/ProseMirror transactions, existing `blocklist-matching.ts` utilities. No IPC changes, no schema changes, no main-process touch.

---

## Pre-flight: Constraints & Assumptions

Read before starting any task:

- **Single ProseMirror transaction is non-negotiable.** All replacements (selection + text-node matches + chip-node overwrites) must happen in one `tr` dispatched once. This is what guarantees AK 5 (single Cmd+Z) and avoids intermediate broken states. Model the implementation after [editorCommands.ts:269-281](src/renderer/src/utils/editorCommands.ts#L269-L281) — collect replacements into an array first, then sort descending by `from`, then apply.
- **Chip nodes are atomic; text matches live in text nodes.** The scan must run in two passes: `state.doc.descendants()` for `isText` nodes (existing logic, line 233) AND a second pass that collects `placeholderChip` nodes with a matching `original` attribute. Positions from both passes go into the same `replacements` array and are sorted/applied together.
- **EntityMap garbage collection.** When an existing chip is overwritten, check whether any chips with that old entityId remain in the document *after the transaction*. Use a post-dispatch scan over `editor.state.doc` (not the pre-dispatch state), then delete orphaned entries from the returned EntityMap. Never mutate the input EntityMap — always return a new object.
- **Source field stays `'manual'`.** Every chip produced by the propagation carries `source: 'manual'` even when it overwrites a former NER or blocklist chip. The overwrite represents an explicit user decision, and the panel's grouping by `source` should reflect that.
- **Tooltip `original` = local occurrence text, not selection text.** Per the finalized UX answer (Postcondition 4), each propagated chip's `original` attribute is set to the actual substring at that position in the document (case and umlaut preserved), not to the user's original selection text. The existing `text.substring(origStart, origEnd)` pattern on line 256 already does this correctly for text nodes; for chip-node overwrites, use the old chip's `original` attribute.
- **No-op detection (AK 11).** `extendSelectionAndExtractText()` returns only `{ from, to, originalText }` — it cannot distinguish a single chip from plain text. After computing `extFrom`/`extTo`, probe the node at `extFrom` and verify it is a chip of the same type filling the entire extended range:
  ```ts
  const singleNode = state.doc.nodeAt(extFrom)
  const isSingleChipSameType =
    singleNode?.type.name === 'placeholderChip' &&
    singleNode.attrs.type === type &&
    extTo - extFrom === singleNode.nodeSize
  if (isSingleChipSameType) return null
  ```
  Do NOT use `extTo - extFrom === 1` alone as a proxy — a single-character text selection ("i", "a") would incorrectly trigger the guard. Callers treat `null` as "no update".
- **Multi-chip selection (AK 12).** Detection lives in the UI layer, not in `editorCommands.ts`. Add a `selectionSpansMultipleChipsOnly` flag to `ContextMenuState` in [EditorContextMenu.tsx](src/renderer/src/components/editor/EditorContextMenu.tsx) and hide/disable the "Anonymisieren als..."-block when true. This keeps the core helper pure.
- **Performance budget: <2s on a 2h session (~20k tokens).** The existing `addToBlocklistRetroactive()` already handles documents of this size. The added chip-node pass is O(n) over the node count (typically <500 chips per session), well below the budget. No worker thread or debouncing needed.
- **Test discipline:** The project has **no existing TipTap editor fixture** — Task 0 adds one. After that, unit tests can boot a real `Editor` with `StarterKit + PlaceholderChip` against jsdom. The schema-heavy functions (`collectIdenticalOccurrences`, `anonymizeSelectionWithPropagation`) cannot be tested against the `createMockEditor` stub used in `useAnonymizationOverview.test.ts` — that stub only fakes `state.doc.descendants()` and does not provide a `Schema`, `Transaction`, or `view.dispatch`. All changes must leave the existing blocklist-matching and serializeDocument tests green; this plan adds the first tests for `editorCommands.ts`.
- **Conventions:** No semicolons, single quotes, no trailing commas, 100 char lines. Unused vars prefixed `_`. Match the style of the surrounding file.

---

## File Structure

Files created (new):
- `src/test-support/createTestEditor.ts` — Task 0 TipTap editor fixture (non-test helper, lives under `src/` so vitest can resolve its imports from test files).
- `src/test-support/createTestEditor.test.ts` — smoke test for the fixture itself.
- `src/renderer/src/utils/__tests__/editorCommands.test.ts` — unit + integration tests for `anonymizeSelectionWithPropagation` and `rebuildEntityMapFromDoc`.

Files modified:
- `src/renderer/src/utils/editorCommands.ts` — add `collectIdenticalOccurrences()` internal helper, add exported `anonymizeSelectionWithPropagation()`, factor-reuse from `addToBlocklistRetroactive()`. Keep `anonymizeSelection()` as a thin deprecated wrapper for one release cycle (delete in a follow-up) — OR replace directly if caller count is ≤1 (verify in Task 1).
- `src/renderer/src/views/ReviewEditor.tsx` — replace the `anonymizeSelection()` call inside `handleAnonymize` with `anonymizeSelectionWithPropagation()`; wire the returned `overwrittenEntityIds` set into an EntityMap cleanup step.
- `src/renderer/src/components/editor/EditorContextMenu.tsx` — extend `ContextMenuState` with `selectionSpansMultipleChipsOnly: boolean`; hide the "Anonymisieren als..."-section when true.
- `src/renderer/src/views/ReviewEditor.tsx` — in `handleContextMenu`, compute `selectionSpansMultipleChipsOnly` and pass it into the context menu state.

Files unchanged but verified:
- `src/shared/utils/blocklist-matching.ts` — reused as-is.
- `src/renderer/src/extensions/placeholderChip.ts` — no attribute changes.
- `src/renderer/src/hooks/useAnonymizationOverview.ts` — re-derives counts automatically once EntityMap + document are in sync.
- `src/main/**` — no changes. IPC surface is untouched.

---

## Tasks

### Task 0 — Add a TipTap editor test fixture

The project currently has no test harness capable of driving `editorCommands.ts` functions. This task creates it so every subsequent test can boot a real editor with minimal ceremony.

**Path constraint:** [vitest.config.ts:13](vitest.config.ts#L13) has `include: ['src/**/*.{test,spec}.{ts,tsx}']` — test files outside `src/` are NOT discovered. The fixture and its smoke test must live under `src/`.

- [ ] Create `src/test-support/createTestEditor.ts` exporting `createTestEditor(initialDoc?: TipTapDocument): Editor`. It constructs a real `@tiptap/core` `Editor` instance with `StarterKit`, `PlaceholderChip`, `SpeakerLabel`, and `Timestamp` extensions, identical to the production `useEditor` config in [ReviewEditor.tsx:92-108](src/renderer/src/views/ReviewEditor.tsx#L92-L108).
- [ ] Strip the `ReactNodeViewRenderer` on `PlaceholderChip` for the test build. Do NOT use `addNodeView: undefined` — TipTap's `getExtensionField` walks up to the parent extension when a field resolves to `void 0`, which silently re-activates `ReactNodeViewRenderer` and crashes in jsdom when it tries to mount a React root. Instead use an explicit function that returns `null`:
  ```ts
  const PlaceholderChipForTests = PlaceholderChip.extend({
    addNodeView() {
      return null as unknown as undefined
    }
  })
  ```
  The `null` return is handled by TipTap's internal guard (the extension is dropped from the NodeView registry), and the parent's `ReactNodeViewRenderer` is correctly bypassed. Chips are then rendered by TipTap's default HTML renderer using the extension's `renderHTML` output — which is sufficient for tests because they read `state.doc` directly, not the rendered DOM.
- [ ] Expose convenience helpers on the returned object: `insertText(pos, text)`, `insertChip(pos, { type, number, original, source, entityId })`, `getChips(): Array<ChipSnapshot>`, `setSelection(from, to)`. These wrap `editor.view.dispatch` with the appropriate transactions.
- [ ] Add `src/test-support/createTestEditor.test.ts` — smoke test that creates an editor, inserts a chip, reads it back, dispatches a replacement, verifies the chip is gone. Also assert that the React root is NOT mounted (no `React.createRoot` calls reach jsdom). Must run under `npm run test` in jsdom.

**Acceptance:** `npm run test src/test-support/createTestEditor.test.ts` is green. The helper is used by at least one other test before Task 9. No React rendering warnings in the jsdom console.

### Task 1 — Inventory existing callers and test coverage

Pre-seeded findings (verified before plan write-up, re-confirm at implementation time):
- `anonymizeSelection()` has exactly one caller: [ReviewEditor.tsx:350](src/renderer/src/views/ReviewEditor.tsx#L350). We replace it directly without a deprecation wrapper.
- `addToBlocklistRetroactive()` has exactly one caller: [ReviewEditor.tsx:382](src/renderer/src/views/ReviewEditor.tsx#L382). Refactored in Task 2, external behavior unchanged.
- No existing test file for `editorCommands.ts`. This plan adds the first tests via Task 7 using the Task 0 fixture.
- Existing test coverage for the matching layer lives in `src/shared/utils/__tests__/blocklist-matching.test.ts` — keep green.

- [ ] Re-verify the above with `grep -rn "anonymizeSelection\\|addToBlocklistRetroactive" src/` and `ls src/renderer/src/utils/__tests__/ 2>/dev/null`.
- [ ] If a new caller has appeared since the plan was written, update Task 4 and Task 7 accordingly before proceeding.

**Acceptance:** Inventory matches or the plan is amended.

### Task 2 — Extract shared `collectIdenticalOccurrences()` helper

- [ ] In `src/renderer/src/utils/editorCommands.ts`, add a non-exported function with this exact signature:
  ```ts
  interface CollectOptions {
    excludeRange: { from: number; to: number }
    overwritesChips: boolean
  }

  interface OccurrenceHit {
    from: number
    to: number
    original: string
    overwrittenChip?: { entityId: string; oldOriginal: string; oldSource: string }
  }

  function collectIdenticalOccurrences(
    state: EditorState,
    term: string,
    opts: CollectOptions
  ): OccurrenceHit[]
  ```
- [ ] Normalize `term` internally exactly as today: `const normalizedTerm = normalizeUmlaut(term.trim().toLowerCase())`. Do not move this to the caller — keeping it internal preserves byte-identical behavior with [editorCommands.ts:231](src/renderer/src/utils/editorCommands.ts#L231).
- [ ] **Pass A (always runs):** iterate `state.doc.descendants()` over `isText` nodes; copy the match + `isWholeWord` + `overlapsSelection` logic from [editorCommands.ts:233-263](src/renderer/src/utils/editorCommands.ts#L233-L263) verbatim. Use `opts.excludeRange` for the overlap check.
- [ ] **Pass B (only when `opts.overwritesChips === true`):** iterate `state.doc.descendants()` over `placeholderChip` nodes; match `normalizeUmlaut(node.attrs.original.toLowerCase()) === normalizedTerm`. Skip chips whose range overlaps `opts.excludeRange`. For each hit, push `{ from: pos, to: pos + node.nodeSize, original: node.attrs.original, overwrittenChip: { entityId, oldOriginal: node.attrs.original, oldSource: node.attrs.source } }`.
- [ ] Refactor `addToBlocklistRetroactive()` to call `collectIdenticalOccurrences(state, term, { excludeRange: { from: extFrom, to: extTo }, overwritesChips: false })`, then prepend the initial-selection replacement, sort descending, dispatch in one transaction. External behavior must be byte-identical. Run existing matching + serializer tests.

**Acceptance:** `npm run test` stays green. Diff shows the extracted helper is called by the refactored function. Behaviour is unchanged for every blocklist case.

### Task 3 — Implement `anonymizeSelectionWithPropagation()`

- [ ] Add exported function with signature:
  ```ts
  export interface PropagationResult {
    entityMap: EntityMap           // updated map with new entityId added — NOT yet cleaned of orphans (Task 4 does that)
    entityId: string               // the new entityId assigned to all propagated chips
    overwrittenEntityIds: Set<string>  // prior entityIds of chips that Pass B replaced
    propagatedCount: number        // total chips written in the transaction, INCLUDING the initial selection
                                   // (e.g. selection + 2 additional matches → propagatedCount === 3)
  }

  export function anonymizeSelectionWithPropagation(
    editor: Editor,
    type: PlaceholderType,
    entityMap: EntityMap
  ): PropagationResult | null
  ```
- [ ] Flow:
  1. Read `state.selection`; bail with `null` if empty.
  2. Call `extendSelectionAndExtractText()` → `{ extFrom, extTo, originalText }`.
  3. **No-op detection (AK 11):** use the `state.doc.nodeAt(extFrom)` probe + nodeSize invariant from the Pre-flight section. If the condition holds, return `null` BEFORE any further work.
  4. Compute the normalized term internally via `collectIdenticalOccurrences` (the helper normalizes; caller passes raw `originalText`).
  5. Generate new `entityId` via `generateEntityId(type, getNextNumber(entityMap, type))`.
  6. Call `collectIdenticalOccurrences(state, originalText, { excludeRange: { from: extFrom, to: extTo }, overwritesChips: true })`.
  7. Build a single `replacements` array: first entry is the initial selection `{ from: extFrom, to: extTo, original: originalText }`; then append every hit from step 6.
  8. Sort descending by `from`; apply in a single `tr.replaceWith(...)` loop creating a chip per entry with `source: 'manual'`, the new `entityId`, and the entry's own `original` (so Postcondition 4 — tooltip = local text — holds).
  9. Dispatch `tr` once.
  10. Compute `overwrittenEntityIds = new Set(hits.filter(h => h.overwrittenChip).map(h => h.overwrittenChip!.entityId))`.
  11. Compute `propagatedCount = replacements.length` (1 for selection + N additional).
  12. Return `{ entityMap: updated, entityId, overwrittenEntityIds, propagatedCount }`. The returned `entityMap` has the new entry added but still contains the overwritten entityIds — caller cleans up after dispatch.

- [ ] In the same file, add a second exported function used by Task 6:
  ```ts
  export function rebuildEntityMapFromDoc(
    doc: PMNode,
    currentMap: EntityMap
  ): EntityMap | null
  ```
  Semantics: walk `doc` once, collect every `placeholderChip`'s `entityId` + `attrs.{type, number, source, original}`. For every chip whose `entityId` is **not** in `currentMap`, reconstruct the entry from the chip's own attributes (placeholder string `[${type} ${number}]`). Return a new `EntityMap` if at least one entityId was added, else return `null`. The comparison is shallow key-presence (`entityId in currentMap`) — NOT reference equality on the whole map. This function is pure (takes a `PMNode`, no `Editor`) and can be unit-tested with a fixture doc, and `vi.spyOn(module, 'rebuildEntityMapFromDoc')` works for the Task 7 keystroke-no-op test.

**Acceptance:** `anonymizeSelectionWithPropagation` returns the result shape described; single transaction dispatched; `propagatedCount` semantics match the JSDoc on the interface (total chips, inclusive of selection). `rebuildEntityMapFromDoc` returns `null` when no drift exists, a new map otherwise — verified by its own unit tests.

### Task 4 — Wire into `ReviewEditor.handleAnonymize` with post-dispatch cleanup

Strict synchronous sequence inside `handleAnonymize`:

1. Call `result = anonymizeSelectionWithPropagation(editor, type, entityMapRef.current)`. The function dispatches the transaction internally.
2. If `result === null` → return (no-op per AK 11).
3. Start from `result.entityMap` (new entity already added, orphans not yet removed).
4. For each `oldId` in `result.overwrittenEntityIds`, call `hasChipsWithEntityId(editor.state.doc, oldId)` against the **post-dispatch** doc state. If it returns `false`, delete that entry from the map.
5. Sync the `blocklistUndoStackRef`: for each overwritten entityId that matches a tracked blocklist entry and is not already `undone`, set `undone = true` and call `window.api.blocklist.delete(entry.entryId)`. This mirrors the existing [handleBatchRemove pattern at ReviewEditor.tsx:329-334](src/renderer/src/views/ReviewEditor.tsx#L329-L334). Cmd+Z readd-via-microtask still works because the existing redo branch at [ReviewEditor.tsx:156-175](src/renderer/src/views/ReviewEditor.tsx#L156-L175) re-adds the SQLite row from `stackEntry.term` + `stackEntry.placeholderType` when chip presence returns.
6. Call `updateEntityMap(cleanedMap)` exactly once.
7. Call `editor.commands.focus()` so the subsequent Cmd+Z works immediately without re-clicking the editor.

**Why no race with Task 6:** Task 6's rebuild is inside the Cmd+Z/Shift+Z `queueMicrotask` — it only runs when the user presses those keys. Task 4 runs synchronously from a context-menu click. The two paths never overlap in time.

**Acceptance:** Manually overwriting a NER-created chip in the UI results in the old entityMap entry disappearing from the Anonymisierungs-Panel. Overwriting a blocklist-created chip also removes the SQLite entry. Cmd+Z after a blocklist-overwrite restores both the chip AND the SQLite row (microtask replay via existing [ReviewEditor.tsx:156-175](src/renderer/src/views/ReviewEditor.tsx#L156-L175)).

### Task 5 — Multi-chip-selection detection in the context menu (AK 12)

- [ ] In `ContextMenuState` ([EditorContextMenu.tsx:24-36](src/renderer/src/components/editor/EditorContextMenu.tsx#L24-L36)), add `selectionSpansMultipleChipsOnly: boolean`.
- [ ] In [ReviewEditor.tsx:274-321](src/renderer/src/views/ReviewEditor.tsx#L274-L321) `handleContextMenu`, after computing `hasSelection`, walk the selection range and classify:
  - Count `placeholderChip` nodes fully contained in the range.
  - Check whether the range contains any non-whitespace text outside those chips.
  - Set `selectionSpansMultipleChipsOnly = chipCount >= 2 && !hasNonWhitespaceText`.
- [ ] In [EditorContextMenu.tsx:111-128](src/renderer/src/components/editor/EditorContextMenu.tsx#L111-L128), render the "Anonymisieren als..." block only when `state.hasSelection && !state.selectionSpansMultipleChipsOnly`. The "Zur Sperrliste hinzufügen..." block has the same edge case — hide it under the same condition.
- [ ] Add a small `<div>` explaining why the action is unavailable when `selectionSpansMultipleChipsOnly` is true (e.g. "Bitte nur einen Chip auswählen"), so the menu doesn't appear empty.

**Acceptance:** Selecting two adjacent chips and right-clicking shows the "Rückgängig machen"-entry (per-chip context) but no "Anonymisieren als..."-block.

### Task 6 — Cmd+Z recovery of overwritten-chip EntityMap entries

**Why not `onUpdate`:** A bare `onUpdate` hook fires on every keystroke, forcing an O(n) document walk per keypress on long sessions. It also races synchronously with `handleAnonymize`'s own `updateEntityMap` call during dispatch. The clean approach is to extend the existing Cmd+Z/Shift+Z watcher at [ReviewEditor.tsx:128-180](src/renderer/src/views/ReviewEditor.tsx#L128-L180).

**Critical placement detail:** the existing `queueMicrotask` block is wrapped in `if (stack.length > 0)` at [ReviewEditor.tsx:130](src/renderer/src/views/ReviewEditor.tsx#L130) — it only fires when there are blocklist entries in the session. Putting the rebuild inside that guard means it never runs for pure-manual sessions (the common case). The rebuild MUST live in a **separate** `queueMicrotask` scheduled unconditionally on every Cmd+Z/Shift+Z.

- [ ] Restructure [ReviewEditor.tsx:127-180](src/renderer/src/views/ReviewEditor.tsx#L127-L180) so the blocklist-reconciliation microtask and the rebuild microtask are two independent `queueMicrotask` calls inside the same `(event.metaKey || event.ctrlKey) && event.key === 'z'` branch:
  ```ts
  if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
    // 1. Existing blocklist reconciliation — unchanged, still gated on stack.length > 0
    const stack = blocklistUndoStackRef.current
    if (stack.length > 0) {
      const snapshot = stack.map(/* ... existing snapshot ... */)
      queueMicrotask(() => { /* ... existing reconciliation loop ... */ })
    }

    // 2. NEW: EntityMap rebuild — ALWAYS fires on Cmd+Z/Shift+Z
    queueMicrotask(() => {
      if (!editorRef.current) return
      const rebuilt = rebuildEntityMapFromDoc(editorRef.current.state.doc, entityMapRef.current)
      if (rebuilt !== null) updateEntityMap(rebuilt)
    })
  }
  ```
  The existing per-entry delete at [ReviewEditor.tsx:152](src/renderer/src/views/ReviewEditor.tsx#L152) stays untouched — it is part of the blocklist reconciliation loop, unrelated to the rebuild direction.
- [ ] The `rebuildEntityMapFromDoc()` function is the one exported from `editorCommands.ts` in Task 3. It handles the churn guard internally (returns `null` when no drift) so the Cmd+Z handler is a one-liner.
- [ ] **Ordering invariant:** the two microtasks are FIFO-drained — the blocklist reconciliation runs first, then the rebuild. This ordering matters: the blocklist loop may `delete updated[stackEntry.entityId]` (line 152), and then the rebuild sees a missing entityId for a chip that ProseMirror has already restored in the doc — and correctly re-adds it with `source: 'blocklist'` read straight from `chip.attrs.source`. This resolves the Cmd+Z-restores-blocklist-row path cleanly without duplicate writes.
- [ ] Do NOT remove entries for entityIds whose chips are absent. Orphan removal is owned by Task 4 (synchronous, post-dispatch). The `rebuildEntityMapFromDoc` contract is additive-only.

**Why this is race-free with `handleAnonymize`:** `handleAnonymize` (Task 4) runs synchronously from a context-menu click, no microtask involved. The Cmd+Z microtasks fire only on user keypress. The two code paths are temporally disjoint.

**Acceptance:**
- Pure-manual session: flag "Müller" (overwrites NER "Müller" as PERSON 1 → new PERSON 4). Cmd+Z → all 3 chips revert to NER form AND the Panel shows PERSON 1 back with correct count.
- Blocklist session: existing blocklist Cmd+Z redo path still works (no regression in [ReviewEditor.tsx:156-175](src/renderer/src/views/ReviewEditor.tsx#L156-L175)).
- Typing plain text does NOT cause the rebuild walk to do any work beyond its early-exit check (verified by `rebuildEntityMapFromDoc` returning `null` and `updateEntityMap` not being called — spiable).

### Task 7 — Tests

All unit + integration tests below use the Task 0 fixture (`createTestEditor`). Each test creates a fresh editor instance to avoid shared state.

**Unit tests (editorCommands.ts level):**
- [ ] **No-op — single chip of same type selected:** insert one PERSON chip; select exactly that chip; call `anonymizeSelectionWithPropagation(editor, 'PERSON', map)` → returns `null`; `editor.state.doc` unchanged (snapshot compare).
- [ ] **No-op distinction — single-character text selection is NOT a no-op:** insert plain text "i bin Adrian" and select "i"; call with type `PERSON` → returns a result (single chip created), NOT `null`. This verifies the `nodeAt` probe, not `extTo - extFrom === 1`.
- [ ] **Basic propagation — 3 text occurrences:** doc has "Müller war Müller und Müller."; select the first "Müller"; flag as PERSON → `propagatedCount === 3`; `entityMap` gains exactly one new entry with `placeholder: '[PERSON 1]'` and `source: 'manual'`; all 3 chips share the same `entityId`.
- [ ] **Case-insensitive + umlaut:** doc has "Müller, mueller, MÜLLER"; selection is "Müller" → all 3 occurrences become chips with matching `entityId`; each chip's `original` attribute reflects the **local** casing ("Müller", "mueller", "MÜLLER" respectively — verifies Postcondition 4).
- [ ] **Whole-word boundary:** doc has "Bern und Berner"; selection "Bern" → `propagatedCount === 1` (only the standalone "Bern", not the prefix of "Berner").
- [ ] **Multi-word selection:** doc has "Anna Müller und Anna und Müller allein"; select "Anna Müller" → `propagatedCount === 1` (only the exact sequence); individual "Anna" and "Müller" remain text.
- [ ] **Chip overwrite:** doc has 2 NER chips with `entityId: 'person-1', original: 'Zürich', type: 'ORT'` (yes, mistyped NER; the test is about overwriting) and 1 text "zürich"; select the text "zürich", flag as ORT → result has `overwrittenEntityIds.has('person-1')`, `propagatedCount === 3`, all 3 chips share the new manual entityId.
- [ ] **Empty document:** empty editor → selection is empty → returns `null`.
- [ ] **Reverse-sort correctness:** doc has text-match at pos 10, chip at pos 50, text-match at pos 100; dispatch succeeds; all three positions now hold chips with the same entityId (position integrity verified by the transaction surviving without ProseMirror errors).

**Integration tests (ReviewEditor component level, using @testing-library/react + createTestEditor):**
- [ ] **EntityMap orphan cleanup:** mount a minimal wrapper around `handleAnonymize` with a seeded `entityMapRef` containing an NER `person-1` entry; trigger a manual flag that overwrites it; assert `entityMapRef.current['person-1']` is `undefined` after the call completes and `updateEntityMap` has fired once.
- [ ] **Atomicity — single Cmd+Z undoes all propagated chips:** flag "Müller" with 3 occurrences → 3 chips present; call `editor.commands.undo()` **once** → zero chips, document returns to original text. (This is the AK 5 guarantee and must have its own assertion.)
- [ ] **Cmd+Z restores EntityMap via microtask hook:** seed `entityMapRef` with an NER entry; flag, overwrite; dispatch `editor.commands.undo()`; drain microtasks (`await Promise.resolve()`); assert `entityMapRef.current` contains the reconstructed NER entry with `source: 'ner'` (not `'manual'`), proving the rebuild reads from chip attrs correctly.
- [ ] **`rebuildEntityMapFromDoc` unit test — no-drift returns `null`:** seed an EntityMap matching all chips in a fixture doc; call the function; assert the return value is exactly `null` (churn guard).
- [ ] **`rebuildEntityMapFromDoc` unit test — drift reconstructs correctly:** fixture doc with 3 chips (one per source: 'ner', 'blocklist', 'manual'); empty EntityMap; call the function; assert the returned map has exactly 3 entries with correct `source` values pulled from chip attrs (no ghost 'manual' entries for blocklist chips).
- [ ] **Keystroke does NOT trigger rebuild work:** `import * as ec from '../editorCommands'; vi.spyOn(ec, 'rebuildEntityMapFromDoc')`; type plain text via `editor.commands.insertContent('x')` 10 times; assert the spy was called zero times. Then press Cmd+Z once; assert the spy was called exactly once. This verifies the rebuild is gated strictly on Cmd+Z/Shift+Z, not on document changes.

**Regression:**
- [ ] All existing tests in `src/shared/utils/__tests__/blocklist-matching.test.ts` stay green.
- [ ] Manual blocklist flow in ReviewEditor still works (covered by Task 8 manual QA since no blocklist unit tests exist).

**Acceptance:** `npm run test` green. No skipped or `.only` tests. Coverage added for every AK (1–12) either directly or via composition.

### Task 8 — Manual QA on a real session

- [ ] `npm run dev`, open a session in Review Editor.
- [ ] Right-click a name, "Anonymisieren als PERSON" — verify all occurrences become `[PERSON X]` chips.
- [ ] Right-click one of the new chips, "Rückgängig machen" — verify all occurrences revert.
- [ ] Flag a word that NER already caught (e.g. "Zürich" as ORT): verify the NER chip is replaced and the Panel shows only the new manual entry.
- [ ] Cmd+Z through the full sequence and verify no visual or state inconsistencies.
- [ ] Try selecting two adjacent chips and right-clicking: verify the "Anonymisieren als..."-block is hidden.
- [ ] Run with a 2h-session fixture (if available) and confirm perceived latency is under 2 seconds.

**Acceptance:** Manual smoke test passes on the real app. No console errors. Auto-save persists the propagated chips (reopen the session and confirm they're still present).

### Task 9 — Close the loop

- [ ] Run `npm run lint && npm run typecheck && npm run test`.
- [ ] Commit with a message referencing issue #42 (no `Co-Authored-By` line without explicit user consent).
- [ ] Open a PR, reference issue #42 in the description, list the AKs that are now satisfied.
- [ ] Request `/code-review:code-review` in the PR comments.

**Acceptance:** PR open, all checks green, linked to issue.

---

## Out of Scope (explicit non-goals)

- **No audit-trail.** Per the finalized story (Out of Scope item 4), the propagation does not log who/when/what.
- **No Sperrliste write.** The manually flagged term stays session-local.
- **No toast / banner.** The Anonymisierungs-Panel count is the sole feedback (user's UX decision).
- **No confirmation dialog** before propagation. The action is instantaneous and reversible via Cmd+Z.
- **No cross-session propagation** and no effect on pipelines that run after. The pipeline's NER/blocklist output is unchanged.
