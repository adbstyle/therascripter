# Search

Stories #209 (search), #210 (stock before the update), #211 (search within a patient dossier) and #212 (edits become searchable soon), Epic #192.

This page describes the part built in PR S3: the search index, the **text phase** of the preparation (Node only, no model), the **exact search** including clear names, dossier hits and the recent searches — main process, shared code and preload. The search by meaning (model, vectors, worker; PR S4), the user interface (PR S5) and the acceptance test with the reference set (PR S6) follow.

Nothing leaves the Mac: index, queries and recent searches live only in `~/.therascript/data/therascript.db` (#209 AK 20).

## Index

Tables, columns and why the FTS table is not contentless: [storage.md](../architecture/storage.md) «Search index».

- **Clear text only.** Chips count with their `original` (a chip without one with its placeholder token), title and summary as `title_plain`/`summary_plain` (#203). Placeholders are numbered per session (Epic OOS 9) and are not searchable. Snippets are therefore always clear text.
- **Sections** (`src/main/search/chunker.ts`) — port of `split_turn`, `build_units`, `build_chunks` from `scripts/search-spike.py` (Spike #208, where the quality target was measured):
  - a unit is a paragraph of `doc.content` (audio: one speaker turn); units over 120 words are split at sentence ends, a sentence without punctuation over 120 words at word boundaries;
  - sections collect units up to ~200 words; the last unit of a section is repeated in the next one when it has ≤ 60 words;
  - section text: one line per unit, «Sprecher N: …» (numbered by first appearance) or «Bericht: …» for PDFs;
  - title and summary are sections of their own (#209 AK 5).
- **Positions.** `units[]` stores per unit paragraph `p`, the clear-text range `[s, e)` in that paragraph, offset `o` of the line in the section text and prefix length `pfx`, plus speaker label and timestamp. «Clear text of a paragraph» = text nodes with their length plus chips with their `original` length (without one: token length); speaker and timestamp nodes do not count (`paragraphSearchText`). The renderer maps ranges to ProseMirror positions with the same rule (PR S5).
- **Parity with the spike.** `src/main/search/__tests__/chunker.parity.test.ts` compares units (IDs, speaker, word count, text) and section boundaries with a fixture produced by the spike's own functions: `scripts/search-chunker-fixture.py` (instructions in its header). The fixture covers three own fictional documents (`__tests__/fixtures/chunker-docs/`, with text) and the 14 documents of the reference set (word counts and SHA-1 only; the test checks them once `tests/fixtures/search-reference` exists or `THERASCRIPT_SEARCH_REFERENCE_DIR` points to it — verified against the spike checkout: 148 sections, 1'158 units identical). Only deliberate difference: a split unit keeps its original whitespace instead of being re-joined with single spaces, so `[s, e)` stays exact.
- **Normalization** (`src/shared/utils/search-normalize.ts`): `normalizeSearchText` = NFC, zero-width characters removed, lowercase (`de-CH`), ä→ae, ö→oe, ü→ue, ß→ss — the rule of `normalizeDossierKey` without trim. `normalizeWithMap` adds an offset table back to the original (per character cluster, so decomposed umlauts map to their cluster); hits are marked in the original spelling.

## Text phase

`src/main/search/SearchIndexService.ts`, started in `src/main/index.ts` after the recovery steps and the completion of interrupted deletions.

- **To be indexed:** `status = 'review' AND deleting_at IS NULL AND (no search_index_state row OR text_rev < search_rev)`. The stock before the update has no row and falls under the same rule (#210 AK 1, PC 2); changed and newly processed sessions (`search_rev > 0`) come before the stock.
- **`search_rev`** rises in `SessionRepository.update` on title, summary, entity map/document (`review:save`, pseudonymization, quick-add to the blocklist) and status → `review`; also through `renameSession`/`updateTitle`, `updateSummaryText`, `saveGeneratedSummary` (regenerating the summary). Not on path, counter or progress updates.
- **Timing:** tick every 5 s; a session is taken 10 s after its last change (`updated_at`, quiet window — intermediate states while editing are skipped, #212 OOS 1). A change is therefore searchable after at most ~15 s plus the time of the queue in front of it (#212 AK 2: one minute).
- **One transaction per session:** new generation with FTS rows, make it active, delete older generations unless an active vector generation (S4) points to it. The exact search sees either the old or the new state (#212 AK 1). The write is skipped if the session was deleted, marked or changed again in the meantime (#212 PC 1).
- **Slices:** at most 25 sessions or 50 ms at a time, then one event-loop turn — the stock after the update is indexed in the background without blocking the app (#210 AK 3).
- **Recording:** never during a recording (#209 AK 19). `setRecordingPause` is called at the same places as the queue's pause (`recording:start`, `stopRecordingInternal`, cleanup on quit); afterwards the next tick catches up (#212 AK 3).
- **Restart:** nothing is kept in memory — what is pending is in the database and indexed after the next start (#212 AK 4).
- **Errors:** an unreadable document is logged and stored in `last_error`; title and summary are indexed anyway, the next change retries.
- **Stopping:** `stop()` in `before-quit` before the database is closed; `stopForUpdate()` for the update swap (wired in PR S4 together with the worker). A text phase is synchronous, so after the call nothing is written any more.

## Exact search

`src/main/search/exactSearch.ts`, `ranking.ts`, `snippet.ts`, orchestrated by `SearchService.query`.

| Rule | Where |
|---|---|
| Every word of the query with ≥ 3 characters occurs in the same section, as part of a longer word too, regardless of case and umlaut spelling (#209 AK 3; decision of the orchestrator). Punctuation at word edges is ignored; shorter words are filler | `parseQuery`, FTS `"w1" AND "w2"` (trigram phrases) |
| A query of only shorter words (e.g. «ab») is a scan over the normalized text stored by `search_fts` (`instr`), newest sessions first, at most 500 matching sections (`truncated`) | `findViaScan` |
| Clear names find text, also by a part (#209 AK 4) — the index holds the originals | chunker |
| Hits in text, title and summary (#209 AK 5) | sections per field |
| Only finished (`review`) sessions not marked for deletion | `SEARCH_VISIBLE_SESSION` in every query |
| Each session/PDF once, up to 3 hits; a section that overlaps a better hit of the same document (the repeated unit) is merged into it (#209 AK 7) | `pickHits` |
| Order without model: best bm25, then newer day (PDFs: document date), then ID (#209 AK 8). From S4 documents with an exact hit come first, then by cosine (`hasExact ? 1 + maxCos : maxCos`) | `rankDocuments` / `compareDocuments`; S4 passes `semantic: {cosine}` per section into the same function |
| Snippet in clear text from the unit with the first match (~220 characters, cut at word boundaries), marks in the original spelling; label = speaker label and timestamp of the unit (PDFs: none) (#209 AK 9) | `buildSnippet`, `buildHit` |
| Focus for «go to the hit» (#209 AK 11): `{kind:'hit', paraFrom, paraTo, ranges, anchor}` (anchor = first exact word, for semantic hits the first 60 characters of the unit), `{kind:'title'}`, `{kind:'summary'}` | `SearchFocus` in `src/shared/types/Search.ts` (PR S5 adopts it into `SessionFocus`) |
| Dossier search: filter on the sessions assigned to the dossier **at query time**, applied **after** ranking and before the limit of 100 documents — same hits in the same order as the search over everything (#211 AK 1, AK 3) | `filterAndLimit` |
| No hits → `results: []` (#209 AK 10) | — |

## Patient dossiers among the hits

Only in the search over everything (#209 AK 23–26): every query word is part of the normalized first or last name, or the whole query is part of the normalized dossier ID. Sorted like the overview, at most 20, returned separately in `dossiers` (the renderer shows them before the content hits) as `DossierRef` with dossier ID and birth date to tell same-named dossiers apart.

## Recent searches

`src/main/db/repositories/SearchRecentRepository.ts` (#209 AK 27/28, PC 2–4):

- at most five, newest first, deduplicated by the normalized query (whitespace collapsed); stored in the database, so they survive a restart;
- the renderer calls `search:recent:remember` on Enter and when opening a hit, only in the search over everything (#211 OOS 3);
- «Verlauf löschen» (`search:recent:clear`): `DELETE` plus WAL checkpoint;
- deleting a dossier removes, in phase 1 of `DossierService.deleteDossier`, every query containing its first name, last name or dossier ID (normalized substring; deleting too much is harmless); the checkpoint at the end of the deletion removes them from the files.

## Deletion

A deleted session or PDF leaves nothing for the search in the app's files (#209 PC 1): see [storage.md](../architecture/storage.md) «Deleting a session». Marking alone already hides it from every search query; `scrubMarkedContent` deletes the index rows if phase 2 has to wait.

## Measurements (PR S3, M5 Pro, 64 GB)

`npx tsx scripts/search-bench.ts` (after `npm rebuild better-sqlite3`), 2'000 synthetic sessions from the vocabulary of the reference set — every tenth a PDF report with 1'500 words, the others 50-minute sessions (7'550 words) — in a database file:

| What | Value |
|---|---|
| Sections | 81'400 |
| Text phase per session | median 10–12 ms, p95 28–33 ms, max 35–81 ms; whole stock 26–32 s |
| Database file | 544 MB: `search_fts_data` 274 MB, `search_chunks` 159 MB (text 104 MB, rest `units` JSON), `search_fts_content` 107 MB |
| «angst» / «schlafen» | 163 / 133 ms |
| «ich habe» / «Anna Beispiel» / «und» (nearly every section) | 271 / 308 / 282 ms |
| «Prüfungsangst» (no hit) | 3 ms |
| «ab» / «xq» (scan, < 3 characters) | 238 / 116 ms |

Not measured on an 8-GB Mac (#209 AK 14 is checked in PR S6). `src/main/search/__tests__/search.performance.test.ts` guards the order of magnitude with 200 sessions and a generous budget.

## IPC

`search:query`, `search:recent:list`, `search:recent:remember`, `search:recent:clear` — see [ipc-api.md](../architecture/ipc-api.md) «Search Handlers». In the renderer: `window.api.search`. `semantic` in the answer is `'unavailable'` until PR S4.

## Tests

`src/main/search/__tests__/`: `chunker.test.ts`, `chunker.parity.test.ts`, `SearchIndexService.test.ts` (text phase, quiet window, recording pause, restart, generations, `search_rev` writers), `SearchService.test.ts` (exact search, snippets, focus, dossier filter, dossier hits), `ranking.test.ts`, `SearchRecentRepository.test.ts`, `search.secureDelete.test.ts` (real database file, raw bytes), `search.performance.test.ts`; `src/main/db/migrations/__tests__/021-search-index.test.ts`, `src/shared/utils/__tests__/search-normalize.test.ts`, `src/main/ipc/__tests__/search-handlers.test.ts`.
