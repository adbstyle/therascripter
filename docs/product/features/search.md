# Search

Stories #209 (search), #210 (stock before the update), #211 (search within a patient dossier) and #212 (edits become searchable soon), Epic #192.

This page describes the main-process side: the search index, the **text phase** of the preparation (Node only, no model), the **exact search** including clear names, dossier hits and the recent searches (PR S3), and the **search process**, the **vector phase**, the **vector store** and the **search by meaning** (PR S4), plus the **user interface** (PR S5, section «User interface» below). The model provisioning is PR S2; the acceptance test with the reference set plus threshold calibration (PR S6) follows.

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
- **Stopping:** own step in `runQuitCleanup` (`PendingEditsFlush.ts`) — after the renderer flush (it may still trigger a `review:save`), before `closeDatabase`; also before `closeDatabase` in the uninstall (`system-handlers.ts`). On quit the step first finishes pending staged deletions for at most 2 s (`finishPurgesForQuit`, `SEARCH_QUIT_PURGE_BUDGET_MS`; the rest at the next start), then stops. `stopForUpdate()` runs before an update swap (`AppUpdateService.installNow` → dep `stopBackgroundWork`, together with stopping the search process). After the call nothing is written any more; a vector batch answered afterwards is discarded.

## Search process (worker)

`src/main/search/SearchWorker.ts` on top of `src/main/utils/line-process.ts` — the **first long-lived child process** of the app (every other ML tool is one `runSubprocess` call per task). One Python process (`search_service.py serve`, see [ml-pipeline.md](../architecture/ml-pipeline.md) «Search Service») serves queries **and** the vector phase; two model copies would exceed 3 GiB.

- **`LineProcess`:** JSON lines on stdin/stdout with request IDs, timeout per request, answers with `id: null` (`bad_json`, `too_large`) go to the oldest open request (the service answers strictly in order), stderr drained continuously into a ring buffer (contract line `Gewichte: …` recorded), start timeout until the ready line, half last line dropped at exit. Whitelist env (`buildSubprocessEnv`) plus `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `PYTHONDONTWRITEBYTECODE=1`, 4 CPU threads. Own process group; stop = close stdin (the service exits on EOF) → 2 s → group SIGTERM → 2 s → SIGKILL. On exit every open request is rejected.
- **States:** `stopped | starting | ready | busy | stopping`, plus the reason why the search by meaning is unavailable right now: `processing | model-missing | tool-blocked | error` (`getState()`). Outside it appears as `SearchAvailability.semantic` next to the model state of PR S2 — `ready` (possible; the process runs or starts on the next query), `loading` (process starting), `unavailable-processing`, `model-missing`, `tool-blocked`, `error` — via `search:open` and the one event `search:availabilityChanged` (sent on every change of model or process). `search:open` starts the preloading (#209 AK 16) and answers at once. When the provisioner reports the model as ready, the vector phase starts by itself (stock, #210 AK 1).
- **Never together with NER, whisper or llama** (8-GB budget): `ensureStarted` is refused while a processing step runs or waits (`TaskQueueService.hasActiveWork()` = running, or pending and not paused for a recording). A **hook before every task** (`TaskQueueService.setBeforeTaskHook`, registered in `main/index.ts`) stops the process and aborts the vector phase; the task becomes `running` only after the process has really exited (#209 AK 17). During a **recording** queries are allowed (the model may load), the preparation never.
- **Memory freed** 5 min after the last query or batch (`SEARCH_WORKER_IDLE_MS`, #209 AK 17); the vector store is released with it.
- **Restart after memory growth:** every answer carries `phys_footprint_bytes`; above 2.5 GiB (`SEARCH_WORKER_RESTART_FOOTPRINT_BYTES`) the process restarts once no request is open, i.e. between two batches.
- **Unexpected end:** reason `error`; after an external SIGKILL the `throwIfToolBlocked('python')` recheck turns it into `tool-blocked`. A new start is tried at the earliest 30 s later (`SEARCH_WORKER_FAILURE_COOLDOWN_MS`), so a broken install does not spawn a process per keystroke. A request without answer in time (query 10 s, batch 60 s, start 60 s) stops the process.
- **Single flight:** concurrent callers share one start; `stop()` is idempotent and works during startup.
- **Quit:** `runQuitCleanup` step `stopSearchWorker` (bounded 3 s) after stopping the index, before `closeDatabase`. **Update:** stopped before the swap; the search does **not** count as work in `WorkGuard` and never delays an update (#210 AK 7).
- **Model access** goes through one function, `resolveSearchModel()` (`src/main/search/searchModel.ts`): folder `~/.therascript/models/search-embeddinggemma-2-text-v1` with marker `READY` (top level — the update manifest schema of shipped app versions rejects archives with `/` in the path), prompts, dimension 768, 1024 tokens, padding grid 128; in development `THERASCRIPT_SEARCH_MODEL_DIR` (and `THERASCRIPT_SEARCH_PYTHON` for the interpreter). PR S2 replaces the inside with the catalog.

## Vector phase

Part of the background loop in `SearchIndexService`, asynchronous next to the slices:

- runs only without a recording, with an empty queue and an installed model; aborted at once when processing or a recording begins (`abortVectorPhase`; an answer arriving afterwards is not written);
- next session: text current (`text_rev = search_rev`) but no complete vector generation of the current model for `text_gen`, no running backoff; changed/new sessions (`search_rev > 0`) before the stock, newest first (#210 AK 6 — new recordings and imports win anyway because the phase only runs with an empty queue);
- sections without vector in **batches of 2**, longest first, **commit per batch** — progress survives a restart (#210 PC 2, #212 AK 4);
- text for the model = the section text **with** «Sprecher N: …» / «Bericht: …» per unit (`sectionEmbeddingText`), exactly what the quality target was measured on (spike `build_chunks`); the document prompt is added by the service. `embeddingText.parity.test.ts` checks it against the chunker fixture. The trigram index keeps omitting the prefixes;
- when all sections have vectors: `vec_gen = text_gen`; until then the previous vector generation stays active (#212 AK 1), afterwards the loop removes it in slices;
- `model_id` per session: vectors of another model are cleared before work starts and the session is embedded again (NFR-9/10);
- errors: `attempts + 1`, `next_attempt_at` after 1 min, 5 min, 30 min, 6 h; a stopped process (processing, quit, model missing, tool blocked) is no failure of the session, a crash is (otherwise a section that kills the service every time would loop);
- int8 quantization at one place (`quantizeVector`): symmetric, scale = max|v| / 127, stored as `vec` (768 bytes) + `vec_scale`.

## Vector store

`src/main/search/VectorStore.ts` — the vectors live in Node, Python stays stateless and never reads the database (deleted content never sits in a foreign process).

- loaded on `search:open` in parallel to the model start, in slices; only the active vector generation of the current model of visible sessions; one block per session (replace/remove = one map operation);
- released when the search process stops (idle, processing);
- kept in sync: a completed vector generation replaces the session; a deleted or marked session is removed **synchronously** via `onSessionsDeleted` in `ChangeEvents.notifySessionsChanged` (#209 PC 1); semantic candidates are additionally checked against `SEARCH_VISIBLE_SESSION`;
- cosine = `(q·query) / ‖q‖` (the query is normalized, the scale cancels); computed in slices of ≤ 20 ms (`SEARCH_COSINE_SLICE_MS`), sessions removed during a pause drop out.

## Search by meaning and ranking

`SearchService.semantic` (`search:semantic`, same payload as `search:query`):

1. `search:query` answers at once with dossiers and exact hits; `semantic` is `pending` (the renderer calls `search:semantic`) or the reason it is unavailable: `unavailable-processing`, `model-missing`, `tool-blocked`, `error`.
2. `search:semantic` embeds the query, scores every section in the vector store, keeps **all** sections with cosine ≥ `SEARCH_SEMANTIC_THRESHOLD` (0.70, provisional until PR S6; no global top-k, so #211 AK 3 holds exactly), merges them with the exact candidates in `rankDocuments` (exact first, inside by cosine), groups, builds snippets/focus like the exact search, and applies the **dossier filter after the ranking** (#211 AK 3 — test: the dossier search equals the filtered search over everything, same order and hits). `semantic: 'complete'`; when unavailable the answer carries the exact hits and the reason.
3. Requests are superseded per window (`event.sender.id`): a newer request ends an older one at its next await (`'superseded'`, exact hits only) without keeping the process busy.
4. `rankChunks(query, {threshold: null})` exposes the internal section ranking before the threshold for the acceptance test (PR S6).

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

## Search model availability (PR S2)

The search model (EmbeddingGemma 2 text encoder, catalog id `embeddinggemma-2-text`) belongs to the basic equipment: first launch loads it, and an install without it (existing users after the update, a failed first-launch download) gets it from the `SearchModelProvisioner` in the background, with retries — the rest of the app stays fully usable (#210 AK 2/3). `search:open` reports its state, `search:availabilityChanged` pushes changes, `search:retryModel` is «Erneut versuchen». Until the artifact is on R2 the catalog entry is `published: false` and the state is `unpublished`. Details: [model-management.md](model-management.md#search-model-epic-192).

Disk space for the search index: up to ~0.6 GB at 2'000 sessions (measured ~0.55 GB, see below); it lives only in the local database and a session's rows go with the session.

## IPC

`search:open` (also preloads), `search:retryModel`, event `search:availabilityChanged`, `search:query`, `search:semantic`, `search:recent:list`, `search:recent:remember`, `search:recent:clear` — see [ipc-api.md](../architecture/ipc-api.md) «Search Handlers». In the renderer: `window.api.search`.

## Measurements (PR S4, M5 Pro, 64 GB, real model)

`src/main/search/__tests__/searchWorker.model.test.ts` with `THERASCRIPT_SEARCH_MODEL_DIR` and `THERASCRIPT_SEARCH_PYTHON` (otherwise skipped), bundled standalone Python of the main checkout, file cache probably warm:

| What | Value |
|---|---|
| `search:open` (preload) → process ready (fresh process) | 5.3 s |
| `search:open` → first answer by meaning | 5.4 s |
| Restart after idle → answer | 4.5 s |
| Further queries incl. embedding, cosine, ranking, snippets | 47–61 ms |
| `phys_footprint` of the search process | 1.58 GiB (peak 1.59 GiB) |
| Vector phase | ~45 ms per section (short test sessions: 6 sections, 90 ms per session) |
| Cosine over 66'000 × 768 int8 in Node | ~30–50 ms in total, longest synchronous stretch ~20–25 ms, 50 MiB (`VectorStore.test.ts`) |

The cold start is just above 5 s on this machine; preloading when the search opens (#209 AK 16) hides most of it. Not measured on an 8-GB Mac (PR S6, #209 AK 14/15/19).

## User interface (PR S5)

Two fixed places, as in the approved prototype («Globale Suche als Modal», «Suche mit Treffern»): ⌘K searches everything, «Im Dossier suchen» only that dossier. Neither can be switched to the other (#211 OOS 2).

### Search window (⌘K)

`components/search/SearchModal.tsx`, carried by `SearchHost` in the app shell (no search during first launch). Opens from the menu «Gehe zu → Suchen …» (⌘K, `nav:command 'search'`, works with the focus in the editor; ⌘K again closes it) and from «Suchen ⌘K» at the top of the sidebar; never on top of another dialog. Opening calls `search:open` (preload, #209 AK 16).

- **Query:** debounced 200 ms (`useSearch`); every request carries a `requestId` from one counter per window, answers to overtaken requests are dropped. `search:query` shows dossiers and exact hits at once; with `semantic: 'pending'` `search:semantic` follows, with a loading line only for that part («Treffer nach Bedeutung werden gesucht …»). An answer `superseded` while the request is still current is re-sent once. If the user has already worked with the list (arrow keys, mouse, scrolling, opened a hit), the hits by meaning are appended below and the shown documents keep their place — nothing jumps under the pointer or the selection; otherwise the ranked order of the second answer applies.
- **List** (`SearchResultsList`, a `listbox` with `group`s): dossiers first and separate with «ID · Geburtsdatum» (AK 24/25), then «Sitzungen und PDF-Dokumente · N Treffer»; per session/PDF one group with a header option (icon, title in the chosen view, date, assigned dossiers; opens the document at the top) and up to three hit options (place on the left: «Titel», «Zusammenfassung», «Person B · 00:14:32»; PDFs «Textstelle» — no page label, decision of the orchestrator). Snippets are **always plain text** (footer «Ausschnitte im Klartext · Treffer öffnen die Fundstelle»); exact places are `<mark>`ed, hits by meaning dotted-underlined. `truncated` adds «Es gibt weitere Treffer …».
- **States:** empty → «Letzte Suchen» (five, from `search:recent:list`; clicking re-runs and remembers it; «Verlauf löschen» → `search:recent:clear`) or, without recent searches, a sentence on what the search finds; no hits → «Keine Treffer für «…»» (only once the search by meaning has finished or is unavailable); a note box (`SemanticNoticeBox`, texts in `utils/searchNotice.ts`, model texts shared with the status card via `utils/searchModelStatus.ts`) when the search by meaning cannot run: during processing (#209 AK 18: «… verfügbar, sobald die Verarbeitung abgeschlossen ist. Genaue Begriffe, Klarnamen und Patientendossiers finden Sie schon jetzt.»), model missing/downloading with progress/waiting (#210 AK 4), loading failed with reason and «Erneut versuchen» (`search:retryModel`, #210 AK 5), tool blocked, search process aborted («Erneut versuchen» repeats the search by meaning). The live `search:availabilityChanged` state wins over the last answer; when it turns `ready`, the shown query fetches the search by meaning by itself.
- **Keyboard and a11y:** the input is a `combobox` (`aria-controls`, `aria-activedescendant`), focus stays in it; no preselection; ↑/↓ through all options (recent searches, dossiers, document headers, hits), ↵ opens the selected one or searches at once; Esc closes only the window (`preventDefault` + `stopPropagation`; the editor's Esc handler skips prevented events), Tab is trapped (`utils/focusTrap.ts`, shared with `DialogShell`). A polite live region announces «2 Patientendossiers, 5 Sitzungen und PDF-Dokumente» or «Keine Treffer für «…»».
- **Recent searches** are remembered on ↵ and when opening a hit or dossier — only here, never from the dossier search (#211 OOS 3). Queries are shown as typed, clear names included (Epic OOS 16), and never logged.

### Opening a hit and coming back (#209 AK 11/12)

A hit navigates to `{kind:'session', sessionId, focus}` (the `SearchFocus` of the hit; header → no focus; dossier → `{kind:'dossier'}`) with `reopenOverlay: 'search'` on the entry it came from. ‹ / Esc / ⌘[ back to that entry reopens the window (`SearchHost`, consumed once per return) with the same query, the same hits, the same selection and scroll position — all kept in `stores/searchSession.ts` (renderer memory only) until the next search or restart. A tipped but not yet searched query is searched when the window opens again. Deleted sessions and dossiers leave the remembered hits (`sessions:changed`/`dossiers:changed` with `deletedIds`), also while the window is closed.

How the editor shows the place: [review-editor.md](review-editor.md#jump-to-a-search-hit-209).

### Search in a patient dossier (#211)

`views/DossierSearchPage.tsx`, route `{kind:'dossierSearch', dossierId}`, reached from «Im Dossier suchen» in the dossier header. Same list component and states, without dossier hits; scope `{kind:'dossier', dossierId}` (filtered after ranking in the main process, #211 AK 1/3). The header always reads «Suche im Patientendossier [Hofer, Lukas]» (the name opens the dossier) plus «N Dokumente · Ausschnitte im Klartext» (AK 2). State per dossier in the same store (`dossier:<id>`): query and hits stay until the next search, the dossier's deletion (entry dropped, the route leaves the history like the dossier page) or a restart (AK 4). Opening a hit sets `anchorId` so ‹ highlights it again; nothing is remembered as a recent search. No hits: «Im Patientendossier … passt keine Stelle zu dieser Anfrage. Für alle Inhalte suchen Sie mit ⌘K.»

### Tests (renderer)

`components/search/__tests__/SearchModal.test.tsx` (open/toggle/Esc, recent searches, two-stage answer, overtaken answers, debounce, append without jumps, superseded, views, no hits, truncated, keyboard and ARIA, return with `reopenOverlay`, deleted hits, all availability notes), `SearchEntryPoints.test.tsx`, `views/__tests__/DossierSearchPage.test.tsx`, `views/__tests__/ReviewEditor.searchFocus.test.tsx`, `extensions/__tests__/searchHighlight.test.ts`, `stores/__tests__/searchSession.test.ts`, `navigation/__tests__/navReducer.test.ts` («Suche»).

## Tests

`src/main/search/__tests__/`: `SearchWorker.test.ts` (fake service: start, single flight, idle stop, stop during start, memory restart, SIGKILL → tool-blocked, crash, timeout), `SearchIndexService.vectors.test.ts` (batches, commit per batch, backoff, restart, priority, generations, model change, abort), `VectorStore.test.ts` (int8 vs float32 ranking, deletion, 66'000-vector timing), `SearchService.semantic.test.ts` (ranking, threshold, dossier = filtered search, superseded, unavailable), `embeddingText.parity.test.ts`, `searchWorker.model.test.ts` (real model, skipped without it); `src/main/utils/__tests__/line-process.test.ts` (real processes with `fixtures/fake-line-service.mjs`); `src/main/services/__tests__/TaskQueueService.beforeTask.test.ts`; `search.blocking.test.ts`, `chunker.test.ts`, `chunker.parity.test.ts`, `SearchIndexService.test.ts` (text phase, quiet window, recording pause, restart, generations, `search_rev` writers), `SearchService.test.ts` (exact search, snippets, focus, dossier filter, dossier hits), `ranking.test.ts`, `SearchRecentRepository.test.ts`, `search.secureDelete.test.ts` (real database file, raw bytes), `search.performance.test.ts`; `src/main/db/migrations/__tests__/021-search-index.test.ts`, `src/shared/utils/__tests__/search-normalize.test.ts`, `src/main/ipc/__tests__/search-handlers.test.ts`.
