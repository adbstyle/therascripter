import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, relative, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildSummarizationPrompt } from './summarization-prompt'
import { SUMMARIZATION_JSON_SCHEMA, SummarizationOutputSchema } from './summarization-schema'

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
    throw new Error(
      `LLM-Output enthält kein JSON-Objekt. Rohtext: ${raw.slice(0, 200)}`
    )
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

  private spawn(args: string[], signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      // ggml dlopens its backend plugins (Metal/BLAS/CPU) at runtime. libggml
      // contains a hardcoded fallback /opt/homebrew/Cellar/... search path
      // that only exists on the build host. On end-user Macs without Homebrew
      // the hardcoded path fails filesystem::exists() and ggml falls back to
      // $GGML_BACKEND_PATH — which we point at the bundle's lib/ where
      // setup-llama.sh placed libggml-*.so + libomp.dylib. On dev machines
      // both paths exist; ggml may load from either, which is harmless.
      const binaryPath = this.deps.getBinaryPath()
      const libDir = join(dirname(binaryPath), '..', 'lib')
      const child = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GGML_BACKEND_PATH: libDir }
      })
      let stdout = ''
      let stderr = ''

      const abort = (): void => {
        child.kill('SIGTERM')
        reject(new Error('Summarization aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        signal.removeEventListener('abort', abort)
        if (code === 0) resolve(stdout)
        else reject(new Error(`llama-cli exited with code ${code}: ${stderr.slice(-500)}`))
      })
    })
  }
}
