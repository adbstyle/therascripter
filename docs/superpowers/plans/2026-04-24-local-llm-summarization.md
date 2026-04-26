# Lokales LLM für Zusammenfassungen (Gemma 4 E4B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, lightweight LLM to Therascript that generates a 2-sentence German summary of a session transcript or imported PDF, fully on-device.

**Architecture:** llama.cpp runs as a subprocess (analog to the existing whisper.cpp pattern), wrapped by a new `LlamaSummarizer` service and invoked through a new `SummarizationExecutor` that plugs into the existing `TaskQueue`. The model is Gemma 4 E4B Instruct in GGUF Q4_K_M quantization (~2.5 GB), Metal-accelerated. Each invocation produces **two outputs in a single pass**: a short session **title** (Nominalphrase, 3–8 Wörter) and a 2-sentence **summary**. Both are persisted on the `sessions` table and are user-editable inline in the Review Editor. The **model is optional** (not required at first launch, downloadable from Settings → Modelle).

**Design decision — summarization is a pipeline tail step on the existing TaskQueue.** The `'summarization'` `TaskType` is appended to both audio and PDF pipeline chains as the last step after `anonymization`. This gives sequential-model safety for free (the TaskQueue runs one executor at a time, honoring the 8 GB RAM budget) and handles the real-world case where the user opens Session B in the Review Editor while Session A is still in the pipeline — summarizations queue up correctly without any extra coordination.

**Executor behavior when model is missing:** If the active summarization model file is not present on disk, the executor logs an info message and completes successfully with no output (task succeeds, `sessions.summary` stays `NULL`). This makes the feature truly opt-in — users who never download the model pay zero cost beyond a trivial queue tick per session.

**UI flow (minimal):** The Review Editor has **no user-facing trigger** for generation or regeneration — no button, no banner, no CTA. Summary and title run exclusively as the pipeline tail step. The Review-Editor state model of the app already guarantees a session only appears in "Review" *after* the pipeline completes, so there is no in-progress UI state. When a session is opened:

- If a summary exists (`sessions.summary IS NOT NULL`), render the `<SummaryPanel>` with the summary text; use `sessions.title` as the editable h1 in the header.
- If no summary exists (model was not installed, executor skipped, generation failed, or session is older than the feature), render nothing extra — the h1 falls back to the existing date-based label, and no summary panel is mounted. No hint, no promotional CTA.

Both fields are **inline-editable** (Notion-pattern `contenteditable`): click to edit, `Enter`/blur saves via `summary:updateTitle` / `summary:updateText`. If the user clears the title to empty, it reverts to the date fallback in the view layer.

**No provenance icons.** No ✨, no 🔒. The affordance for editability is a subtle hover highlight, consistent with editable text elsewhere in the app.

**Tech Stack:** llama.cpp (Homebrew in dev, ad-hoc signed binary + dylibs in `resources/bin` + `resources/lib/` for production), GGUF format via llama-cli, TypeScript main-process service, React/Tailwind in renderer, better-sqlite3 for persistence, existing R2 manifest flow for model distribution.

---

## Pre-flight: Constraints & Assumptions

Read before starting any task:

- **RAM budget is 8 GB.** Summarization runs as the tail step of each pipeline via the existing `TaskQueue`, which guarantees strictly sequential executor runs. Never invoke `LlamaSummarizer` outside of `SummarizationExecutor` (no direct IPC spawn path) — that is the only way to keep the sequential guarantee.
- **CSP is `connect-src 'none'` in production.** No network calls from renderer. All model loading happens in main process via local file paths.
- **Gemma 4 E4B Instruct Q4_K_M GGUF (~2.5 GB)** is the target. Community conversions live under `bartowski/google_gemma-4-e4b-it-GGUF` on HuggingFace. Verify availability in Task 1 before proceeding — if no GGUF exists yet, fall back to Gemma 3 4B Instruct Q4_K_M (`bartowski/gemma-3-4b-it-GGUF`) and document the fallback in CLAUDE.md.
- **Model hash sync is manual.** Per CLAUDE.md gotcha: after `scripts/publish-manifest.sh` the SHA-256 in `ModelDownloadService.ts` `MODEL_DEFINITIONS` must be hand-updated. The packaging script prints hashes to stdout but does not auto-patch.
- **Summarization IS a TaskQueue task.** Add `'summarization'` to the `TaskType` union and append it to both audio and PDF pipeline chains. `SummarizationExecutor.execute()` returns `Promise<void>` and persists the result via `SessionService.saveGeneratedSummary(id, title, text, modelId)` — results flow to the UI through the existing `task:completed` event stream + `summary:get`, never as a direct IPC return value.
- **Model-missing is a skip, not a failure.** If `modelDownloadService.isModelInstalled(activeSummarizationModelId)` returns `false`, the executor completes successfully with no output. Do not mark the task as `failed`. Do not surface a modal error. Summary feature is strictly opt-in.
- **Anonymized text extraction happens server-side.** `SessionService` will gain a `getAnonymizedPlainText(sessionId)` helper that loads the stored TipTap JSON and walks it into plain text — the renderer passes only `sessionId`, never raw text across IPC.
- **Test discipline:** Write tests for logic (service classes, schema validation, IPC input validation, DB migrations, prompt builder). Skip tests for trivial wiring (preload bridge, React button click → IPC call). Tests use vitest + jsdom, live next to the code in `__tests__/` or `*.test.ts` files.
- **Conventions:** No semicolons, single quotes, no trailing commas, 100 char lines. Unused vars prefixed `_`. Never write `#` comments inside Bash tool calls.

---

## File Structure

Files created (new):
- `scripts/setup-llama.sh` — install llama.cpp binary + dylibs to `resources/bin/` + `resources/lib/`; optional `--model` flag downloads Gemma 4 E4B GGUF to `~/.therascript/models/summarization/`.
- `src/main/ml/LlamaSummarizer.ts` — plain service: spawns `llama-cli`, returns the parsed summary string. Not a `TaskExecutor`; used by the executor below.
- `src/main/ml/__tests__/LlamaSummarizer.test.ts` — unit tests (args builder, output parser, path-traversal guard).
- `src/main/ml/SummarizationExecutor.ts` — `TaskExecutor` implementation. Skips when model missing; otherwise calls `LlamaSummarizer` and persists via `SessionService.saveGeneratedSummary`.
- `src/main/ml/__tests__/SummarizationExecutor.test.ts` — skip-when-missing + save-on-success tests.
- `src/main/ml/summarization-prompt.ts` — builds the Gemma 4 chat-template prompt for German 2-sentence summary.
- `src/main/ml/__tests__/summarization-prompt.test.ts` — prompt builder tests.
- `src/main/ipc/summary-handlers.ts` — IPC handlers `summary:get` (reads title + summary), `summary:updateTitle`, `summary:updateText`. No regenerate, no clear, no synchronous generate.
- `src/main/ipc/__tests__/summary-handlers.test.ts` — handler input-validation tests.
- `src/main/db/migrations/002-add-summary-to-sessions.sql` — add `title`, `summary`, `summary_model_id`, `summarized_at` columns to `sessions` (adjust the leading number to match the next free migration index; migrations are `.sql` files tracked via `schema_version`, not TypeScript).
- `src/main/ml/tiptap-plain-text.ts` — pure function extracting plain text from a TipTap JSON document (unwrap speaker labels, placeholder chips, timestamps).
- `src/main/ml/__tests__/tiptap-plain-text.test.ts` — extraction tests.
- `src/renderer/src/components/review/SummaryPanel.tsx` — "Zusammenfassung" panel in Review Editor: button + generated text + regenerate + error state.
- `src/renderer/src/components/review/__tests__/SummaryPanel.test.tsx` — renders states: empty / loading / success / error / model-missing.
- `src/shared/validation/summary-schemas.ts` — Zod schemas for `summary:get` / `summary:updateTitle` / `summary:updateText`.

Files modified:
- `src/shared/validation/model-catalog-schemas.ts` — extend `ModelGroupSchema` to include `'summarization'`.
- `src/main/services/ModelDownloadService.ts` — add Gemma 4 E4B entry to `MODEL_DEFINITIONS`.
- `src/main/services/SettingsService.ts` — add `activeModels.summarization` field + default + `GROUP_TO_SETTINGS_KEY` mapping. Note: existing shape is `{ transcription, diarization, diarizationPipeline, ner, ocr }` — extend with `summarization`.
- `src/main/services/SessionService.ts` — add `getAnonymizedPlainText(id)`, `getSummary(id)` returning `{ title, text, modelId, summarizedAt }`, `saveGeneratedSummary(id, title, text, modelId)`, `updateTitle(id, title)`, `updateSummaryText(id, text)`.
- `src/shared/types/IpcApi.ts` — add `SummaryApi` interface to `IpcApi`.
- `src/preload/index.ts` — expose `summary` API via contextBridge.
- `src/main/index.ts` — wire up `LlamaSummarizer` executor + `registerSummaryHandlers()`.
- `src/renderer/src/views/ReviewEditor.tsx` — mount `<SummaryPanel>` above or below the anonymization view.
- `src/renderer/src/components/settings/ModelsSettingsSection.tsx` (or equivalent) — add new `"summarization"` group to the models settings UI.
- `src/renderer/src/components/FirstLaunchScreen.tsx` — no change (summary model is optional, not required at first launch). Document this.
- `scripts/publish-manifest.sh` — add Gemma 4 E4B entry to `MODELS` array.
- `scripts/build-sidecar.sh` — no change (llama.cpp is a standalone binary, not Python).
- `electron-builder.yml` — ensure `resources/bin/llama-cli` and `resources/lib/libllama*.dylib`, `libggml*.dylib` are packaged.
- `CLAUDE.md` — document the new model type, setup script, manual hash sync, GGUF fallback.
- `docs/product/features/summarization.md` — new feature doc (architecture, prompt, model, limits).

---

## Task 1: Verify GGUF availability and lock the model choice

**Files:**
- Read-only investigation; final notes written to the plan status comments or a scratch doc.

- [ ] **Step 1: Check bartowski's Gemma 4 E4B GGUF repo**

Run: `curl -sI https://huggingface.co/bartowski/google_gemma-4-e4b-it-GGUF/resolve/main/google_gemma-4-e4b-it-Q4_K_M.gguf | head -5`

Expected: HTTP/2 200 (or 302 redirect to CDN) and a `content-length` header around `2500000000` (±500 MB).

If 404: check the repo root `https://huggingface.co/bartowski/google_gemma-4-e4b-it-GGUF` in a browser for the correct filename (versions sometimes use `-unsloth-` or date suffixes). Note the resolved filename.

- [ ] **Step 2: If no Gemma 4 E4B GGUF exists, confirm Gemma 3 4B fallback**

Run: `curl -sI https://huggingface.co/bartowski/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf | head -5`

Expected: HTTP/2 200.

- [ ] **Step 3: Document the final choice inline in the plan**

Edit this plan: replace all `<GGUF_URL>`, `<GGUF_FILENAME>`, `<GGUF_SIZE_BYTES>` placeholders below with the concrete values from Step 1 or Step 2. No code written yet.

- [ ] **Step 4: Commit the plan update**

```bash
git add docs/superpowers/plans/2026-04-24-local-llm-summarization.md
git commit -m "plan: lock GGUF source for summarization LLM"
```

---

## Task 2: Setup script for llama.cpp + Gemma 4 E4B model

**Files:**
- Create: `scripts/setup-llama.sh`

- [ ] **Step 1: Write the setup script skeleton**

Mirror the structure of `scripts/setup-whisper.sh`. Contents:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/resources/bin"
LIB_DIR="$REPO_ROOT/resources/lib"

mkdir -p "$BIN_DIR" "$LIB_DIR"

echo "==> Installing llama.cpp via Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install from https://brew.sh" >&2
  exit 1
fi
brew install llama.cpp

BREW_PREFIX="$(brew --prefix llama.cpp)"
echo "==> Copying llama-cli binary"
cp "$BREW_PREFIX/bin/llama-cli" "$BIN_DIR/llama-cli"

echo "==> Copying runtime dylibs"
cp "$BREW_PREFIX/lib/"libllama*.dylib "$LIB_DIR/" 2>/dev/null || true
cp "$BREW_PREFIX/lib/"libggml*.dylib "$LIB_DIR/" 2>/dev/null || true

echo "==> Re-signing binary with ad-hoc signature"
codesign --force --sign - "$BIN_DIR/llama-cli"
for dylib in "$LIB_DIR/"libllama*.dylib "$LIB_DIR/"libggml*.dylib; do
  [ -f "$dylib" ] && codesign --force --sign - "$dylib"
done

echo "==> Verifying binary"
"$BIN_DIR/llama-cli" --version

if [[ "${1:-}" == "--model" ]]; then
  MODEL_DIR="$HOME/.therascript/models/summarization"
  mkdir -p "$MODEL_DIR"
  MODEL_FILE="$MODEL_DIR/<GGUF_FILENAME>"
  if [ ! -f "$MODEL_FILE" ]; then
    echo "==> Downloading Gemma 4 E4B (~2.5 GB)"
    curl -L --fail -o "$MODEL_FILE" "<GGUF_URL>"
  else
    echo "Model already present: $MODEL_FILE"
  fi
  echo "==> SHA-256:"
  shasum -a 256 "$MODEL_FILE"
fi

echo "==> Done"
```

- [ ] **Step 2: Make executable and run for dev**

```bash
chmod +x scripts/setup-llama.sh
./scripts/setup-llama.sh --model
```

Expected: `resources/bin/llama-cli --version` succeeds, model file present in `~/.therascript/models/summarization/<GGUF_FILENAME>`, SHA-256 printed.

- [ ] **Step 3: Record the SHA-256**

Copy the SHA-256 output to a scratch note. You will paste it into `MODEL_DEFINITIONS` in Task 6.

- [ ] **Step 4: Smoke-test inference manually**

```bash
./resources/bin/llama-cli \
  -m ~/.therascript/models/summarization/<GGUF_FILENAME> \
  -p "Fasse in zwei Sätzen zusammen: Das Wetter war gut und wir gingen spazieren." \
  --chat-template gemma \
  -n 80 \
  --temp 0.3 \
  --no-display-prompt
```

Expected: A short German summary prints within a few seconds. If it hangs or outputs gibberish, check `--chat-template` support (`llama-cli --help | grep chat-template`) — Gemma 4 may use a different template name. Note the working template name for Task 4.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-llama.sh
git commit -m "feat(build): add llama.cpp + Gemma 4 E4B setup script"
```

---

## Task 3: Extend model catalog schema to include `'summarization'` group

**Files:**
- Modify: `src/shared/validation/model-catalog-schemas.ts`
- Test: `src/shared/validation/__tests__/model-catalog-schemas.test.ts` (create if missing)

- [ ] **Step 1: Write failing test**

Add to the test file:

```ts
import { describe, it, expect } from 'vitest'
import { ModelGroupSchema } from '../model-catalog-schemas'

describe('ModelGroupSchema', () => {
  it('accepts "summarization" as a valid group', () => {
    expect(ModelGroupSchema.parse('summarization')).toBe('summarization')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run src/shared/validation/__tests__/model-catalog-schemas.test.ts`

Expected: FAIL — `"summarization"` not in enum.

- [ ] **Step 3: Extend the enum**

In `src/shared/validation/model-catalog-schemas.ts`:

```ts
export const ModelGroupSchema = z.enum(['asr', 'diarization', 'ner', 'summarization'])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run src/shared/validation/__tests__/model-catalog-schemas.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck the repo**

Run: `npm run typecheck`

Expected: Errors where `ModelGroup` is pattern-matched exhaustively — the compiler will point you at `GROUP_TO_SETTINGS_KEY` in `SettingsService.ts` and any switch statements that miss `'summarization'`. Do not fix them here — Task 4 covers SettingsService; any other hits should get a `case 'summarization':` branch wired to sensible no-op behavior, consistent with the surrounding code.

- [ ] **Step 6: Commit**

```bash
git add src/shared/validation/model-catalog-schemas.ts src/shared/validation/__tests__/model-catalog-schemas.test.ts
git commit -m "feat(catalog): add summarization model group"
```

---

## Task 4: Add `activeModels.summarization` to SettingsService

**Files:**
- Modify: `src/main/services/SettingsService.ts`
- Test: `src/main/services/__tests__/SettingsService.test.ts` (create if missing)

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import { SettingsService } from '../SettingsService'

describe('SettingsService defaults', () => {
  it('includes summarization in activeModels defaults', () => {
    const svc = new SettingsService()
    expect(svc.getSettings().activeModels.summarization).toBe('gemma-4-e4b-summarization')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run src/main/services/__tests__/SettingsService.test.ts`

Expected: FAIL — property missing or undefined.

- [ ] **Step 3: Update the AppSettings shape and defaults**

In `src/main/services/SettingsService.ts`, extend the existing `AppSettings.activeModels` type (current shape is `{ transcription, diarization, diarizationPipeline, ner, ocr }`) by adding `summarization: string`. Do NOT remove or rename the existing fields.

Then extend `defaults.activeModels` with one new line:

```ts
summarization: 'gemma-4-e4b-summarization',
```

(Preserve the existing default values for the other fields — read them from the current file, do not replace the whole block.)

Extend `GROUP_TO_SETTINGS_KEY` by adding one entry; keep existing mappings as-is:

```ts
summarization: 'summarization',
```

TypeScript will enforce exhaustiveness over `ModelGroup` — once Task 3 adds `'summarization'` to the enum, the compiler will flag this map as incomplete until this line is added.

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run src/main/services/__tests__/SettingsService.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/SettingsService.ts src/main/services/__tests__/SettingsService.test.ts
git commit -m "feat(settings): add active summarization model"
```

---

## Task 5: Add `'summarization'` to TaskType and both pipeline chains

**Files:**
- Modify: `src/shared/types/Task.ts` (or wherever `TaskType` lives)
- Modify: `src/main/services/TaskQueueService.ts` — extend audio + PDF pipeline chains

- [ ] **Step 1: Find the current TaskType definition and pipeline chains**

Run: `grep -rn "TaskType\|'anonymization'" src/shared/types src/main/services --include="*.ts"`

Expected: locate the union (current values are `'transcription' | 'diarization' | 'alignment' | 'extraction' | 'ocr' | 'anonymization'`) and the pipeline chain arrays for audio + PDF.

- [ ] **Step 2: Extend TaskType**

Append `| 'summarization'` to the union. Do not reorder existing members.

- [ ] **Step 3: Append to pipeline chains**

In `TaskQueueService`, locate the chain arrays and append `'summarization'` as the last element:

```ts
// audio pipeline (example — match actual existing chain)
const AUDIO_PIPELINE: TaskType[] = ['transcription', 'diarization', 'alignment', 'anonymization', 'summarization']
// PDF pipeline (example — match actual existing chain)
const PDF_PIPELINE: TaskType[] = ['extraction', 'ocr', 'anonymization', 'summarization']
```

Preserve the existing order of the other steps. The summarization step must be **last** — it depends on the anonymized document being persisted.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: TypeScript errors in switches that pattern-match `TaskType`. For each, add a `case 'summarization':` branch. For now, stub with a throw (`throw new Error('Summarization executor not yet registered')`) — the real executor wires up in Task 11. This commit leaves the type in place but not functional yet; that is intentional and keeps the commit small.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/Task.ts src/main/services/TaskQueueService.ts <any-other-switch-files>
git commit -m "feat(task): add summarization as pipeline tail step"
```

---

## Task 6: Add Gemma 4 E4B to MODEL_DEFINITIONS

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts`

- [ ] **Step 1: Add the model entry**

In the `MODEL_DEFINITIONS` array, append:

```ts
{
  id: 'gemma-4-e4b-summarization',
  label: 'Gemma 4 E4B (Summarization)',
  url: `${R2_CDN}/<GGUF_FILENAME>`,
  relativePath: 'summarization/<GGUF_FILENAME>',
  checkPath: 'summarization/<GGUF_FILENAME>',
  sizeBytes: <GGUF_SIZE_BYTES>,
  sha256: '<SHA_FROM_TASK_2>',
  group: 'summarization',
  isRequired: false,
  description: 'Lokales 4B-Parameter-Modell für 2-Satz-Zusammenfassungen deutscher Texte.',
  languages: ['de', 'en'],
},
```

`isRequired: false` is the critical flag — FirstLaunchScreen will skip it.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "feat(models): register Gemma 4 E4B summarization model"
```

---

## Task 7: Add summary columns to sessions table (SQL migration)

**Files:**
- Create: `src/main/db/migrations/00N-add-summary-to-sessions.sql` — determine `N` from Step 1 (next free index after existing migrations).

- [ ] **Step 1: Find the next migration index**

Run: `ls src/main/db/migrations/`

Expected: numbered `.sql` files like `001-initial-schema.sql`. Migrations are tracked by `schema_version` in `src/main/db/connection.ts` and run automatically on startup — no registry file to edit. Pick the next free number (e.g. `002` if `001` is the last existing migration).

- [ ] **Step 2: Verify summary column does not already exist**

Run: `grep -n "summary" src/main/db/migrations/*.sql || echo "not present"`

Expected: `not present` (or no hits on the `sessions` table).

- [ ] **Step 3: Write the migration**

Create `src/main/db/migrations/002-add-summary-to-sessions.sql` (adjust number per Step 1):

```sql
ALTER TABLE sessions ADD COLUMN title TEXT;
ALTER TABLE sessions ADD COLUMN summary TEXT;
ALTER TABLE sessions ADD COLUMN summary_model_id TEXT;
ALTER TABLE sessions ADD COLUMN summarized_at TEXT;
```

Four columns: `title` is the LLM-generated or user-edited session headline (view layer falls back to formatted date if `NULL` / empty); `summary_model_id` lets us invalidate generation provenance when the active model changes; `summarized_at` is an ISO-8601 timestamp for debugging. No `edited_by_user` flags — user edits simply overwrite the values and, for the `summary`, clear `summary_model_id` to `NULL` (so we know a subsequent model upgrade shouldn't assume the text is still machine-authoritative).

- [ ] **Step 4: Start the app to run the migration**

Run: `npm run dev`

Expected: main-process log shows migration executed, no SQL errors. Stop after first window paint.

- [ ] **Step 5: Verify schema**

```bash
sqlite3 ~/.therascript/therascript.db ".schema sessions" | grep -E "title|summary|summarized"
```

Expected: the four new columns appear.

- [ ] **Step 6: Commit**

```bash
git add src/main/db/migrations/002-add-summary-to-sessions.sql
git commit -m "feat(db): add summary columns to sessions"
```

---

## Task 7b: SessionService summary methods + TipTap plain-text extractor (TDD)

**Files:**
- Create: `src/main/ml/tiptap-plain-text.ts`
- Test: `src/main/ml/__tests__/tiptap-plain-text.test.ts`
- Modify: `src/main/services/SessionService.ts`
- Test: `src/main/services/__tests__/SessionService.test.ts` (create if missing)

- [ ] **Step 1: Write failing test for TipTap extractor**

```ts
import { describe, it, expect } from 'vitest'
import { tiptapToPlainText } from '../tiptap-plain-text'

describe('tiptapToPlainText', () => {
  it('joins text nodes across paragraphs with newlines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Satz A.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Satz B.' }] },
      ],
    }
    expect(tiptapToPlainText(doc)).toBe('Satz A.\nSatz B.')
  })

  it('renders placeholderChip nodes using their label attribute', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'text', text: 'Der Patient ' },
          { type: 'placeholderChip', attrs: { label: '[PERSON 1]' } },
          { type: 'text', text: ' war müde.' },
        ] },
      ],
    }
    expect(tiptapToPlainText(doc)).toBe('Der Patient [PERSON 1] war müde.')
  })

  it('drops speakerLabel and timestamp nodes (noise for LLM)', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'speakerLabel', attrs: { speaker: 'SPEAKER_00' } },
          { type: 'timestamp', attrs: { seconds: 12.3 } },
          { type: 'text', text: 'Hallo.' },
        ] },
      ],
    }
    expect(tiptapToPlainText(doc)).toBe('Hallo.')
  })

  it('returns empty string for malformed input', () => {
    expect(tiptapToPlainText(null as any)).toBe('')
    expect(tiptapToPlainText({} as any)).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `vitest run src/main/ml/__tests__/tiptap-plain-text.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the extractor**

```ts
interface TipTapNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: TipTapNode[]
}

export function tiptapToPlainText(doc: TipTapNode | null | undefined): string {
  if (!doc || typeof doc !== 'object') return ''
  const parts: string[] = []

  const walk = (node: TipTapNode, into: string[]): void => {
    if (!node) return
    switch (node.type) {
      case 'text':
        into.push(node.text ?? '')
        return
      case 'placeholderChip':
        into.push(String(node.attrs?.label ?? ''))
        return
      case 'speakerLabel':
      case 'timestamp':
        return
      case 'paragraph': {
        const buf: string[] = []
        for (const child of node.content ?? []) walk(child, buf)
        into.push(buf.join(''))
        return
      }
      default:
        for (const child of node.content ?? []) walk(child, into)
    }
  }

  const buf: string[] = []
  walk(doc, buf)
  return buf.filter(s => s.length > 0).join('\n')
}
```

- [ ] **Step 4: Run extractor test**

Run: `vitest run src/main/ml/__tests__/tiptap-plain-text.test.ts`

Expected: PASS.

- [ ] **Step 5: Locate where the anonymized TipTap doc is stored**

Run: `grep -rn "anonymizedPath\|anonymized_path" src/main --include="*.ts"`

Note how the anonymized TipTap JSON is persisted (likely a file referenced by `sessions.anonymized_path`). The `SessionService.getAnonymizedPlainText` implementation will read that file and run it through `tiptapToPlainText`.

- [ ] **Step 6: Add SessionService methods**

In `src/main/services/SessionService.ts`, append five methods (adapt signatures to match existing conventions — e.g. if other methods take numeric IDs, use numeric; if they throw on not-found, throw; if they return null, return null):

```ts
getAnonymizedPlainText(sessionId: string): string {
  const session = this.getById(sessionId) // or whatever the existing getter is called
  if (!session?.anonymizedPath) throw new Error(`Session ${sessionId} has no anonymized document`)
  const raw = readFileSync(session.anonymizedPath, 'utf-8')
  const doc = JSON.parse(raw)
  return tiptapToPlainText(doc)
}

getSummary(sessionId: string): { title: string | null; text: string; modelId: string | null; summarizedAt: string | null } | null {
  const row = this.db.prepare('SELECT title, summary, summary_model_id, summarized_at FROM sessions WHERE id = ?').get(sessionId) as any
  // Return a record if EITHER title or summary is present. Otherwise the renderer
  // would lose a user-edited title when the summary happens to be empty.
  // SummaryPanel handles the empty-text case by rendering null; the header still shows the title.
  if (!row || (!row.summary && !row.title)) return null
  return {
    title: row.title ?? null,
    text: row.summary ?? '',
    modelId: row.summary_model_id,
    summarizedAt: row.summarized_at,
  }
}

saveGeneratedSummary(sessionId: string, title: string, text: string, modelId: string): void {
  this.db.prepare('UPDATE sessions SET title = ?, summary = ?, summary_model_id = ?, summarized_at = ? WHERE id = ?')
    .run(title, text, modelId, new Date().toISOString(), sessionId)
}

updateTitle(sessionId: string, title: string): void {
  const normalized = title.trim()
  this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?')
    .run(normalized.length > 0 ? normalized : null, sessionId)
}

updateSummaryText(sessionId: string, text: string): void {
  const normalized = text.trim()
  // User-edited summary is no longer LLM-authoritative — clear the model id.
  this.db.prepare('UPDATE sessions SET summary = ?, summary_model_id = NULL WHERE id = ?')
    .run(normalized.length > 0 ? normalized : null, sessionId)
}
```

Adjust imports: `import { readFileSync } from 'node:fs'` and the `tiptapToPlainText` import. Match the actual DB-access pattern of the class (the snippet above assumes a `this.db` better-sqlite3 handle — if the codebase uses a repository layer, route through it).

- [ ] **Step 7: Write a SessionService test for saveGeneratedSummary/getSummary round-trip**

Use an in-memory sqlite DB seeded with the `sessions` schema + the Task 7 migration. Insert a dummy session, call `saveGeneratedSummary(id, title, text, modelId)`, then `getSummary`, assert `title`, `text`, and `modelId` match. Add a second test that inserts a session, calls `updateTitle` only (leaves summary null), and verifies `getSummary` returns the record with the title preserved and `text === ''`.

- [ ] **Step 8: Run tests**

Run: `vitest run src/main/services/__tests__/SessionService.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/ml/tiptap-plain-text.ts src/main/ml/__tests__/tiptap-plain-text.test.ts src/main/services/SessionService.ts src/main/services/__tests__/SessionService.test.ts
git commit -m "feat(session): summary persistence + TipTap plain-text extractor"
```

---

## Task 8: Write the summarization prompt builder (TDD)

**Files:**
- Create: `src/main/ml/summarization-prompt.ts`
- Test: `src/main/ml/__tests__/summarization-prompt.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import { buildSummarizationPrompt } from '../summarization-prompt'

describe('buildSummarizationPrompt', () => {
  it('requests structured TITEL + ZUSAMMENFASSUNG output in German', () => {
    const prompt = buildSummarizationPrompt('Der Patient berichtet von Schlafstörungen.')
    expect(prompt).toContain('TITEL:')
    expect(prompt).toContain('ZUSAMMENFASSUNG:')
    expect(prompt).toContain('zwei')
    expect(prompt).toContain('Schlafstörungen')
  })

  it('truncates input exceeding 120k characters to fit model context', () => {
    const long = 'a'.repeat(200_000)
    const prompt = buildSummarizationPrompt(long)
    expect(prompt.length).toBeLessThan(150_000)
  })

  it('preserves placeholder chips inside the anonymized text verbatim', () => {
    const prompt = buildSummarizationPrompt('Der Patient [PERSON 1] war müde.')
    expect(prompt).toContain('[PERSON 1]')
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `vitest run src/main/ml/__tests__/summarization-prompt.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

```ts
const MAX_INPUT_CHARS = 120_000

const INSTRUCTION = `Du bist ein professioneller Assistent für die Kurz-Beschreibung von Therapiesitzungen und medizinischen Dokumenten. Analysiere den folgenden Text und erzeuge zwei Ausgaben:

1. Einen prägnanten deutschen Titel (Nominalphrase, 3–8 Wörter, max. 80 Zeichen). Keine vollständige Satz, keine Anführungszeichen, keine Einleitung.
2. Eine Zusammenfassung in genau zwei prägnanten deutschen Sätzen. Nenne die zentralen Themen und Schlüsselpunkte.

Formatiere die Antwort exakt so (zwei Zeilen, keine weiteren Inhalte):

TITEL: <dein Titel>
ZUSAMMENFASSUNG: <deine zwei Sätze>

Keine Einleitung, keine Aufzählungen, keine Meta-Kommentare, keine Markdown-Formatierung.`

export function buildSummarizationPrompt(text: string): string {
  const trimmed = text.length > MAX_INPUT_CHARS
    ? text.slice(0, MAX_INPUT_CHARS) + '\n[... gekürzt ...]'
    : text
  return `${INSTRUCTION}\n\nText:\n---\n${trimmed}\n---`
}
```

Note: the chat template itself (`<start_of_turn>user`, etc.) is applied by `llama-cli --chat-template gemma` — we pass a plain prompt.

- [ ] **Step 4: Run tests**

Run: `vitest run src/main/ml/__tests__/summarization-prompt.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ml/summarization-prompt.ts src/main/ml/__tests__/summarization-prompt.test.ts
git commit -m "feat(ml): summarization prompt builder"
```

---

## Task 9: Implement `LlamaSummarizer` service (TDD)

**Files:**
- Create: `src/main/ml/LlamaSummarizer.ts`
- Test: `src/main/ml/__tests__/LlamaSummarizer.test.ts`

This is a **plain service class** that wraps the llama-cli subprocess. It is called by `SummarizationExecutor` (Task 9b). Public surface: `summarize(text, signal): Promise<{ title: string; text: string }>`. No in-flight mutex is needed — the `TaskQueue` guarantees serial executor runs.

- [ ] **Step 1: Write failing tests for the pure helpers**

```ts
import { describe, it, expect } from 'vitest'
import { buildLlamaArgs, parseLlamaOutput, validateModelPath } from '../LlamaSummarizer'

describe('buildLlamaArgs', () => {
  it('includes required flags with given model + prompt path', () => {
    const args = buildLlamaArgs({
      modelPath: '/models/gemma.gguf',
      promptFilePath: '/tmp/prompt.txt',
      maxTokens: 200,
    })
    expect(args).toContain('-m')
    expect(args).toContain('/models/gemma.gguf')
    expect(args).toContain('-f')
    expect(args).toContain('/tmp/prompt.txt')
    expect(args).toContain('--chat-template')
    expect(args).toContain('gemma')
    expect(args).toContain('-n')
    expect(args).toContain('200')
    expect(args).toContain('--no-display-prompt')
  })
})

describe('parseLlamaOutput', () => {
  it('extracts TITEL and ZUSAMMENFASSUNG fields into a structured result', () => {
    const raw = 'TITEL: Schlafstörungen und Arbeitsstress\nZUSAMMENFASSUNG: Der Patient berichtet von Einschlafproblemen. Vereinbart wird ein Schlaftagebuch.\n[end of text]'
    expect(parseLlamaOutput(raw)).toEqual({
      title: 'Schlafstörungen und Arbeitsstress',
      text: 'Der Patient berichtet von Einschlafproblemen. Vereinbart wird ein Schlaftagebuch.',
    })
  })

  it('strips any trailing [end of text] marker and trims whitespace', () => {
    const raw = 'TITEL: Thema\nZUSAMMENFASSUNG: Satz eins. Satz zwei.\n\nllama_print_timings: ...'
    expect(parseLlamaOutput(raw)).toEqual({ title: 'Thema', text: 'Satz eins. Satz zwei.' })
  })

  it('tolerates lowercase variants and leading/trailing whitespace around keys', () => {
    const raw = '  titel: Thema  \n  zusammenfassung:  Satz eins. Satz zwei.  '
    expect(parseLlamaOutput(raw)).toEqual({ title: 'Thema', text: 'Satz eins. Satz zwei.' })
  })

  it('captures the full summary when the LLM splits it across multiple lines', () => {
    const raw = 'TITEL: Thema\nZUSAMMENFASSUNG: Satz eins.\nSatz zwei.'
    expect(parseLlamaOutput(raw)).toEqual({ title: 'Thema', text: 'Satz eins. Satz zwei.' })
  })

  it('throws a readable error when the output is missing either field', () => {
    expect(() => parseLlamaOutput('something else entirely')).toThrow(/TITEL|ZUSAMMENFASSUNG/)
  })
})

describe('validateModelPath', () => {
  it('accepts paths under the allowed models directory', () => {
    expect(() => validateModelPath('/root/models/summarization/gemma.gguf', '/root/models')).not.toThrow()
  })

  it('rejects paths that escape the allowed directory', () => {
    expect(() => validateModelPath('/root/models/../etc/passwd', '/root/models')).toThrow()
    expect(() => validateModelPath('/etc/passwd', '/root/models')).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `vitest run src/main/ml/__tests__/LlamaSummarizer.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildSummarizationPrompt } from './summarization-prompt'

export interface LlamaArgsInput {
  modelPath: string
  promptFilePath: string
  maxTokens: number
}

export function buildLlamaArgs(input: LlamaArgsInput): string[] {
  return [
    '-m', input.modelPath,
    '-f', input.promptFilePath,
    '--chat-template', 'gemma',
    '-n', String(input.maxTokens),
    '--temp', '0.3',
    '--top-p', '0.9',
    '--no-display-prompt',
    '-ngl', '999',
  ]
}

export interface SummarizeResult {
  title: string
  text: string
}

export function parseLlamaOutput(raw: string): SummarizeResult {
  const cleaned = raw
    .replace(/\[end of text\]\s*$/i, '')
    .replace(/llama_print_timings[\s\S]*$/i, '')
    .trim()

  // Extract TITEL from its single line.
  const titleMatch = cleaned.match(/^\s*titel\s*:\s*(.+?)\s*$/im)

  // Extract ZUSAMMENFASSUNG as everything after the label to end-of-string.
  // Do NOT use the /m flag here — a two-sentence summary may span multiple lines.
  const sumLabelIdx = cleaned.search(/(^|\n)\s*zusammenfassung\s*:/i)
  let summary = ''
  if (sumLabelIdx >= 0) {
    const sliced = cleaned.slice(sumLabelIdx).replace(/^\s*\n?/, '').replace(/^\s*zusammenfassung\s*:\s*/i, '')
    // Collapse internal newlines to single spaces; trim edges.
    summary = sliced.replace(/\s*\n\s*/g, ' ').trim()
  }

  if (!titleMatch || summary.length === 0) {
    throw new Error(`Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt. Rohtext: ${cleaned.slice(0, 200)}`)
  }

  return {
    title: titleMatch[1].trim(),
    text: summary,
  }
}

export function validateModelPath(modelPath: string, allowedDir: string): void {
  const resolved = resolvePath(modelPath)
  const allowedResolved = resolvePath(allowedDir)
  const rel = relative(allowedResolved, resolved)
  if (rel.startsWith('..') || resolvePath(allowedResolved, rel) !== resolved) {
    throw new Error(`Model path escapes allowed directory: ${modelPath}`)
  }
}

export interface LlamaSummarizerDeps {
  getModelPath: () => string
  getBinaryPath: () => string
  getAllowedModelsDir: () => string
}

export class LlamaSummarizer {
  constructor(private readonly deps: LlamaSummarizerDeps) {}

  async summarize(text: string, signal: AbortSignal): Promise<SummarizeResult> {
    const modelPath = this.deps.getModelPath()
    validateModelPath(modelPath, this.deps.getAllowedModelsDir())

    const prompt = buildSummarizationPrompt(text)
    const promptFile = join(tmpdir(), `therascript-summary-${randomUUID()}.txt`)
    await writeFile(promptFile, prompt, 'utf-8')

    try {
      const args = buildLlamaArgs({ modelPath, promptFilePath: promptFile, maxTokens: 260 })
      const raw = await this.spawn(args, signal)
      return parseLlamaOutput(raw)
    } finally {
      await unlink(promptFile).catch(() => {})
    }
  }

  private spawn(args: string[], signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.deps.getBinaryPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''

      const abort = () => { child.kill('SIGTERM'); reject(new Error('Summarization aborted')) }
      signal.addEventListener('abort', abort, { once: true })

      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('close', code => {
        signal.removeEventListener('abort', abort)
        if (code === 0) resolve(stdout)
        else reject(new Error(`llama-cli exited with code ${code}: ${stderr.slice(-500)}`))
      })
    })
  }
}
```

For `getBinaryPath`, mirror whatever `WhisperService.ts` uses to resolve its `whisper-cli` binary — likely a helper that returns `app.isPackaged ? join(process.resourcesPath, 'bin', 'llama-cli') : join(__dirname, '../../../resources/bin/llama-cli')`. Reuse the helper (or factor one out if `WhisperService` inlines the logic).

- [ ] **Step 4: Run tests**

Run: `vitest run src/main/ml/__tests__/LlamaSummarizer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ml/LlamaSummarizer.ts src/main/ml/__tests__/LlamaSummarizer.test.ts
git commit -m "feat(ml): LlamaSummarizer service with path-traversal guard"
```

---

## Task 9b: Implement `SummarizationExecutor` (TDD)

**Files:**
- Create: `src/main/ml/SummarizationExecutor.ts`
- Test: `src/main/ml/__tests__/SummarizationExecutor.test.ts`

This is the `TaskExecutor` registered with the `TaskQueue`. It handles the "skip when model missing" behavior and persists the result (title + summary text) via `SessionService.saveGeneratedSummary`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { SummarizationExecutor } from '../SummarizationExecutor'

const makeDeps = (over: any = {}) => ({
  llamaSummarizer: {
    summarize: vi.fn().mockResolvedValue({ title: 'Kurztitel', text: 'Eine Zusammenfassung.' }),
    ...over.llamaSummarizer,
  },
  sessionService: {
    getAnonymizedPlainText: vi.fn().mockReturnValue('Der Patient war müde.'),
    saveGeneratedSummary: vi.fn(),
    ...over.sessionService,
  },
  isModelInstalled: over.isModelInstalled ?? (() => true),
  getActiveModelId: over.getActiveModelId ?? (() => 'gemma-4-e4b-summarization'),
  logger: { info: vi.fn(), error: vi.fn() },
})

const task = { id: 't1', type: 'summarization' as const, sessionId: 'abc' } as any
const onProgress = () => {}
const signal = new AbortController().signal

describe('SummarizationExecutor', () => {
  it('skips cleanly when model is not installed (task succeeds, no spawn, no save)', async () => {
    const deps = makeDeps({ isModelInstalled: () => false })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).resolves.toBeUndefined()
    expect(deps.llamaSummarizer.summarize).not.toHaveBeenCalled()
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringMatching(/skip.*model/i))
  })

  it('summarizes anonymized text and persists title + text with active model id', async () => {
    const deps = makeDeps()
    const exec = new SummarizationExecutor(deps)
    await exec.execute(task, onProgress, signal)
    expect(deps.llamaSummarizer.summarize).toHaveBeenCalledWith('Der Patient war müde.', signal)
    expect(deps.sessionService.saveGeneratedSummary).toHaveBeenCalledWith(
      'abc', 'Kurztitel', 'Eine Zusammenfassung.', 'gemma-4-e4b-summarization',
    )
  })

  it('propagates summarizer errors as task failure (no save)', async () => {
    const deps = makeDeps({ llamaSummarizer: { summarize: vi.fn().mockRejectedValue(new Error('spawn failed')) } })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).rejects.toThrow('spawn failed')
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
  })

  it('skips cleanly when anonymized text is empty (nothing to summarize)', async () => {
    const deps = makeDeps({ sessionService: { getAnonymizedPlainText: vi.fn().mockReturnValue('') } })
    const exec = new SummarizationExecutor(deps)
    await expect(exec.execute(task, onProgress, signal)).resolves.toBeUndefined()
    expect(deps.llamaSummarizer.summarize).not.toHaveBeenCalled()
    expect(deps.sessionService.saveGeneratedSummary).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `vitest run src/main/ml/__tests__/SummarizationExecutor.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the executor**

```ts
import type { Task, TaskExecutor } from '../../shared/types/Task'

export interface SummarizationExecutorDeps {
  llamaSummarizer: { summarize(text: string, signal: AbortSignal): Promise<{ title: string; text: string }> }
  sessionService: {
    getAnonymizedPlainText(sessionId: string): string
    saveGeneratedSummary(sessionId: string, title: string, text: string, modelId: string): void
  }
  isModelInstalled: () => boolean
  getActiveModelId: () => string
  logger: { info(msg: string): void; error(msg: string): void }
}

export class SummarizationExecutor implements TaskExecutor {
  readonly taskType = 'summarization' as const

  constructor(private readonly deps: SummarizationExecutorDeps) {}

  async execute(task: Task, _onProgress: (p: number) => void, signal: AbortSignal): Promise<void> {
    if (!this.deps.isModelInstalled()) {
      this.deps.logger.info(`Summarization skipped for session ${task.sessionId}: model not installed`)
      return
    }

    const text = this.deps.sessionService.getAnonymizedPlainText(task.sessionId)
    if (!text || text.trim().length === 0) {
      this.deps.logger.info(`Summarization skipped for session ${task.sessionId}: empty anonymized text`)
      return
    }

    const result = await this.deps.llamaSummarizer.summarize(text, signal)
    this.deps.sessionService.saveGeneratedSummary(task.sessionId, result.title, result.text, this.deps.getActiveModelId())
  }
}
```

Adapt the `TaskExecutor` interface shape (method name, progress-callback type) to whatever the existing codebase defines. The progress signature here is `(p: number) => void` (a 0–1 float) per the earlier review finding; match the actual signature. Summarization has no meaningful fine-grained progress, so it's not reported — task state transitions (pending → running → completed) are enough for UI.

- [ ] **Step 4: Run tests**

Run: `vitest run src/main/ml/__tests__/SummarizationExecutor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ml/SummarizationExecutor.ts src/main/ml/__tests__/SummarizationExecutor.test.ts
git commit -m "feat(ml): SummarizationExecutor with skip-on-missing-model"
```

---

## Task 10: Add IPC schemas + handlers (TDD on validation)

**Files:**
- Create: `src/shared/validation/summary-schemas.ts`
- Create: `src/main/ipc/summary-handlers.ts`
- Test: `src/main/ipc/__tests__/summary-handlers.test.ts`

- [ ] **Step 1: Write Zod schemas**

```ts
import { z } from 'zod'

const MAX_TITLE_CHARS = 120
const MAX_SUMMARY_CHARS = 2_000

export const SummaryGetInputSchema = z.object({
  sessionId: z.string().min(1),
})

export const SummaryUpdateTitleInputSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().max(MAX_TITLE_CHARS),
})

export const SummaryUpdateTextInputSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().max(MAX_SUMMARY_CHARS),
})

export type SummaryGetInput = z.infer<typeof SummaryGetInputSchema>
export type SummaryUpdateTitleInput = z.infer<typeof SummaryUpdateTitleInputSchema>
export type SummaryUpdateTextInput = z.infer<typeof SummaryUpdateTextInputSchema>
```

No `generate`, `regenerate`, or `clear` channels. Initial generation happens automatically as the pipeline tail step (Task 5). There is no UI affordance to re-trigger; users can only edit the persisted text. Length caps guard against a compromised renderer flooding the DB with oversized blobs.

- [ ] **Step 2: Write failing handler tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleSummaryGet, handleSummaryUpdateTitle, handleSummaryUpdateText } from '../summary-handlers'

const makeDeps = (over: any = {}) => ({
  sessionService: {
    getSummary: vi.fn().mockReturnValue(null),
    updateTitle: vi.fn(),
    updateSummaryText: vi.fn(),
    ...over.sessionService,
  },
})

describe('summary:get', () => {
  it('rejects empty sessionId', () => {
    expect(() => handleSummaryGet({ sessionId: '' }, makeDeps())).toThrow()
  })

  it('returns the cached SummaryRecord when present', () => {
    const record = {
      title: 'Kurztitel', text: 'Cached.', modelId: 'gemma-4-e4b-summarization', summarizedAt: '2026-04-24T10:00:00Z',
    }
    const deps = makeDeps({ sessionService: { getSummary: vi.fn().mockReturnValue(record) } })
    expect(handleSummaryGet({ sessionId: 'abc' }, deps)).toBe(record)
  })

  it('returns null when no summary', () => {
    expect(handleSummaryGet({ sessionId: 'abc' }, makeDeps())).toBeNull()
  })
})

describe('summary:updateTitle', () => {
  it('rejects empty sessionId', () => {
    expect(() => handleSummaryUpdateTitle({ sessionId: '', title: 'x' }, makeDeps())).toThrow()
  })

  it('rejects title exceeding 120 chars', () => {
    const long = 'x'.repeat(121)
    expect(() => handleSummaryUpdateTitle({ sessionId: 'abc', title: long }, makeDeps())).toThrow()
  })

  it('delegates to SessionService.updateTitle', () => {
    const deps = makeDeps()
    handleSummaryUpdateTitle({ sessionId: 'abc', title: 'Neuer Titel' }, deps)
    expect(deps.sessionService.updateTitle).toHaveBeenCalledWith('abc', 'Neuer Titel')
  })

  it('accepts empty title (resets to date-fallback in view layer)', () => {
    const deps = makeDeps()
    handleSummaryUpdateTitle({ sessionId: 'abc', title: '' }, deps)
    expect(deps.sessionService.updateTitle).toHaveBeenCalledWith('abc', '')
  })
})

describe('summary:updateText', () => {
  it('delegates to SessionService.updateSummaryText', () => {
    const deps = makeDeps()
    handleSummaryUpdateText({ sessionId: 'abc', text: 'Editierte Zusammenfassung.' }, deps)
    expect(deps.sessionService.updateSummaryText).toHaveBeenCalledWith('abc', 'Editierte Zusammenfassung.')
  })

  it('rejects text exceeding 2000 chars', () => {
    const long = 'x'.repeat(2_001)
    expect(() => handleSummaryUpdateText({ sessionId: 'abc', text: long }, makeDeps())).toThrow()
  })
})
```

- [ ] **Step 3: Run to verify FAIL**

Run: `vitest run src/main/ipc/__tests__/summary-handlers.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement the handler module**

```ts
import { ipcMain } from 'electron'
import {
  SummaryGetInputSchema,
  SummaryUpdateTitleInputSchema,
  SummaryUpdateTextInputSchema,
} from '../../shared/validation/summary-schemas'

export interface SummaryRecord {
  title: string | null
  text: string
  modelId: string | null
  summarizedAt: string | null
}

export interface SummaryHandlerDeps {
  sessionService: {
    getSummary(id: string): SummaryRecord | null
    updateTitle(id: string, title: string): void
    updateSummaryText(id: string, text: string): void
  }
}

export function handleSummaryGet(input: unknown, deps: SummaryHandlerDeps): SummaryRecord | null {
  const parsed = SummaryGetInputSchema.parse(input)
  return deps.sessionService.getSummary(parsed.sessionId)
}

export function handleSummaryUpdateTitle(input: unknown, deps: SummaryHandlerDeps): void {
  const parsed = SummaryUpdateTitleInputSchema.parse(input)
  deps.sessionService.updateTitle(parsed.sessionId, parsed.title)
}

export function handleSummaryUpdateText(input: unknown, deps: SummaryHandlerDeps): void {
  const parsed = SummaryUpdateTextInputSchema.parse(input)
  deps.sessionService.updateSummaryText(parsed.sessionId, parsed.text)
}

export function registerSummaryHandlers(deps: SummaryHandlerDeps): void {
  ipcMain.handle('summary:get', (_evt, input) => handleSummaryGet(input, deps))
  ipcMain.handle('summary:updateTitle', (_evt, input) => handleSummaryUpdateTitle(input, deps))
  ipcMain.handle('summary:updateText', (_evt, input) => handleSummaryUpdateText(input, deps))
}
```

No `taskQueue` dependency — the handler is purely a read + two edit endpoints. All SessionService methods referenced here are added in Task 7b.

- [ ] **Step 5: Run tests**

Run: `vitest run src/main/ipc/__tests__/summary-handlers.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/validation/summary-schemas.ts src/main/ipc/summary-handlers.ts src/main/ipc/__tests__/summary-handlers.test.ts
git commit -m "feat(ipc): summary get + update handlers"
```

---

## Task 11: Wire `LlamaSummarizer` + summary handlers into `main/index.ts`

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/services/ModelDownloadService.ts` (only if `getActiveModelPath` doesn't already exist)

- [ ] **Step 1: Ensure `getActiveModelPath(group)` exists on `ModelDownloadService`**

Run: `grep -n "getActiveModelPath\|getActiveModelId" src/main/services/ModelDownloadService.ts`

If `getActiveModelId(group)` exists but `getActiveModelPath` does not, add:

```ts
getActiveModelPath(group: ModelGroup): string {
  const activeId = this.getActiveModelId(group)
  const def = MODEL_DEFINITIONS.find(d => d.id === activeId)
  if (!def) throw new Error(`No model definition for active ${group} id: ${activeId}`)
  return join(this.getModelsDir(), def.relativePath)
}
```

(Use whatever the actual models-dir accessor is called — `getModelsDir()`, `modelsDir`, etc.)

- [ ] **Step 2: Wire the service + executor + handlers at startup**

Find the block that instantiates services and registers task executors (grep `new WhisperService\|registerExecutor`). Add after `sessionService`, `modelDownloadService`, and `taskQueue` are available:

```ts
import { LlamaSummarizer } from './ml/LlamaSummarizer'
import { SummarizationExecutor } from './ml/SummarizationExecutor'
import { registerSummaryHandlers } from './ipc/summary-handlers'
import { join } from 'node:path'
import { logger } from './logger' // or wherever the project's logger lives

const llamaSummarizer = new LlamaSummarizer({
  getModelPath: () => modelDownloadService.getActiveModelPath('summarization'),
  getBinaryPath: () => resolveLlamaBinary(),
  getAllowedModelsDir: () => join(modelDownloadService.getModelsDir(), 'summarization'),
})

const summarizationExecutor = new SummarizationExecutor({
  llamaSummarizer,
  sessionService,
  isModelInstalled: () => modelDownloadService.isModelInstalled(
    modelDownloadService.getActiveModelId('summarization'),
  ),
  getActiveModelId: () => modelDownloadService.getActiveModelId('summarization'),
  logger,
})

taskQueue.registerExecutor(summarizationExecutor)

registerSummaryHandlers({ sessionService })
```

`resolveLlamaBinary()` is a small helper mirroring the whisper binary resolver; if `WhisperService` inlines its resolver, copy the pattern here (or factor both into `src/main/services/resolve-binary.ts`).

The `logger` reference should use whatever the project's existing logging convention is (console, debug-namespace, pino, etc.) — do not introduce a new logger.

- [ ] **Step 3: Start the app**

Run: `npm run dev`

Expected: app starts, no errors in main-process log.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/services/ModelDownloadService.ts
git commit -m "feat(main): wire LlamaSummarizer and summary handlers"
```

---

## Task 12: Expose summary API in preload + IpcApi types

**Files:**
- Modify: `src/shared/types/IpcApi.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add `SummaryApi` to `IpcApi.ts`**

```ts
export interface SummaryRecord {
  title: string | null
  text: string
  modelId: string | null
  summarizedAt: string | null
}

export interface SummaryApi {
  get(sessionId: string): Promise<SummaryRecord | null>
  updateTitle(sessionId: string, title: string): Promise<void>
  updateText(sessionId: string, text: string): Promise<void>
}

export interface IpcApi {
  // ... existing
  summary: SummaryApi
}
```

No `generate` / `regenerate` / `clear` — initial generation runs automatically as the pipeline tail step, and re-triggering is not exposed in v1. Users can only view the persisted record or edit the title/text in place.

- [ ] **Step 2: Expose via preload**

In `src/preload/index.ts`, add to the `api` object passed to `contextBridge.exposeInMainWorld`:

```ts
summary: {
  get: (sessionId: string) => ipcRenderer.invoke('summary:get', { sessionId }),
  updateTitle: (sessionId: string, title: string) =>
    ipcRenderer.invoke('summary:updateTitle', { sessionId, title }),
  updateText: (sessionId: string, text: string) =>
    ipcRenderer.invoke('summary:updateText', { sessionId, text }),
},
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/IpcApi.ts src/preload/index.ts
git commit -m "feat(preload): expose summary API"
```

---

## Task 13: Add `SummaryPanel` component (TDD)

**Files:**
- Create: `src/renderer/src/components/review/SummaryPanel.tsx`
- Test: `src/renderer/src/components/review/__tests__/SummaryPanel.test.tsx`

Minimal behavior:
- Fetches `summary:get(sessionId)` on mount.
- If the result is `null` **or** its `text` is empty (title-only record) → the component renders `null`. No placeholder, no CTA, no missing-model notice.
- If the result has a non-empty `text` → renders it as inline-editable `contenteditable` paragraph. `Enter` or blur saves via `summary:updateText`; `Esc` cancels. Empty-on-blur is accepted and persisted (user can clear the summary; after the commit the panel unmounts on next reload).
- No provenance icons (no 🔒, no ✨). No regenerate button.

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SummaryPanel } from '../SummaryPanel'

const makeApi = (over: any = {}) => ({
  summary: {
    get: vi.fn().mockResolvedValue(null),
    updateText: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    ...over.summary,
  },
})

beforeEach(() => { (globalThis as any).window.api = makeApi() })

describe('SummaryPanel', () => {
  it('renders null when there is no summary', async () => {
    const { container } = render(<SummaryPanel sessionId="abc" />)
    await waitFor(() => {
      expect((globalThis as any).window.api.summary.get).toHaveBeenCalledWith('abc')
    })
    expect(container.firstChild).toBeNull()
  })

  it('renders the summary text when present', async () => {
    ;(globalThis as any).window.api = makeApi({
      summary: { get: vi.fn().mockResolvedValue({
        title: 'Kurztitel', text: 'Eine Zusammenfassung.',
        modelId: 'gemma-4-e4b-summarization', summarizedAt: '2026-04-24T10:00:00Z',
      }) },
    })
    render(<SummaryPanel sessionId="abc" />)
    await waitFor(() => expect(screen.getByText('Eine Zusammenfassung.')).toBeDefined())
  })

  it('persists an edit via summary:updateText on blur', async () => {
    ;(globalThis as any).window.api = makeApi({
      summary: { get: vi.fn().mockResolvedValue({
        title: null, text: 'Alter Text.', modelId: null, summarizedAt: null,
      }) },
    })
    render(<SummaryPanel sessionId="abc" />)
    const para = await screen.findByText('Alter Text.')
    para.textContent = 'Neuer Text.'
    fireEvent.blur(para)
    await waitFor(() => {
      expect((globalThis as any).window.api.summary.updateText).toHaveBeenCalledWith('abc', 'Neuer Text.')
    })
  })

  it('does not persist on Escape (reverts to original)', async () => {
    ;(globalThis as any).window.api = makeApi({
      summary: { get: vi.fn().mockResolvedValue({
        title: null, text: 'Original.', modelId: null, summarizedAt: null,
      }) },
    })
    render(<SummaryPanel sessionId="abc" />)
    const para = await screen.findByText('Original.')
    para.textContent = 'Draft.'
    fireEvent.keyDown(para, { key: 'Escape' })
    expect((globalThis as any).window.api.summary.updateText).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `vitest run src/renderer/src/components/review/__tests__/SummaryPanel.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement the component**

```tsx
import { useEffect, useRef, useState, KeyboardEvent, FocusEvent } from 'react'

interface Props {
  sessionId: string
}

export function SummaryPanel({ sessionId }: Props) {
  const [text, setText] = useState<string | null>(null)
  const originalRef = useRef<string>('')

  useEffect(() => {
    let cancelled = false
    window.api.summary.get(sessionId).then(record => {
      if (cancelled) return
      if (record && record.text && record.text.length > 0) {
        setText(record.text)
        originalRef.current = record.text
      } else {
        setText(null)
      }
    })
    return () => { cancelled = true }
  }, [sessionId])

  if (text === null) return null

  const commit = (el: HTMLElement) => {
    const next = (el.textContent ?? '').trim()
    if (next === originalRef.current) return
    originalRef.current = next
    window.api.summary.updateText(sessionId, next).catch(err => {
      console.error('Failed to save summary edit', err)
    })
  }

  const onBlur = (e: FocusEvent<HTMLParagraphElement>) => commit(e.currentTarget)
  const onKeyDown = (e: KeyboardEvent<HTMLParagraphElement>) => {
    if (e.key === 'Escape') {
      e.currentTarget.textContent = originalRef.current
      e.currentTarget.blur()
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  return (
    <section className="rounded border p-3">
      <p
        className="text-sm outline-none focus:ring-1 focus:ring-ring rounded-sm"
        contentEditable
        suppressContentEditableWarning
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {text}
      </p>
    </section>
  )
}
```

- No mount when there's nothing to show (panel is invisible in that state).
- `contentEditable` uses `suppressContentEditableWarning` because React doesn't manage the DOM text inside. The `originalRef` tracks the committed value for change detection and Escape-revert.
- `Shift+Enter` stays as a newline in contenteditable; plain `Enter` commits and blurs (common chat/editor convention).
- No optimistic UI with state updates on every keystroke — we read `textContent` at commit time. Keeps the component trivial.

- [ ] **Step 4: Run tests**

Run: `vitest run src/renderer/src/components/review/__tests__/SummaryPanel.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/review/SummaryPanel.tsx src/renderer/src/components/review/__tests__/SummaryPanel.test.tsx
git commit -m "feat(ui): summary panel with states"
```

---

## Task 14: Mount `SummaryPanel` + editable title in `ReviewEditor`

**Files:**
- Modify: `src/renderer/src/views/ReviewEditor.tsx`
- Possibly create: `src/renderer/src/components/review/EditableSessionTitle.tsx` (inline-edit h1)

The `SummaryPanel` renders itself as `null` when there's nothing to show, so no `modelAvailable` prop, no gating logic in the parent — just mount it unconditionally. The editable title is wider: it affects not only the Review Editor header but also the session list (Task 14b).

- [ ] **Step 1: Create the `EditableSessionTitle` component**

`src/renderer/src/components/review/EditableSessionTitle.tsx`:

```tsx
import { useRef, KeyboardEvent, FocusEvent } from 'react'

interface Props {
  sessionId: string
  title: string | null
  fallback: string // e.g. formatted date shown as CSS placeholder when title is empty
}

export function EditableSessionTitle({ sessionId, title, fallback }: Props) {
  // The DOM text content is always the actual title (empty string if null).
  // The fallback is shown via CSS `::before` from `data-placeholder`, NOT as real text.
  // This avoids the fallback-promotion bug where focusing+blurring an empty field
  // would otherwise commit the fallback string as the real title.
  const originalRef = useRef(title ?? '')

  const commit = (el: HTMLElement) => {
    const next = (el.textContent ?? '').trim()
    if (next === originalRef.current) return
    originalRef.current = next
    window.api.summary.updateTitle(sessionId, next).catch(err => {
      console.error('Failed to save title edit', err)
    })
  }

  const onBlur = (e: FocusEvent<HTMLHeadingElement>) => commit(e.currentTarget)
  const onKeyDown = (e: KeyboardEvent<HTMLHeadingElement>) => {
    if (e.key === 'Escape') {
      e.currentTarget.textContent = originalRef.current
      e.currentTarget.blur()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  return (
    <h1
      className="session-title text-2xl font-semibold outline-none focus:ring-1 focus:ring-ring rounded-sm"
      contentEditable
      suppressContentEditableWarning
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      aria-label="Sitzungstitel bearbeiten"
      data-placeholder={fallback}
    >
      {title ?? ''}
    </h1>
  )
}
```

Add the placeholder CSS once (e.g. in the component's stylesheet or the app's global Tailwind layer):

```css
.session-title:empty::before {
  content: attr(data-placeholder);
  color: var(--muted-foreground, #6b7280);
  pointer-events: none;
}
```

Result: when `title` is null, the DOM text is empty and CSS shows the fallback date. Focusing + blurring without typing reads empty `textContent`, which equals `originalRef.current = ''` → no update fires. Fallback is never promoted to real content.

- [ ] **Step 2: Wire into ReviewEditor header**

Replace the existing static date/time label with `<EditableSessionTitle>`. Mount `<SummaryPanel>` below it (above transcript):

```tsx
import { EditableSessionTitle } from '../components/review/EditableSessionTitle'
import { SummaryPanel } from '../components/review/SummaryPanel'

// In the render:
<header>
  <EditableSessionTitle
    sessionId={session.id}
    title={summaryRecord?.title ?? null}
    fallback={formatDateTime(session.createdAt)}
  />
  <p className="text-sm text-muted-foreground">
    {formatDateTime(session.createdAt)} • {formatDuration(session.durationSeconds)}
  </p>
</header>
<SummaryPanel sessionId={session.id} />
{/* existing transcript editor below */}
```

Source of `summaryRecord`: load once in the ReviewEditor via `window.api.summary.get(sessionId)`, cache it in local state, pass the `title` down. SummaryPanel does its own fetch; acceptable duplication for isolation, or factor into a shared hook `useSummary(sessionId)` if the repo prefers hooks. Match existing patterns.

- [ ] **Step 3: Manual smoke test**

```bash
npm run dev
```

Process a new session. In Review Editor:
- Verify an auto-generated title appears as h1.
- Verify the summary paragraph appears below.
- Click the title → type → blur → reload the app → title persists.
- Same for the summary text.
- Clear the title to empty → blur → reload → h1 now shows the date fallback.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/views/ReviewEditor.tsx src/renderer/src/components/review/EditableSessionTitle.tsx
git commit -m "feat(review): editable title + summary panel"
```

---

## Task 14b: Show session title in session list

**Files:**
- Modify: the session-list component (find via `grep -rn "anonymizedPath\|session.createdAt" src/renderer/src/components` + `src/renderer/src/views`)

The session list currently shows a date-based label as primary. Update it to prefer `session.title` (when non-empty), falling back to the date. Secondary metadata row keeps the date + duration + status.

- [ ] **Step 1: Locate the list component**

Run: `grep -rn "createdAt" src/renderer/src --include="*.tsx" | head -20`

Identify the card/row component.

- [ ] **Step 2: Read `title` from the session model in the renderer**

The renderer's session type needs a `title: string | null` field. The IPC layer that serves sessions (list endpoint, grep for `session:list` or similar) should already select the new `title` column — if not, extend the SELECT to include it and update the shared type.

- [ ] **Step 3: Render title as primary, date as secondary**

```tsx
<div className="flex flex-col">
  <span className="font-medium line-clamp-2">
    {session.title && session.title.length > 0 ? session.title : formatDateTime(session.createdAt)}
  </span>
  <span className="text-xs text-muted-foreground">
    {formatDateTime(session.createdAt)} • {formatDuration(session.durationSeconds)} • {session.status}
  </span>
</div>
```

- [ ] **Step 4: Live-update after pipeline completes**

If the list already re-renders when a session's status changes (most likely via an existing `sessions:changed` event or task completion event), no extra work. If not, subscribe to `task:completed` with `type === 'summarization'` to refresh the affected row.

- [ ] **Step 5: Commit**

```bash
git add <touched-files>
git commit -m "feat(sessions): show LLM-generated title as primary label"
```

---

## Task 15: (removed — not needed)

Earlier revisions of this plan required the renderer to query `modelDownload.isInstalled('gemma-4-e4b-summarization')` to decide whether to show a "model missing" notice in the SummaryPanel. The revised UI does not render anything when no summary is present, so the renderer does not need to know about model installation state. The server-side `ModelDownloadService.isModelInstalled(...)` is still used by `SummarizationExecutor` (Task 9b) to decide whether to skip — no IPC change needed.

Skip to Task 16.

---

## Task 16: Add summarization to Settings → Modelle section

**Files:**
- Modify: `src/renderer/src/components/settings/ModelsSettingsSection.tsx` (find actual file via `grep -rn "activeModels" src/renderer/src/components`)

- [ ] **Step 1: Render the summarization group**

Add a new group block matching the existing pattern for ASR/diarization/NER, driven by `group === 'summarization'` entries in the model catalog. Show download size, installed state, and a download button — reuse existing subcomponents.

- [ ] **Step 2: Manual smoke test**

Open Settings → Modelle. Confirm the "Zusammenfassung" group appears with the Gemma 4 E4B entry, a size indicator (~2.5 GB), and a download button when not installed.

- [ ] **Step 3: Commit**

```bash
git add <touched-files>
git commit -m "feat(settings): show summarization model group"
```

---

## Task 17: Add Gemma 4 E4B to manifest publishing + electron-builder packaging

**Files:**
- Modify: `scripts/publish-manifest.sh`
- Modify: `electron-builder.yml`

- [ ] **Step 1: Add entry to `MODELS` array in `publish-manifest.sh`**

Find the `MODELS=(` array. Add:

```
"gemma-4-e4b-summarization|<GGUF_FILENAME>|Gemma 4 E4B — Summarization|summarization/<GGUF_FILENAME>|false|summarization/<GGUF_FILENAME>"
```

Adjust field order to match the existing rows.

- [ ] **Step 2: Confirm `electron-builder.yml` packages the binary + dylibs**

Check the `extraResources` section. If `resources/bin/**` and `resources/lib/**` are not already globbed, add:

```yaml
extraResources:
  - from: resources/bin
    to: bin
    filter: ["**/*"]
  - from: resources/lib
    to: lib
    filter: ["**/*"]
```

If these globs are already present, nothing to do — `llama-cli` and its dylibs land there automatically.

- [ ] **Step 3: Smoke-test a local package build**

```bash
npm run package
```

Expected: build succeeds, DMG produced. Open the app bundle (right-click → Show Package Contents) and confirm `Contents/Resources/bin/llama-cli` + `Contents/Resources/lib/libllama*.dylib` exist.

- [ ] **Step 4: Commit**

```bash
git add scripts/publish-manifest.sh electron-builder.yml
git commit -m "feat(build): package llama-cli + register Gemma 4 E4B in manifest"
```

---

## Task 18: Update docs (CLAUDE.md + feature doc)

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/product/features/summarization.md`

- [ ] **Step 1: Extend CLAUDE.md Commands section**

Add to the command list:

```
scripts/setup-llama.sh             # Install llama.cpp binary via Homebrew → resources/bin/ + resources/lib/
scripts/setup-llama.sh --model     # Also download Gemma 4 E4B (~2.5 GB)
```

- [ ] **Step 2: Extend CLAUDE.md Architecture — ML pipeline section**

Add a fourth ML runtime:

```
4. llama.cpp subprocess — optionale Zusammenfassung über auswählbares Modell aus Katalog
   (Default: Gemma 4 E4B Q4_K_M). Registriert als letzter Schritt beider Pipeline-Chains
   (Audio + PDF). Wenn Modell nicht installiert → Executor skippt den Step geräuschlos,
   Summary bleibt NULL. Active model in electron-store (`activeModels.summarization`).
```

- [ ] **Step 3: Add a Gotcha entry**

```
- **Gemma 4 E4B GGUF source:** Community GGUF from bartowski's HuggingFace repo (no official
  GGUF from Google). If upstream rehosts or renames, update `MODEL_DEFINITIONS` URL and re-run
  `scripts/publish-manifest.sh` to mirror into R2.
```

- [ ] **Step 4: Write the feature doc**

Create `docs/product/features/summarization.md` with: purpose, model choice + rationale, prompt design, failure modes, privacy note (all local), RAM + disk cost, UI entry points.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/product/features/summarization.md
git commit -m "docs: document local LLM summarization feature"
```

---

## Task 19: End-to-end verification

- [ ] **Step 1: Full build**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
```

Expected: all green.

- [ ] **Step 2: Dev run — happy path (automatic)**

```bash
npm run dev
```

- Record or import a new session.
- Wait for the full pipeline to finish (transcription → diarization → anonymization → summarization).
- Open the session in Review Editor. Expect:
  - Header shows an auto-generated German title (h1) — **not** the date.
  - Below the title, a Zusammenfassung panel with 2 sentences, no icons, no regenerate button.
- Click the title → type → Enter → it persists (reload the app to confirm).
- Click the summary text → edit → blur → it persists.
- Clear the title to empty → blur → h1 reverts to the date fallback.

- [ ] **Step 3: Session list**

- Return to the session list. Confirm this session is listed by its auto-title (not the date) as the primary label; date + duration appear in the secondary row.
- Sessions processed before the feature was installed still show the date as primary — no regression.

- [ ] **Step 4: Dev run — concurrent session (the real RAM test)**

- Start recording/processing Session A (long enough to reach the pipeline).
- While Session A is still in pipeline, open Session B (already processed) in Review Editor and edit its summary text.
- Expect: the UI works smoothly (editing the text calls `summary:updateText` with no queue interaction). The summarization step for Session A runs after anonymization and does not collide RAM-wise with any resident pipeline model (check Activity Monitor — only one ML model resident at any time).

- [ ] **Step 5: Dev run — model not installed**

Delete `~/.therascript/models/summarization/` and restart.

- Process a new session. Verify in the main-process log: `Summarization skipped for session <id>: model not installed`. No error surfaces in UI.
- Open the session in Review Editor. Expect: h1 shows the date fallback, no SummaryPanel visible, no hint, no CTA. Feature is silent when unavailable.

- [ ] **Step 6: Dev run — empty anonymized text**

Process a session whose anonymized document is empty (edge case — e.g. a recording of only silence). Expect: executor logs skip, `title` and `summary` stay NULL, no crash.

- [ ] **Step 7: Dev run — abort mid-inference**

During the pipeline's summarization step, kill the app (Cmd+Q). Confirm no zombie `llama-cli` process remains (`ps | grep llama-cli`).

- [ ] **Step 8: Production build smoke test**

```bash
npm run package
```

Install the DMG, run the app, exercise summarization end-to-end. Confirm Metal acceleration is active (in Activity Monitor, `llama-cli` should show GPU usage briefly).

- [ ] **Step 9: Final commit (if any fixes needed)**

```bash
git commit -am "chore: summarization E2E polish"
```

---

## Risk Register

- **Gemma 4 E4B GGUF availability:** mitigated by Task 1 verification + Gemma 3 4B fallback.
- **Chat template name mismatch:** mitigated by Task 2 Step 4 smoke test — if `gemma` template fails, check `llama-cli --help` for valid values and update `buildLlamaArgs`.
- **RAM spike during Metal load:** llama.cpp Q4_K_M for a 4B model peaks around 3 GB resident. Sequential-model safety comes from the TaskQueue — summarization is registered as the last step of both pipeline chains, so it only runs after all other models have unloaded. Never add a direct IPC spawn path; the queue registration is the only supported invocation surface.
- **Prompt-injection via transcript content:** acceptable here — output is shown to the same user who owns the transcript and is never executed. No mitigation needed at this stage.
- **Quality on Swiss-German:** transcripts arrive as standard German (ASR normalizes). Summaries should be fine. If users report quality issues on Swiss-German specifics, consider a future dedicated Swiss-German prompt variant — out of scope here.
