# Multi-Whisper-ASR-Modelle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mehrere Whisper-ASR-Modelle als auswählbare Alternativen anbieten (initial: bestehendes multilinguales Turbo + Swiss-German-Fine-Tune von Flurin17), mit On-Demand-Download, Delete und Active-Selection via Settings-Tab "Modelle".

**Architecture:** ASR-Modelle werden als Katalog modelliert (mehrere Definitionen, dieselbe `engineType: 'whisper'`), pyannote + flair bleiben Pflicht-Modelle. `activeModels.transcription` aus electron-store (bereits vorhanden) steuert welches Modell `WhisperService` lädt. First-Launch lädt nur Pflicht-Modelle + das aktive ASR-Modell. Settings-UI listet installierte und verfügbare ASR-Modelle mit Download/Delete/Activate-Aktionen. Update-Check prüft nur installierte Modelle.

**Tech Stack:** Electron 30+, TypeScript strict, React 19, Tailwind v4, better-sqlite3, electron-store, whisper.cpp (subprocess), Zod-IPC-Validierung, Vitest.

---

## File Structure

**Create:**
- `scripts/convert-hf-whisper.sh` — Shell-Script: HuggingFace-Modell → ggml → Quantisierung
- `src/main/ipc/model-catalog-handlers.ts` — IPC-Handler für Single-Model-Ops (download/delete/setActive/list)
- `src/renderer/src/components/settings/ModelsSettings.tsx` — Inhalt des "Modelle"-Tabs
- `src/renderer/src/components/settings/AsrModelCard.tsx` — Einzelne ASR-Modell-Karte
- `src/renderer/src/components/settings/RequiredModelRow.tsx` — Read-only Info-Zeile für Pflicht-Modelle
- `src/shared/validation/model-catalog-schemas.ts` — Zod-Schemas für Catalog-IPC
- `src/main/services/__tests__/ModelDownloadService.test.ts` — Unit-Tests für reine Funktionen

**Modify:**
- `src/main/services/ModelDownloadService.ts` — `ModelDefinition` erweitern, neue Funktionen, Swiss-German im Katalog
- `src/main/ml/WhisperService.ts:38` — `getModelPath()` auf aktives Modell umstellen
- `src/main/services/UpdateCheckService.ts:107` — Updates nur für installierte Modelle prüfen
- `src/main/index.ts` — neuen IPC-Handler registrieren
- `src/preload/index.ts:102` — `modelCatalog`-API ergänzen
- `src/shared/types/IpcApi.ts` — Typen für neue IPC-Methoden
- `src/renderer/src/views/Settings.tsx:43-49` — Placeholder durch `<ModelsSettings />` ersetzen
- `scripts/publish-manifest.sh:72-76` — Multi-ASR-Einträge im Manifest
- `docs/product/MODELS.md` oder vergleichbar — Release-Flow + Modell-Registrierung dokumentieren

---

## Task 1: `ModelDefinition` um ASR-Katalog-Felder erweitern

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:10-23`

- [ ] **Step 1: Typdefinition erweitern**

In `ModelDownloadService.ts` ab Zeile 10 `ModelDefinition` anpassen — neue optionale Felder für die UI und zur Kategorisierung:

```ts
export type ModelGroup = 'asr' | 'diarization' | 'ner'

export interface ModelDefinition {
  id: string
  label: string
  url: string
  sizeBytes: number
  sha256: string
  // For flat files: relative path to the final file (e.g., 'asr/ggml-large-v3-turbo-q5_0.bin')
  // For archives: relative path of the extraction directory (e.g., 'diarization')
  relativePath: string
  // If true, download is a tar.gz that needs extraction into relativePath
  archive?: boolean
  // Path to check for existence (relative to modelsDir). Used by checkModelsExist().
  checkPath: string
  // Gruppe — ASR-Modelle sind auswählbar, diarization/ner sind Pflicht.
  // Optional in Task 1, damit bestehende MODEL_DEFINITIONS noch compilen.
  // In Task 2 bei allen Einträgen gesetzt — danach könnte man `group` auf required
  // engziehen, tun wir aber nicht (kein Vorteil, Breaking-Change für externe Consumer).
  group?: ModelGroup
  // Wenn true, wird das Modell beim First-Launch automatisch geladen und kann nicht gelöscht werden.
  // Default (undefined) = false.
  isRequired?: boolean
  // Nur für ASR: optionale UI-Metadaten
  description?: string
  languages?: string[] // BCP-47 Codes ('de-CH', 'de', 'multi', ...)
  accuracyScore?: number // 0.0–1.0
  speedScore?: number // 0.0–1.0
}
```

**Warum optional:** Wenn `group` und `isRequired` required wären, würde der Build zwischen Task 1 und Task 2 brechen (bestehende drei `MODEL_DEFINITIONS`-Einträge haben die Felder noch nicht). Optional → Task 1 ist für sich grün, Task 2 füllt alle Einträge vollständig aus. In den Query-Helpers (Task 4) werden fehlende Werte defensiv auf `false`/keine Gruppe gemappt.

- [ ] **Step 2: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS. Nächste Schritte füllen die neuen Felder für bestehende Einträge und fügen das Swiss-German-Modell hinzu.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: extend ModelDefinition with group and ASR metadata fields"
```

---

## Task 2: Bestehende Modelle mit neuen Feldern annotieren

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:45-75`

- [ ] **Step 1: `MODEL_DEFINITIONS` ergänzen — alle drei Einträge mit `group` + `isRequired`, ASR-Eintrag mit UI-Metadaten**

```ts
const MODEL_DEFINITIONS: ModelDefinition[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo (Multilingual)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    group: 'asr',
    isRequired: false,
    description:
      'Schnelles multilinguales Modell. Empfohlen wenn Schweizerdeutsch im Dialekt eher moderat ist oder wenn Aufnahmen auch andere Sprachen enthalten.',
    languages: ['multi'],
    accuracyScore: 0.8,
    speedScore: 0.9
  },
  {
    id: 'pyannote-community-1',
    label: 'Sprechererkennung (pyannote-community-1)',
    url: `${R2_CDN}/pyannote-models.tar.gz`,
    relativePath: 'diarization',
    checkPath: 'diarization/models--pyannote--speaker-diarization-3.1',
    sizeBytes: 30_461_603,
    sha256: 'b42e8aee7cf5eb330f4d5519216f9035dc1defad871097977fa9cecc11edb570',
    archive: true,
    group: 'diarization',
    isRequired: true
  },
  {
    id: 'flair-ner-german-large',
    label: 'Anonymisierung (flair-ner-german-large)',
    url: `${R2_CDN}/flair-ner-german-large.tar.gz`,
    relativePath: 'ner',
    checkPath: 'ner/models/ner-german-large',
    sizeBytes: 1_741_705_466,
    sha256: 'a34f6315659a34991930dae5d7a2bc2f3ee24ff6eb70dcd4d41e3aca7a5253e6',
    archive: true,
    group: 'ner',
    isRequired: true
  }
]
```

**Hinweis:** Das bestehende Turbo-Modell hat bewusst `isRequired: false` — bei First-Launch wird aber via `activeModels.transcription` (Default `'whisper-large-v3-turbo'`) garantiert, dass mindestens dieses Modell geladen wird. Siehe Task 5.

- [ ] **Step 2: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: annotate existing model definitions with group and ASR metadata"
```

---

## Task 3: Swiss-German-Modell im Katalog registrieren (Platzhalter-Hash)

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:45-…` (`MODEL_DEFINITIONS`)

**Begründung:** Das konvertierte Modell wird später via Task 16 gebaut und auf R2 hochgeladen. Bis dahin steht der Hash auf einem Platzhalter — der Download würde scheitern, aber der Katalog ist testbar. Nach Upload wird der Hash in einem separaten Commit nachgezogen.

- [ ] **Step 1: Swiss-German-Eintrag zu `MODEL_DEFINITIONS` hinzufügen** (nach dem Turbo-Eintrag, vor pyannote)

```ts
  {
    id: 'whisper-large-v3-turbo-swiss',
    label: 'Whisper Large V3 Turbo (Swiss-German)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-swiss-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    sizeBytes: 0, // TBD: wird nach Konvertierung in Task 16 aus r2-upload/ gesetzt
    sha256: 'PENDING_UPLOAD', // TBD: wird nach Konvertierung in Task 16 gesetzt
    group: 'asr',
    isRequired: false,
    description:
      'Feinabgestimmtes Modell (Basis: Flurin17/whisper-large-v3-turbo-swiss-german) — höhere Genauigkeit bei Schweizerdeutsch-Dialekten, Kosten: grösser und spezifisch deutsch/schweizerdeutsch.',
    languages: ['de-CH', 'de'],
    accuracyScore: 0.9,
    speedScore: 0.85
  },
```

- [ ] **Step 2: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "feat: register swiss-german whisper model in catalog (placeholder hash)"
```

---

## Task 4: Query-Helpers + Active-Model-Lookup

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts` (nach `getModelDefinitions`, ca. Zeile 81)
- Test: `src/main/services/__tests__/ModelDownloadService.test.ts` (neu)

- [ ] **Step 1: Failing Test schreiben** — Datei `src/main/services/__tests__/ModelDownloadService.test.ts` anlegen:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import {
  getAsrModels,
  getRequiredModels,
  getModelById,
  getModelsToLoadOnFirstLaunch
} from '../ModelDownloadService'
import { initSettings } from '../SettingsService'

// Settings müssen initialisiert sein, weil spätere deleteModel/setActiveAsrModel-Tests
// via getSettings() drauf zugreifen. Auch vorab OK, kostet wenig.
beforeAll(() => {
  initSettings()
})

describe('ModelDownloadService catalog helpers', () => {
  it('getAsrModels returns all models with group="asr"', () => {
    const asrs = getAsrModels()
    expect(asrs.length).toBeGreaterThanOrEqual(2)
    expect(asrs.every((m) => m.group === 'asr')).toBe(true)
  })

  it('getRequiredModels returns pyannote and flair but no asr', () => {
    const required = getRequiredModels()
    expect(required.map((m) => m.id).sort()).toEqual([
      'flair-ner-german-large',
      'pyannote-community-1'
    ])
  })

  it('getModelById returns definition or null', () => {
    expect(getModelById('whisper-large-v3-turbo')?.group).toBe('asr')
    expect(getModelById('does-not-exist')).toBeNull()
  })

  it('getModelsToLoadOnFirstLaunch returns required + activeAsrId', () => {
    const loaded = getModelsToLoadOnFirstLaunch('whisper-large-v3-turbo')
    const ids = loaded.map((m) => m.id).sort()
    expect(ids).toEqual([
      'flair-ner-german-large',
      'pyannote-community-1',
      'whisper-large-v3-turbo'
    ])
  })

  it('getModelsToLoadOnFirstLaunch falls back gracefully on unknown activeAsrId', () => {
    const loaded = getModelsToLoadOnFirstLaunch('nonexistent')
    // Nur required — ASR darf nicht versucht werden, wenn unbekannt
    expect(loaded.map((m) => m.id).sort()).toEqual([
      'flair-ner-german-large',
      'pyannote-community-1'
    ])
  })
})
```

- [ ] **Step 2: Test ausführen (soll fehlschlagen)**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: FAIL — `getAsrModels is not a function` (Symbole noch nicht exportiert).

- [ ] **Step 3: Implementierung in `ModelDownloadService.ts` ergänzen** (nach bestehendem `getModelDefinitions`):

```ts
export function getAsrModels(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.group === 'asr')
}

export function getRequiredModels(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.isRequired === true)
}

export function getModelById(id: string): ModelDefinition | null {
  return MODEL_DEFINITIONS.find((m) => m.id === id) ?? null
}

/**
 * Modelle, die auf First-Launch heruntergeladen werden müssen:
 * alle required + das aktive ASR-Modell (falls gültig).
 */
export function getModelsToLoadOnFirstLaunch(activeAsrId: string): ModelDefinition[] {
  const required = getRequiredModels()
  const active = getModelById(activeAsrId)
  if (active && active.group === 'asr') {
    // Duplikate vermeiden (required hat keine ASR, aber defensiv)
    return [...required, active].filter(
      (m, i, arr) => arr.findIndex((x) => x.id === m.id) === i
    )
  }
  return required
}

/**
 * Prüft, ob die Minimal-Menge (required + aktives ASR) installiert ist.
 * Ersatz für checkModelsExist(), das alle Modelle erwartete.
 */
export function checkRequiredAndActiveAsrExist(activeAsrId: string): boolean {
  const modelsDir = getModelsDir()
  const toCheck = getModelsToLoadOnFirstLaunch(activeAsrId)
  return toCheck.every((m) => existsSync(join(modelsDir, m.checkPath)))
}

/**
 * Prüft, ob ein einzelnes Modell installiert ist (für UI-Status).
 */
export function isModelInstalled(id: string): boolean {
  const def = getModelById(id)
  if (!def) return false
  return existsSync(join(getModelsDir(), def.checkPath))
}
```

- [ ] **Step 4: Test erneut ausführen**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: PASS (alle 5 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/ModelDownloadService.ts src/main/services/__tests__/ModelDownloadService.test.ts
git commit -m "feat: add catalog query helpers (getAsrModels, getModelById, etc)"
```

---

## Task 5: `checkModelsExist` an Active-ASR-Logik koppeln

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:87-93` (`checkModelsExist`)
- Modify: Aufrufer von `checkModelsExist` in `src/main/ipc/model-download-handlers.ts:16` und `src/main/index.ts` (falls dort aufgerufen)

**Begründung:** `checkModelsExist` prüfte bisher, ob *alle* drei Modelle installiert sind — das stimmt nicht mehr, sobald es optionale ASR-Alternativen gibt. Die Semantik ändert sich zu "Pflicht-Modelle + aktives ASR-Modell vorhanden".

- [ ] **Step 1: `checkModelsExist` in `ModelDownloadService.ts` ersetzen**

Zeilen 87–93 durch diese Version ersetzen:

```ts
export function checkModelsExist(): boolean {
  const activeAsrId = getSettings().get('activeModels').transcription
  return checkRequiredAndActiveAsrExist(activeAsrId)
}
```

(Import von `getSettings` steht bereits in Zeile 5.)

- [ ] **Step 2: `getOverallModelSize` + `getAlreadyDownloadedBytes` auf "zu-ladende" Menge umstellen**

Diese beiden Helpers werden vom First-Launch-Progress genutzt. Sie müssen jetzt nur die Modelle zählen, die tatsächlich geladen werden (required + aktives ASR), sonst stimmt die 0%/100%-Skala nicht. Zeilen 95–116 ersetzen:

```ts
export function getModelsToLoad(): ModelDefinition[] {
  const activeAsrId = getSettings().get('activeModels').transcription
  return getModelsToLoadOnFirstLaunch(activeAsrId)
}

export function getOverallModelSize(): number {
  return getModelsToLoad().reduce((sum, m) => sum + m.sizeBytes, 0)
}

export function getAlreadyDownloadedBytes(): number {
  const modelsDir = getModelsDir()
  let total = 0
  for (const model of getModelsToLoad()) {
    const checkTarget = join(modelsDir, model.checkPath)
    if (existsSync(checkTarget)) {
      total += model.sizeBytes
    } else if (!model.archive) {
      const partialPath = join(modelsDir, model.relativePath) + '.partial'
      if (existsSync(partialPath)) {
        total += statSync(partialPath).size
      }
    }
  }
  return total
}
```

- [ ] **Step 3: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: scope model existence checks to required + active asr model"
```

---

## Task 6: `startModelDownload` auf First-Launch-Menge umstellen

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:125-237` (`startModelDownload`)

**Begründung:** Die Schleife geht bislang über alle `MODEL_DEFINITIONS`. Das zieht bei 2+ ASR-Einträgen auch optionale Modelle rein. Ersatz: `getModelsToLoad()`.

- [ ] **Step 1: Schleifenziel austauschen**

In `startModelDownload` Zeile 133 ändern:

```ts
  for (const model of getModelsToLoad()) {
```

statt

```ts
  for (const model of MODEL_DEFINITIONS) {
```

Alle anderen Zeilen in `startModelDownload` bleiben. `getOverallModelSize()` stimmt durch Task 5 bereits.

- [ ] **Step 2: Manuell gegenlesen**

Die Schleife darf nicht mehr auf `MODEL_DEFINITIONS` zugreifen — sonst wird ein optionales Swiss-German bei First-Launch versehentlich mitgeladen.

Run: `grep -n "MODEL_DEFINITIONS" src/main/services/ModelDownloadService.ts`
Expected: Nur noch die Declaration-Zeile (45) + die Query-Helper-Funktionen (`getAsrModels`, `getRequiredModels`, `getModelById`). Kein direkter Zugriff aus `startModelDownload`, `getOverallModelSize`, `getAlreadyDownloadedBytes` mehr.

- [ ] **Step 3: Build-Check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: scope first-launch download to required + active asr model"
```

---

## Task 7: Single-Model-Download-Funktion

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts` (neue Funktion am Ende vor den Exports)

- [ ] **Step 1: Failing Test für Happy-Path-Validation (nur Argument-Validierung, kein echter HTTP-Download)**

In `src/main/services/__tests__/ModelDownloadService.test.ts` anhängen:

```ts
import { downloadSingleModel } from '../ModelDownloadService'

describe('downloadSingleModel', () => {
  it('throws when model id is unknown', async () => {
    await expect(downloadSingleModel('does-not-exist')).rejects.toThrow(
      /unbekanntes Modell/i
    )
  })

  it('throws when model is not in group "asr"', async () => {
    await expect(downloadSingleModel('pyannote-community-1')).rejects.toThrow(
      /nur ASR-Modelle/i
    )
  })
})
```

- [ ] **Step 2: Test ausführen**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: FAIL — `downloadSingleModel is not a function`.

- [ ] **Step 3: `downloadSingleModel` implementieren**

Nach der bestehenden `abortModelDownload`-Funktion (ca. Zeile 239) anhängen:

```ts
/**
 * Lädt ein einziges ASR-Modell herunter (nicht für Pflicht-Modelle gedacht —
 * die laufen via startModelDownload auf First-Launch).
 *
 * Sendet denselben `modelDownload:status`-Channel wie startModelDownload,
 * damit die bestehende UI-Progress-Anzeige wiederverwendbar bleibt.
 */
export async function downloadSingleModel(id: string): Promise<void> {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Download: unbekanntes Modell "${id}"`)
  }
  if (def.group !== 'asr') {
    throw new Error(`Download: nur ASR-Modelle sind einzeln ladbar (id=${id})`)
  }

  if (abortSignal && !abortSignal.aborted) {
    throw new Error('Download: bereits aktiv — zuerst abbrechen')
  }

  abortSignal = { aborted: false }
  const modelsDir = getModelsDir()
  const checkTarget = join(modelsDir, def.checkPath)

  if (existsSync(checkTarget)) {
    sendProgress({ state: 'complete' })
    abortSignal = null
    return
  }

  const targetPath = def.archive
    ? join(modelsDir, `${def.id}.tar.gz`)
    : join(modelsDir, def.relativePath)

  const result = await downloadFile(
    def.url,
    targetPath,
    (progress) => {
      sendProgress({
        state: 'downloading',
        progress: {
          currentModel: def.id,
          currentModelLabel: def.label,
          currentModelProgress: progress.percent,
          currentModelDownloaded: progress.downloadedBytes,
          currentModelTotal: progress.totalBytes,
          overallDownloaded: progress.downloadedBytes,
          overallTotal: def.sizeBytes,
          overallPercent: progress.percent
        }
      })
    },
    abortSignal
  )

  if (!result.success) {
    sendProgress({
      state: 'error',
      error: result.error ?? 'Download fehlgeschlagen',
      modelId: def.id
    })
    abortSignal = null
    throw new Error(result.error ?? 'Download fehlgeschlagen')
  }

  sendProgress({ state: 'verifying', modelId: def.id })
  const valid = await verifyFileSha256(targetPath, def.sha256)
  if (!valid) {
    try {
      unlinkSync(targetPath)
    } catch {
      /* non-fatal */
    }
    sendProgress({
      state: 'error',
      error: `SHA-256-Prüfung fehlgeschlagen für ${def.label}`,
      modelId: def.id
    })
    abortSignal = null
    throw new Error(`SHA-256-Prüfung fehlgeschlagen für ${def.label}`)
  }

  if (def.archive) {
    sendProgress({ state: 'extracting', modelId: def.id })
    const extractDir = join(modelsDir, def.relativePath)
    mkdirSync(extractDir, { recursive: true })
    const extractResult = await extractTarGz(targetPath, extractDir)
    if (!extractResult.success) {
      try {
        unlinkSync(targetPath)
      } catch {
        /* non-fatal */
      }
      sendProgress({
        state: 'error',
        error: extractResult.error ?? 'Entpacken fehlgeschlagen',
        modelId: def.id
      })
      abortSignal = null
      throw new Error(extractResult.error ?? 'Entpacken fehlgeschlagen')
    }
  }

  sendProgress({ state: 'complete' })
  abortSignal = null
}
```

- [ ] **Step 4: Test erneut ausführen**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/ModelDownloadService.ts src/main/services/__tests__/ModelDownloadService.test.ts
git commit -m "feat: add downloadSingleModel for on-demand ASR downloads"
```

---

## Task 8: Single-Model-Delete-Funktion

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts`

- [ ] **Step 1: Failing Test anhängen**

```ts
import { deleteModel } from '../ModelDownloadService'

describe('deleteModel', () => {
  it('throws when model id is unknown', async () => {
    await expect(deleteModel('does-not-exist')).rejects.toThrow(/unbekanntes Modell/i)
  })

  it('throws when model is required', async () => {
    await expect(deleteModel('pyannote-community-1')).rejects.toThrow(
      /Pflicht-Modell/i
    )
  })

  it('throws when attempting to delete the active asr model', async () => {
    // Default ist 'whisper-large-v3-turbo' — das ist aktiv
    await expect(deleteModel('whisper-large-v3-turbo')).rejects.toThrow(
      /aktiv/i
    )
  })
})
```

- [ ] **Step 2: Test ausführen**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: FAIL — `deleteModel is not a function`.

(Der `beforeAll(() => initSettings())`-Hook aus Task 4 deckt schon ab, dass `getSettings()` hier funktioniert.)

- [ ] **Step 3: `deleteModel` implementieren**

Nach `downloadSingleModel`:

```ts
import { rmSync } from 'fs'
// ^ ergänzen zu den bestehenden fs-Imports in Zeile 1

export async function deleteModel(id: string): Promise<void> {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Löschen: unbekanntes Modell "${id}"`)
  }
  if (def.isRequired) {
    throw new Error(`Löschen: "${def.label}" ist ein Pflicht-Modell und nicht löschbar`)
  }

  const settings = getSettings()
  const activeAsr = settings.get('activeModels').transcription
  if (activeAsr === id) {
    throw new Error(
      `Löschen: "${def.label}" ist aktuell aktiv. Zuerst anderes Modell aktivieren.`
    )
  }

  const modelsDir = getModelsDir()
  const target = join(modelsDir, def.checkPath)
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }
  // Archiv-Rest (tar.gz) ebenfalls wegräumen, falls liegengeblieben
  const archivePath = join(modelsDir, `${def.id}.tar.gz`)
  if (existsSync(archivePath)) {
    try {
      unlinkSync(archivePath)
    } catch {
      /* non-fatal */
    }
  }

  // installedModelVersions-Eintrag entfernen (Update-Check soll dieses Modell nicht mehr betrachten)
  const installed = { ...settings.get('installedModelVersions') }
  delete installed[id]
  settings.set('installedModelVersions', installed)
}
```

- [ ] **Step 4: Test erneut ausführen**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/ModelDownloadService.ts src/main/services/__tests__/ModelDownloadService.test.ts
git commit -m "feat: add deleteModel with guards for required + active models"
```

---

## Task 9: Active-ASR-Setter

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts`

- [ ] **Step 1: Failing Test anhängen**

```ts
import { setActiveAsrModel } from '../ModelDownloadService'

describe('setActiveAsrModel', () => {
  it('throws when model id is unknown', () => {
    expect(() => setActiveAsrModel('nope')).toThrow(/unbekanntes Modell/i)
  })

  it('throws when model is not asr group', () => {
    expect(() => setActiveAsrModel('pyannote-community-1')).toThrow(/keine ASR/i)
  })

  it('throws when model is not installed', () => {
    // Swiss-German ist im Katalog, aber nicht auf Disk vorhanden
    expect(() => setActiveAsrModel('whisper-large-v3-turbo-swiss')).toThrow(
      /nicht installiert/i
    )
  })
})
```

- [ ] **Step 2: Test ausführen**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: FAIL — `setActiveAsrModel is not a function`.

- [ ] **Step 3: Implementieren**

```ts
export function setActiveAsrModel(id: string): void {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Aktivieren: unbekanntes Modell "${id}"`)
  }
  if (def.group !== 'asr') {
    throw new Error(`Aktivieren: "${def.label}" ist keine ASR-Engine`)
  }
  if (!isModelInstalled(id)) {
    throw new Error(`Aktivieren: "${def.label}" ist nicht installiert`)
  }
  const settings = getSettings()
  const current = settings.get('activeModels')
  settings.set('activeModels', { ...current, transcription: id })
}
```

- [ ] **Step 4: Test erneut ausführen**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/ModelDownloadService.ts src/main/services/__tests__/ModelDownloadService.test.ts
git commit -m "feat: add setActiveAsrModel with install/group guards"
```

---

## Task 10: `WhisperService.getModelPath` auf aktives Modell umstellen

**Files:**
- Modify: `src/main/ml/WhisperService.ts:38-40`

- [ ] **Step 1: Imports ergänzen** — oben in `WhisperService.ts` nach den bestehenden Imports:

```ts
import { getSettings } from '../services/SettingsService'
import { getModelById } from '../services/ModelDownloadService'
```

- [ ] **Step 2: `getModelPath` ersetzen** (Zeilen 38–40)

```ts
  private getModelPath(): string {
    const activeAsrId = getSettings().get('activeModels').transcription
    const def = getModelById(activeAsrId)
    if (!def) {
      throw new Error(
        `WhisperService: aktives ASR-Modell "${activeAsrId}" nicht im Katalog registriert.`
      )
    }
    return join(getDataDir(), 'models', def.relativePath)
  }
```

- [ ] **Step 3: Build + Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manueller Smoke-Test — bestehendes Default-Modell muss weiter funktionieren**

Run: `npm run dev`
- App starten
- Session aufnehmen (kurz, ~30 s reicht) → transkribieren
- Expected: Transkription läuft unverändert mit Turbo-Multilingual durch

- [ ] **Step 5: Commit**

```bash
git add src/main/ml/WhisperService.ts
git commit -m "refactor: resolve whisper model path via active ASR setting"
```

---

## Task 11: `UpdateCheckService` auf installierte Modelle beschränken

**Files:**
- Modify: `src/main/services/UpdateCheckService.ts:107-145`

**Begründung:** Heute lädt `UpdateCheckService` jedes Modell im Manifest zum Update vor, wenn sein Hash von `installedVersions` abweicht. Bei nicht installiertem Swiss-German-Modell ist `installedVersions[id]` leer → Service würde unnötig zum Download auffordern. Fix: nur Modelle updaten, die bereits installiert sind.

- [ ] **Step 1: `isModelInstalled`-Import ergänzen**

In `UpdateCheckService.ts` Zeile 6:

```ts
import { getModelDefinitions, getModelsDir, isModelInstalled } from './ModelDownloadService'
```

- [ ] **Step 2: Schleife anpassen** (Zeilen 107–145)

Die Schleife im `checkForUpdates` so ändern, dass sie optionale/nicht installierte Modelle überspringt:

```ts
    for (const manifestModel of manifest.models) {
      // Path-traversal guard on id
      if (manifestModel.id.includes('..') || manifestModel.id.includes('/')) {
        console.warn(`UpdateCheckService: suspicious model id skipped: ${manifestModel.id}`)
        continue
      }

      // Find structural info from local MODEL_DEFINITIONS
      const definition = definitions.find((d) => d.id === manifestModel.id)
      if (!definition) {
        console.warn(`UpdateCheckService: unknown model id in manifest: ${manifestModel.id}`)
        continue
      }

      // Nur Modelle updaten, die bereits installiert sind —
      // optionale ASR-Alternativen ohne Install werden nicht als "Update verfügbar" beworben.
      if (!isModelInstalled(manifestModel.id)) {
        continue
      }

      const installed = installedVersions[manifestModel.id]
      if (installed && installed.sha256 === manifestModel.sha256) {
        continue // Already up to date
      }

      // Path-traversal guard on relativePath
      if (definition.relativePath.includes('..')) {
        console.warn(
          `UpdateCheckService: suspicious relativePath skipped: ${definition.relativePath}`
        )
        continue
      }

      modelUpdates.push({
        id: manifestModel.id,
        version: manifestModel.version,
        label: manifestModel.label,
        url: manifestModel.url,
        sha256: manifestModel.sha256,
        sizeBytes: manifestModel.sizeBytes,
        relativePath: definition.relativePath,
        archive: definition.archive,
        checkPath: definition.checkPath
      })
    }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/UpdateCheckService.ts
git commit -m "refactor: skip update check for non-installed optional models"
```

---

## Task 12: Zod-Schemas für neue IPC

**Files:**
- Create: `src/shared/validation/model-catalog-schemas.ts`

- [ ] **Step 1: Datei neu anlegen**

```ts
import { z } from 'zod'

export const ModelGroupSchema = z.enum(['asr', 'diarization', 'ner'])

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string(),
  description: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  group: ModelGroupSchema,
  isRequired: z.boolean(),
  languages: z.array(z.string()).optional(),
  accuracyScore: z.number().min(0).max(1).optional(),
  speedScore: z.number().min(0).max(1).optional(),
  isInstalled: z.boolean(),
  isActive: z.boolean()
})

export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

export const ModelIdPayloadSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/i, 'nur a-z, 0-9 und Bindestrich erlaubt')
})
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/validation/model-catalog-schemas.ts
git commit -m "feat: add zod schemas for model catalog ipc"
```

---

## Task 13: IPC-Handler `model-catalog-handlers.ts`

**Files:**
- Create: `src/main/ipc/model-catalog-handlers.ts`
- Modify: `src/main/index.ts` (Handler registrieren)

- [ ] **Step 1: Handler-Datei anlegen**

`src/main/ipc/model-catalog-handlers.ts`:

```ts
import { ipcMain } from 'electron'
import { z } from 'zod'
import { getSettings } from '../services/SettingsService'
import {
  abortModelDownload,
  deleteModel,
  downloadSingleModel,
  getAsrModels,
  getModelById,
  isModelInstalled,
  setActiveAsrModel
} from '../services/ModelDownloadService'
import {
  ModelIdPayloadSchema,
  type ModelCatalogEntry
} from '../../shared/validation/model-catalog-schemas'

function buildCatalogEntries(): ModelCatalogEntry[] {
  const activeAsr = getSettings().get('activeModels').transcription
  return getAsrModels().map((def) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    sizeBytes: def.sizeBytes,
    group: def.group,
    isRequired: def.isRequired,
    languages: def.languages,
    accuracyScore: def.accuracyScore,
    speedScore: def.speedScore,
    isInstalled: isModelInstalled(def.id),
    isActive: def.id === activeAsr
  }))
}

function validate<T>(schema: z.ZodType<T>, payload: unknown, channel: string): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`IPC ${channel}: ungültige Argumente: ${parsed.error.message}`)
  }
  return parsed.data
}

export function registerModelCatalogHandlers(): void {
  ipcMain.handle('modelCatalog:listAsr', () => {
    return buildCatalogEntries()
  })

  ipcMain.handle('modelCatalog:download', async (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:download')
    await downloadSingleModel(id)
    return buildCatalogEntries()
  })

  ipcMain.handle('modelCatalog:delete', async (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:delete')
    await deleteModel(id)
    return buildCatalogEntries()
  })

  ipcMain.handle('modelCatalog:setActive', (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:setActive')
    setActiveAsrModel(id)
    return buildCatalogEntries()
  })

  // Cancel läuft gegen dasselbe abortSignal-Singleton, das auch downloadSingleModel nutzt —
  // funktioniert für laufende Downloads, egal ob via First-Launch oder Catalog-API gestartet.
  ipcMain.handle('modelCatalog:cancelDownload', () => {
    abortModelDownload()
  })
}
```

- [ ] **Step 2: Handler in `main/index.ts` registrieren**

`grep -n "registerModelDownloadHandlers" src/main/index.ts` → dort direkt darunter:

```ts
import { registerModelCatalogHandlers } from './ipc/model-catalog-handlers'
```

Und in der `app.whenReady()`-Callback-Sequenz, nach der bestehenden `registerModelDownloadHandlers()`-Zeile:

```ts
registerModelCatalogHandlers()
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/model-catalog-handlers.ts src/main/index.ts
git commit -m "feat: add ipc handlers for asr model catalog (list/download/delete/setActive)"
```

---

## Task 14: Preload-API erweitern

**Files:**
- Modify: `src/preload/index.ts:102-114`
- Modify: `src/shared/types/IpcApi.ts`

- [ ] **Step 1: TypeScript-Typen in `IpcApi.ts` ergänzen**

Am Ende der Datei `src/shared/types/IpcApi.ts`:

```ts
import type { ModelCatalogEntry } from '../validation/model-catalog-schemas'

export interface ModelCatalogApi {
  listAsr: () => Promise<ModelCatalogEntry[]>
  download: (id: string) => Promise<ModelCatalogEntry[]>
  delete: (id: string) => Promise<ModelCatalogEntry[]>
  setActive: (id: string) => Promise<ModelCatalogEntry[]>
  cancelDownload: () => Promise<void>
}
```

Danach in der bestehenden `ElectronApi`/`IpcApi`-Interface-Definition einen Eintrag `modelCatalog: ModelCatalogApi` ergänzen. (Exakte Stelle per `grep -n "modelDownload:" src/shared/types/IpcApi.ts` finden — analog anhängen.)

- [ ] **Step 2: Preload-Export ergänzen**

In `src/preload/index.ts`, nach dem `modelDownload`-Block (Zeile 114), einfügen:

```ts
  modelCatalog: {
    listAsr: () => ipcRenderer.invoke('modelCatalog:listAsr'),
    download: (id: string) => ipcRenderer.invoke('modelCatalog:download', { id }),
    delete: (id: string) => ipcRenderer.invoke('modelCatalog:delete', { id }),
    setActive: (id: string) => ipcRenderer.invoke('modelCatalog:setActive', { id }),
    cancelDownload: () => ipcRenderer.invoke('modelCatalog:cancelDownload')
  },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/shared/types/IpcApi.ts
git commit -m "feat: expose modelCatalog api via preload bridge"
```

---

## Task 15: UI-Komponente `AsrModelCard.tsx`

**Files:**
- Create: `src/renderer/src/components/settings/AsrModelCard.tsx`

**UX-Hinweise, die im Code umgesetzt sind:**
- Active-State subtil: nur Border-Akzent + Pill „Aktiv", **kein** Background-Tint (kein visuelles Über-Akzentuieren bei nur 2 Karten — Von Restorff: Pill reicht).
- **Keine Accuracy/Speed-Balken** — Therapeuten können `0.8 vs 0.9` nicht einordnen. Stattdessen prägnante Chips (Sprache, Geschwindigkeit) + Prosa-Beschreibung im `description`-Feld der Registry, die die „Wann wähle ich was?"-Frage beantwortet.
- Download-State: Karte leicht gedimmt, Progress + **Cancel-Button** (574 MB dauern auf schlechtem Netz > 5 min — Abbruch ist Pflicht).
- Karte selbst **nicht** klickbar — alle Aktionen über explizite Buttons (keine versteckten Interaktionen).

- [ ] **Step 1: Komponente anlegen**

`src/renderer/src/components/settings/AsrModelCard.tsx`:

```tsx
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'

interface Props {
  model: ModelCatalogEntry
  downloading: boolean
  progress?: number
  anyBusy: boolean
  onDownload: () => void
  onCancelDownload: () => void
  onDelete: () => void
  onActivate: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Übersetzt BCP-47-Codes in Therapeut-freundliche Labels. */
function formatLanguage(code: string): string {
  switch (code) {
    case 'multi':
      return 'Multilingual'
    case 'de':
      return 'Hochdeutsch'
    case 'de-CH':
      return 'Schweizerdeutsch'
    default:
      return code
  }
}

function Chip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-tertiary">
      {children}
    </span>
  )
}

export default function AsrModelCard({
  model,
  downloading,
  progress,
  anyBusy,
  onDownload,
  onCancelDownload,
  onDelete,
  onActivate
}: Props): React.JSX.Element {
  const dimmed = downloading ? 'opacity-70' : ''
  const borderClass = model.isActive ? 'border-primary' : 'border-border'

  return (
    <div
      className={`rounded-lg border p-4 ${borderClass} ${dimmed}`}
      role="group"
      aria-labelledby={`model-${model.id}-name`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3
              id={`model-${model.id}-name`}
              className="font-semibold text-text-primary"
            >
              {model.label}
            </h3>
            {model.isActive && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-white">
                Aktiv
              </span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {model.languages?.map((lang) => <Chip key={lang}>{formatLanguage(lang)}</Chip>)}
            <Chip>{formatBytes(model.sizeBytes)}</Chip>
          </div>

          {model.description && (
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              {model.description}
            </p>
          )}
        </div>
      </div>

      {downloading && progress !== undefined && (
        <div className="mt-3">
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-text-tertiary">
            Lädt herunter … {progress}%
          </p>
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        {downloading && (
          <button
            className="titlebar-no-drag rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2"
            onClick={onCancelDownload}
          >
            Download abbrechen
          </button>
        )}
        {!downloading && !model.isInstalled && (
          <button
            className="titlebar-no-drag rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
            onClick={onDownload}
            disabled={anyBusy}
          >
            Herunterladen
          </button>
        )}
        {!downloading && model.isInstalled && !model.isActive && (
          <>
            <button
              className="titlebar-no-drag rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 disabled:opacity-50"
              onClick={onDelete}
              disabled={anyBusy}
            >
              Löschen
            </button>
            <button
              className="titlebar-no-drag rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
              onClick={onActivate}
              disabled={anyBusy}
            >
              Aktivieren
            </button>
          </>
        )}
        {!downloading && model.isInstalled && model.isActive && (
          <span className="text-xs text-text-tertiary">
            Wird für Transkription verwendet
          </span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/AsrModelCard.tsx
git commit -m "feat: add AsrModelCard component for model settings"
```

---

## Task 16: UI-Komponente `ModelsSettings.tsx`

**Files:**
- Create: `src/renderer/src/components/settings/ModelsSettings.tsx`

**UX-Hinweise, die im Code umgesetzt sind:**
- **Toast-Feedback** via `useToast()` nach Aktivieren — Peak-End Rule: der Wechsel ist ein „peak moment", die Bestätigung prägt das Erlebnis. Inkl. Hinweis "Bereits verarbeitete Sitzungen bleiben unverändert" — schützt vor Panik.
- **ConfirmDialog** (vorhandene Komponente) statt `window.confirm()` — Details-Array zeigt die freigegebene Grösse, destructive-Flag färbt den Button rot.
- **Cancel-Button** für Download — leitet zu bestehendem `abortModelDownload()` durch (siehe Task 7.5 unten).

- [ ] **Step 1: Komponente anlegen**

`src/renderer/src/components/settings/ModelsSettings.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'
import type { ModelDownloadStatus } from '../../../../shared/types/IpcApi'
import { useToast } from '../../hooks/useToast'
import { ConfirmDialog } from '../ConfirmDialog'
import AsrModelCard from './AsrModelCard'

function formatBytesShort(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export default function ModelsSettings(): React.JSX.Element {
  const toast = useToast()
  const [models, setModels] = useState<ModelCatalogEntry[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | undefined>(undefined)
  const [deleteCandidate, setDeleteCandidate] = useState<ModelCatalogEntry | null>(null)

  const reload = async (): Promise<void> => {
    const list = await window.api.modelCatalog.listAsr()
    setModels(list)
  }

  useEffect(() => {
    reload()
    const unsubscribe = window.api.modelDownload.onStatus((status: ModelDownloadStatus) => {
      if (status.state === 'downloading') {
        setProgress(status.progress.currentModelProgress)
      } else if (status.state === 'complete') {
        setProgress(undefined)
        setDownloadingId(null)
        reload()
      } else if (status.state === 'error') {
        toast.error(status.error)
        setProgress(undefined)
        setDownloadingId(null)
      }
    })
    return unsubscribe
  }, [toast])

  const handleDownload = async (id: string): Promise<void> => {
    setDownloadingId(id)
    try {
      const updated = await window.api.modelCatalog.download(id)
      setModels(updated)
      toast.success('Modell erfolgreich heruntergeladen.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setDownloadingId(null)
    }
  }

  const handleCancelDownload = async (): Promise<void> => {
    await window.api.modelCatalog.cancelDownload()
    setDownloadingId(null)
    setProgress(undefined)
  }

  const handleDeleteConfirmed = async (model: ModelCatalogEntry): Promise<void> => {
    setDeleteCandidate(null)
    try {
      const updated = await window.api.modelCatalog.delete(model.id)
      setModels(updated)
      toast.success(`"${model.label}" gelöscht — ${formatBytesShort(model.sizeBytes)} freigegeben.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleActivate = async (model: ModelCatalogEntry): Promise<void> => {
    try {
      const updated = await window.api.modelCatalog.setActive(model.id)
      setModels(updated)
      toast.success(
        `"${model.label}" aktiviert. Neue Transkriptionen verwenden ab jetzt dieses Modell — bereits verarbeitete Sitzungen bleiben unverändert.`
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const installed = models.filter((m) => m.isInstalled)
  const available = models.filter((m) => !m.isInstalled)
  const anyBusy = downloadingId !== null

  return (
    <div className="space-y-6 p-6">
      <section>
        <h2 className="mb-1 text-lg font-semibold">Transkriptions-Modelle</h2>
        <p className="text-sm text-text-secondary">
          Wähle das Modell, das für die Transkription deiner Sitzungen verwendet werden soll.
          Ein Modellwechsel wirkt sich nur auf neue Transkriptionen aus.
        </p>
      </section>

      {installed.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-text-tertiary">Installiert</h3>
          <div className="space-y-3">
            {installed.map((m) => (
              <AsrModelCard
                key={m.id}
                model={m}
                downloading={downloadingId === m.id}
                progress={downloadingId === m.id ? progress : undefined}
                anyBusy={anyBusy}
                onDownload={() => handleDownload(m.id)}
                onCancelDownload={handleCancelDownload}
                onDelete={() => setDeleteCandidate(m)}
                onActivate={() => handleActivate(m)}
              />
            ))}
          </div>
        </section>
      )}

      {available.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-text-tertiary">Zum Download verfügbar</h3>
          <div className="space-y-3">
            {available.map((m) => (
              <AsrModelCard
                key={m.id}
                model={m}
                downloading={downloadingId === m.id}
                progress={downloadingId === m.id ? progress : undefined}
                anyBusy={anyBusy}
                onDownload={() => handleDownload(m.id)}
                onCancelDownload={handleCancelDownload}
                onDelete={() => setDeleteCandidate(m)}
                onActivate={() => handleActivate(m)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-sm font-medium text-text-tertiary">Pflicht-Modelle</h3>
        <p className="mb-2 text-xs text-text-tertiary">
          Diese Modelle sind für die Anonymisierung zwingend erforderlich und werden
          automatisch aktuell gehalten.
        </p>
        <ul className="space-y-1 rounded-md border border-border bg-surface-1 p-3 text-xs text-text-tertiary">
          <li>Sprechererkennung (pyannote-community-1)</li>
          <li>Anonymisierung (flair-ner-german-large)</li>
        </ul>
      </section>

      {deleteCandidate && (
        <ConfirmDialog
          title={`${deleteCandidate.label} löschen?`}
          message={`${formatBytesShort(deleteCandidate.sizeBytes)} werden freigegeben. Du kannst das Modell später jederzeit erneut herunterladen.`}
          confirmLabel="Löschen"
          destructive
          onConfirm={() => handleDeleteConfirmed(deleteCandidate)}
          onCancel={() => setDeleteCandidate(null)}
        />
      )}
    </div>
  )
}
```

**Hinweis zu `ConfirmDialog`:** Die bestehende Komponente zeigt standardmässig den Zusatzsatz „Diese Aktion kann nicht rückgängig gemacht werden." — das ist für Modell-Löschen **falsch** (kann ja wieder heruntergeladen werden). Akzeptabel als kleine Ungenauigkeit; optional später über Prop-Extension in `ConfirmDialog` fixen.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/ModelsSettings.tsx
git commit -m "feat: add ModelsSettings tab content"
```

---

## Task 17: Settings-View verdrahten

**Files:**
- Modify: `src/renderer/src/views/Settings.tsx:1-54`

- [ ] **Step 1: Import ergänzen und Placeholder ersetzen**

Zeile 1–4 Block um Import erweitern:

```tsx
import ModelsSettings from '../components/settings/ModelsSettings'
```

Zeilen 43–49 ersetzen:

```tsx
        {currentTab === 'modelle' && <ModelsSettings />}
```

- [ ] **Step 2: Manueller Smoke-Test**

Run: `npm run dev`
- Settings öffnen → Tab "Modelle"
- Expected: Karten für beide Whisper-Modelle; Turbo-Multilingual als "Aktiv", Swiss-German als "Zum Download verfügbar" (wird aber bei Klick scheitern, weil Task 18 noch aussteht — das ist ok)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/views/Settings.tsx
git commit -m "feat: wire ModelsSettings into settings view"
```

---

## Task 18: HF-Konvertierungs-Script

**Files:**
- Create: `scripts/convert-hf-whisper.sh`

**Begründung:** Reproduzierbarer Weg, Flurin17's Modell (und weitere HF-Whisper-Fine-Tunes in Zukunft) auf ggml/q5_0 zu bringen. Das Script wird **einmalig** lokal gelaufen, Output landet in `r2-upload/`.

- [ ] **Step 1: Script anlegen**

`scripts/convert-hf-whisper.sh`:

```bash
#!/usr/bin/env bash
# Konvertiert ein HuggingFace-Whisper-Modell in ggml-q5_0 für whisper.cpp.
#
# Voraussetzungen:
#   - git, python3 (3.10+), pip, cmake
#   - huggingface-cli eingeloggt (falls Modell gated)
#
# Usage:
#   scripts/convert-hf-whisper.sh <hf-repo> <output-basename>
# Beispiel:
#   scripts/convert-hf-whisper.sh Flurin17/whisper-large-v3-turbo-swiss-german \
#     whisper-ggml-large-v3-turbo-swiss-q5_0
#
# Output: r2-upload/<output-basename>.bin (quantisiert, hochladebereit)

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <hf-repo> <output-basename>" >&2
  exit 1
fi

HF_REPO="$1"
OUT_NAME="$2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORK_DIR="$PROJECT_ROOT/build/convert-hf-whisper"
OUT_DIR="$PROJECT_ROOT/r2-upload"
WHISPER_CPP_DIR="$WORK_DIR/whisper.cpp"
OPENAI_WHISPER_DIR="$WORK_DIR/openai-whisper"
MODEL_DIR="$WORK_DIR/hf-model"

mkdir -p "$WORK_DIR" "$OUT_DIR"

# 1a. whisper.cpp clonen (Konvertierungs-Script + quantize-Tool)
if [ ! -d "$WHISPER_CPP_DIR" ]; then
  echo "→ Klone whisper.cpp nach $WHISPER_CPP_DIR"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_CPP_DIR"
fi

# 1b. openai/whisper-Repo clonen — convert-h5-to-ggml.py erwartet das
#     als zweites Argument (Quelle: Mel-Filter-Assets + Tokenizer-Artefakte).
#     Die Script-Signatur aus whisper.cpp/models/convert-h5-to-ggml.py:
#       python3 convert-h5-to-ggml.py <hf-model-dir> <whisper-repo-dir> <out-dir>
if [ ! -d "$OPENAI_WHISPER_DIR" ]; then
  echo "→ Klone openai/whisper nach $OPENAI_WHISPER_DIR"
  git clone --depth 1 https://github.com/openai/whisper "$OPENAI_WHISPER_DIR"
fi

# 2. Python-Deps in ein venv, um System-Python nicht zu verschmutzen
VENV="$WORK_DIR/venv"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet torch transformers huggingface_hub

# 3. HF-Modell herunterladen
if [ ! -d "$MODEL_DIR/$(basename "$HF_REPO")" ]; then
  echo "→ Lade $HF_REPO herunter"
  mkdir -p "$MODEL_DIR"
  huggingface-cli download "$HF_REPO" \
    --local-dir "$MODEL_DIR/$(basename "$HF_REPO")" \
    --local-dir-use-symlinks False
fi

# 4. ggml-Conversion
#    Das Script legt `ggml-model.bin` in $WORK_DIR ab.
GGML_RAW="$WORK_DIR/$OUT_NAME-raw.bin"
echo "→ Konvertiere nach ggml"
python "$WHISPER_CPP_DIR/models/convert-h5-to-ggml.py" \
  "$MODEL_DIR/$(basename "$HF_REPO")" \
  "$OPENAI_WHISPER_DIR" \
  "$WORK_DIR"
mv "$WORK_DIR/ggml-model.bin" "$GGML_RAW"

# 5. whisper.cpp bauen (ohne expliziten --target: neuere Versionen benennen
#    den Binary `quantize` in `whisper-quantize` um, je nach Release).
if [ ! -d "$WHISPER_CPP_DIR/build" ]; then
  echo "→ Baue whisper.cpp"
  (cd "$WHISPER_CPP_DIR" && cmake -B build && cmake --build build -j)
fi

# 6. Quantize-Binary finden (Name variiert nach whisper.cpp-Version)
QUANTIZE_BIN=""
for candidate in "$WHISPER_CPP_DIR/build/bin/quantize" \
                 "$WHISPER_CPP_DIR/build/bin/whisper-quantize"; do
  if [ -x "$candidate" ]; then
    QUANTIZE_BIN="$candidate"
    break
  fi
done
if [ -z "$QUANTIZE_BIN" ]; then
  echo "Error: quantize-Binary nicht gefunden in $WHISPER_CPP_DIR/build/bin/" >&2
  ls "$WHISPER_CPP_DIR/build/bin/" >&2
  exit 1
fi

# 7. Quantisierung → q5_0
echo "→ Quantisiere q5_0 via $QUANTIZE_BIN"
"$QUANTIZE_BIN" "$GGML_RAW" "$OUT_DIR/$OUT_NAME.bin" q5_0

# 8. SHA-256 + Grösse ausgeben
HASH=$(shasum -a 256 "$OUT_DIR/$OUT_NAME.bin" | cut -d' ' -f1)
SIZE=$(stat -f%z "$OUT_DIR/$OUT_NAME.bin")
echo ""
echo "=== Fertig ==="
echo "Datei:     $OUT_DIR/$OUT_NAME.bin"
echo "SHA-256:   $HASH"
echo "Grösse:    $SIZE bytes"
echo ""
echo "Nächste Schritte:"
echo "  1. sha256 + sizeBytes in MODEL_DEFINITIONS (ModelDownloadService.ts) eintragen"
echo "  2. scripts/publish-manifest.sh laufen lassen (lädt nach R2)"
```

- [ ] **Step 2: Ausführbar machen**

Run: `chmod +x scripts/convert-hf-whisper.sh`

- [ ] **Step 3: Sanity-Check gegen Base-Turbo — bevor wir dem Fine-Tune-Modell vertrauen**

Das konvertierte Base-Modell muss sich laden lassen. Wenn das schon scheitert, ist die Conversion-Toolchain für Turbo blockiert und der Plan stoppt hier.

Run:
```bash
scripts/convert-hf-whisper.sh openai/whisper-large-v3-turbo whisper-turbo-smoke-test
```

Smoke-Load-Test:
```bash
resources/bin/whisper-cli -m r2-upload/whisper-turbo-smoke-test.bin \
  -f <pfad-zu-testaudio.wav> -l de --no-prints
```

Expected: whisper-cli gibt Transkript aus ohne "invalid model"-Fehler. Wenn das klappt → Base-Turbo-Conversion funktioniert, Flurin17-Fine-Tune hat hohe Erfolgsaussicht. Wenn nicht → Issue aufmachen, Plan pausieren.

Nach erfolgreichem Smoke-Test: `rm r2-upload/whisper-turbo-smoke-test.bin`

- [ ] **Step 4: Flurin17-Modell konvertieren — erzeugt die Release-Datei + druckt SHA-256 und Grösse**

Run:
```bash
scripts/convert-hf-whisper.sh Flurin17/whisper-large-v3-turbo-swiss-german \
  whisper-ggml-large-v3-turbo-swiss-q5_0
```

Expected (nach einigen Minuten): Datei unter `r2-upload/whisper-ggml-large-v3-turbo-swiss-q5_0.bin`, Hash auf stdout. Notiere Hash und Grösse für Task 19.

- [ ] **Step 5: Commit Script (ohne die Modelldatei, die ist gitignored via `r2-upload/`)**

```bash
git add scripts/convert-hf-whisper.sh
git commit -m "feat: add script to convert huggingface whisper models to ggml q5_0"
```

---

## Task 19: SHA-256 + sizeBytes des Swiss-German-Modells nachziehen

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts` (Swiss-German-Eintrag aus Task 3)

- [ ] **Step 1: Platzhalter ersetzen**

Im `MODEL_DEFINITIONS`-Eintrag `whisper-large-v3-turbo-swiss`:
- `sizeBytes: 0` → tatsächliche Grösse aus Task 18 Step 3
- `sha256: 'PENDING_UPLOAD'` → tatsächlichen Hash aus Task 18 Step 3

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "chore: set sha256 + size for swiss-german whisper model"
```

---

## Task 20: `publish-manifest.sh` auf Multi-ASR erweitern

**Files:**
- Modify: `scripts/publish-manifest.sh:72-76` (MODELS-Array)

- [ ] **Step 1: Swiss-German-Eintrag im `MODELS`-Array ergänzen**

Array-Block so ergänzen:

```bash
declare -a MODELS=(
  "whisper-large-v3-turbo|whisper-ggml-large-v3-turbo-q5_0.bin|Whisper Large V3 Turbo (Multilingual)|asr/ggml-large-v3-turbo-q5_0.bin|false|asr/ggml-large-v3-turbo-q5_0.bin"
  "whisper-large-v3-turbo-swiss|whisper-ggml-large-v3-turbo-swiss-q5_0.bin|Whisper Large V3 Turbo (Swiss-German)|asr/ggml-large-v3-turbo-swiss-q5_0.bin|false|asr/ggml-large-v3-turbo-swiss-q5_0.bin"
  "pyannote-community-1|pyannote-models.tar.gz|Sprechererkennung (pyannote-community-1)|diarization|true|diarization/models--pyannote--speaker-diarization-3.1"
  "flair-ner-german-large|flair-ner-german-large.tar.gz|Anonymisierung (flair-ner-german-large)|ner|true|ner/models/ner-german-large"
)
```

- [ ] **Step 2: Dry-Run prüfen**

Run: `scripts/publish-manifest.sh --dry-run`
Expected: Das JSON enthält vier `models`-Einträge (nicht drei) mit korrekten SHA-256-Werten (Dry-Run liest aus `r2-upload/`).

- [ ] **Step 3: Commit**

```bash
git add scripts/publish-manifest.sh
git commit -m "chore: include swiss-german whisper in manifest publisher"
```

---

## Task 21: Swiss-German-Modell auf R2 hochladen + Manifest publizieren

**Files (extern):**
- R2 Bucket `therascript`

- [ ] **Step 1: Modelldatei auf R2 hochladen**

Run:
```bash
source .env
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
aws s3 cp r2-upload/whisper-ggml-large-v3-turbo-swiss-q5_0.bin \
  s3://therascript/whisper-ggml-large-v3-turbo-swiss-q5_0.bin \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

Expected: Upload-Bestätigung, keine Fehler.

- [ ] **Step 2: Manifest publizieren**

Run: `scripts/publish-manifest.sh`
Expected: `manifest.json` auf R2 aktualisiert. Enthält Swiss-German-Eintrag mit korrektem Hash/URL.

- [ ] **Step 3: Verify — Manifest über CDN abrufen**

Run:
```bash
curl -s https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json | jq '.models[] | {id, sha256, sizeBytes}'
```

Expected: Vier Einträge, Swiss-German-Hash stimmt mit `MODEL_DEFINITIONS` überein.

- [ ] **Step 4: Commit `manifest.json`** (falls lokal aktualisiert durch Dry-Run)

```bash
git add manifest.json
git commit -m "chore: update manifest with swiss-german whisper entry"
```

---

## Task 22: End-to-End-Test im Dev-Modus

**Files:** keine Änderungen, nur Verifikation.

- [ ] **Step 1: Frischer Settings-State simulieren** (optional, nur wenn man den First-Launch testen will)

Run: `mv ~/.therascript/models ~/.therascript/models.bak`

- [ ] **Step 2: Dev-Server starten**

Run: `npm run dev`
Expected:
- First-Launch zeigt Download-Screen
- Lädt nur drei Modelle (Turbo-Multilingual + pyannote + flair), NICHT Swiss-German
- Gesamtgrösse ~2.3 GB (nicht ~4 GB)

Falls Step 1 übersprungen: App startet direkt.

- [ ] **Step 3: Modelle-Tab**

- Settings → Tab "Modelle"
- Expected: Turbo-Multilingual als "Installiert, Aktiv", Swiss-German als "Zum Download verfügbar"

- [ ] **Step 4: Swiss-German laden**

- Klick "Herunterladen" bei Swiss-German-Karte
- Expected: Karte wird gedimmt, Progress-Bar + "Download abbrechen"-Button erscheinen
- Am Ende: Karte zeigt "Installiert", Button "Aktivieren" erscheint, Success-Toast "Modell erfolgreich heruntergeladen"

- [ ] **Step 4b: Download-Abbruch verifizieren** (kurz — nur Start, dann cancel)

- Vor Step 4, oder nach Delete in Step 6: erneut "Herunterladen" klicken
- Warte bis Progress ~5–10%, dann "Download abbrechen"
- Expected: Karte kehrt in "Zum Download verfügbar"-State zurück, keine halbe Datei in `~/.therascript/models/asr/`

- [ ] **Step 5: Aktivieren + Transkribieren**

- Klick "Aktivieren" bei Swiss-German-Karte
- Expected: Badge springt auf Swiss-German, Success-Toast mit Erklärungssatz ("Neue Transkriptionen verwenden ab jetzt dieses Modell — bereits verarbeitete Sitzungen bleiben unverändert.")
- Neue Session aufnehmen (Schweizerdeutsch sprechen, 30–60 s)
- Expected: Transkription läuft durch, Output erkennt Schweizerdeutsch-Dialekt erkennbar besser als mit Multilingual

- [ ] **Step 6: Löschen**

- Zurück auf Modelle-Tab, Swiss-German ist aktiv → Delete-Button fehlt (Guard greift)
- Turbo-Multilingual aktivieren → Swiss-German bekommt jetzt "Löschen"-Button
- Klick "Löschen" → ConfirmDialog erscheint mit Grössenangabe ("574 MB werden freigegeben.")
- Abbrechen-Button schliesst Dialog ohne Effekt
- Erneut klicken, dann bestätigen → Modell verschwindet aus "Installiert"-Sektion, taucht in "Zum Download verfügbar" auf, Success-Toast mit freigegebener Grösse

- [ ] **Step 7: Cleanup (falls Step 1 gemacht)**

Run: `mv ~/.therascript/models.bak ~/.therascript/models`

- [ ] **Step 8: Keine Code-Änderungen — kein Commit nötig.**

---

## Task 23: Doku aktualisieren

**Files:**
- Modify: `CLAUDE.md` (ML-Pipeline-Abschnitt)
- Modify: `docs/product/` (eine passende Datei, z. B. `architecture.md` oder eine neue `models.md`)

- [ ] **Step 1: `CLAUDE.md` ML-Pipeline-Audio-Abschnitt anpassen**

Den Bullet "1. whisper.cpp subprocess — ASR (Whisper Large V3 Turbo Q5_0, Metal GPU) ✓ implemented" erweitern:

```markdown
1. whisper.cpp subprocess — ASR via auswählbares Modell aus Katalog (Default: Whisper Large V3 Turbo Q5_0 multilingual; optional: Swiss-German-Fine-Tune). Active model stored in electron-store (`activeModels.transcription`), verwaltet via Settings → Modelle.
```

- [ ] **Step 2: Neue Doku `docs/product/models.md`** (oder bestehenden Architektur-Eintrag erweitern) mit:
  - Tabelle der verfügbaren ASR-Modelle (ID, Sprache, Grösse, Quelle)
  - Release-Flow für neue Modelle (Script → R2-Upload → publish-manifest → Hash nachziehen)
  - Entscheidungs-Hinweis wann welches Modell (Multilingual vs. Swiss-German)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/product/
git commit -m "docs: describe multi-asr-model selection and release flow"
```

---

## Self-Review gegen die Anforderungen

**Spec coverage:**
- Mehrere ASR-Modelle im Katalog? → Task 1–3
- Active-Model über Settings steuerbar? → Task 4, 9, 10, 16
- First-Launch lädt nur Pflicht + aktives ASR? → Task 5–6
- On-Demand-Download einzelner Modelle? → Task 7, 13, 16
- Delete-Funktion mit Guards? → Task 8, 13, 16
- UI à la Handy (Active-Badge, Bars, Download, Delete)? → Task 15, 16, 17
- Update-Check für nicht installierte Modelle unterdrückt? → Task 11
- HF → ggml Konvertierungs-Pipeline? → Task 18
- Manifest + R2-Deploy? → Task 20, 21
- Bestehende User verlieren nichts? → `activeModels.transcription` hat bereits seit heute Default `'whisper-large-v3-turbo'` (siehe `SettingsService.ts:28`) → keine Migration nötig
- End-to-End-Verifikation? → Task 22

**Platzhalter-Scan:** Task 3 hat explizit `sha256: 'PENDING_UPLOAD'` + `sizeBytes: 0` — das ist bewusst (Placeholder wird in Task 19 nachgezogen, nachdem Task 18 gelaufen ist). Keine weiteren Platzhalter.

**Type consistency:** `ModelDefinition` erweitert (Task 1), alle späteren Tasks referenzieren dieselben Felder (`group`, `isRequired`, `description`, `languages`, `accuracyScore`, `speedScore`). IPC-Schema `ModelCatalogEntry` (Task 12) spiegelt die UI-relevanten Felder plus `isInstalled` + `isActive` wider. Funktionsnamen durchgängig konsistent (`getAsrModels`, `getModelById`, `downloadSingleModel`, `deleteModel`, `setActiveAsrModel`, `isModelInstalled`).
