import { existsSync, unlinkSync, writeFileSync } from 'fs'

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
