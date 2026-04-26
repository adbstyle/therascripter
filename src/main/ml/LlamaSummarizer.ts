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
    '-m',
    input.modelPath,
    '-f',
    input.promptFilePath,
    '--chat-template',
    'gemma',
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

export function parseLlamaOutput(raw: string): SummarizeResult {
  const cleaned = raw
    .replace(/\[end of text\]\s*$/i, '')
    .replace(/llama_print_timings[\s\S]*$/i, '')
    .trim()

  const titleMatch = cleaned.match(/^\s*titel\s*:\s*(.+?)\s*$/im)

  // Capture ZUSAMMENFASSUNG as everything after the label until end-of-string.
  // No /m flag — a two-sentence summary may span multiple lines.
  const sumLabelIdx = cleaned.search(/(^|\n)\s*zusammenfassung\s*:/i)
  let summary = ''
  if (sumLabelIdx >= 0) {
    const sliced = cleaned
      .slice(sumLabelIdx)
      .replace(/^\s*\n?/, '')
      .replace(/^\s*zusammenfassung\s*:\s*/i, '')
    summary = sliced.replace(/\s*\n\s*/g, ' ').trim()
  }

  if (!titleMatch || summary.length === 0) {
    throw new Error(
      `Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt. Rohtext: ${cleaned.slice(0, 200)}`
    )
  }

  return {
    title: titleMatch[1].trim(),
    text: summary
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
