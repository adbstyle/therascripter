import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import type { BundleModel } from '../../shared/validation/model-update-schemas'

/**
 * Modelle eines Updates bereitstellen und austauschen (Issue #167).
 *
 * Bereitgestellt wird unter models/.update/ — auf demselben Laufwerk wie die
 * Modelle, damit der Austausch beim Beenden nur Umbenennungen sind (NFR 5),
 * und ausserhalb von models/.staging, das der Start des alten Ablaufs
 * leert. Ein Download, der vor einem Neustart abbricht, läuft danach weiter.
 *
 *   .update/<sha256>/artifact.tar.gz|.bin(.partial)   Download
 *   .update/<sha256>/payload.tmp/                     Ziel beim Entpacken
 *   .update/<sha256>/payload                          fertig: Ordner bzw. Datei
 *   .update/backup/<id>/                              bisherige Fassung beim Tausch
 *
 * «Bereit» heisst: payload existiert. Der letzte Schritt dorthin ist ein
 * Umbenennen, also ist ein payload immer vollständig geprüft. Der Ordner ist
 * nach der Prüfsumme benannt; eine neue Fassung landet von selbst woanders.
 */

export const STAGE_DIR = '.update'
/** Sicherungen der bisherigen Fassungen beim Austausch (nie automatisch aufräumen). */
export const BACKUP_DIR = 'backup'

export function modelStageRoot(modelsDir: string): string {
  return join(modelsDir, STAGE_DIR)
}

export interface StagePaths {
  dir: string
  artifact: string
  payload: string
  payloadTmp: string
  final: string
  backup: string
}

type Placed = Pick<BundleModel, 'id' | 'sha256' | 'relativePath' | 'archive'>

export function stagePaths(modelsDir: string, model: Placed): StagePaths {
  const dir = join(modelStageRoot(modelsDir), model.sha256)
  return {
    dir,
    artifact: join(dir, model.archive ? 'artifact.tar.gz' : 'artifact.bin'),
    payload: join(dir, 'payload'),
    payloadTmp: join(dir, 'payload.tmp'),
    final: join(modelsDir, model.relativePath),
    backup: join(modelStageRoot(modelsDir), BACKUP_DIR, model.id)
  }
}

export function isModelStaged(modelsDir: string, model: Placed): boolean {
  return existsSync(stagePaths(modelsDir, model).payload)
}

export interface StageIo {
  download: (
    url: string,
    target: string,
    onPercent: (percent: number) => void,
    signal: AbortSignal
  ) => Promise<{ success: boolean; error?: string; sha256?: string }>
  sha256OfFile: (path: string) => Promise<string>
  extractTarGz: (archive: string, targetDir: string, signal: AbortSignal) => Promise<void>
}

/**
 * Lädt, prüft und entpackt ein Modell bis zum fertigen payload. Wirft bei
 * jedem Fehler; was schon heruntergeladen ist, bleibt für den nächsten
 * Versuch liegen (ausser eine falsche Datei).
 */
export async function stageModel(
  modelsDir: string,
  model: BundleModel,
  io: StageIo,
  onPercent: (percent: number) => void,
  signal: AbortSignal
): Promise<void> {
  const paths = stagePaths(modelsDir, model)
  if (existsSync(paths.payload)) return
  if (!model.url.startsWith('https://')) throw new Error('Download-Adresse ist nicht verschlüsselt')
  mkdirSync(paths.dir, { recursive: true })

  let sha: string
  if (existsSync(paths.artifact)) {
    sha = await io.sha256OfFile(paths.artifact)
  } else {
    const result = await io.download(model.url, paths.artifact, onPercent, signal)
    if (signal.aborted) throw new Error('Abgebrochen')
    if (!result.success) throw new Error(result.error ?? 'Download fehlgeschlagen')
    // Nach einem fortgesetzten Download fehlt die Prüfsumme aus dem Datenstrom
    sha = result.sha256 ?? (await io.sha256OfFile(paths.artifact))
  }
  if (sha !== model.sha256) {
    rmSync(paths.artifact, { force: true })
    throw new Error(`${model.label}: Datei stimmt nicht mit der signierten Beschreibung überein`)
  }

  if (model.archive) {
    rmSync(paths.payloadTmp, { recursive: true, force: true })
    mkdirSync(paths.payloadTmp)
    await io.extractTarGz(paths.artifact, paths.payloadTmp, signal)
    assertNoEscapingLinks(paths.payloadTmp)
    const inner = model.checkPath.slice(model.relativePath.length + 1)
    if (!existsSync(join(paths.payloadTmp, inner))) {
      throw new Error(`${model.label}: Archiv enthält ${model.checkPath} nicht`)
    }
    renameSync(paths.payloadTmp, paths.payload)
    rmSync(paths.artifact, { force: true })
  } else {
    renameSync(paths.artifact, paths.payload)
  }
}

/**
 * Wirft, wenn ein Archiv eine Verknüpfung auf etwas ausserhalb seines Ordners
 * enthält — ein Modell darf beim Austausch nichts anderes erreichen. Interne
 * Verknüpfungen (HuggingFace-Cache: snapshots → blobs) bleiben erlaubt.
 */
export function assertNoEscapingLinks(root: string): void {
  const base = resolve(root)
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const target = resolve(dirname(path), readlinkSync(path))
        if (target !== base && !target.startsWith(base + sep)) {
          throw new Error(`Archiv enthält eine Verknüpfung nach ausserhalb: ${name}`)
        }
      } else if (stat.isDirectory()) {
        walk(path)
      }
    }
  }
  walk(base)
}

export type Rename = (from: string, to: string) => void

/**
 * Tauscht alle Modelle ein: bisherige Fassung in die Sicherung, payload an
 * ihren Platz. Nur Umbenennungen (NFR 5). Scheitert ein Schritt, wird alles
 * zurückgetauscht und der Fehler weitergeworfen — alles oder nichts.
 */
export function swapModelsIn(
  modelsDir: string,
  models: readonly BundleModel[],
  rename: Rename = renameSync
): void {
  try {
    for (const model of models) {
      const paths = stagePaths(modelsDir, model)
      mkdirSync(dirname(paths.backup), { recursive: true })
      if (existsSync(paths.final)) rename(paths.final, paths.backup)
      mkdirSync(dirname(paths.final), { recursive: true })
      rename(paths.payload, paths.final)
    }
  } catch (err) {
    rollbackModels(modelsDir, models, rename)
    throw err
  }
}

/**
 * Macht einen (auch halben) Austausch rückgängig — allein aus dem Zustand auf
 * der Festplatte, darum auch nach einem Absturz beim nächsten Start und
 * beliebig oft. Pro Modell, rückwärts:
 *   payload fehlt, Ziel da     → das Ziel ist die neue Fassung: zurück nach payload
 *   Sicherung da, Ziel fehlt   → bisherige Fassung zurück
 * Nur für Modelle aufrufen, deren payload vor dem Austausch vollständig war.
 */
export function rollbackModels(
  modelsDir: string,
  models: readonly BundleModel[],
  rename: Rename = renameSync
): void {
  for (const model of [...models].reverse()) {
    const paths = stagePaths(modelsDir, model)
    if (!existsSync(paths.payload) && existsSync(paths.final)) rename(paths.final, paths.payload)
    if (existsSync(paths.backup) && !existsSync(paths.final)) rename(paths.backup, paths.final)
  }
}

/** Sind alle Modelle eingetauscht (payload verbraucht, Prüfpfad vorhanden)? */
export function modelsSwappedIn(modelsDir: string, models: readonly BundleModel[]): boolean {
  return models.every(
    (m) => !existsSync(stagePaths(modelsDir, m).payload) && existsSync(join(modelsDir, m.checkPath))
  )
}

/** Liegt noch eine Sicherung eines früheren Austauschs im Weg? */
export function hasLeftoverBackup(modelsDir: string, models: readonly BundleModel[]): boolean {
  return models.some((m) => existsSync(stagePaths(modelsDir, m).backup))
}

export function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
