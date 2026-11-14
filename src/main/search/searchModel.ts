import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getDataDir } from '../db/connection'

/**
 * Zugriff auf das Suchmodell (Epic #192, Bauplan Abschnitt 2) an EINER Stelle.
 *
 * Bis der Katalogeintrag `embeddinggemma-2-text` (PR S2) da ist, gelten hier
 * die Werte des Bauplans; S2 ersetzt nur das Innere von `resolveSearchModel`
 * durch den Katalog (`embedding`-Block, `checkPath`). Alles andere — Worker,
 * Vektorphase, Vektorspeicher — fragt nur diese Funktion.
 *
 * NFR-9/10: Prompts, Dimension und Länge kommen mit dem Modell; jede
 * Indexzeile merkt sich `modelId`, ein anderes Modell macht alle Vektoren
 * veraltet.
 */

export interface SearchModelInfo {
  /** Ordner des Text-Artefakts (model.safetensors, tokenizer.json, config.json). */
  dir: string
  modelId: string
  dim: number
  queryPrompt: string
  documentPrompt: string
  maxTokens: number
  padMultiple: number
}

/**
 * Ordner des Suchmodells im Modellverzeichnis — auf oberster Ebene: das
 * Update-Manifest-Schema ausgelieferter App-Versionen verwirft Archive mit
 * `/` im Pfad. PR S2 exportiert dieselbe Konstante aus dem Katalog.
 */
export const SEARCH_MODEL_RELATIVE_PATH = 'search-embeddinggemma-2-text-v1'

export const SEARCH_MODEL_DEFAULTS = {
  modelId: 'embeddinggemma-2-text',
  relativePath: SEARCH_MODEL_RELATIVE_PATH,
  readyMarker: 'READY',
  dim: 768,
  queryPrompt: 'task: search result | query: ',
  documentPrompt: 'title: none | text: ',
  maxTokens: 1024,
  padMultiple: 128
} as const

function info(dir: string): SearchModelInfo {
  const d = SEARCH_MODEL_DEFAULTS
  return {
    dir,
    modelId: d.modelId,
    dim: d.dim,
    queryPrompt: d.queryPrompt,
    documentPrompt: d.documentPrompt,
    maxTokens: d.maxTokens,
    padMultiple: d.padMultiple
  }
}

/**
 * Installiertes Suchmodell oder null. In der Entwicklung (nicht gepackt)
 * zeigt `THERASCRIPT_SEARCH_MODEL_DIR` auf ein entpacktes Artefakt; in der
 * gepackten App gilt nur das Modellverzeichnis (Marker `READY` = vollständig
 * entpackt, er liegt als letzte Datei im Archiv).
 */
export function resolveSearchModel(): SearchModelInfo | null {
  const override = process.env.THERASCRIPT_SEARCH_MODEL_DIR
  if (override && !app.isPackaged) {
    return existsSync(join(override, SEARCH_MODEL_DEFAULTS.readyMarker)) ? info(override) : null
  }
  const dir = join(getDataDir(), 'models', SEARCH_MODEL_DEFAULTS.relativePath)
  return existsSync(join(dir, SEARCH_MODEL_DEFAULTS.readyMarker)) ? info(dir) : null
}
