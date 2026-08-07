import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getDataDir } from '../db/connection'

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
