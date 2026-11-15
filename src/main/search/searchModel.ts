import { existsSync } from 'fs'
import { getSearchModelLocation } from '../services/ModelDownloadService'

/**
 * Zugriff auf das Suchmodell für Suchprozess, Vektorphase und
 * Vektorspeicher (Epic #192) — dünne Hülle um den Katalog: Ort und
 * «installiert» aus `getSearchModelLocation()` (ModelDownloadService, PR S2;
 * Ordner `SEARCH_MODEL_DIR_NAME` mit Marker `SEARCH_MODEL_READY_FILE`, in der
 * Entwicklung übersteuerbar mit THERASCRIPT_SEARCH_MODEL_DIR), Prompts,
 * Dimension und Längen aus dem `embedding`-Block des Katalogeintrags.
 * `getSearchModelLocation` liest den Eintrag auch, wenn er noch nicht
 * veröffentlicht ist (`published: false`) — ein lokal vorhandenes Modell ist
 * so trotzdem nutzbar.
 *
 * NFR-9/10: jede Indexzeile merkt sich `modelId`; ein anderes Modell macht
 * alle Vektoren veraltet.
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

/** Installiertes Suchmodell oder null. */
export function resolveSearchModel(): SearchModelInfo | null {
  const location = getSearchModelLocation()
  if (!location || !existsSync(location.readyPath)) return null
  const embedding = location.def.embedding
  if (!embedding) return null
  return {
    dir: location.dir,
    modelId: location.def.id,
    dim: embedding.dim,
    queryPrompt: embedding.queryPrompt,
    documentPrompt: embedding.documentPrompt,
    maxTokens: embedding.maxTokens,
    padMultiple: embedding.padMultiple
  }
}
