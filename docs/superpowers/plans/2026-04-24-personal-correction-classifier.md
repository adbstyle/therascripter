# Persönliches Korrektur-Modell für die Anonymisierung ("Layer 4") — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-device, per-user correction classifier on top of the existing flair NER pipeline. The classifier learns from the therapist's real workflow decisions — Sperrliste additions (missed entities), chip deletions (false positives), and chip retentions (true positives) — and emits a `P(keep | features)` score for every NER candidate. Entities scoring below a user-adjustable threshold are filtered out before being turned into placeholder chips. The classifier is **additive** — never overrides explicit Sperrliste hits — and **opt-in** via sample count: it only activates once the user has produced enough feedback to be statistically useful.

**Architecture:** The classifier is a lightweight scikit-learn logistic-regression model trained by a new Python sidecar script, invoked from a new `ClassifierTrainingExecutor` that plugs into the existing `TaskQueue`. At inference time, scoring happens **inline** inside the existing NER sidecar (`ner_service.py`) — flair detects candidates, features are built per candidate, the local classifier (if present) scores them, and low-confidence candidates are dropped before the JSON is emitted to the main process. No separate inference TaskType, no IPC roundtrip per entity.

**Design decision — inference is inline, training is a separate task.** Inference runs inside `ner_service.py` because it needs raw flair output + context tokens and must stay on the anonymization hot path. Training is decoupled onto the TaskQueue so it honors the 8 GB / one-model-at-a-time constraint: when a training task fires, no other ML job runs. Training is triggered (a) automatically after N new feedback samples accumulate, or (b) manually from Settings → Modelle → Persönliches Modell.

**Cold-start behavior:** If no classifier file is present, `ner_service.py` logs an info line and passes flair's output through unchanged. This makes Phase 1 of a user's lifetime identical to today's pipeline. The classifier only kicks in once training has produced `correction-classifier-v1.pkl`.

**Privacy:** All feedback records are stored locally in SQLite alongside sessions and are **cascade-deleted with the session they came from** (Auto-Deletion after 30 days applies). A "Persönliches Modell zurücksetzen" button wipes both the feedback table and the trained model file. Context tokens (the ±3-token window around each candidate) are stored raw — this is the same sensitivity class as the transcript itself, which is why feedback must follow the same deletion rules.

**Drift-Pattern-Parallele.** The architecture is a direct analog to Drift's `suggestion.service.ts` + `classifier.ts` + `trainer.ts` pattern (see `/Users/adrianbader/Dev/drift/src/main/services/ml/`): logistic classifier, local features, user-in-the-loop labels, inkrementelles Retraining. Der wesentliche Unterschied: Therascript hat eine **starke Baseline** (flair + Sperrliste), der Classifier muss also nichts von Grund auf lernen — er lernt nur die *Korrekturen* des Users zur Baseline.

**Tech Stack:** Python (scikit-learn, joblib) im bestehenden Sidecar, TypeScript im Main-Prozess (neuer Executor + Repository + IPC), React/Tailwind in Settings UI, better-sqlite3 für Feedback-Storage, existing ModelDownloadService pattern für versionierte Modell-Files (lokal geschrieben, nicht von R2 gezogen).

**Produktentscheide, die in diesen Plan einfliessen** (Reverse-Engineering der Requirements, 2026-04-24):

1. **User-Rolle:** Alle user-facing Strings (Settings-Texte, Tooltips, Dialoge) adressieren den THERAPEUT in Sie-Form — konsistent mit dem restlichen Produkt. Im Code bleibt die generische Bezeichnung `user` in TypeScript-/Python-Identifikatoren erhalten; nur Klartext ist betroffen.
2. **Scope — Audio *und* PDF:** Das persönliche Modell lernt aus beiden Medientypen. Der Review-Editor ist derselbe Code-Pfad für Audio-Sessions und importierte PDFs — keine Code-Trennung nötig, aber Feedback-Emission muss in beiden Fällen feuern. Siehe Task 4 für die konkrete Instrumentierung.
3. **Erstes aktiviertes Modell startet auf Stufe "Vorsichtig":** Nach dem allerersten erfolgreichen Training setzt der `ClassifierTrainingExecutor` `settings.personalCorrection.thresholdMode` auf `'conservative'` — aber nur, wenn vorher `lastTrainedAt === null` (wirklich das erste Training) und der aktuelle Mode noch der Initialwert `'off'` ist. Damit wird ein manueller Opt-out nach Erst-Training nicht silent überschrieben. Siehe Task 8 für die Implementierung und Task 9 für den geänderten Default.
4. **Keine First-Activation-Benachrichtigung:** Der THERAPEUT merkt erst bei bewusstem Öffnen der Einstellungen, dass das Modell aktiv ist. Kein Toast, kein Banner, kein Onboarding-Dialog. Konsistent mit dem "no user-facing trigger"-Muster des Summarization-Plans.
5. **Keine Rückwirkung auf alte Sessions:** Reset, Threshold-Änderung oder Modell-Aktivierung wirken ausschliesslich auf neue Anonymisierungen. Bereits anonymisierte Sessions bleiben unverändert. Dadurch ist auch kein "Alte Sessions neu anonymisieren"-UI nötig — siehe Out-of-Scope.

---

## Pre-flight: Constraints & Assumptions

Read before starting any task:

- **RAM budget is 8 GB.** Training uses sklearn's `LogisticRegression` on <10k samples — peak memory is a few hundred MB. It still runs as a TaskQueue executor to respect the sequential-model contract, not because it competes for RAM with flair/pyannote, but because we must not run two Python sidecars concurrently.
- **Inference must add <20 ms per entity.** The scoring happens inside `ner_service.py` after flair, before JSON emit. With ~200-dim feature vectors and a single logistic regression dot-product, realistic overhead is <1 ms per entity — the budget exists only to catch regressions if someone swaps in a heavier model.
- **CSP is `connect-src 'none'` in production.** The personal model is generated locally and lives in `~/.therascript/models/personal/`. It is **never** downloaded from R2 and is **never** included in the manifest — it is purely user-generated state.
- **Cold-start threshold is 50 samples.** Below that, training is refused (runtime check in the Python trainer, UI-level hint in Settings). Above 50, retraining is allowed. This number is a first guess based on flair's strong baseline; tune in Task 11 after real-world data.
- **Classifier is opt-in per session decision, not per user.** A user with a trained classifier can still opt out via the threshold slider (set to 0 → keep everything, i.e. pure flair behavior). There is no separate "enable/disable" toggle — the threshold is the single control surface.
- **Sperrliste is sacred.** The classifier **never** touches entities inserted via the Sperrliste path. Sperrliste hits bypass scoring entirely. The classifier only filters flair-detected NER candidates.
- **ORG entities are still ignored.** Existing rule stays: `type == 'ORG'` in flair output is dropped before scoring, consistent with the existing pipeline.
- **Feedback collection is passive.** No new UI gestures, no "was this right?" prompts. Signals come from three existing user actions: Sperrliste add (positive for missed-entity class), chip deletion (negative), chip retention on save (weak positive).
- **Test discipline:** Write tests for logic (feature extractor, training sample construction, threshold logic, migration, IPC validation). Skip tests for trivial wiring (preload bridge, Settings button → IPC call). Tests use vitest + jsdom, colocated in `__tests__/` or `*.test.ts`.
- **Conventions:** No semicolons, single quotes, no trailing commas, 100 char lines. Unused vars prefixed `_`. Never write `#` comments inside Bash tool calls.

---

## File Structure

Files created (new):

**Main process (TypeScript):**
- `src/main/db/migrations/007-add-ner-feedback.sql` — new table `ner_feedback` storing per-entity decision records.
- `src/main/db/repositories/NerFeedbackRepository.ts` — CRUD + aggregate queries (count, bulk-insert, per-session delete).
- `src/main/db/repositories/__tests__/NerFeedbackRepository.test.ts` — repository tests against in-memory SQLite.
- `src/main/ml/ClassifierTrainingExecutor.ts` — `TaskExecutor` that spawns `train_correction_classifier.py`, writes output to `~/.therascript/models/personal/`.
- `src/main/ml/__tests__/ClassifierTrainingExecutor.test.ts` — skip-on-insufficient-samples, success-writes-file, progress-forwarding.
- `src/main/ipc/feedback-handlers.ts` — IPC: `feedback:recordChipDeletion`, `feedback:recordChipRetention`, `feedback:recordBlocklistAddition`, `feedback:getStats`, `feedback:clearAll`.
- `src/main/ipc/__tests__/feedback-handlers.test.ts` — input validation + repo wiring tests.
- `src/main/ipc/personal-model-handlers.ts` — IPC: `personalModel:getStatus`, `personalModel:retrain`, `personalModel:reset`, `personalModel:setThreshold`.
- `src/shared/validation/feedback-schemas.ts` — Zod schemas for all feedback-related IPC payloads.
- `src/shared/validation/personal-model-schemas.ts` — Zod schemas for retrain / reset / threshold IPC payloads.
- `src/shared/types/FeedbackTypes.ts` — `FeedbackRecord`, `FeedbackDecision`, `PersonalModelStatus`.

**Python sidecar:**
- `python_sidecar/correction_features.py` — pure feature-extraction module, imported by both trainer and NER service.
- `python_sidecar/train_correction_classifier.py` — CLI: reads feedback JSON from stdin, trains sklearn model, writes pickle + metadata.json to `--output-dir`, emits JSON report to stdout.
- `python_sidecar/tests/test_correction_features.py` — feature extractor unit tests (pytest, optional — add only if pytest is already set up).

**Renderer:**
- `src/renderer/src/components/settings/PersonalModelSection.tsx` — Settings → Modelle → Persönliches Modell card: sample count, last training time, threshold slider, "Neu trainieren" button, "Zurücksetzen" button.
- `src/renderer/src/components/settings/__tests__/PersonalModelSection.test.tsx` — renders each status (uninitialized / sufficient-data / trained / threshold states).

Files modified:

- `src/shared/types/Task.ts` — add `'classifier-training'` to `TaskType` union.
- `src/main/services/TaskQueueService.ts` — register `ClassifierTrainingExecutor`.
- `src/main/services/SettingsService.ts` — add `activeModels.personalCorrection?: string` (model-file path hint) + `personalCorrection: { thresholdMode: 'off' | 'conservative' | 'default' | 'aggressive' }`.
- `src/main/db/migrations/index.ts` — register migration 007.
- `src/main/ml/AnonymizationService.ts` — pass `--personal-model-dir` and `--threshold-mode` args to `ner_service.py`.
- `python_sidecar/ner_service.py` — load personal classifier if present, extract features per candidate, apply threshold filter, include `personalModelScore` in output for telemetry/debug.
- `src/shared/types/NerTypes.ts` — extend `NerEntity` with optional `personalModelScore?: number` (non-breaking).
- `src/renderer/src/views/ReviewEditor.tsx` — on chip-delete and on-save, call `feedback:record*` IPC with the entity's context window extracted from the TipTap document.
- `src/renderer/src/utils/editorCommands.ts` — `addToBlocklistRetroactive()` emits `feedback:recordBlocklistAddition` for every match it creates.
- `src/renderer/src/components/settings/ModelsSettingsSection.tsx` — mount `<PersonalModelSection>` below the existing model groups.
- `src/preload/index.ts` — expose `feedback` and `personalModel` APIs via contextBridge.
- `src/shared/types/IpcApi.ts` — add `FeedbackApi` and `PersonalModelApi` interfaces to `IpcApi`.
- `python_sidecar/requirements-ner.txt` — add `scikit-learn>=1.4` and `joblib>=1.3` (trainer + NER service share the venv).
- `scripts/setup-ner.sh` — no change expected; pip install re-runs will pick up new requirements.
- `CLAUDE.md` — document the new TaskType, personal model dir, privacy model.
- `docs/product/features/anonymization.md` (or new `personal-model.md` if no anonymization doc exists) — user-facing feature description + privacy note.
- `docs/product/adr/` — new ADR `adr-NNN-personal-correction-classifier.md` capturing the decision.

---

## Task 1: Database migration — `ner_feedback` table

**Files:**
- Create: `src/main/db/migrations/007-add-ner-feedback.sql`
- Modify: `src/main/db/migrations/index.ts`
- Create: `src/main/db/migrations/__tests__/007-add-ner-feedback.test.ts`

- [ ] **Step 1: Write the migration SQL**

  Follow the style of existing migrations under `src/main/db/migrations/`. Schema:

  ```sql
  CREATE TABLE ner_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    surface TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    flair_confidence REAL,
    context_before TEXT NOT NULL,
    context_after TEXT NOT NULL,
    segment_index INTEGER,
    decision TEXT NOT NULL CHECK(decision IN ('keep', 'drop', 'blocklist_add')),
    source TEXT NOT NULL CHECK(source IN ('flair', 'blocklist', 'manual')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    UNIQUE(session_id, surface, segment_index, decision)
  );

  CREATE INDEX idx_ner_feedback_session ON ner_feedback(session_id);
  CREATE INDEX idx_ner_feedback_created ON ner_feedback(created_at);
  CREATE INDEX idx_ner_feedback_decision ON ner_feedback(decision);
  ```

  Two constraints of note:

  - `ON DELETE CASCADE` to `sessions` is how we honor the 30-day auto-deletion rule for feedback.
  - `UNIQUE(session_id, surface, segment_index, decision)` is the defense against duplicate insertions — specifically the retention-recording case, where re-opening a session and saving it again unmounts/remounts `ReviewEditor` and would otherwise re-emit "keep" records for every surviving chip. SQLite will enforce this regardless of whether the renderer remembers what it already sent. The repository in Task 2 uses `INSERT OR IGNORE` so duplicates fail silently, which is the desired behavior.

  Note that the tuple `(session_id, surface, segment_index, decision)` can legitimately appear twice if a user deletes a chip (`decision = 'drop'`), undoes, then adds the same term via Sperrliste (`decision = 'blocklist_add'`) — those have different `decision` values so the constraint permits it. Conversely, if a user deletes the same chip twice (delete → undo → delete → save), the second insert is a no-op, which is correct: the signal is "user rejected this entity" and it doesn't matter how often they did it.

- [ ] **Step 2: Register migration 007 in `migrations/index.ts`**

  Import the SQL and append `{ version: 7, sql: migration007 }` to the array. Check the current latest is `006-add-word-count.sql` (per exploration).

- [ ] **Step 3: Write a migration test**

  In `src/main/db/migrations/__tests__/007-add-ner-feedback.test.ts`: open an in-memory DB with migrations 1–6 pre-applied, apply 7, assert `ner_feedback` table exists with expected columns. Three behavioral assertions:

  1. CASCADE: insert a feedback row → delete the parent session → `COUNT(*) FROM ner_feedback` returns 0.
  2. UNIQUE constraint: insert the same `(session_id, surface, segment_index, decision)` tuple twice via `INSERT` → second insert throws; via `INSERT OR IGNORE` → second insert is a no-op and row count is 1.
  3. UNIQUE allows same surface with different `decision`: `('drop')` and `('blocklist_add')` for the same surface in the same segment both insert successfully.

- [ ] **Step 4: Run migration tests**

  ```bash
  vitest run src/main/db/migrations/__tests__/007-add-ner-feedback.test.ts
  ```

  Expected: green. All earlier migrations still pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/db/migrations/007-add-ner-feedback.sql src/main/db/migrations/index.ts src/main/db/migrations/__tests__/007-add-ner-feedback.test.ts
  git commit -m "feat(db): add ner_feedback table for personal correction classifier"
  ```

---

## Task 2: Feedback repository

**Files:**
- Create: `src/main/db/repositories/NerFeedbackRepository.ts`
- Create: `src/main/db/repositories/__tests__/NerFeedbackRepository.test.ts`
- Create: `src/shared/types/FeedbackTypes.ts`

- [ ] **Step 1: Define shared types**

  In `src/shared/types/FeedbackTypes.ts`:

  ```ts
  export type FeedbackDecision = 'keep' | 'drop' | 'blocklist_add'
  export type FeedbackSource = 'flair' | 'blocklist' | 'manual'

  export interface FeedbackRecord {
    id: number
    sessionId: number
    surface: string
    entityType: string
    flairConfidence: number | null
    contextBefore: string
    contextAfter: string
    segmentIndex: number | null
    decision: FeedbackDecision
    source: FeedbackSource
    createdAt: number
  }

  export interface PersonalModelStatus {
    sampleCount: number
    trainedAt: number | null
    modelVersion: string | null
    thresholdMode: 'off' | 'conservative' | 'default' | 'aggressive'
    modelPath: string | null
  }
  ```

- [ ] **Step 2: Implement `NerFeedbackRepository`**

  Mirror `BlocklistRepository` style (constructor takes `Database`, methods use prepared statements). Minimum surface:

  - `insertMany(records: Omit<FeedbackRecord, 'id' | 'createdAt'>[]): { inserted: number; skipped: number }` — single transaction, uses `INSERT OR IGNORE` so duplicates (blocked by the UNIQUE constraint from Task 1) are silently skipped. Returns counts so callers can log "recorded 8 new retention signals (skipped 17 duplicates)".
  - `count(): number` — for cold-start gating.
  - `countByDecision(): { keep: number; drop: number; blocklist_add: number }` — for Settings UI.
  - `getAllForTraining(): FeedbackRecord[]` — streaming-safe (training reads everything, but <10k rows is fine as a single read).
  - `deleteBySession(sessionId: number): number` — **belt-and-suspenders** alongside the CASCADE.
  - `clearAll(): void` — powers the "reset personal model" action.
  - `getLatestCreatedAt(): number | null` — used to decide whether to auto-trigger retraining.

- [ ] **Step 3: Write repository tests**

  In `__tests__/NerFeedbackRepository.test.ts`: use in-memory SQLite + `applyTestSchema`. Cover insert+count, `insertMany` returns correct `{ inserted, skipped }` counts when duplicates are present (repeat the same tuple → `inserted=1, skipped=1`), countByDecision categorization, getAllForTraining ordering (ascending by `created_at`), deleteBySession, clearAll, CASCADE behavior (delete session → feedback gone).

- [ ] **Step 4: Run tests**

  ```bash
  vitest run src/main/db/repositories/__tests__/NerFeedbackRepository.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/shared/types/FeedbackTypes.ts src/main/db/repositories/NerFeedbackRepository.ts src/main/db/repositories/__tests__/NerFeedbackRepository.test.ts
  git commit -m "feat(db): NerFeedbackRepository for personal classifier feedback"
  ```

---

## Task 3: Feedback IPC handlers

**Files:**
- Create: `src/shared/validation/feedback-schemas.ts`
- Create: `src/main/ipc/feedback-handlers.ts`
- Create: `src/main/ipc/__tests__/feedback-handlers.test.ts`

- [ ] **Step 1: Define Zod schemas**

  In `src/shared/validation/feedback-schemas.ts`:

  ```ts
  import { z } from 'zod'

  const baseFields = {
    sessionId: z.number().int().positive(),
    surface: z.string().min(1).max(500),
    entityType: z.string().min(1).max(50),
    flairConfidence: z.number().min(0).max(1).nullable(),
    contextBefore: z.string().max(500),
    contextAfter: z.string().max(500),
    segmentIndex: z.number().int().nonnegative().nullable()
  }

  export const ChipDeletionFeedbackSchema = z.object({ ...baseFields, source: z.literal('flair') })
  export const ChipRetentionBatchSchema = z.object({
    sessionId: z.number().int().positive(),
    entries: z.array(z.object(baseFields)).max(1000)
  })
  export const BlocklistAdditionFeedbackSchema = z.object({ ...baseFields })
  ```

  Keep `blocklist_add` distinguishable at the schema-name level so the handler can set `decision` / `source` correctly server-side (never trusted from renderer).

- [ ] **Step 2: Write handlers**

  In `src/main/ipc/feedback-handlers.ts`, register:

  - `feedback:recordChipDeletion` — parse `ChipDeletionFeedbackSchema`, insert with `decision = 'drop'`, `source = 'flair'`. Returns `{ inserted: number; skipped: number }`.
  - `feedback:recordChipRetentionBatch` — parse `ChipRetentionBatchSchema`, insert all with `decision = 'keep'`, `source = 'flair'`. Returns `{ inserted: number; skipped: number }`. Duplicates blocked by the UNIQUE constraint are expected and reported via the `skipped` count — see Task 4 Step 3 for the rationale.
  - `feedback:recordBlocklistAddition` — parse `BlocklistAdditionFeedbackSchema`, insert with `decision = 'blocklist_add'`, `source = 'blocklist'`. Returns `{ inserted: number; skipped: number }`.
  - `feedback:getStats` — return `{ total: number, byDecision: ... }` for the Settings UI.
  - `feedback:clearAll` — clear the table.

  Pattern matches `blocklist-handlers.ts`. Note: all insert handlers must also evaluate the auto-retrain trigger (see Task 9 Step 3) using the threshold-crossing check, not a modulo check.

- [ ] **Step 3: Wire up in `src/main/index.ts`**

  Find the existing `registerBlocklistHandlers()` call, add `registerFeedbackHandlers()` next to it.

- [ ] **Step 4: Expose in preload**

  In `src/preload/index.ts`, add a `feedback` namespace with the four channels. Add `FeedbackApi` interface to `src/shared/types/IpcApi.ts`.

- [ ] **Step 5: Write handler tests**

  In `__tests__/feedback-handlers.test.ts`: use the standard pattern from `BlocklistRepository` tests — mock `ipcMain`, verify schema rejection on bad input, verify repository methods called with correct arguments (spy on repo).

- [ ] **Step 6: Run + commit**

  ```bash
  vitest run src/main/ipc/__tests__/feedback-handlers.test.ts
  git add src/shared/validation/feedback-schemas.ts src/main/ipc/feedback-handlers.ts src/main/ipc/__tests__/feedback-handlers.test.ts src/main/index.ts src/preload/index.ts src/shared/types/IpcApi.ts
  git commit -m "feat(ipc): feedback recording channels for personal classifier"
  ```

---

## Task 4: Instrument the Review Editor to emit feedback

**Scope note:** `ReviewEditor.tsx` is the single render path for *both* audio-transcribed sessions and imported-PDF sessions. All three feedback signals (chip deletion, chip retention on save, retroactive blocklist addition) must fire regardless of whether the underlying session was recorded or imported. No branching on session type is needed — the IPC payload is identical. The acceptance criteria in the epic explicitly include PDF feedback, and the test plan in Task 11 requires validation on both an audio and a PDF session.

**Files:**
- Modify: `src/renderer/src/views/ReviewEditor.tsx`
- Modify: `src/renderer/src/utils/editorCommands.ts`
- Create: `src/renderer/src/utils/__tests__/feedback-context-extraction.test.ts`
- Create: `src/renderer/src/utils/feedback-context-extraction.ts`

- [ ] **Step 1: Write a pure context-extraction helper**

  `src/renderer/src/utils/feedback-context-extraction.ts` exports one function:

  ```ts
  export function extractContextWindow(
    doc: TipTapDocument,
    segmentIndex: number,
    anchorText: string
  ): { contextBefore: string; contextAfter: string }
  ```

  Strategy: walk the TipTap doc to the given segment, find `anchorText` (or `entityId` for chips) inside it, take ±3 tokens around the span, strip chip wrappers to their `original` text, return plain-text context. Missing-anchor case → return empty strings.

  Write unit tests covering: plain text segment, segment with chips intermixed, anchor at segment start (no `contextBefore`), anchor at segment end (no `contextAfter`), anchor not found (empty both).

- [ ] **Step 2: Wire chip-deletion feedback**

  In `ReviewEditor.tsx` `handleKeyDown` (existing around lines 112–125), before calling `handleBatchRemoveRef.current(entityId)`, extract the chip's attrs and context, then fire:

  ```ts
  window.api.feedback.recordChipDeletion({
    sessionId,
    surface: chipAttrs.original,
    entityType: chipAttrs.type,
    flairConfidence: chipAttrs.flairConfidence ?? null,
    contextBefore,
    contextAfter,
    segmentIndex
  })
  ```

  Note: `flairConfidence` is not in the current `TipTapPlaceholderChipAttrs` shape — either add it as an optional attr in the placeholderChip extension and have `AnonymizationService` write it at chip-creation time (preferred), or pass `null` for now and add it in a follow-up. **Decision in this plan: add the optional attr — it is a single-line change and the classifier genuinely benefits from it.** See Task 7 for where it gets populated.

- [ ] **Step 3: Wire chip-retention feedback on save**

  In the `save` path of `ReviewEditor.tsx` (before/after calling `ReviewService.save`), iterate all surviving chips in the final TipTap doc that have `source === 'ner'`, build a batch of retention records, and fire:

  ```ts
  window.api.feedback.recordChipRetentionBatch({ sessionId, entries })
  ```

  **Duplicate protection — rely on the DB, not on renderer state.** `ReviewEditor` unmounts every time the user navigates away and re-mounts when the session is re-opened (Simple view state `'sessions' | 'settings' | 'review'` per CLAUDE.md), so any React-local "already recorded" flag resets and would re-emit retention for every surviving chip on the next save. **Do not** try to guard this renderer-side. Instead, send the batch unconditionally on every save — the DB `UNIQUE(session_id, surface, segment_index, decision)` constraint from Task 1 plus `INSERT OR IGNORE` in the repository makes redundant emissions a no-op on the storage side.

  The renderer should log the `{ inserted, skipped }` result returned from the IPC handler (bubble it through `personal-model-handlers` if useful) so we have telemetry on how often this fires, but nothing else is required.

- [ ] **Step 4: Wire blocklist-addition feedback**

  In `editorCommands.ts` `addToBlocklistRetroactive()` (lines 205–293), after each successful chip replacement, emit:

  ```ts
  window.api.feedback.recordBlocklistAddition({
    sessionId,
    surface: term,
    entityType: placeholderType,
    flairConfidence: null, // blocklist hits aren't from flair
    contextBefore,
    contextAfter,
    segmentIndex
  })
  ```

  For batched retroactive additions, fire them individually (sub-millisecond IPC) or add a `feedback:recordBlocklistAdditionBatch` channel if the existing function already collects all matches. Prefer the batch version if easy.

- [ ] **Step 5: Manual smoke test**

  ```bash
  npm run dev
  ```

  Open a test session, delete a chip, add a term to the blocklist, save. Open SQLite DB (`sqlite3 ~/.therascript/therascript.db`): `SELECT decision, COUNT(*) FROM ner_feedback GROUP BY decision` should show entries for all three decision types.

- [ ] **Step 6: Commit**

  ```bash
  git add src/renderer/src/views/ReviewEditor.tsx src/renderer/src/utils/editorCommands.ts src/renderer/src/utils/feedback-context-extraction.ts src/renderer/src/utils/__tests__/feedback-context-extraction.test.ts
  git commit -m "feat(review): emit NER feedback on chip delete, retention, and blocklist add"
  ```

---

## Task 5: Python feature extractor

**Files:**
- Create: `python_sidecar/correction_features.py`
- Modify: `python_sidecar/requirements-ner.txt`

- [ ] **Step 1: Add sklearn + joblib to requirements**

  Append to `python_sidecar/requirements-ner.txt`:

  ```
  scikit-learn>=1.4
  joblib>=1.3
  ```

  Re-run `scripts/setup-ner.sh` to install.

  ```bash
  scripts/setup-ner.sh
  ```

  Verify from the sidecar venv:

  ```bash
  python_sidecar/venv/bin/python -c "import sklearn, joblib; print(sklearn.__version__, joblib.__version__)"
  ```

- [ ] **Step 2: Write `correction_features.py`**

  Pure module, no I/O. Exports:

  ```python
  FEATURE_SCHEMA_VERSION = 1

  def build_feature_vector(
      surface: str,
      entity_type: str,
      flair_confidence: float | None,
      context_before: str,
      context_after: str,
  ) -> np.ndarray: ...

  def feature_dimension() -> int: ...
  ```

  Feature list (all concatenated into one dense vector — keep it small and interpretable):

  1. **Entity type one-hot** (7 dims: PER, LOC, ORG, MISC, BERUF, BEZIEHUNG, MEDIKAMENT) — types from the Sperrliste enum + flair's labels.
  2. **flair_confidence** (1 dim, 0 if None).
  3. **Surface length in characters** (1 dim, clipped to [0, 50] then divided by 50).
  4. **Surface word count** (1 dim, clipped to [0, 10] / 10).
  5. **Is all-caps** (1 dim, 0/1).
  6. **Is title-case** (1 dim, 0/1).
  7. **Has digit** (1 dim, 0/1).
  8. **Hashing trick on surface lowercased** (32 dims) — `sklearn.feature_extraction.FeatureHasher` with `n_features=32`, `input_type='string'`, tokenized on whitespace+punct.
  9. **Hashing trick on context_before tokens** (32 dims).
  10. **Hashing trick on context_after tokens** (32 dims).
  11. **Hashing trick on surface character n-grams** (n=3, 32 dims) — catches morphological patterns in German.

  Total dim ≈ 140. Document the schema version — bumping it forces retraining.

- [ ] **Step 3: Unit test the feature extractor**

  If pytest is already configured for the sidecar (check for `python_sidecar/pytest.ini` or similar), add `python_sidecar/tests/test_correction_features.py` with cases: known surface → stable vector (deterministic via `FeatureHasher`), dimension matches `feature_dimension()`, None confidence handled, empty context handled.

  If pytest is not configured: defer to Task 6 where the trainer's end-to-end test will exercise the extractor indirectly.

- [ ] **Step 4: Commit**

  ```bash
  git add python_sidecar/correction_features.py python_sidecar/requirements-ner.txt python_sidecar/tests/
  git commit -m "feat(sidecar): feature extractor for personal correction classifier"
  ```

---

## Task 6: Python trainer script

**Files:**
- Create: `python_sidecar/train_correction_classifier.py`

- [ ] **Step 1: Define the CLI contract**

  ```
  Usage: train_correction_classifier.py --output-dir <dir>
  Reads: feedback records as JSON array on stdin.
  Writes: <output-dir>/correction-classifier-v1.pkl
          <output-dir>/correction-classifier-v1.metadata.json
  Stdout: progress lines ("[PROGRESS] 0.25"), then final JSON report.
  Stderr: human-readable logs.
  Exit codes: 0 = success, 2 = insufficient samples, 3 = training error.
  ```

  Input record shape (matches `NerFeedbackRepository.getAllForTraining()`):

  ```json
  {
    "surface": "Anna",
    "entityType": "PER",
    "flairConfidence": 0.97,
    "contextBefore": "meine Patientin",
    "contextAfter": "kam heute",
    "decision": "keep",
    "source": "flair"
  }
  ```

  Labels:

  - `decision == 'keep'` or `decision == 'blocklist_add'` → **positive** (label 1: "this should be anonymized").
  - `decision == 'drop'` → **negative** (label 0: "flair was wrong, don't anonymize").

- [ ] **Step 2: Implement training logic**

  - Read stdin into list.
  - If `len(records) < 50`: exit with code 2 and a stderr message.
  - Build feature matrix `X` (n_samples × ~140) and label vector `y`.
  - Split 80/20 stratified — but only if both classes have ≥5 samples, else skip split (use full training set, report no holdout metrics).
  - Train `LogisticRegression(solver='liblinear', penalty='l2', class_weight='balanced', max_iter=1000, C=1.0, random_state=42)`. **Solver-Wahl:** `liblinear` ist für binäre Klassifikation auf sparse Hashing-Features bei kleinem N (50–10k) der robusteste Solver — konvergiert deterministisch ohne Tuning, im Gegensatz zum sklearn-Default `lbfgs`, der bei N<100 gelegentlich nicht konvergiert. `saga` wäre overkill und braucht grosse N.
  - **C-Tuning ab N ≥ 100:** Mini-CV-Grid `C ∈ {0.1, 0.5, 1.0, 2.0}` mit `GridSearchCV(cv=3, scoring='f1')`. Bei `liblinear` + ~140 dim in <1 s durch, macht den Cold-Start gegen Surface-Hash-Kollisionen robuster. Bei N < 100 fix `C=1.0`. Best-`C` in `metadata.json` mitschreiben.
  - **Probability-Kalibrierung ab N ≥ 200:** `CalibratedClassifierCV(clf, method='sigmoid', cv=3)` drumherum. Begründung: Der Threshold-Slider (Aus/Vorsichtig/Standard/Aggressiv) braucht semantisch konsistente `predict_proba` — `class_weight='balanced'` zieht die rohen Probas bei kleinem N. Unter N=200 ist die rohe LogReg-Kalibrierung gut genug, der Wrapper würde wegen kleiner CV-Folds nur Rauschen einführen.
  - On holdout (if available): compute accuracy, precision, recall, F1 per class **plus Threshold-Cutoffs für die 4 Sensitivitätsstufen**. Cutoff-Semantik: `keep_proba < cutoff` ⇒ Entity wird gedroppt. Höherer Cutoff ⇒ mehr Drops ⇒ aggressiver. Cutoffs werden auf die `keep`-Probas der **Negativ-Klasse** (echte Drops im Holdout) gemappt, sodass die Slider-Stufen modellspezifisch konsistent sind: `aggressive` = 75. Perzentil der Negativ-Probas (droppt ~75 % der echten Negativen + alles darunter), `default` = 50. Perzentil, `conservative` = 25. Perzentil, `off` = 0.0. Bei fehlendem Holdout oder Negativ-Klasse <5 Samples: hartkodierte Fallbacks `{off: 0.0, conservative: 0.3, default: 0.5, aggressive: 0.7}` (matchen die heutige `THRESHOLD_MAP` in `ner_service.py`).
  - Dump via `joblib.dump(clf, output_path)`.
  - Write metadata JSON: `{ version, schemaVersion, trainedAt, sampleCount, classCounts, holdoutMetrics, thresholdCutoffs, bestC, calibrated }` where `schemaVersion` is `FEATURE_SCHEMA_VERSION` imported from `correction_features`. This is the field `ner_service.py` reads at load time (Task 7 Step 2) to decide whether the pickle is still compatible. `thresholdCutoffs` is the dict consumed by the inference path to map `thresholdMode` → cutoff probability.
  - Final stdout JSON report with metrics for the main process to persist.

- [ ] **Step 3: Smoke-test with synthetic data**

  ```bash
  python_sidecar/venv/bin/python -c "
  import json, random, string
  records = []
  for _ in range(100):
      keep = random.random() < 0.7
      records.append({
          'surface': ''.join(random.choices(string.ascii_letters, k=5)),
          'entityType': random.choice(['PER', 'LOC', 'ORG']),
          'flairConfidence': random.random(),
          'contextBefore': 'die patientin',
          'contextAfter': 'kam heute',
          'decision': 'keep' if keep else 'drop',
          'source': 'flair',
      })
  print(json.dumps(records))
  " | python_sidecar/venv/bin/python python_sidecar/train_correction_classifier.py --output-dir /tmp/test-classifier
  ```

  Expected: pickle + metadata written, metrics printed.

- [ ] **Step 4: Commit**

  ```bash
  git add python_sidecar/train_correction_classifier.py
  git commit -m "feat(sidecar): trainer for personal correction classifier"
  ```

---

## Task 7: Inference integration in `ner_service.py`

**Files:**
- Modify: `python_sidecar/ner_service.py`
- Modify: `src/main/ml/AnonymizationService.ts`
- Modify: `src/shared/types/NerTypes.ts`
- Modify: `src/renderer/src/extensions/placeholderChip.ts` (add `flairConfidence` attr + `personalModelScore` attr)

- [ ] **Step 1: Extend `AnonymizationService` args**

  In `runNerSidecar()` (around line 119), add two more CLI args before spawn:

  ```ts
  const personalModelDir = path.join(getDataDir(), 'models', 'personal')
  const thresholdMode = settings.personalCorrection?.thresholdMode ?? 'default'

  const args = [
    '--transcript', transcriptPath,
    '--model-dir', nerModelDir,
    '--personal-model-dir', personalModelDir,
    '--threshold-mode', thresholdMode,
  ]
  ```

  The sidecar silently ignores `--personal-model-dir` when no model is present.

- [ ] **Step 2: Load personal classifier in `ner_service.py` with schema-version guard**

  At service start, after flair is loaded. The classifier only activates if the pickle *and* its sidecar metadata exist *and* the metadata's `schemaVersion` matches the currently-compiled `FEATURE_SCHEMA_VERSION`. A mismatch means the user's trained pickle was built against an older feature layout and calling `predict_proba` on it would either crash with a dimension error or silently return garbage; the correct recovery is to ignore the pickle, pass flair output through unchanged, and let the next training run regenerate a compatible model. The feedback rows remain untouched, so no work is lost.

  ```python
  from correction_features import FEATURE_SCHEMA_VERSION

  personal_clf = None
  personal_model_path = Path(args.personal_model_dir) / 'correction-classifier-v1.pkl'
  personal_metadata_path = Path(args.personal_model_dir) / 'correction-classifier-v1.metadata.json'

  if personal_model_path.exists() and personal_metadata_path.exists():
      try:
          with open(personal_metadata_path) as f:
              metadata = json.load(f)
          stored_schema = metadata.get('schemaVersion')
          if stored_schema != FEATURE_SCHEMA_VERSION:
              print(
                  f'[INFO] personal classifier schema mismatch '
                  f'(pickle v{stored_schema}, current v{FEATURE_SCHEMA_VERSION}) — '
                  f'ignoring until next retrain',
                  file=sys.stderr,
              )
          else:
              personal_clf = joblib.load(personal_model_path)
              print(f'[INFO] personal classifier loaded: {personal_model_path}', file=sys.stderr)
      except Exception as e:
          print(f'[WARN] personal classifier load failed, skipping: {e}', file=sys.stderr)
  else:
      print('[INFO] no personal classifier — flair output passes through', file=sys.stderr)
  ```

  Do **not** delete the stale pickle. Main process surfaces the mismatch via `personalModel:getStatus` (see Task 9) so the Settings UI can show e.g. "Modell veraltet — bitte neu trainieren" and the user understands why the classifier isn't active. The next successful training run overwrites the pickle with a compatible version.

- [ ] **Step 3: Score and filter entities**

  In the per-segment loop (around lines 127–149), after flair emits entities and before appending to output:

  ```python
  for ent in flair_entities:
      score = None
      if personal_clf is not None and ent.type != 'ORG':
          ctx_before, ctx_after = extract_context_tokens(segment_text, ent.start, ent.end, window=3)
          features = build_feature_vector(
              ent.text, ent.type, ent.confidence, ctx_before, ctx_after
          )
          score = float(personal_clf.predict_proba([features])[0, 1])

      if score is not None:
          threshold = threshold_map[args.threshold_mode]
          if score < threshold:
              continue  # dropped by personal classifier

      ent_dict = {
          'text': ent.text,
          'type': ent.type,
          'segmentIndex': seg_idx,
          'charStart': ent.start,
          'charEnd': ent.end,
          'confidence': ent.confidence,
          'personalModelScore': score,
      }
      output_entities.append(ent_dict)
  ```

  Threshold map — **bevorzugt aus `<output-dir>/correction-classifier-v1.metadata.json` `thresholdCutoffs` lesen** (vom Trainer pro Modell auf der Holdout-Negativ-Verteilung kalibriert, siehe Task 6 Step 2). Fallback (kein Metadata-File, fehlender Key, oder File älter als das Pickle):

  ```python
  THRESHOLD_MAP_FALLBACK = {
      'off':          0.0,   # keep everything (equivalent to no classifier)
      'conservative': 0.3,   # rarely drop — only very confident rejections
      'default':      0.5,
      'aggressive':   0.7,   # drop aggressively — only keep very confident entities
  }

  threshold_map = THRESHOLD_MAP_FALLBACK
  metadata_path = personal_model_path.with_suffix('.metadata.json')
  if metadata_path.exists():
      try:
          metadata = json.loads(metadata_path.read_text())
          if isinstance(metadata.get('thresholdCutoffs'), dict):
              threshold_map = {**THRESHOLD_MAP_FALLBACK, **metadata['thresholdCutoffs']}
      except Exception as e:
          print(f'[WARN] threshold metadata read failed, using fallback: {e}', file=sys.stderr)
  ```

- [ ] **Step 4: Propagate score to TipTap chip attrs**

  Update `NerEntity` in `src/shared/types/NerTypes.ts`:

  ```ts
  export interface NerEntity {
    // existing fields ...
    personalModelScore?: number | null
  }
  ```

  Update `placeholderChip` TipTap extension attrs to include `flairConfidence?: number | null` and `personalModelScore?: number | null` — both optional. At chip-creation time in `AnonymizationService` (wherever entities are turned into chips), pass these through.

- [ ] **Step 5: End-to-end smoke test**

  With no personal model: run a recording → anonymization through the pipeline. Expected: same behavior as today, `[INFO] no personal classifier` in logs.

  Manually place a stale/empty pickle in `~/.therascript/models/personal/correction-classifier-v1.pkl` by running Task 6's smoke test and copying the output. Re-run: `[INFO] personal classifier loaded` in logs, `personalModelScore` populated on chips (inspect via DevTools on an open session).

- [ ] **Step 6: Commit**

  ```bash
  git add python_sidecar/ner_service.py src/main/ml/AnonymizationService.ts src/shared/types/NerTypes.ts src/renderer/src/extensions/placeholderChip.ts
  git commit -m "feat(anon): inline personal classifier scoring in NER sidecar"
  ```

---

## Task 8: `ClassifierTrainingExecutor` + new TaskType

**Files:**
- Modify: `src/shared/types/Task.ts`
- Create: `src/main/ml/ClassifierTrainingExecutor.ts`
- Create: `src/main/ml/__tests__/ClassifierTrainingExecutor.test.ts`
- Modify: `src/main/services/TaskQueueService.ts`

- [ ] **Step 1: Add TaskType**

  ```ts
  export type TaskType =
    | 'transcription'
    | 'diarization'
    | 'alignment'
    | 'extraction'
    | 'ocr'
    | 'anonymization'
    | 'classifier-training'
  ```

- [ ] **Step 2: Implement the executor**

  `ClassifierTrainingExecutor implements TaskExecutor`:

  ```ts
  async execute(task, onProgress, signal) {
    const repo = new NerFeedbackRepository(getDatabase())
    const records = repo.getAllForTraining()

    if (records.length < 50) {
      logger.info(`[trainer] insufficient samples (${records.length}/50), skipping`)
      return // success with no-op
    }

    onProgress(0.05)

    const outputDir = path.join(getDataDir(), 'models', 'personal')
    await fs.promises.mkdir(outputDir, { recursive: true })

    const previousLastTrainedAt = settings.personalCorrection.lastTrainedAt
    const previousThresholdMode = settings.personalCorrection.thresholdMode

    const proc = spawn(pythonBin, ['train_correction_classifier.py', '--output-dir', outputDir], {
      cwd: sidecarDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc.stdin.write(JSON.stringify(records))
    proc.stdin.end()

    signal?.addEventListener('abort', () => proc.kill('SIGTERM'))

    // parse [PROGRESS] lines from stdout, final JSON line is the report
    // forward progress to onProgress
    // on close:
    //   exit 0 → persist metadata path/timestamp/metrics in electron-store
    //            → **first-training default**: if previousLastTrainedAt === null &&
    //              previousThresholdMode === 'off', set thresholdMode to 'conservative'.
    //              Do NOT overwrite if the user has already set any other mode.
    //   exit 2 → treat as success (insufficient samples; shouldn't happen given the pre-check,
    //            but safe to no-op)
    //   else   → throw so the task is marked failed
  }
  ```

  The first-training mode-switch is the reason we read `settings.personalCorrection` *before* spawning the trainer: after the pickle lands and `lastTrainedAt` gets updated, we cannot tell whether this was the initial run or a later retrain. The pre-captured `previousLastTrainedAt === null` is the unambiguous signal.

- [ ] **Step 3: Register in TaskQueueService**

  In `TaskQueueService.ts` initialization, register alongside other executors:

  ```ts
  queue.registerExecutor('classifier-training', new ClassifierTrainingExecutor())
  ```

- [ ] **Step 4: Test**

  In `__tests__/ClassifierTrainingExecutor.test.ts`:
  - Insufficient-samples case → execute resolves, pickle not written, no spawn called (mock spawn).
  - Sufficient-samples case → spawn called with expected args, progress forwarded, on-success marks electron-store.
  - Abort signal → SIGTERM sent.

- [ ] **Step 5: Commit**

  ```bash
  git add src/shared/types/Task.ts src/main/ml/ClassifierTrainingExecutor.ts src/main/ml/__tests__/ClassifierTrainingExecutor.test.ts src/main/services/TaskQueueService.ts
  git commit -m "feat(ml): ClassifierTrainingExecutor task + TaskQueue wiring"
  ```

---

## Task 9: Personal model IPC + auto-retrain trigger

**Files:**
- Create: `src/shared/validation/personal-model-schemas.ts`
- Create: `src/main/ipc/personal-model-handlers.ts`
- Modify: `src/main/services/SettingsService.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/IpcApi.ts`

- [ ] **Step 1: Extend `SettingsService`**

  Add to `AppSettings`:

  ```ts
  personalCorrection: {
    thresholdMode: 'off' | 'conservative' | 'default' | 'aggressive'
    autoRetrain: boolean
    lastTrainedAt: number | null
    lastTrainingSampleCount: number | null
    lastHoldoutMetrics: { accuracy: number; precisionKeep: number; recallKeep: number } | null
  }
  ```

  Defaults: `thresholdMode: 'off'`, `autoRetrain: true`, the rest `null`.

  Rationale for `'off'` as the initial default: before the first training, no pickle exists, so `ner_service.py` passes flair output through unchanged regardless of the mode — the value is technically moot. But storing `'off'` makes the state self-documenting ("classifier not yet active") and gives the `ClassifierTrainingExecutor` an unambiguous signal to promote to `'conservative'` on first successful training (see Task 8 Step 2). Users who trained once and later manually switched back to `'off'` are *not* re-promoted on subsequent retrains, because the executor only promotes when `lastTrainedAt === null` before the run.

- [ ] **Step 2: Write handlers**

  `personal-model-handlers.ts`:

  - `personalModel:getStatus` — returns `PersonalModelStatus` by reading repo count + settings + file existence on `~/.therascript/models/personal/correction-classifier-v1.pkl`. Additionally reads `correction-classifier-v1.metadata.json` and compares its `schemaVersion` against a TypeScript-side constant mirroring the Python `FEATURE_SCHEMA_VERSION`; exposes a boolean `schemaMismatch` in the status so the Settings UI can render "Modell veraltet — bitte neu trainieren" (see Task 10). The schema-version constant lives in `src/shared/types/FeedbackTypes.ts` as `export const FEATURE_SCHEMA_VERSION = 1` and must be bumped in lockstep with the Python constant; add a brief comment there pointing to `python_sidecar/correction_features.py`.
  - `personalModel:retrain` — enqueues a `classifier-training` task via `TaskQueueService.enqueue(...)`. Returns the task id. Rejects (does not enqueue) when `repo.count() < 50` and returns a typed error so the UI can show "Nicht genug Rückmeldungen" immediately instead of waiting for the Python exit code 2.
  - `personalModel:reset` — deletes the pickle file, the metadata file, clears `ner_feedback`, resets `personalCorrection.lastTrainedAt` etc. to null in settings.
  - `personalModel:setThreshold` — writes `settings.personalCorrection.thresholdMode`.

- [ ] **Step 3: Auto-retrain trigger hook — threshold-crossing, not modulo**

  In `feedback-handlers.ts`, every insert handler must:

  1. Read `countBefore = repo.count()` before the insert.
  2. Perform the insert.
  3. Read `countAfter = repo.count()` after the insert.
  4. If `autoRetrain` is on, and `Math.floor(countAfter / 25) > Math.floor(countBefore / 25)`, and no `classifier-training` task is currently queued or running, enqueue one.

  Why this specifically and not `countAfter % 25 == 0`: the batch retention handler (`recordChipRetentionBatch` from Task 3) inserts up to hundreds of rows in a single transaction and can legitimately skip over a multiple of 25. The modulo test would miss those crossings entirely; the floor-division test fires exactly once per crossed threshold. This also works correctly for the single-insert handlers — with a batch of 1, the floor-div only changes when `countAfter` crosses a multiple of 25, which is the same condition as modulo.

  Helper: extract this to a single function `maybeTriggerAutoRetrain(countBefore: number, countAfter: number): void` and call it from all three insert handlers.

  Cold-start edge: the function must also refuse to trigger when `countAfter < 50` (the minimum training sample size). That guard is logically redundant with the Python trainer's exit-code-2 path, but it avoids spinning up the Python process at all for users who are between 25 and 49 samples.

- [ ] **Step 4: Test**

  Input validation tests for the new schemas; integration test that `personalModel:retrain` enqueues a task. Skip testing auto-retrain wiring beyond a unit-level check that the helper is called.

- [ ] **Step 5: Commit**

  ```bash
  git add src/shared/validation/personal-model-schemas.ts src/main/ipc/personal-model-handlers.ts src/main/services/SettingsService.ts src/main/index.ts src/preload/index.ts src/shared/types/IpcApi.ts
  git commit -m "feat(ipc): personal model status, retrain, reset, threshold"
  ```

---

## Task 10: Settings UI — Persönliches Modell card

**Files:**
- Create: `src/renderer/src/components/settings/PersonalModelSection.tsx`
- Create: `src/renderer/src/components/settings/__tests__/PersonalModelSection.test.tsx`
- Modify: `src/renderer/src/components/settings/ModelsSettingsSection.tsx`

- [ ] **Step 1: Component structure**

  Follow the visual style of the existing model-group cards in `ModelsSettingsSection.tsx`. All user-facing copy addresses the THERAPEUT in Sie-Form (no "du", no generic "User"-Ansprache). Card contents:

  - **Heading:** "Persönliches Modell (lernt aus Ihren Korrekturen)"
  - **Status line:**
    - "Noch nicht trainiert — 23 von 50 benötigten Rückmeldungen gesammelt" (when `sampleCount < 50`)
    - "Trainiert am 14.03.2026 · 127 Rückmeldungen · Präzision 94%" (when trained and schema matches)
    - "Modell veraltet — bitte neu trainieren" (when `schemaMismatch === true`; render in a warning color, auto-enable the retrain button if `sampleCount >= 50`)
  - **Threshold slider:** 4 stops (Aus / Vorsichtig / Standard / Aggressiv). Tooltip on each stop with a brief Sie-Form explanation (e.g. "Vorsichtig — das Modell entfernt nur Vorschläge, bei denen es sehr sicher ist, dass Sie sie zurückweisen würden").
  - **Auto-Retrain toggle:** "Automatisch neu trainieren nach 25 neuen Rückmeldungen" (default on).
  - **Buttons:**
    - "Jetzt neu trainieren" (disabled when `sampleCount < 50` or a training task is already running).
    - "Zurücksetzen" (destructive, confirm dialog: "Alle Rückmeldungen und das persönliche Modell löschen?").
  - **Privacy note:** Small italic text below the card: "Alle Daten bleiben auf Ihrem Gerät. Rückmeldungen werden zusammen mit der Sitzung nach 30 Tagen gelöscht."
  - **Scope note (neben der Status-Zeile, grau/klein):** "Lernt aus Ihren Korrekturen in Audio- und PDF-Sitzungen."

- [ ] **Step 2: Data wiring**

  - On mount: call `window.api.personalModel.getStatus()` and subscribe to `task:completed` events for `classifier-training` tasks to refresh status.
  - Threshold change: `window.api.personalModel.setThreshold(mode)`.
  - Retrain button: `window.api.personalModel.retrain()` → refresh when the resulting task completes.
  - Reset button: confirm → `window.api.personalModel.reset()` → refresh.

- [ ] **Step 3: Mount in `ModelsSettingsSection.tsx`**

  Append `<PersonalModelSection />` below the existing model groups.

- [ ] **Step 4: Tests**

  Render the component with four different `getStatus` mock outputs (uninitialized / collecting / trained / training-in-progress) and assert the correct status line + button enabled/disabled states.

- [ ] **Step 5: Manual test**

  ```bash
  npm run dev
  ```

  Open Settings → Modelle. Verify the card renders, threshold slider persists across reload, "Jetzt neu trainieren" is disabled on a clean DB, "Zurücksetzen" confirms before wiping.

- [ ] **Step 6: Commit**

  ```bash
  git add src/renderer/src/components/settings/PersonalModelSection.tsx src/renderer/src/components/settings/__tests__/PersonalModelSection.test.tsx src/renderer/src/components/settings/ModelsSettingsSection.tsx
  git commit -m "feat(settings): Persönliches Modell card with threshold, retrain, reset"
  ```

---

## Task 11: Real-data validation + threshold tuning

**Files:**
- Modify: `docs/product/features/personal-model.md` (created in Task 12)

- [ ] **Step 1: Generate realistic feedback data**

  Record 3–5 test sessions (or import 3–5 test PDFs), edit anonymization (intentional mix of accept + delete + blocklist-add), accumulate ≥50 feedback rows.

- [ ] **Step 2: Trigger a training run**

  Settings → Persönliches Modell → "Jetzt neu trainieren". Observe:
  - Task completes in <10 seconds.
  - Metadata JSON shows realistic metrics (keep-precision > 0.8 is a sanity lower bound; if below, revisit features in Task 5).

- [ ] **Step 3: Validate threshold modes**

  Re-run an anonymization on a fresh session (or replay an existing one by deleting its anonymized output) for each threshold mode and compare:
  - `off` — identical output to pre-classifier behavior.
  - `conservative` — drops <5% of flair candidates vs. `off`.
  - `default` — drops candidates that the user historically removed.
  - `aggressive` — drops significantly more; verify nothing critical (real PER entities) gets cut.

  Document the per-mode drop rate in the feature doc.

- [ ] **Step 4: Revise the cold-start threshold if needed**

  If 50 samples produce obviously noisy classifiers, raise to 100 in `train_correction_classifier.py` and update the Settings copy. Only do this with evidence from Step 3 — do not pre-tune.

- [ ] **Step 5: Commit any tuning changes**

  ```bash
  git add python_sidecar/train_correction_classifier.py docs/product/features/personal-model.md
  git commit -m "tune: cold-start threshold + threshold-mode documentation from real-data run"
  ```

---

## Task 12: Documentation + ADR

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/product/features/personal-model.md`
- Create: `docs/product/adr/adr-NNN-personal-correction-classifier.md` (pick next free number)

- [ ] **Step 1: ADR**

  Sections:
  - **Context:** flair has fixed per-model precision/recall; therapists see systematic FP/FN patterns; manual Sperrliste addresses misses but not false positives.
  - **Decision:** Per-user logistic-regression correction layer on top of flair, trained locally from passive feedback signals.
  - **Consequences:**
    - ✅ Personalization without touching the base model (no catastrophic forgetting, no RAM pressure).
    - ✅ Respects NFR-1 (fully local), NFR-9/10 (plugin architecture — classifier is swappable per-user).
    - ⚠️ Cold-start period of ~50 sessions before the classifier activates.
    - ⚠️ Feedback context tokens are sensitive — must cascade-delete with sessions (addressed by DB CASCADE + 30-day rule).
  - **Alternatives considered:**
    - Fine-tuning flair / LoRA adapters → rejected (RAM, data volume, complexity).
    - Pure rule-based Sperrliste extension → insufficient for FP correction.
    - Federated learning → violates NFR-1.

- [ ] **Step 2: Feature doc**

  `docs/product/features/personal-model.md` — user-facing:
  - What it does.
  - When it activates.
  - Privacy (data stays local, cascade-deleted).
  - Threshold modes explained in plain German.
  - Reset behavior.

- [ ] **Step 3: Update CLAUDE.md**

  Append under "Architecture":
  - New `ner_feedback` table + CASCADE.
  - New `classifier-training` TaskType.
  - Personal classifier path `~/.therascript/models/personal/correction-classifier-v1.pkl`.
  - `ner_service.py` loads the classifier optionally.
  - Reference the ADR.

- [ ] **Step 4: Commit**

  ```bash
  git add CLAUDE.md docs/product/features/personal-model.md docs/product/adr/
  git commit -m "docs: personal correction classifier — ADR + feature doc + CLAUDE.md"
  ```

---

## Out of scope for this plan

- **LoRA fine-tune of flair.** Tracked as a follow-up for when the correction classifier demonstrably plateaus.
- **Cross-user federated learning.** Violates NFR-1; revisit only if the product scope changes.
- **Active learning UI** ("was this right?" prompts during review). Passive feedback should be enough — introduce only if cold-start proves too slow in practice.
- **Per-entity-type sub-classifiers.** One global classifier is the right baseline; split only if a single type (e.g. ORG) dominates the error modes.
- **Differential privacy on the trained model.** The model lives on the user's device and never leaves it — DP is unnecessary unless we later expose model export.
- **First-activation notification.** No toast, banner, or dialog when the classifier first becomes active. Visibility is exclusively via Settings → Persönliches Modell.
- **Retroactive re-anonymization.** Reset, threshold change, or classifier activation affect only *new* anonymizations. Previously reviewed sessions stay as they were saved — no "alte Sessions neu anonymisieren"-UI, no background re-run.
- **Cross-device model sync / export.** The trained pickle and metadata stay on one device.

## Offene Fragen (Produkt & Privacy)

These are requirements-level questions that came out of the reverse-engineering discussion. They are **not implementation blockers** — the plan can be executed end-to-end without answers — but they should be resolved before the feature is declared "done" for product acceptance.

1. **@Produkt:** What is the quantitative target for success criterion 3 ("manuelle Chip-Löschungen sinken in Folge-Sessions")? Needs a concrete number (e.g. "30% fewer deletions after 90 days of active use") so Task 11 can validate against a threshold instead of an aspirational trend.
2. **@Privacy:** May feedback records be deleted earlier than the 30-day session-cascade rule — e.g. immediately after a successful training run — or must raw context-token storage persist for the full session lifetime so retraining after a schema bump remains possible? This is a privacy/retrainability trade-off. Current plan keeps the cascade rule (maximum retrainability); switching to early deletion would shrink the privacy surface but prevent re-training older feedback after feature-schema changes.

---

## Acceptance criteria (end-to-end)

- Fresh install: pipeline behavior identical to pre-classifier — zero regressions. `settings.personalCorrection.thresholdMode === 'off'`.
- After ≥50 feedback samples + automatic retraining (first ever):
  - `~/.therascript/models/personal/correction-classifier-v1.pkl` exists.
  - `ner_service.py` log shows `[INFO] personal classifier loaded`.
  - Chip attrs include `personalModelScore` (inspect via DevTools).
  - Settings → Persönliches Modell shows real sample count + trained timestamp.
  - `settings.personalCorrection.thresholdMode === 'conservative'` (auto-promoted by the executor on first training). Subsequent retrains do not overwrite a user's manual mode change.
- **PDF sessions contribute feedback** (scope decision): reviewing an imported-PDF session and performing the same three actions (delete a chip, add a term to the blocklist, save) produces `ner_feedback` rows indistinguishable from audio-session feedback. Verify via `SELECT session_id, COUNT(*) FROM ner_feedback GROUP BY session_id` containing both audio- and PDF-typed session ids.
- **No first-activation surprise**: the UI shows no toast, banner, or dialog when the classifier first becomes active. Settings is the sole surface that reveals the state change.
- **No retroactive re-anonymization**: opening a session that was reviewed *before* the first training shows its original chips unchanged, even though the classifier is now active. Only re-runs of the pipeline (new recordings, new imports) are affected.
- "Zurücksetzen" removes both the pickle and all feedback rows; pipeline reverts to pre-classifier behavior.
- Deleting a session cascades: `SELECT COUNT(*) FROM ner_feedback WHERE session_id = <deleted-id>` returns 0.
- Threshold slider "Aus" produces identical entity lists to pre-classifier (verifies threshold wiring).
- **Retention is idempotent** (Task 4 Step 3): opening a reviewed session, making no changes, saving it → `SELECT COUNT(*) FROM ner_feedback WHERE decision = 'keep' AND session_id = X` returns the same number before and after. Repeat three times to confirm.
- **Batch retention triggers auto-retrain correctly** (Task 9 Step 3): with `autoRetrain = true` and `count = 20`, saving a session with 30 retained chips enqueues exactly one `classifier-training` task (threshold-crossing check fires once, not zero times).
- **Schema-version mismatch degrades gracefully** (Task 7 Step 2): manually edit `correction-classifier-v1.metadata.json` to set `schemaVersion: 99` → rerun anonymization. Expected: `[INFO] personal classifier schema mismatch` in logs, flair output passes through unchanged, pipeline does not crash, Settings UI shows "Modell veraltet". Revert the edit → classifier loads normally on next run.
- No new network calls observable in production CSP logs.
