# Search

Stories #209 (search), #210 (stock before the update), #211 (search within a patient dossier) and #212 (edits become searchable soon), Epic #192.

This page describes the main-process side: the search index, the **text phase** of the preparation (Node only, no model), the **exact search** including clear names, dossier hits and the recent searches (PR S3), and the **search process**, the **vector phase**, the **vector store** and the **search by meaning** (PR S4), plus the **user interface** (PR S5, section «User interface» below). The model provisioning is PR S2; the acceptance test with the reference set, the threshold calibration and the measurements of the real implementation (PR S6) are in «Quality», «Threshold» and «Measurements (PR S6)» below.

Nothing leaves the Mac: index, queries and recent searches live only in `~/.therascript/data/therascript.db` (#209 AK 20).

## Index

Tables, columns and why the FTS table is not contentless: [storage.md](../architecture/storage.md) «Search index».

- **Clear text only.** Chips count with their `original`, title and summary as `title_plain`/`summary_plain` (#203). Placeholders are numbered per session (Epic OOS 9) and not meant as search terms. **Exception:** a chip **without** a stored original is indexed with its placeholder token (e.g. `[PERSON 1]`, like the Klartext view shows it) — a query «person» therefore hits such places. Snippets are otherwise always clear text.
- **Sections** (`src/main/search/chunker.ts`) — port of `split_turn`, `build_units`, `build_chunks` from `scripts/search-spike.py` (Spike #208, where the quality target was measured):
  - a unit is a paragraph of `doc.content` (audio: one speaker turn); units over 120 words are split at sentence ends, a sentence without punctuation over 120 words at word boundaries;
  - sections collect units up to ~200 words; the last unit of a section is repeated in the next one when it has ≤ 60 words;
  - section text: one line per unit, «Sprecher N: …» (numbered by first appearance) or «Bericht: …» for PDFs;
  - title and summary are sections of their own (#209 AK 5). **Titles take part only in the exact search** (`SEARCH_SEMANTIC_FIELDS` = summary and text): short titles («Sitzung 1», «Aufnahme 12.11.2026 16:30») reach high cosine values and pushed text hits aside (acceptance test: nDCG@10 with title sections 0.461 instead of 0.568; in the visual review invented words like «Donaudampf» returned only title hits of unrelated sessions). Summaries stay in the search by meaning.
- **Positions.** `units[]` stores per unit paragraph `p`, the clear-text range `[s, e)` in that paragraph, offset `o` of the line in the section text and prefix length `pfx`, plus speaker label and timestamp. «Clear text of a paragraph» = text nodes with their length plus chips with their `original` length (without one: token length); speaker and timestamp nodes do not count (`paragraphSearchText`). The renderer maps ranges to ProseMirror positions with the same rule (PR S5).
- **Parity with the spike.** `src/main/search/__tests__/chunker.parity.test.ts` compares units (IDs, speaker, word count, text) and section boundaries with a fixture produced by the spike's own functions: `scripts/search-chunker-fixture.py` (instructions in its header). The fixture covers three own fictional documents (`__tests__/fixtures/chunker-docs/`, with text) and the 14 documents of the reference set (word counts and SHA-1 only; the test checks them once `tests/fixtures/search-reference` exists or `THERASCRIPT_SEARCH_REFERENCE_DIR` points to it — verified against the spike checkout: 148 sections, 1'158 units identical). Only deliberate difference: a split unit keeps its original whitespace instead of being re-joined with single spaces, so `[s, e)` stays exact.
- **Normalization** (`src/shared/utils/search-normalize.ts`): `normalizeSearchText` = NFC, zero-width characters removed, lowercase (`de-CH`), ä→ae, ö→oe, ü→ue, ß→ss — the rule of `normalizeDossierKey` without trim. `normalizeWithMap` adds an offset table back to the original (per character cluster, so decomposed umlauts map to their cluster); hits are marked in the original spelling.

## Background loop (deletion, cleanup, text phase)

`src/main/search/SearchIndexService.ts`, started in `src/main/index.ts` after the recovery steps and the completion of interrupted deletions. One loop does, in slices of at most 40 ms (deletion slices 15 ms, see below) with a **real pause of 30 ms** in between, in this order: (1) remove the index rows of deleted sessions — also during a recording —, (2) remove stale text generations, (3) once after the start, compare the document files with the state stored at indexing, (4) the text phase. Steps 2–4 never run during a recording.

- **To be indexed:** `status = 'review' AND deleting_at IS NULL AND (no search_index_state row OR text_rev < search_rev)`. The stock before the update has no row and falls under the same rule (#210 AK 1, PC 2); changed and newly processed sessions (`search_rev > 0`) come before the stock.
- **`search_rev`** rises in `SessionRepository.update` on title, summary, entity map/document (`review:save`, pseudonymization, quick-add to the blocklist) and status → `review`; also through `renameSession`/`updateTitle`, `updateSummaryText`, `saveGeneratedSummary` (regenerating the summary). Not on path, counter or progress updates.
- **Timing:** tick every 5 s; a session is taken 10 s after its last change (`updated_at`, quiet window — intermediate states while editing are skipped, #212 OOS 1). A change is therefore searchable after at most ~15 s plus the time of the queue in front of it (#212 AK 2: one minute). The vectors follow on the same tick: the vector phase starts right after the text phase when no recording runs, the queue is empty and the model is installed, and an edited session comes before the stock — `SearchIndexService.vectors.test.ts` drives the real tick with fake timers and checks text **and** vectors 60 s after an edit (also after an earlier failure of that session, whose backoff the new text resets). **Documented limit:** the minute cannot be guaranteed when the search process itself fails — after a crash the next start waits for the 30 s pause, after three failed starts in a row the preparation stops starting it until the model is provided again, a search starts it or the app restarts («Search process» below); until then the edit is found exactly and by meaning with the previous vectors (`fromEarlierVersion`).
- **One transaction per session:** new generation with FTS rows, make it active. The exact search sees either the old or the new state (#212 AK 1). The write is skipped if the session was deleted, marked or changed again in the meantime (#212 PC 1). The previous generation is **not** deleted in that transaction (with `secure-delete` a section costs ~20–40 ms to delete; a two-hour session blocked 4–6 s): it is invisible at once through the join on `text_gen` and step 2 removes it section by section (unless an active vector generation, S4, points to it). Unfinished cleanup survives a restart: the loop looks for stale generations once at start.
- **Slices:** at most 25 sessions; the remaining time is checked **before** reading the next session (one session per slice always — a single very large session may exceed the budget, then the pause follows). The stock after the update is indexed in the background without blocking the app (#210 AK 3).
- **Changed file without DB update:** `ReviewService.save` writes the document first, then the database. A crash in between would leave the index on the old text. The text phase stores the file's `size:mtime` in `search_index_state.doc_stat`; after the start the loop compares it for every indexed session and makes changed ones pending again (`search_rev + 1`).
- **Recording:** never during a recording (#209 AK 19). `setRecordingPause` is called at the same places as the queue's pause (`recording:start`, `stopRecordingInternal`, cleanup on quit); afterwards the next tick catches up (#212 AK 3).
- **Restart:** nothing is kept in memory — what is pending is in the database and indexed after the next start (#212 AK 4).
- **Errors:** an unreadable document is logged and stored in `last_error`; title and summary are indexed anyway, the next change retries.
- **Stopping:** own step in `runQuitCleanup` (`PendingEditsFlush.ts`) — after the renderer flush (it may still trigger a `review:save`), before `closeDatabase`; also before `closeDatabase` in the uninstall (`system-handlers.ts`). On quit the step first finishes pending staged deletions for at most 2 s (`finishPurgesForQuit`, `SEARCH_QUIT_PURGE_BUDGET_MS`; the rest at the next start), then stops. `stopForUpdate()` runs before an update swap (`AppUpdateService.installNow` → dep `stopBackgroundWork`, together with stopping the search process). After the call nothing is written any more; a vector batch answered afterwards is discarded.

## Search process (worker)

`src/main/search/SearchWorker.ts` on top of `src/main/utils/line-process.ts` — the **first long-lived child process** of the app (every other ML tool is one `runSubprocess` call per task). One Python process (`search_service.py serve`, see [ml-pipeline.md](../architecture/ml-pipeline.md) «Search Service») serves queries **and** the vector phase; two model copies would exceed 3 GiB.

- **`LineProcess`:** JSON lines on stdin/stdout with request IDs, timeout per request, answers with `id: null` (`bad_json`, `too_large`) go to the oldest open request (the service answers strictly in order), stderr drained continuously into a ring buffer (contract line `Gewichte: …` recorded), start timeout until the ready line, half last line dropped at exit. Whitelist env (`buildSubprocessEnv`) plus `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `PYTHONDONTWRITEBYTECODE=1`, 4 CPU threads. Own process group; stop = close stdin (the service exits on EOF) → 2 s → group SIGTERM → 2 s → SIGKILL. **Hard upper bound:** 1 s after the SIGKILL the process counts as ended even without `'close'` (a grandchild outside the group holding the pipes, or a process stuck in the kernel; logged loudly) — so the hook before every task never blocks the queue forever, and it only continues after the SIGKILL was sent. On exit every open request is rejected.
- **States:** `stopped | starting | ready | busy | stopping`, plus the reason why the search by meaning is unavailable right now: `processing | model-missing | tool-blocked | error` (`getState()`). Outside it appears as `SearchAvailability.semantic` next to the model state of PR S2 — `ready` (possible; the process runs or starts on the next query), `loading` (process starting), `unavailable-processing`, `model-missing`, `tool-blocked`, `error` (with `semanticMessage`, a German sentence) — via `search:open` and the one event `search:availabilityChanged`. The event goes out only when the payload changes (during the preparation the process switches between `busy` and `ready` per batch; for the interface that is the same state). Processing start/end is reported at once (`TaskQueueService.setActivityListener`), not with the next tick; `hasActiveWork()` answers from memory (at most 1 s old, every new task sets it at once) instead of a DB query per batch. `search:open` starts the preloading (#209 AK 16) and answers at once. When the provisioner reports the model as ready, stopped starts are allowed again and the vector phase starts by itself (stock, #210 AK 1).
- **Never together with NER, whisper or llama** (8-GB budget): `ensureStarted` is refused while a processing step runs or waits (`TaskQueueService.hasActiveWork()` = running, or pending and not paused for a recording). A **hook before every task** (`TaskQueueService.setBeforeTaskHook`, registered in `main/index.ts`) stops the process and aborts the vector phase; the task becomes `running` only after the process has really exited (#209 AK 17). During a **recording** queries are allowed (the model may load), the preparation never.
- **Memory freed** (#209 AK 17): only the last **USER interaction** counts (`search:open`, a query). 5 min after it the process ends (`SEARCH_WORKER_IDLE_MS`), the vector store is released with it. The preparation does **not** extend this time. **Deviation from the wording of the AK:** while the preparation of the stock or of changed sessions runs, the process may live without any search — the background preparation needs the model too. As soon as it is finished, paused or aborted (also when a recording begins) and the last USER interaction is more than 5 min ago (or there was none), the process ends at once. Processing start ends it in any case (hook before every task).
- **Restart after memory growth:** every answer carries `phys_footprint_bytes`; above 2.5 GiB (`SEARCH_WORKER_RESTART_FOOTPRINT_BYTES`) the process restarts once no request is open, i.e. between two batches — and starts again right away when the preparation runs or the USER searched recently (not only at the next query).
- **Unexpected end** (crash, OOM kill, a request without answer in time — query 10 s, batch 60 s, start 60 s): reason `error`; after an external SIGKILL the recheck of `ToolHealthService` turns it into `tool-blocked`, or — if Therascript repaired the block itself — allows an immediate retry. The reason is reported **only during the pause** of 30 s (`SEARCH_WORKER_FAILURE_COOLDOWN_MS`; no process per keystroke); afterwards the next query or `search:open` tries a restart. A query that falls exactly into an intended stop (idle, memory restart) starts the process again instead of failing. After 3 failed **starts** in a row (`SEARCH_WORKER_MAX_START_FAILURES`) the preparation stops starting the process (no start loop with a memory peak every 30 s) until something changes: the model is provided again, a USER search starts it successfully, or the app restarts; meanwhile `semantic` is `error` with an explanation, and a USER search may still try after the pause.
- **Single flight:** concurrent callers share one start; `stop()` is idempotent and works during startup.
- **Start gate:** the process starts only after the tool check at startup (`startToolCheck`, the same gate the queue waits for) — otherwise a Python start could fall into the quarantine repair after an update.
- **Quit:** `runQuitCleanup` step `stopSearchWorker` after stopping the index, before `closeDatabase`: EOF → 0.5 s → SIGTERM → 1 s → SIGKILL, ended at the latest after 2.5 s (hard bound above); the 3 s of `shutdown()` are only the outer safeguard. **Update:** stopped before the swap; the search does **not** count as work in `WorkGuard` and never delays an update (#210 AK 7).
- **Model access** goes through one function, `resolveSearchModel()` (`src/main/search/searchModel.ts`): folder `~/.therascript/models/search-embeddinggemma-2-text-v1` with marker `READY` (top level — the update manifest schema of shipped app versions rejects archives with `/` in the path), prompts, dimension 768, 1024 tokens, padding grid 128; in development `THERASCRIPT_SEARCH_MODEL_DIR` (and `THERASCRIPT_SEARCH_PYTHON` for the interpreter). PR S2 replaces the inside with the catalog.

## Vector phase

Part of the background loop in `SearchIndexService`, asynchronous next to the slices:

- runs only without a recording, with an empty queue and an installed model; aborted at once when processing or a recording begins (`abortVectorPhase`; an answer arriving afterwards is not written);
- next session: text current (`text_rev = search_rev`) but no complete vector generation of the current model for `text_gen`, no running backoff; changed/new sessions (`search_rev > 0`) before the stock, newest first (#210 AK 6 — new recordings and imports win anyway because the phase only runs with an empty queue);
- sections without vector in **batches of 2**, longest first — title sections never get one (`SEMANTIC_FIELD_FILTER`, no superfluous vectors) — **commit per batch** — progress survives a restart (#210 PC 2, #212 AK 4);
- text for the model = the section text **with** «Sprecher N: …» / «Bericht: …» per unit (`sectionEmbeddingText`), exactly what the quality target was measured on (spike `build_chunks`); the document prompt is added by the service. `embeddingText.parity.test.ts` checks it against the chunker fixture. The trigram index keeps omitting the prefixes;
- when all summary and text sections have vectors: `vec_gen = text_gen` (an index built before titles were excluded stays correct without a rebuild: its title vectors are simply no longer read, see «Vector store»); until then the previous vector generation stays active (#212 AK 1), afterwards the loop removes it in slices;
- `model_id` per session: vectors of another model are cleared before work starts and the session is embedded again (NFR-9/10);
- a new text generation (an edit) resets the backoff (`attempts = 0`, `next_attempt_at = NULL`): a failure with the old text does not hold the new one back for up to 6 h;
- errors: `attempts + 1`, `next_attempt_at` after 1 min, 5 min, 30 min, 6 h — only for failures caused by the session's own batch (crash or timeout **during** that request). A pause after an earlier failure, a failed start, stopped starts, processing, quit, a missing model or a blocked tool are no failure of the session;
- a session deleted (or marked) during the run sends no further section to the search process (`noteSessionsDeleted`, synchronously from `ChangeEvents`);
- the phase reports its start and end to the search process (`setIndexing`) — the idle rule above;
- int8 quantization at one place (`quantizeVector`): symmetric, scale = max|v| / 127, stored as `vec` (768 bytes) + `vec_scale`.

## Vector store

`src/main/search/VectorStore.ts` — the vectors live in Node, Python stays stateless and never reads the database (deleted content never sits in a foreign process).

- loaded on `search:open` in parallel to the model start, in slices; only the active vector generation of the current model of visible sessions, only summary and text sections (title vectors from older indexes are skipped); one block per session (replace/remove = one map operation);
- released when the search process stops (idle, processing);
- kept in sync: a completed vector generation replaces the session; a deleted or marked session is removed **synchronously** via `onSessionsDeleted` in `ChangeEvents.notifySessionsChanged` (#209 PC 1); semantic candidates are additionally checked against `SEARCH_VISIBLE_SESSION`;
- cosine = `(q·query) / ‖q‖` (the query is normalized, the scale cancels); computed in slices of ≤ 20 ms (`SEARCH_COSINE_SLICE_MS`), sessions removed during a pause drop out.

## Search by meaning and ranking

`SearchService.semantic` (`search:semantic`, same payload as `search:query`):

1. `search:query` answers at once with dossiers and exact hits; `semantic` is `pending` (the renderer calls `search:semantic`) or the reason it is unavailable: `unavailable-processing`, `model-missing`, `tool-blocked`, `error`.
2. `search:semantic` embeds the query, scores every section in the vector store, keeps **all** sections with cosine ≥ `SEARCH_SEMANTIC_THRESHOLD` (0.71, calibrated in PR S6, see «Threshold» below; no global top-k, so #211 AK 3 holds exactly), merges them with the exact candidates in `rankDocuments` (exact first, inside by cosine), groups, builds snippets/focus like the exact search, and applies the **dossier filter after the ranking** (#211 AK 3 — test: the dossier search equals the filtered search over everything, same order and hits). `semantic: 'complete'`; when unavailable the answer carries the exact hits and the reason.
3. Requests are superseded per window **and scope** (`event.sender.id` plus overall search / dossier ID): a newer request ends an older one of the same scope at its next await (`'superseded'`, exact hits only) without keeping the process busy; the overall search and a dossier search of the same window do not replace each other.
4. Hits from the previous vector generation (after an edit, until the new vectors are complete — #212 AK 1) carry `fromEarlierVersion: true`: their paragraph numbers belong to the old version, so the interface finds the place by `anchor` in the current document.
5. `rankChunks(query, {threshold: null})` exposes the internal section ranking before the threshold for the acceptance test (PR S6).

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

Not measured on an 8-GB Mac; the measurement of the real search incl. the search by meaning is in «Measurements (PR S6)» below. `search.performance.test.ts` guards the order of magnitude of queries, `search.blocking.test.ts` the slices of re-indexing and deleting a two-hour session (150 sessions, generous budget).

## Search model availability (PR S2)

The search model (EmbeddingGemma 2 text encoder, catalog id `embeddinggemma-2-text`) belongs to the basic equipment: first launch loads it, and an install without it (existing users after the update, a failed first-launch download) gets it from the `SearchModelProvisioner` in the background, with retries — the rest of the app stays fully usable (#210 AK 2/3). `search:open` reports its state, `search:availabilityChanged` pushes changes, `search:retryModel` is «Erneut versuchen». Until the artifact is on R2 the catalog entry is `published: false` and the state is `unpublished`. Details: [model-management.md](model-management.md#search-model-epic-192).

Disk space for the search index: up to ~0.7 GB at 2'000 sessions (measured 0.55 GB without vectors in PR S3, 634 MB with vectors in PR S6, see below); it lives only in the local database and a session's rows go with the session.

## IPC

`search:open` (also preloads), `search:retryModel`, event `search:availabilityChanged`, `search:query`, `search:semantic`, `search:recent:list`, `search:recent:remember`, `search:recent:clear` — see [ipc-api.md](../architecture/ipc-api.md) «Search Handlers». In the renderer: `window.api.search`.

## Measurements (PR S4, M5 Pro, 64 GB, real model)

`src/main/search/__tests__/searchWorker.model.test.ts` with `THERASCRIPT_SEARCH_MODEL_DIR` and `THERASCRIPT_SEARCH_PYTHON` (otherwise skipped), bundled standalone Python of the main checkout, file cache probably warm:

| What | Value |
|---|---|
| `search:open` (preload) → process ready (fresh process) | 5.3–5.6 s |
| `search:open` → first answer by meaning | 5.4–5.7 s |
| Restart after idle → answer | 4.4–4.8 s |
| Further queries incl. embedding, cosine, ranking, snippets | 47–65 ms |
| `phys_footprint` of the search process | 1.58 GiB (peak 1.59 GiB) |
| Vector phase | ~45 ms per section (short test sessions: 6 sections, 90 ms per session) |
| Cosine over 66'000 × 768 int8 in Node | ~30–50 ms in total, longest synchronous stretch ~20–25 ms, 50 MiB (`VectorStore.test.ts`) |

The cold start is just above 5 s on this machine (the import of torch alone took 2.5–3 s in these runs); preloading when the search opens (#209 AK 16) hides most of it. Tried after the review: loading the tokenizer and reading `model.safetensors` in a thread while torch imports — 4.69–4.78 s to the ready line against 4.70–5.12 s without (4 runs each, warm file cache): no measurable gain, not adopted (a cold file cache cannot be produced without `sudo purge`). Not measured on an 8-GB Mac; see «Measurements (PR S6)» below for the 2'000-entry stock.

## Quality (acceptance test, PR S6)

`npm run test:search-quality` (`src/main/search/__tests__/reference-set.model.test.ts`) runs the **real** search against the fictional reference set (`tests/fixtures/search-reference`, Spike #208): fixtures → TipTap documents as the app stores them after pseudonymization (one paragraph per turn, speaker and timestamp nodes, chips with `original`) → database file with the real repositories → text phase → `SearchWorker` with `search_service.py` → vector phase (int8) → `rankChunks` before the threshold → sections mapped via `units[]` onto the unit IDs of the set. Metrics are a line-by-line port of `scripts/search-spike.py` (`referenceSet.ts`; `referenceMetrics.test.ts` reproduces the spike's stored result incl. the bootstrap CI and runs in `npm test`). Needs `THERASCRIPT_SEARCH_MODEL_DIR` + `THERASCRIPT_SEARCH_PYTHON`; when requested without them the script fails with a message instead of passing as «skipped». Always skipped in `npm test`, never in CI. Temporary databases are deleted; with `THERASCRIPT_SEARCH_QUALITY_OUT=<file.json>` the measurement data stays for `scripts/search-calibrate.ts`.

| What (M5 Pro, 2026-11-14) | Value |
|---|---|
| nDCG@10 by meaning before the threshold (#209 AK 13, target ≥ 0.52) | **0.568** (95 % CI 0.519–0.615); spike 0.570 |
| Repetition (fresh database, fresh search process) | 0.568, same to two decimals |
| Hit@5 / unit recall@10 / separation of queries without hits (AUC) | 0.79 (0.72–0.87) / 0.63 / 0.70 |
| Per query type | clear name 0.66 · report 0.63 · facts 0.63 · keyword 0.61 · thematic 0.54 · paraphrase 0.53 · colloquial/dialect 0.47 · cross-session 0.40 |
| Production order (exact first, threshold 0.71, grouped, nDCG@10 over the shown hits) | 0.382 (0.334–0.431), Hit@5 0.62 — 0.402 at 0.70, 0.540 without threshold (before titles left the search by meaning: 0.380 / 0.398 / 0.498) |
| Exact first, ungrouped, before the threshold | 0.626 (0.579–0.670) |

The test also asserts that the production order it evaluates is exactly what `SearchService.semantic` returns (documents, hits, kinds, paragraphs) at T = 0.65 / 0.71 / 0.75. Details, versions and how to repeat: reference set README, «Abnahme der Implementierung».

**Limits.** The set is small (14 documents, 148 sections, 126 queries with hits, 10 without) and fictional. Titles in the set are generic («Sitzung 1»); such short titles reach high cosine values (best title median 0.68) and pushed the value down to 0.46 when they took part in the search by meaning — since the second visual review they no longer do (titles are found exactly only, «Index» above). The target is defined on the 148 text sections and unchanged by that (0.568 before and after).

## Threshold (#209 AK 6)

Calibrated from the acceptance test (`npx tsx scripts/search-calibrate.ts <data.json>`); table re-measured after titles left the search by meaning (second visual review) — only the production columns changed, mostly fewer documents per query (at 0.71: 2.6 → 2.2 with hits), the by-meaning columns and the threshold stay as they were. «By meaning» = all text sections with cosine ≥ T; «production» = the order the user sees (exact hits first, each document once with up to three hits). Recall grade 2 = (query, section with grade 2) pairs that are shown.

| T | by meaning: query with hits shows a relevant hit | by meaning: query without hits shows nothing | by meaning: recall grade 2 | documents by meaning (with / without hits) | production: relevant hit | production: without hits empty | production: recall grade 2 | production: documents (with / without) |
|---|---|---|---|---|---|---|---|---|
| 0.66 | 89 % | 0 % | 76 % | 6.7 / 5.4 | 93 % | 0 % | 60 % | 6.8 / 5.4 |
| 0.67 | 85 % | 0 % | 71 % | 5.3 / 4.2 | 90 % | 0 % | 56 % | 5.4 / 4.2 |
| 0.68 | 77 % | 20 % | 61 % | 4.2 / 3.2 | 84 % | 20 % | 51 % | 4.4 / 3.2 |
| 0.69 | 73 % | 30 % | 55 % | 3.3 / 2.2 | 83 % | 30 % | 49 % | 3.5 / 2.2 |
| 0.70 | 63 % | 40 % | 44 % | 2.5 / 1.4 | 77 % | 40 % | 44 % | 2.8 / 1.4 |
| **0.71** | **60 %** | **80 %** | **36 %** | **1.9 / 0.3** | **75 %** | **80 %** | **40 %** | **2.2 / 0.3** |
| 0.72 | 50 % | 90 % | 26 % | 1.3 / 0.1 | 67 % | 90 % | 36 % | 1.7 / 0.1 |
| 0.73 | 44 % | 100 % | 20 % | 0.9 / 0.0 | 63 % | 100 % | 32 % | 1.2 / 0.0 |
| 0.74 | 31 % | 100 % | 13 % | 0.5 / 0.0 | 53 % | 100 % | 27 % | 0.9 / 0.0 |
| 0.75 | 21 % | 100 % | 7 % | 0.4 / 0.0 | 45 % | 100 % | 23 % | 0.7 / 0.0 |

(0.60–0.65: no query without hits stays empty; 0.76–0.80: by meaning ≤ 17 % of the queries with hits still show a relevant hit.)

**Set to 0.71** (`SEARCH_SEMANTIC_THRESHOLD`; provisional value was 0.70): from 0.70 to 0.71 the queries without hits that show nothing double (4 → 8 of 10) while the queries with hits that still show a relevant hit drop only slightly (production 77 → 75 %, by meaning 63 → 60 %); the recall of the grade-2 sections drops more clearly (by meaning 44 → 36 %, in the order the user sees 44 → 40 %), the price of fewer unrelated hits; above 0.72 the loss of relevant hits grows quickly. Caveats: the top cosine of the 10 queries without hits lies between 0.671 and 0.730, four of them between 0.700 and 0.708 — the step from 0.70 to 0.71 rests on these four queries. In a large stock (66'000 sections instead of 148) the top values of unrelated sections rise (more chances), so the share of empty answers for unrelated queries will be lower than here; this cannot be measured with fictional data (the benchmark vectors are copies of the 148 reference vectors). The top cosine of queries with hits has median 0.725 (p25 0.692), the overlap with the negatives is the measured AUC of 0.70. **The final choice is the product owner's**, based on this table.

## Measurements (PR S6, real implementation, M5 Pro, 64 GB — not measured on an 8-GB Mac)

`npm run bench:search` (`src/main/search/__tests__/search.bench.model.test.ts`, real model, ~3–5 min): 2'000 entries (every tenth a 1'500-word PDF report, the rest 50-minute sessions with 7'550 words) composed of whole paragraphs of the reference set incl. speaker nodes and chips — real sentences and names in the trigram index; vectors synthetic as in the spike (the real vectors of the 148 reference sections plus noise, int8). 71'958 sections incl. titles, database file 634 MB.

| What | Value | Limit |
|---|---|---|
| Exact search (`search:query` incl. snippets), 30 queries | median 4 ms, 95 % 9 ms, max 39 ms | 2 s |
| Search by meaning with loaded model (`search:semantic` incl. exact hits, cosine over all sections, ranking, snippets; on average 88 documents), 30 queries | median 130 ms, 95 % 149 ms, max 165 ms | 2 s |
| `search:open` → first answer by meaning (fresh search process, warm file cache) | 4.64 s (first run 4.94 s) | 5 s |
| `phys_footprint` search process: queries / preparation | 1.56 GiB / 1.73 GiB peak | 3.5 GiB |
| Additional memory of the main process for the vector store | 54 MiB (ArrayBuffers +58 MiB, `footprint` of the Node process +89 MiB) | – |
| Preparation of one 50-minute session (39 sections) | text phase 18 ms; vector phase 7.5 s (193 ms per section, model already loaded) | – |
| Text phase per entry while building the stock | median 6 ms, 95 % 23 ms, max 28 ms | – |

**For a Mac with 8 GB RAM** (derived, assumptions in brackets):

- **Memory ≤ 3.5 GiB (#209 AK 15): expected to hold.** Search process 1.56–1.73 GiB plus ~0.1 GiB in the main process [the footprint depends on model and stock, not on the RAM of the device; measured without memory pressure; the restart at 2.5 GiB caps growth].
- **Further searches < 2 s (#209 AK 14): expected to hold.** Slowest of 30 searches 165 ms [unsupported assumption, not measured: an M1 computes at most ~4× slower than the M5 Pro; even 10× would stay below 2 s; the cosine part runs in Node, independent of the GPU].
- **First search < 5 s when the model must load (#209 AK 14): at risk.** Already 4.6–4.9 s on the M5 Pro with a warm file cache; an 8-GB Mac with a cold cache or swap loads the 0.54-GB weights and torch more slowly [loading depends on disk and memory pressure]. Preloading on `search:open` (#209 AK 16) and the instant exact hits hide part of it. Needs a measurement on a real 8-GB Mac (Bauplan decision 10).
- **Not measured:** on a real 8-GB Mac, next to a running processing step or a recording (#209 AK 19), cold file cache, the first preparation of a whole stock (at ~0.2 s per section ≈ 4 h for 72'000 sections on the M5 Pro, spread over idle times; an M1 slower).

## User interface (PR S5)

Two fixed places, as in the approved prototype («Globale Suche als Modal», «Suche mit Treffern»): ⌘K searches everything, «Im Dossier suchen» only that dossier. Neither can be switched to the other (#211 OOS 2).

### Search window (⌘K)

`components/search/SearchModal.tsx`, carried by `SearchHost` in the app shell (no search during first launch). Opens from the menu «Gehe zu → Suchen …» (⌘K, `nav:command 'search'`, works with the focus in the editor; ⌘K again closes it) and from «Suchen ⌘K» at the top of the sidebar; never on top of another dialog. Opening calls `search:open` (preload, #209 AK 16). The input row always shows the scope «Alle Inhalte» next to the input, also after typing (#211 AK 2); the input's accessible name is «In allen Inhalten suchen» — scope chip and the «esc» hint are `aria-hidden` (as is «⌘K» on the sidebar button, which carries `aria-keyshortcuts`).

- **Query:** debounced 200 ms (`useSearch`); every request carries a `requestId` from one counter per window, answers to overtaken requests are dropped. `search:query` shows dossiers and exact hits at once; with `semantic: 'pending'` `search:semantic` follows, with a loading line only for that part («Treffer nach Bedeutung werden gesucht …»). An answer `superseded` while the request is still current is re-sent once. Without interaction the ranked order of the second answer applies («passendste zuerst», #211 AK 3). Interaction means arrow keys, scrolling by the user (wheel, touch, scrollbar) or a click — a mouse merely resting on the list does not count. After interaction the shown documents keep their position, but each is replaced by its version from the second answer (new hits appear) and new documents are appended; a keyboard-reachable button «Neue Treffer nach Bedeutung — nach Relevanz sortieren» restores the ranked order (`ranked` in the store), and reopening the window always shows the ranked order. «Erneut versuchen» / fetching the search by meaning later searches the current input instead if it differs from the shown query or is still being debounced. A rejected `search:query` shows its own error state («Die Suche ist fehlgeschlagen.» with «Erneut versuchen»), never «Keine Treffer».
- **List** (`SearchResultsList`, a `listbox` with `group`s): dossiers first and separate with «ID · Geburtsdatum» (AK 24/25), then «Sitzungen und PDF-Dokumente · N Treffer»; per session/PDF one group with a header option (icon, title in the chosen view, date, assigned dossiers; opens the document at the top) and up to three hit options (place on the left in a fixed column wide enough for «Zusammenfassung», longer labels wrap: «Titel», «Zusammenfassung», «Person B · 00:14:32»; PDFs «Textstelle» — no page label, decision of the orchestrator). Snippets are **always plain text**. In the **pseudonymized** view the list is `select-none` (not selectable or copyable, also with ⌘A — copying always follows the chosen view, #203) and a clearly visible note «Ausschnitte im Klartext: … Auswählen und kopieren lassen sie sich nur in der Klartext-Ansicht.» heads the list; in the Klartext view the footer «Dossiers über Name oder ID · Ausschnitte im Klartext» suffices. Dossier hits show their entry count («6 Einträge», `entryCount` from `findDossiers`, same counting rule as the overview); exact places are `<mark>`ed, hits by meaning dotted-underlined. `truncated` adds «Es gibt weitere Treffer …».
- **States:** empty → «Letzte Suchen» (five, from `search:recent:list`; clicking re-runs and remembers it; «Verlauf löschen» → `search:recent:clear`) or, without recent searches, a sentence on what the search finds; no hits → «Keine Treffer für «…»» (only once the search by meaning has finished or is unavailable); a note box (`SemanticNoticeBox`, texts in `utils/searchNotice.ts`, model texts shared with the status card via `utils/searchModelStatus.ts`) when the search by meaning cannot run: during processing (#209 AK 18: «… verfügbar, sobald die Verarbeitung abgeschlossen ist. Genaue Begriffe, Klarnamen und Patientendossiers finden Sie schon jetzt.»), model missing/downloading with progress/waiting (#210 AK 4), loading failed with reason and «Erneut versuchen» (`search:retryModel`, #210 AK 5), tool blocked, search process aborted («Erneut versuchen» repeats the search by meaning; `availability.semanticMessage` replaces the generic text for `error`/`tool-blocked`; a live `error` no longer shows once an answer delivered `complete` — the main process restarts the search process on the next query or `search:open`). The live `search:availabilityChanged` state wins over the last answer; when it turns `ready`, the shown query fetches the search by meaning by itself.
- **Keyboard and a11y:** the input is a `combobox` (`aria-controls`, `aria-activedescendant`), focus stays in it; no preselection; ↑/↓ through all options (recent searches, dossiers, document headers, hits), ↵ opens the selected one or searches at once; Esc and Tab are handled by a capture listener on `document` while the window is open, so they work even with the focus on `body`: Esc closes only the window (`preventDefault` + `stopPropagation`; the editor's Esc handler also skips prevented events), Tab is trapped (`utils/focusTrap.ts`, shared with `DialogShell`); the dialog has `tabIndex=-1` and a click on text without focus returns the focus to the input. `nav:openSettings` (⌘, / tray) closes the window; the menu item first shows a hidden app window (`onShowWindow`). Rows and groups of the list are memoized and the scroll position lives in a ref until the window closes or a hit opens, so typing and scrolling do not re-render the entries. A polite live region announces «2 Patientendossiers, 5 Sitzungen und PDF-Dokumente» or «Keine Treffer für «…»».
- **Recent searches** are remembered on ↵ and when opening a hit or dossier — only here, never from the dossier search (#211 OOS 3). Queries are shown as typed, clear names included (Epic OOS 16), and never logged.

### Opening a hit and coming back (#209 AK 11/12)

A hit navigates to `{kind:'session', sessionId, focus}` (the `SearchFocus` of the hit, with `fromEarlierVersion: true` when the hit comes from the vectors of an earlier version of the session — the editor then looks the place up by its `anchor` right away, #212 AK 1; header → no focus; dossier → `{kind:'dossier'}`) with `reopenOverlay: 'search'` on the entry it came from. ‹ / Esc / ⌘[ back to that entry reopens the window (`SearchHost`, consumed once per return) with the same query, the same hits, the same selection and scroll position — all kept in `stores/searchSession.ts` (renderer memory only) until the next search or restart. A tipped but not yet searched query is searched when the window opens again. Deleted sessions leave the remembered hits (`sessions:changed` with `deletedIds`), also while the window is closed. A deleted dossier resets every remembered search completely (also the one over everything) whose result contained it (as hit or badge) or whose query contains its first name, last name or ID — the same rule as #209 PC 4; the names come from the dossier refs seen in earlier answers (memory only). A hit in the session that is already open marks the entry closing leads to; navigating on from the target page (a new page or ›) drops older `reopenOverlay` marks, so the window never pops up several steps later.

How the editor shows the place: [review-editor.md](review-editor.md#jump-to-a-search-hit-209).

### Search in a patient dossier (#211)

`views/DossierSearchPage.tsx`, route `{kind:'dossierSearch', dossierId}`, reached from «Im Dossier suchen» in the dossier header. Same list component and states, without dossier hits; scope `{kind:'dossier', dossierId}` (filtered after ranking in the main process, #211 AK 1/3). The header always reads «Suche im Patientendossier [Hofer, Lukas]» (the name opens the dossier; same-named dossiers with ID or birth date) plus «Ausschnitte im Klartext» — once the number of documents is known, «N Dokumente · Ausschnitte im Klartext», also «0 Dokumente · …» after a search without hits; before the first search and while the search by meaning still runs without hits only «Ausschnitte im Klartext» (AK 2). State per dossier in the same store (`dossier:<id>`): query and hits stay until the next search, the dossier's deletion (entry dropped, the route leaves the history like the dossier page) or a restart (AK 4). Opening a hit sets `anchorId` so ‹ highlights it again; nothing is remembered as a recent search. Same order rules, «nach Relevanz sortieren», non-selectable snippets in the pseudonymized view and error state as in the window. No hits: «Im Patientendossier … passt keine Stelle zu dieser Anfrage. Für alle Inhalte suchen Sie mit ⌘K.»

### Tests (renderer)

`components/search/__tests__/SearchModal.test.tsx` (open/toggle/Esc, recent searches, two-stage answer, overtaken answers, debounce, append without jumps, superseded, views, no hits, truncated, keyboard and ARIA, return with `reopenOverlay`, deleted hits, all availability notes), `SearchEntryPoints.test.tsx`, `views/__tests__/DossierSearchPage.test.tsx`, `views/__tests__/ReviewEditor.searchFocus.test.tsx`, `extensions/__tests__/searchHighlight.test.ts`, `stores/__tests__/searchSession.test.ts`, `navigation/__tests__/navReducer.test.ts` («Suche»).

## Tests

`src/main/search/__tests__/`: `SearchWorker.idle.test.ts` (fake timers: idle rule, preparation, memory restart, start gate), `search.dossierEquivalence.test.ts` (random: dossier search == filtered overall search), `search.earlierVersion.test.ts`, `searchAvailability.test.ts` (event dedupe, provisioner glue, hook factory), `SearchWorker.test.ts` (fake service: start, single flight, idle stop, stop during start, memory restart, SIGKILL → tool-blocked, crash, timeout), `SearchIndexService.vectors.test.ts` (batches, commit per batch, backoff, restart, priority, generations, model change, abort), `VectorStore.test.ts` (int8 vs float32 ranking, deletion, 66'000-vector timing), `SearchService.semantic.test.ts` (ranking, threshold, dossier = filtered search, superseded, unavailable), `embeddingText.parity.test.ts`, `searchWorker.model.test.ts` (real model, skipped without it), `reference-set.model.test.ts` (acceptance test, only via `npm run test:search-quality`), `search.bench.model.test.ts` (only via `npm run bench:search`), `referenceMetrics.test.ts` (metric port); `src/main/utils/__tests__/line-process.test.ts` (real processes with `fixtures/fake-line-service.mjs`); `src/main/services/__tests__/TaskQueueService.beforeTask.test.ts`; `search.blocking.test.ts`, `chunker.test.ts`, `chunker.parity.test.ts`, `SearchIndexService.test.ts` (text phase, quiet window, recording pause, restart, generations, `search_rev` writers), `SearchService.test.ts` (exact search, snippets, focus, dossier filter, dossier hits), `ranking.test.ts`, `SearchRecentRepository.test.ts`, `search.secureDelete.test.ts` (real database file, raw bytes), `search.performance.test.ts`; `src/main/db/migrations/__tests__/021-search-index.test.ts`, `src/shared/utils/__tests__/search-normalize.test.ts`, `src/main/ipc/__tests__/search-handlers.test.ts`.
