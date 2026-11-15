import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDataDir } from '../db/connection'
import { fileExists, writeFile } from '../utils/file-ops'

// Startup-Sweep für PHI-tragende Temp-Artefakte, die ein harter Crash /
// SIGKILL / Stromausfall hinterlassen kann (das reguläre finally-Cleanup der
// Services läuft dann nie). Generalisiert das Muster von
// UpdateCheckService.cleanupIncompleteUpdates auf:
//
// 1. tmpdir/therascript-stitch/ — gestitchte Speech-only-WAVs (PHI!)
// 2. tmpdir/therascript-summary-*.txt — llama-Prompt-Dateien (volles
//    Transkript als Prompt, PHI!)
// 3. <dataDir>/**/*.tmp — verwaiste writeFileAtomic-Zwischendateien
//    (Muster <name>.<pid>-<hex>.tmp); der models/-Teilbaum wird
//    übersprungen (GB-groß, bekommt nie .tmp-Writes)

export interface SweepTargets {
  stitchDir: string
  osTmpDir: string
  dataDir: string
}

const ATOMIC_TMP_PATTERN = /\.\d+-[0-9a-f]+\.tmp$/

export function sweepStaleArtifacts(targets: SweepTargets): void {
  // 1. Stitch-Verzeichnis komplett entfernen — wird von
  //    stitchSpeechSegments bei Bedarf neu angelegt.
  try {
    if (existsSync(targets.stitchDir)) {
      rmSync(targets.stitchDir, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('[StartupCleanup] Stitch-Dir-Sweep fehlgeschlagen:', err)
  }

  // 2. llama-Prompt-Dateien im OS-tmpdir
  try {
    if (existsSync(targets.osTmpDir)) {
      for (const entry of readdirSync(targets.osTmpDir)) {
        if (entry.startsWith('therascript-summary-') && entry.endsWith('.txt')) {
          try {
            unlinkSync(join(targets.osTmpDir, entry))
          } catch {
            // Datei kann zwischenzeitlich verschwunden sein
          }
        }
      }
    }
  } catch (err) {
    console.error('[StartupCleanup] Prompt-File-Sweep fehlgeschlagen:', err)
  }

  // 3. Verwaiste writeFileAtomic-Tmp-Dateien im Datenverzeichnis
  try {
    if (existsSync(targets.dataDir)) {
      sweepAtomicTmpFiles(targets.dataDir)
    }
  } catch (err) {
    console.error('[StartupCleanup] Tmp-File-Sweep fehlgeschlagen:', err)
  }
}

function sweepAtomicTmpFiles(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'models') continue // GB-groß, bekommt nie .tmp-Writes
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      sweepAtomicTmpFiles(full)
    } else if (ATOMIC_TMP_PATTERN.test(entry)) {
      try {
        unlinkSync(full)
        console.log(`[StartupCleanup] Verwaiste Tmp-Datei entfernt: ${full}`)
      } catch {
        // Datei kann zwischenzeitlich verschwunden sein
      }
    }
  }
}

/** Produktions-Einstieg: Standard-Pfade aus App-Umgebung. */
export function sweepStaleArtifactsAtStartup(): void {
  sweepStaleArtifacts({
    stitchDir: join(tmpdir(), 'therascript-stitch'),
    osTmpDir: tmpdir(),
    dataDir: getDataDir()
  })
}

// Sitzungsordner unter ~/.therascript/, deren Dateien genau einer Sitzung
// gehören und nach deren ID benannt sind (Issue #202, Postcondition 2).
export const SESSION_FILE_DIRS = [
  'audio',
  'transcripts',
  'diarization',
  'anonymized',
  'pdf',
  'extracted',
  'recovery'
] as const

// <uuid>.<ext> oder <uuid>-aligned.json — nur Dateien nach diesem Muster
// sind sicher einer Sitzung zuzuordnen, alles andere bleibt unangetastet.
const SESSION_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-aligned)?\.[a-z0-9]+$/i

/**
 * Entfernt Dateien in den Sitzungsordnern, deren Sitzung es in der Datenbank
 * nicht (mehr) gibt — Reste eines Löschens, das vor Issue #202 oder durch
 * einen Absturz zwischen Zeilen- und Datei-Löschung unvollständig blieb, oder
 * die ein abgebrochener Executor nach dem Löschen noch geschrieben hat.
 * Konservativ: nur Dateien, deren Name dem Sitzungs-Muster entspricht. Muss
 * laufen, bevor IPC-Handler eine neue Sitzung anlegen können.
 *
 * Returns the number of removed files.
 */
export function sweepOrphanedSessionFiles(dataDir: string, knownSessionIds: Set<string>): number {
  const known = new Set([...knownSessionIds].map((id) => id.toLowerCase()))
  let removed = 0
  for (const dirName of SESSION_FILE_DIRS) {
    const dir = join(dataDir, dirName)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue // Ordner fehlt — nichts zu tun
    }
    for (const entry of entries) {
      const match = SESSION_FILE_PATTERN.exec(entry)
      if (!match || known.has(match[1].toLowerCase())) continue
      const full = join(dir, entry)
      try {
        if (!statSync(full).isFile()) continue
        unlinkSync(full)
        removed++
        console.log(`[StartupCleanup] Datei einer gelöschten Sitzung entfernt: ${full}`)
      } catch (err) {
        console.error(`[StartupCleanup] Datei konnte nicht entfernt werden: ${full}`, err)
      }
    }
  }
  return removed
}

/** Hält Spotlight aus dem Datenverzeichnis heraus (PHI soll nicht indexiert werden). */
export function ensureSpotlightExclusion(): void {
  const dataDir = getDataDir()
  const markerPath = join(dataDir, '.metadata_never_index')
  if (!fileExists(markerPath)) {
    writeFile(markerPath, '', 0o600)
  }
}
