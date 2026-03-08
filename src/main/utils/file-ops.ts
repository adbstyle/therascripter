import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export function removeFile(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // File may not exist — ignore
  }
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath)
}

export function writeFile(filePath: string, content: string, mode?: number): void {
  writeFileSync(filePath, content, mode !== undefined ? { mode } : undefined)
}

export function writeFileAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)
}

export type ValidateResult<T> = { ok: true; data: T } | { ok: false; error: string }

export function validateIntermediateFile<T>(filePath: string): ValidateResult<T> {
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` }
  }
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as T
    return { ok: true, data }
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
