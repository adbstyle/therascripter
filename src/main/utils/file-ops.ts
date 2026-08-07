import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'fs'
import { randomBytes } from 'crypto'
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

/**
 * Unique tmp path per write: a fixed `.tmp` suffix let two concurrent writers
 * to the same target clobber each other's half-written temp file.
 */
export function tmpPathFor(filePath: string): string {
  return `${filePath}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
}

export function writeFileAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const tmp = tmpPathFor(filePath)
  // fsync vor dem rename: ohne Durability-Barriere kann ein Stromausfall auf
  // APFS eine 0-Byte-Datei unter dem finalen Namen hinterlassen — für den
  // Review-Save wäre das der Verlust des editierten Transkripts.
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    unlinkSync(tmp)
    throw err
  }
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
