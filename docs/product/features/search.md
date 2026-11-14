# Search

Stories #209 (search), #210 (stock before the update), #211 (search within a patient dossier) and #212 (edits become searchable soon), Epic #192.

This page describes the part built in PR S3: the search index, the **text phase** of the preparation (Node only, no model), the **exact search** including clear names, dossier hits and the recent searches — main process, shared code and preload. The search by meaning (model, vectors, worker; PR S4), the user interface (PR S5) and the acceptance test with the reference set (PR S6) follow.

Nothing leaves the Mac: index, queries and recent searches live only in `~/.therascript/data/therascript.db` (#209 AK 20).

## Index

Tables, columns and why the FTS table is not contentless: [storage.md](../architecture/storage.md) «Search index».

- **Clear text only.** Chips count with their `original`, title and summary as `title_plain`/`summary_plain` (#203). Placeholders are numbered per session (Epic OOS 9) and not meant as search terms. **Exception:** a chip **without** a stored original is indexed with its placeholder token (e.g. `[PERSON 1]`, like the Klartext view shows it) — a query «person» therefore hits such places. Snippets are otherwise always clear text.
- **Sections** (`src/main/search/chunker.ts`) — port of `split_turn`, `build_units`, `build_chunks` from `scripts/search-spike.py` (Spike #208, where the quality target was measured):
  - a unit is a paragraph of `doc.content` (audio: one speaker turn); units over 120 words are split at sentence ends, a sentence without punctuation over 120 words at word boundaries;
  - sections collect units up to ~200 words; the last unit of a section is repeated in the next one when it has ≤ 60 words;
  - section text: one line per unit, «Sprecher N: …» (numbered by first appearance) or «Bericht: …» for PDFs;
  - title and summary are sections of their own (#209 AK 5).
- **Positions.** `units[]` stores per unit paragraph `p`, the clear-text range `[s, e)` in that paragraph, offset `o` of the line in the section text and prefix length `pfx`, plus speaker label and timestamp. «Clear text of a paragraph» = text nodes with their length plus chips with their `original` length (without one: token length); speaker and timestamp nodes do not count (`paragraphSearchText`). The renderer maps ranges to ProseMirror positions with the same rule (PR S5).
- **Parity with the spike.** `src/main/search/__tests__/chunker.parity.test.ts` compares units (IDs, speaker, word count, text) and section boundaries with a fixture produced by the spike's own functions: `scripts/search-chunker-fixture.py` (instructions in its header). The fixture covers three own fictional documents (`__tests__/fixtures/chunker-docs/`, with text) and the 14 documents of the reference set (word counts and SHA-1 only; the test checks them once `tests/fixtures/search-reference` exists or `THERASCRIPT_SEARCH_REFERENCE_DIR` points to it — verified against the spike checkout: 148 sections, 1'158 units identical). Only deliberate difference: a split unit keeps its original whitespace instead of being re-joined with single spaces, so `[s, e)` stays exact.
- **Normalization** (`src/shared/utils/search-normalize.ts`): `normalizeSearchText` = NFC, zero-width characters removed, lowercase (`de-CH`), ä→ae, ö→oe, ü→ue, ß→ss — the rule of `normalizeDossierKey` without trim. `normalizeWithMap` adds an offset table back to the original (per character cluster, so decomposed umlauts map to their cluster); hits are marked in the original spelling.

## Background loop (deletion, cleanup, text phase)

`src/main/search/SearchIndexService.ts`, started in `src/main/index.ts` after the recovery steps and the completion of interrupted deletions. One loop does, in slices of at most 40 ms (deletion slices 15 ms, see below) with a **real pause of 30 ms** in between, in this order: (1) remove the index rows of deleted sessions — also during a recording —, (2) remove stale text generations, (3) once after the start, compare the document files with the state stored at indexing, (4) the text phase. Steps 2–4 never run during a recording.

- **To be indexed:** `status = 'review' AND deleting_at IS NULL AND (no search_index_state row OR text_rev < search_rev)`. The stock before the update has no row and falls under the same rule (#210 AK 1, PC 2); changed and newly processed sessions (`search_rev > 0`) come before the stock.
- **`search_rev`** rises in `SessionRepository.update` on title, summary, entity map/document (`review:save`, pseudonymization, quick-add to the blocklist) and status → `review`; also through `renameSession`/`updateTitle`, `updateSummaryText`, `saveGeneratedSummary` (regenerating the summary). Not on path, counter or progress updates.
- **Timing:** tick every 5 s; a session is taken 10 s after its last change (`updated_at`, quiet window — intermediate states while editing are skipped, #212 OOS 1). A change is therefore searchable after at most ~15 s plus the time of the queue in front of it (#212 AK 2: one minute).
- **One transaction per session:** new generation with FTS rows, make it active. The exact search sees either the old or the new state (#212 AK 1). The write is skipped if the session was deleted, marked or changed again in the meantime (#212 PC 1). The previous generation is **not** deleted in that transaction (with `secure-delete` a section costs ~20–40 ms to delete; a two-hour session blocked 4–6 s): it is invisible at once through the join on `text_gen` and step 2 removes it section by section (unless an active vector generation, S4, points to it). Unfinished cleanup survives a restart: the loop looks for stale generations once at start.
- **Slices:** at most 25 sessions; the remaining time is checked **before** reading the next session (one session per slice always — a single very large session may exceed the budget, then the pause follows). The stock after the update is indexed in the background without blocking the app (#210 AK 3).
- **Changed file without DB update:** `ReviewService.save` writes the document first, then the database. A crash in between would leave the index on the old text. The text phase stores the file's `size:mtime` in `search_index_state.doc_stat`; after the start the loop compares it for every indexed session and makes changed ones pending again (`search_rev + 1`).
- **Recording:** never during a recording (#209 AK 19). `setRecordingPause` is called at the same places as the queue's pause (`recording:start`, `stopRecordingInternal`, cleanup on quit); afterwards the next tick catches up (#212 AK 3).
- **Restart:** nothing is kept in memory — what is pending is in the database and indexed after the next start (#212 AK 4).
- **Errors:** an unreadable document is logged and stored in `last_error`; title and summary are indexed anyway, the next change retries.
- **Stopping:** own step in `runQuitCleanup` (`PendingEditsFlush.ts`) — after the renderer flush (it may still trigger a `review:save`), before `closeDatabase`; also before `closeDatabase` in the uninstall (`system-handlers.ts`). `stopForUpdate()` for the update swap (wired in PR S4 together with the worker). Every step is synchronous, so after the call nothing is written any more.

## Exact search

`src/main/search/exactSearch.ts`, `ranking.ts`, `snippet.ts`, orchestrated by `SearchService.query`.

| Rule | Where |
|---|---|
| Every word of the query with ≥ 3 characters occurs in the same section, as part of a longer word too, regardless of case and umlaut spelling (#209 AK 3; decision of the orchestrator). Punctuation at word edges is ignored; shorter words are filler | `parseQuery`, FTS `"w1" AND "w2"` (trigram phrases) |
| A query of only shorter words (e.g. «ab») is a scan over the normalized text stored by `search_fts` (`instr`) over the **newest 500 sessions** (in a dossier search: the newest 500 of the dossier), at most 500 matching sections; `truncated` when either limit applies | `findViaScan` |
| At most 2'000 matching sections are grouped: in FTS5 `ORDER BY bm25 LIMIT 2000`, joined and grouped only afterwards (the join over all hits cost up to half a second for «und»); `truncated` when the limit applies. Sections of stale generations or deleted sessions that are still waiting for their cleanup count against the limit and drop out in the join, so the limit is an upper bound | `findViaFts` |
| Clear names find text, also by a part (#209 AK 4) — the index holds the originals | chunker |
| Hits in text, title and summary (#209 AK 5) | sections per field |
| Only finished (`review`) sessions not marked for deletion | `SEARCH_VISIBLE_SESSION` in every query |
| Each session/PDF once, up to 3 hits; a section that overlaps a better hit of the same document (the repeated unit) is merged into it (#209 AK 7) | `pickHits` |
| Order without model: best bm25, then newer day (PDFs: document date), then ID (#209 AK 8). From S4 documents with an exact hit come first, then by cosine (`hasExact ? 1 + maxCos : maxCos`) | `rankDocuments` / `compareDocuments`; S4 passes `semantic: {cosine}` per section into the same function |
| Snippet in clear text from the unit with the first match (~220 characters, cut at word boundaries), marks in the original spelling; label = speaker label and timestamp of the unit (PDFs: none) (#209 AK 9) | `buildSnippet`, `buildHit` |
| Focus for «go to the hit» (#209 AK 11): `{kind:'hit', paraFrom, paraTo, ranges, anchor}` (anchor = first exact word, for semantic hits the first 60 characters of the unit), `{kind:'title'}`, `{kind:'summary'}` | `SearchFocus` in `src/shared/types/Search.ts` (PR S5 adopts it into `SessionFocus`) |
| Dossier search: the query itself is restricted to the sections of the sessions assigned to the dossier **at query time** — **before** the limits of 2'000 sections and 500 scanned sessions, so hits of the dossier are never cut off by other dossiers (#211 AK 1). Same comparison function as the search over everything: as long as no limit applies (`truncated` false), these are exactly the hits of the search over everything from this dossier, in the same order (#211 AK 3). **Beyond a limit** the search over everything shows only documents whose best sections are among the 2'000 best (resp. sessions among the newest 500), while the dossier search applies the limit within the dossier — it can then show additional documents the search over everything cut off, and a document may show more hits than there; the relative order of the documents both show stays the same | `findExactCandidates` |
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

A deleted session or PDF leaves nothing for the search in the app's files (#209 PC 1): see [storage.md](../architecture/storage.md) «Deleting a session». Marking (`deleting_at`) hides it from every search query at once and `scrubMarkedContent` empties title, summary and entity map. While the loop runs, the deletion is **staged**: the IPC call `session:delete` / `dossier:delete` returns after marking and removing the files (a few ms), `sessions:changed` with the IDs goes out at once, and the loop deletes the index rows in slices right away — no other event is awaited — and then calls `SessionService.finishDeletion` (row, WAL checkpoint). Without a running loop (start path `finishPendingDeletions`, i.e. after a crash in the middle) the cascade deletes everything in one piece.

## Measurements (PR S3 after review, M5 Pro, 64 GB)

`npx tsx scripts/search-bench.ts` (after `npm rebuild better-sqlite3`), 2'000 synthetic sessions from the vocabulary of the reference set — every tenth a PDF report with 1'500 words, the others 50-minute sessions (7'550 words) — in a database file. The loop is driven as in the app (slices plus 30 ms pause).

| What | Value |
|---|---|
| Sections | 81'400 |
| Stock after the update | ~506 slices, longest 70–83 ms, median 47 ms, none > 100 ms; busy 25 s, 40 s including the pauses (≈ 12 ms per session; the reviewer measured 23 ms median per session and 42 s on his run) |
| Database file | 544 MB: `search_fts_data` 274 MB, `search_chunks` 159 MB (text 104 MB, rest `units` JSON), `search_fts_content` 107 MB. Disk space for the search index: **~0.55 GB at 2'000 sessions** |
| Exact search over everything | «angst» 37 ms, «schlafen» 33 ms, «und» 71 ms, «ich habe» 93 ms, «Prüfungsangst» (no hit) 3 ms, «ab» 4 ms, «xq» 34 ms; «Anna Beispiel» **114 ms** — a name in 92 % of all sections (synthetic worst case): bm25 over 75'000 matching sections in FTS5 alone takes ~70–100 ms |
| Exact search in a dossier with 50 sessions | 3–81 ms |
| Re-indexing a two-hour session after an edit | write in one slice (~22 ms), stale generation removed in 53 slices of ≤ ~90 ms, ~7 s in the background |
| Deleting a 50-minute session | IPC call a few ms; index rows in ~12 slices, ~1.5 s in the background |
| Deleting a dossier with 10 sessions | ~14 s in the background (~25 ms per section incl. commit) |

Before the review: exact queries 133–337 ms («und» 268, «Anna Beispiel» 337, scan «xq» 170); deleting/re-indexing blocked the main process for seconds in one piece.

Not measured on an 8-GB Mac (#209 AK 14 is checked in PR S6). `search.performance.test.ts` guards the order of magnitude of queries, `search.blocking.test.ts` the slices of re-indexing and deleting a two-hour session (150 sessions, generous budget).

## IPC

`search:query`, `search:recent:list`, `search:recent:remember`, `search:recent:clear` — see [ipc-api.md](../architecture/ipc-api.md) «Search Handlers». In the renderer: `window.api.search`. `semantic` in the answer is `'unavailable'` until PR S4.

## Tests

`src/main/search/__tests__/`: `search.blocking.test.ts`, `chunker.test.ts`, `chunker.parity.test.ts`, `SearchIndexService.test.ts` (text phase, quiet window, recording pause, restart, generations, `search_rev` writers), `SearchService.test.ts` (exact search, snippets, focus, dossier filter, dossier hits), `ranking.test.ts`, `SearchRecentRepository.test.ts`, `search.secureDelete.test.ts` (real database file, raw bytes), `search.performance.test.ts`; `src/main/db/migrations/__tests__/021-search-index.test.ts`, `src/shared/utils/__tests__/search-normalize.test.ts`, `src/main/ipc/__tests__/search-handlers.test.ts`.
