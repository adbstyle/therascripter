import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildSummarizationPrompt } from './summarization-prompt'
import { SUMMARIZATION_JSON_SCHEMA, SummarizationOutputSchema } from './summarization-schema'
import { runSubprocess } from '../utils/subprocess'

// Unter der 600-s-Watchdog-Wall (STALL_THRESHOLDS.summarization), damit ein
// Stall hier als sauberer Graceful-Skip endet statt als Watchdog-Abort.
const LLAMA_TIMEOUT_MS = 540_000

export interface LlamaArgsInput {
  modelPath: string
  promptFilePath: string
  maxTokens: number
}

export function buildLlamaArgs(input: LlamaArgsInput): string[] {
  return [
    '-m',
    input.modelPath,
    '-f',
    input.promptFilePath,
    // Constrains token sampling so the model can ONLY emit tokens that
    // lead to a valid JSON document matching SUMMARIZATION_JSON_SCHEMA.
    // Removes the entire format-following risk class — model cannot emit
    // prose, headers, markdown, free-form German, or any non-JSON output.
    '--json-schema',
    SUMMARIZATION_JSON_SCHEMA,
    // Single-turn mode: applies the model's jinja chat template + exits
    // after one assistant response. Without this, llama-cli b8920+ either
    // skips the chat template (raw -p mode) or hangs interactively.
    '-st',
    // Explizite Context-Größe passend zu MAX_INPUT_CHARS (summarization-
    // prompt.ts) — ohne -c nutzt llama-cli 4096 und truncated still.
    '-c',
    '8192',
    '-n',
    String(input.maxTokens),
    '--temp',
    '0.3',
    '--top-p',
    '0.9',
    '--no-display-prompt',
    '-ngl',
    '999'
  ]
}

export interface SummarizeResult {
  title: string
  text: string
}

/**
 * Extracts the first balanced top-level JSON object from `raw` and validates
 * it against SummarizationOutputSchema. Robust against:
 *  - llama-cli loading-spinner ASCII (e.g. `|-\|/-\|/`) prefixing the output
 *  - chat-mode banners + `>` prompt echoes
 *  - perf-stats `[ Prompt: ... | Generation: ... ]` and `Exiting...` suffixes
 *  - braces inside string values (the scanner respects JSON string + escape
 *    semantics, so a `}` inside `"foo"` doesn't close the outer object)
 *
 * The grammar engine on llama-cli's side guarantees the model's response
 * is structurally valid JSON; this function's job is just to find the
 * substring that contains it.
 */
export function parseLlamaOutput(raw: string): SummarizeResult {
  const json = extractFirstJSONObject(raw)
  if (json === null) {
    throw new Error(`LLM-Output enthält kein JSON-Objekt. Rohtext: ${raw.slice(0, 200)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(
      `LLM-Output ist kein gültiges JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `Extrahierter Block: ${json.slice(0, 200)}`
    )
  }

  const result = SummarizationOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `LLM-Output passt nicht zum Schema: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    )
  }

  return { title: result.data.title, text: result.data.summary }
}

/**
 * Find the first balanced `{...}` block in `raw`, respecting JSON string
 * + escape semantics. Returns `null` if no balanced object is present.
 */
export function extractFirstJSONObject(raw: string): string | null {
  let depth = 0
  let start = -1
  let inString = false
  let escapeNext = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (inString) {
      if (ch === '\\') {
        escapeNext = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        return raw.slice(start, i + 1)
      }
      if (depth < 0) {
        // Unbalanced — reset and keep scanning for a real opener
        depth = 0
        start = -1
      }
    }
  }

  return null
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
      const args = buildLlamaArgs({ modelPath, promptFilePath: promptFile, maxTokens: 400 })
      const raw = await this.spawn(args, signal)
      return parseLlamaOutput(raw)
    } finally {
      await unlink(promptFile).catch(() => {})
    }
  }

  private async spawn(args: string[], signal: AbortSignal): Promise<string> {
    // ggml dlopens its backend plugins (Metal/BLAS/CPU) at runtime und findet
    // sie über den Scan des EXECUTABLE-Verzeichnisses — setup-llama.sh legt
    // die libggml-*.so deshalb neben llama-cli in bin/. KEIN
    // GGML_BACKEND_PATH setzen: diese ggml-Generation dlopent den Wert als
    // einzelne Datei (nicht als Suchverzeichnis) — der frühere Env-Override
    // war wirkungslos und wurde auf Dev-Macs nur vom Homebrew-Cellar-
    // Fallback (/opt/homebrew/Cellar/ggml/<ver>/libexec) maskiert; auf
    // Endnutzer-Macs lud er null Backends und die Summarization skippte
    // still (live nachgestellt, nachdem ein brew upgrade den Fallback vom
    // Dev-Mac entfernt hatte).
    const binaryPath = this.deps.getBinaryPath()

    const result = await runSubprocess({
      bin: binaryPath,
      args,
      signal,
      // Erstmals ein echter Timeout: vorher war die einzige Grenze der
      // ProcessWatchdog (600 s Wall ohne Heartbeat, da summarize() keine
      // Progress-Callbacks liefert). Knapp darunter, damit der Fehler hier
      // sauber als Skip landet statt als Watchdog-Abort.
      timeoutMs: LLAMA_TIMEOUT_MS
    })

    if (result.aborted) {
      throw new Error('Summarization aborted')
    }
    if (result.timedOut) {
      throw new Error(
        `llama-cli Timeout nach ${Math.round(LLAMA_TIMEOUT_MS / 1000)}s — Zusammenfassung übersprungen`
      )
    }
    if (result.code !== 0) {
      throw new Error(`llama-cli exited with code ${result.code}: ${result.stderr.slice(-500)}`)
    }
    return result.stdout
  }
}
