# Multi-Diarization-Modelle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die für ASR bereits existierende Modell-Auswahl (Download/Delete/Activate via Settings → Modelle) auf die Diarization-Gruppe ausweiten. Initial: `pyannote/speaker-diarization-3.1` (bestehend, Default) + `pyannote/speaker-diarization-community-1` (neu, bessere DER auf Deutsch laut Memory-Record). Das heute hartcodierte `pyannote-community-1` wird korrekt einem der beiden Katalog-Einträge zugeordnet.

**Architecture:** Der ASR-Katalog (mehrere `ModelDefinition`s mit `group: 'asr'`, `isRequired: false`) wird auf `group: 'diarization'` generalisiert. `activeModels.diarization` (bereits im electron-store-Schema vorhanden) steuert, welchen HuggingFace-Identifier `diarize.py` lädt. `PyannoteSidecar` liest das aktive Modell und reicht es als CLI-Argument durch. `isRequired: true` wird für Diarization durch eine **Group-Required**-Semantik ersetzt: mindestens ein Modell der Gruppe muss installiert und aktiv sein — `deleteModel()` verbietet das Löschen des letzten installierten Diarization-Modells. Catalog-IPC (`modelCatalog:list/download/delete/setActive`) wird für alle Gruppen geöffnet. UI bekommt eine zweite Section "Sprechererkennungs-Modelle" im Settings → Modelle-Tab. R2-Packaging splittet die bisherige `pyannote-models.tar.gz` in zwei atomare Tarballs.

**Tech Stack:** Electron 30+, TypeScript strict, React 19, Tailwind v4, electron-store, pyannote.audio 4.x (Python sidecar), Zod-IPC-Validierung, Vitest.

---

## File Structure

**Create:**
- `docs/plans/2026-04-23-multi-diarization-models.md` — dieser Plan
- `src/renderer/src/components/settings/ModelCard.tsx` — generalisierte Model-Karte (extrahiert aus `AsrModelCard.tsx`)
- `src/main/services/__tests__/ModelDownloadService.group.test.ts` — Unit-Tests für group-aware Helpers + Group-Required-Invariante

**Modify:**
- `src/main/services/ModelDownloadService.ts` — neuer zweiter Diarization-Eintrag, generalisiertes `getModelsByGroup/setActiveModel/deleteModel`, neues Feld `hfIdentifier`, `GROUP_TO_SETTINGS_KEY`-Record, PENDING-SHA-Preflight-Guard
- `src/main/services/SettingsService.ts:28-32` + `initSettings()` — Default-Update auf `pyannote-speaker-diarization-3.1` + defensive Migration (unbekannte IDs + `installedModelVersions`-Key) (Task 2.5)
- `src/main/services/__tests__/ModelDownloadService.test.ts` (Zeilen 61, 75, 84, 97, 109, 124) — ID-Rename + Expect-Patterns anpassen (Task 2.6) + zweiter Arg in `getModelsToLoadOnFirstLaunch` (Task 5)
- `src/main/services/__tests__/UpdateCheckService.test.ts` (Zeilen 55, 134, 162, 186, 291, 476, 495, 576) — ID-Rename (Task 2.6)
- `src/main/ml/__tests__/PyannoteSidecar.test.ts` (Zeilen 114, 119, 132, 140, 146) — ID-Rename + dritten Arg für `buildDiarizationData` (Task 2.6 + Task 12)
- `src/renderer/src/__tests__/App.test.tsx:73-75` + `src/renderer/src/components/__tests__/SessionDashboard.test.tsx:147-149` — `modelCatalog`-Mock um `list/download/delete/setActive/cancelDownload` erweitern (Task 2.6)
- `src/renderer/src/components/__tests__/UpdateBanner.test.tsx:38` — ID-Rename (Task 2.6)
- `src/shared/validation/__tests__/model-update-schemas.test.ts:71` — ID-Rename (Task 2.6)
- `src/shared/types/Diarization.ts:8` — Kommentar-Update (Task 2.6)
- `src/renderer/src/components/settings/ModelsSettings.tsx:145` — alte pyannote-Zeile aus Pflicht-Modelle-Block explizit entfernen (Task 10 Step 3)
- `src/shared/validation/model-catalog-schemas.ts:26` — `ModelIdPayloadSchema`-Regex um Punkt erweitern (Task 7)
- `python_sidecar/diarize.py` — `--hf-model` required, `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1` setzen, `local_config`-Fallback entfernen (Task 11)
- `src/main/ml/PyannoteSidecar.ts` — aktives Diarization-Modell aus Settings lesen, `--hf-model` an `diarize.py` reichen, Metadata-Field korrekt setzen
- `python_sidecar/diarize.py` — CLI-Flag `--hf-model` entgegennehmen, an `Pipeline.from_pretrained()` weitergeben
- `src/main/ipc/model-catalog-handlers.ts` — `listAsr` → `list(group)`, `setActive` für jede Gruppe erlauben, `download` für Diarization erlauben
- `src/shared/validation/model-catalog-schemas.ts` — `ModelGroupSchema` bereits vorhanden; Payload für `list` + `setActive` erweitern
- `src/preload/index.ts:115-120` — `modelCatalog`-API: `list(group)` statt `listAsr()`, setActive nimmt group
- `src/shared/types/IpcApi.ts` — Typen für `list(group)`, `setActive(group, id)`
- `src/renderer/src/components/settings/ModelsSettings.tsx` — zweite Section "Sprechererkennungs-Modelle"
- `src/renderer/src/components/settings/AsrModelCard.tsx` — wird `ModelCard` (verschoben) oder bleibt als Alias
- `scripts/setup-pyannote.sh` — optionaler `--model <id>`-Param für lokalen Download des zweiten Modells
- `scripts/package-models.sh` — zwei Tarballs statt einem
- `scripts/publish-manifest.sh:72-76` — neue Einträge + Tarball-Filenames im MODELS-Array
- `src/main/services/ModelDownloadService.ts` (erneut, separater Commit) — SHA-256-Hashes nach R2-Upload nachziehen

---

## Task 1: `ModelDefinition` um `hfIdentifier` erweitern

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:10-32`

**Begründung:** Der Python-Sidecar muss wissen, welchen HuggingFace-Identifier er an `Pipeline.from_pretrained()` übergibt. Bisher hardcoded in `diarize.py`. Neues optionales Feld `hfIdentifier` hält den String `'pyannote/speaker-diarization-3.1'` bzw. `'pyannote/speaker-diarization-community-1'`. Für ASR bleibt das Feld `undefined`.

- [ ] **Step 1: Typdefinition erweitern**

In `ModelDownloadService.ts` ab Zeile 10 nach den bestehenden Feldern:

```ts
export interface ModelDefinition {
  // ... bestehende Felder bleiben unverändert ...
  accuracyScore?: number
  speedScore?: number
  // HuggingFace-Identifier — nur für Diarization relevant (pyannote-pipelines laden via from_pretrained).
  // Für ASR undefined (whisper.cpp lädt flat-file).
  hfIdentifier?: string
}
```

- [ ] **Step 2: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: add hfIdentifier field to ModelDefinition"
```

---

## Task 2: Bestehenden pyannote-Eintrag korrigieren + umbenennen

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:87-98`

**Begründung:** Der heutige Eintrag `id: 'pyannote-community-1'` ist irreführend — er lädt tatsächlich `speaker-diarization-3.1` (siehe `diarize.py:82` und `checkPath: '...diarization-3.1'`). Für Alignment mit ASR-Pattern wird der Eintrag zu `pyannote-speaker-diarization-3.1` umbenannt, UI-Metadaten ergänzt, `isRequired` auf `false` gesetzt (Group-Required-Invariante in Task 5 ersetzt das).

- [ ] **Step 1: Eintrag in `MODEL_DEFINITIONS` umschreiben**

Ersetze den bestehenden pyannote-Eintrag:

```ts
{
  id: 'pyannote-speaker-diarization-3.1',
  label: 'Sprechererkennung (Diarization 3.1)',
  url: `${R2_CDN}/pyannote-speaker-diarization-3.1.tar.gz`,
  relativePath: 'diarization',
  checkPath: 'diarization/models--pyannote--speaker-diarization-3.1',
  sizeBytes: 30_461_603, // Vorläufig — wird in Task 14 nach Package-Rebuild aktualisiert
  sha256: 'PENDING_REPACKAGE', // Vorläufig — wird in Task 14 gesetzt
  archive: true,
  group: 'diarization',
  isRequired: false,
  description:
    'Standard-Pipeline von pyannote. Breit getestet, solide auf Hochdeutsch.',
  languages: ['multi'],
  accuracyScore: 0.8,
  speedScore: 0.9,
  hfIdentifier: 'pyannote/speaker-diarization-3.1'
},
```

**Hinweis:** Der `sizeBytes` + `sha256` ändern sich beim Repackaging in Task 13 (nur noch ein Modell pro Tarball). `PENDING_REPACKAGE` als Platzhalter bleibt bis Task 14 — lokales Dev funktioniert ohnehin via Filesystem-Check, nicht via Download.

**CLAUDE.md Gotcha — Model hash sync:** Das Zwischenstadium mit `PENDING_*`-Platzhaltern ist gefährlich: läuft zwischen Task 2 und Task 14 versehentlich ein First-Launch-Download (frischer `~/.therascript/models/`-Ordner), wirft `verifyFileSha256` eine kryptische "SHA-256-Prüfung fehlgeschlagen"-Message ohne Hinweis auf die eigentliche Ursache.

- [ ] **Step 2: Preflight-Guard gegen PENDING-Platzhalter**

In `ModelDownloadService.ts` in `startModelDownload()` + `downloadSingleModel()` direkt **vor** dem ersten `downloadFile()`-Aufruf:

```ts
if (model.sha256.startsWith('PENDING_')) {
  throw new Error(
    `Modell "${model.label}" (${model.id}) hat noch keinen finalen SHA-256 ` +
    `(Wert: "${model.sha256}"). Das deutet auf ein nicht abgeschlossenes Packaging hin — ` +
    `erst scripts/package-models.sh + scripts/publish-manifest.sh ausführen und die Hashes setzen.`
  )
}
```

In `downloadSingleModel()` die gleiche Prüfung (mit `def.sha256` statt `model.sha256`).

**Analog in `scripts/publish-manifest.sh`** (nach `HASH=...`-Ermittlung) — keine Änderung nötig, weil das Skript den echten SHA dynamisch berechnet, aber ein Sanity-Check schadet nicht:

```bash
if [[ "$HASH" == PENDING_* ]]; then
  echo "FEHLER: $ID hat einen PENDING-Platzhalter als SHA — Abbruch."
  exit 1
fi
```
(Dieser Check greift nur bei manuellem `MODELS=`-Eintrag-Fehler, nicht bei normalem Flow.)

- [ ] **Step 3: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: rename pyannote-community-1 + add PENDING-sha preflight guard"
```

---

## Task 2.5: Settings-Migration für bestehende Installationen

**Files:**
- Modify: `src/main/services/SettingsService.ts:28-32` + `initSettings()`

**Begründung:** Der Default `activeModels.diarization: 'pyannote-community-1'` wurde bereits bei jedem existierenden User in `electron-store` persistiert. Nach dem Rename in Task 2 liefert `getModelById('pyannote-community-1')` `null` → `PyannoteSidecar` wirft "kein hfIdentifier — Konfigurationsfehler" beim ersten Diarization-Lauf. Ohne Migration crasht Diarization für jeden bestehenden User (einschließlich Entwickler-Setup auf diesem Branch).

- [ ] **Step 1: Default aktualisieren**

In `SettingsService.ts:28-32` den Default-Wert umschreiben:

```ts
const defaults: AppSettings = {
  activeModels: {
    transcription: 'whisper-large-v3-turbo',
    diarization: 'pyannote-speaker-diarization-3.1', // NEU (war: 'pyannote-community-1')
    ner: 'flair-ner-german-large',
    ocr: 'apple-vision'
  },
  // ...
}
```

- [ ] **Step 2: Defensive Migration in `initSettings()` ergänzen**

Die Migration muss drei Szenarien abdecken, nicht nur den bekannten Legacy-Wert:

1. **Legacy-Key**: `active.diarization === 'pyannote-community-1'` → neuer Default-Key
2. **Unbekannte ID** (z.B. manipulierte Settings, altes Dev-Setup): irgendein String, der nicht in `MODEL_DEFINITIONS` existiert → zurück auf Default, sonst crasht `PyannoteSidecar` beim `hfIdentifier`-Lookup
3. **`installedModelVersions`-Key**: der alte Eintrag `installedModelVersions['pyannote-community-1']` bleibt sonst für immer verwaist, weil `UpdateCheckService` über Manifest-IDs iteriert

Top of file — Import ergänzen:
```ts
import { getModelDefinitions } from './ModelDownloadService'
```

**Hinweis:** Potenzieller Zirkel-Import prüfen — falls `ModelDownloadService` irgendwo `initSettings` direkt aufruft (nicht lazy via `getSettings()`), muss die Migration stattdessen nach `initSettings` als separate Funktion `migrateSettings()` ausgelagert und explizit in `main/index.ts` nach `initSettings()` aufgerufen werden. Im aktuellen Code ruft `ModelDownloadService` `getSettings()` nur lazy auf (keine Top-Level-Calls), also ist der Import safe.

Migration in `initSettings()`:

```ts
export function initSettings(): Store<AppSettings> {
  if (store) return store

  store = new Store<AppSettings>({
    name: 'settings',
    defaults
  })

  // Migration 2026-04-23 — Diarization-Modell-ID-Rename + defensive Repair
  const active = store.get('activeModels')
  const knownDiarIds = new Set(
    getModelDefinitions()
      .filter((m) => m.group === 'diarization')
      .map((m) => m.id)
  )
  const DEFAULT_DIAR = 'pyannote-speaker-diarization-3.1'

  if (!knownDiarIds.has(active.diarization)) {
    // deckt ab: altes 'pyannote-community-1', manipulierte Werte, Downgrade-Rückstände.
    // Kann nach 2-3 Releases entfernt werden (kommentiere dann die Zeile).
    console.warn(
      `[settings-migration] activeModels.diarization="${active.diarization}" unbekannt → reset auf "${DEFAULT_DIAR}"`
    )
    store.set('activeModels', { ...active, diarization: DEFAULT_DIAR })
  }

  // installedModelVersions: Altlasten-Key mit-migrieren, sonst bleibt er für immer
  // verwaist (UpdateCheckService iteriert über Manifest-IDs, nicht über installed-keys).
  const installed = { ...store.get('installedModelVersions') }
  if (installed['pyannote-community-1']) {
    installed[DEFAULT_DIAR] = installed[DEFAULT_DIAR] ?? installed['pyannote-community-1']
    delete installed['pyannote-community-1']
    store.set('installedModelVersions', installed)
  }

  return store
}
```

- [ ] **Step 3: Manueller Test**

Mit bereits laufender Installation:
```bash
node -e "const Store=require('electron-store');const s=new Store({name:'settings'});console.log(s.get('activeModels'))"
```

Setze manuell `activeModels.diarization = 'pyannote-community-1'` (z.B. via `defaults.json` im electron-userData-Ordner), starte dann die App, prüfe dass nach Boot `activeModels.diarization === 'pyannote-speaker-diarization-3.1'`.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/SettingsService.ts
git commit -m "feat: migrate activeModels.diarization key from pyannote-community-1 to speaker-diarization-3.1"
```

---

## Task 2.6: Test-Sweep — alle `pyannote-community-1`-Vorkommen migrieren

**Files (vom Review verifiziert):**
- Modify: `src/main/services/__tests__/UpdateCheckService.test.ts` (Zeilen 55, 134, 162, 186, 291, 476, 495, 576)
- Modify: `src/main/services/__tests__/ModelDownloadService.test.ts` (Zeilen 61, 75, 84, 97, 109, 124)
- Modify: `src/main/ml/__tests__/PyannoteSidecar.test.ts` (Zeilen 114, 119, 132, 140, 146 — siehe Task 12 für Signatur-Änderung)
- Modify: `src/renderer/src/__tests__/App.test.tsx:74` (Mock-Erweiterung)
- Modify: `src/renderer/src/components/__tests__/SessionDashboard.test.tsx:148` (Mock-Erweiterung)
- Modify: `src/renderer/src/components/__tests__/UpdateBanner.test.tsx:38`
- Modify: `src/shared/validation/__tests__/model-update-schemas.test.ts:71`
- Modify: `src/shared/types/Diarization.ts:8` (Kommentar-Doku)

**Begründung:** `grep -rn pyannote-community-1 src/` findet 20+ Vorkommen in Tests + Kommentaren. Wenn diese nicht zusammen mit Task 2 migriert werden, brechen Tests sofort (z.B. `ModelDownloadService.test.ts:109` erwartet `/Pflicht-Modell/i`, nach `isRequired: false` wird jetzt Group-Required-Fehler geworfen → Test fällt hart).

- [ ] **Step 1: Bulk-Rename in Test-Files**

```bash
# Alle Tests auf neuen ID umstellen
grep -rln "pyannote-community-1" src/ | while read f; do
  sed -i '' 's/pyannote-community-1/pyannote-speaker-diarization-3.1/g' "$f"
done
```

Dann **manuell prüfen**, wo der Rename semantisch nicht passt:

- **`ModelDownloadService.test.ts:109`** — `deleteModel`-Test erwartete `/Pflicht-Modell/i`. Nach Task 2 + Task 5 hat `pyannote-speaker-diarization-3.1` `isRequired: false`. Der Group-Required-Check wirft stattdessen `/aktiv als Sprechererkennungs-Modell/i`. Expect-Pattern anpassen:
  ```ts
  await expect(deleteModel('pyannote-speaker-diarization-3.1')).rejects.toThrow(
    /aktiv als Sprechererkennungs-Modell/i
  )
  ```
  Plus neuen Test-Case hinzufügen, der den `isRequired`-Pfad gegen `flair-ner-german-large` verifiziert (damit der `isRequired`-Code-Pfad weiterhin getestet ist):
  ```ts
  it('should throw Pflicht-Modell when deleting flair', async () => {
    await expect(deleteModel('flair-ner-german-large')).rejects.toThrow(/Pflicht-Modell/i)
  })
  ```

- **`ModelDownloadService.test.ts:97`** — `downloadSingleModel`-Test erwartete `/nur ASR-Modelle/i`. Nach Task 6 Step 2 lautet die Message `/nur ASR- und Diarization-Modelle/i`. Und: Diarization-Modelle werden nach Task 6 **tatsächlich einzeln ladbar** — der Test-Case ist konzeptionell obsolet für die neue ID. Besser: Test umstellen auf NER-ID (`flair-ner-german-large`), die weiterhin rejizieren soll.

- **`ModelDownloadService.test.ts:124`** — `setActiveAsrModel`-Test erwartete `/keine ASR/i`. Nach Rename sucht `getModelById('pyannote-speaker-diarization-3.1')` ein Modell der `diarization`-Gruppe — der Error lautet nach Task 6 Step 1 `/ist diarization, erwartet wurde asr/i`. Pattern anpassen, oder auf eine wirklich unbekannte ID umstellen.

- **`UpdateCheckService.test.ts`** — alle 8 Vorkommen sind Fixtures für Modell-IDs; reiner String-Rename genügt, keine Pattern-Änderungen nötig.

- **`model-update-schemas.test.ts:71`** — Schema-Test mit einer Dummy-ID. Rein textuell migrierbar.

- **`UpdateBanner.test.tsx:38`** — Fixture-String. Rename genügt.

- **`Diarization.ts:8`** — nur ein Kommentar `// "pyannote-community-1"`. Auf neuen Default-Wert aktualisieren.

- **`App.test.tsx:74` + `SessionDashboard.test.tsx:148`** — die Renderer-Mocks bieten nur `listAsr: vi.fn().mockResolvedValue([])`. Nach Task 8 ruft `ModelsSettings.tsx` jedoch `window.api.modelCatalog.list('asr')` und `list('diarization')` auf. Mock erweitern:
  ```ts
  modelCatalog: {
    list: vi.fn().mockResolvedValue([]),
    listAsr: vi.fn().mockResolvedValue([]),
    download: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue([]),
    setActive: vi.fn().mockResolvedValue([]),
    cancelDownload: vi.fn().mockResolvedValue(undefined)
  }
  ```

- [ ] **Step 2: Test-Run — alles muss grün bleiben**

```bash
npm run test
```

Expected: Alle Tests grün (inkl. der angepassten expect-Patterns).

- [ ] **Step 3: Commit**

```bash
git add src/main/services/__tests__ src/main/ml/__tests__ src/renderer/src/__tests__ src/renderer/src/components/__tests__ src/shared/validation/__tests__ src/shared/types/Diarization.ts
git commit -m "test: migrate pyannote-community-1 references to speaker-diarization-3.1"
```

---

## Task 3: Community-1 als zweiten Diarization-Eintrag registrieren (Platzhalter)

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts` (nach 3.1-Eintrag, vor flair)

- [ ] **Step 1: Neuen Eintrag hinzufügen**

```ts
{
  id: 'pyannote-speaker-diarization-community-1',
  label: 'Sprechererkennung (Diarization Community 1)',
  url: `${R2_CDN}/pyannote-speaker-diarization-community-1.tar.gz`,
  relativePath: 'diarization',
  checkPath: 'diarization/models--pyannote--speaker-diarization-community-1',
  sizeBytes: 0, // TBD: nach Download + Package in Task 13
  sha256: 'PENDING_UPLOAD', // TBD: nach Upload in Task 14
  archive: true,
  group: 'diarization',
  isRequired: false,
  description:
    'Community-Variante mit besserer Performance auf Deutsch (DER ca. 8.3 % laut HF). Experimentell.',
  languages: ['de', 'multi'],
  accuracyScore: 0.9,
  speedScore: 0.9,
  hfIdentifier: 'pyannote/speaker-diarization-community-1'
},
```

- [ ] **Step 2: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "feat: register pyannote community-1 as second diarization model (placeholder hash)"
```

---

## Task 4: Generische Query-Helpers — `getModelsByGroup`, `getActiveModelId`

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:115-128`

**Begründung:** `getAsrModels()` ist ASR-spezifisch. Neue generische Helper erlauben Catalog-IPC und First-Launch-Logik gleichermaßen mit Diarization + NER umzugehen.

- [ ] **Step 1: Neue Helper hinzufügen**

Ersetze `getAsrModels()` und ergänze:

```ts
export function getModelsByGroup(group: ModelGroup): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.group === group)
}

/** Backward-Compat-Alias — weiterhin verwendet von First-Launch + Update-Check. */
export function getAsrModels(): ModelDefinition[] {
  return getModelsByGroup('asr')
}

/** Liefert die aktuell aktive Model-ID für eine Gruppe aus den Settings. */
export function getActiveModelId(group: ModelGroup): string {
  const active = getSettings().get('activeModels')
  if (group === 'asr') return active.transcription
  if (group === 'diarization') return active.diarization
  if (group === 'ner') return active.ner
  throw new Error(`Keine aktive Modell-Konfiguration für Gruppe "${group}"`)
}
```

- [ ] **Step 2: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS — der Alias `getAsrModels()` hält bestehende Call-Sites grün.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: add group-aware model query helpers"
```

---

## Task 5: Group-Required-Invariante in First-Launch + Delete

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:131-154` + `:421-461`

**Begründung:** Bisher: `isRequired: true` → Modell wird auf First-Launch geladen + ist nicht löschbar. Für Diarization wollen wir stattdessen: genau *ein* aktives Modell pro Gruppe muss installiert sein. `isRequired` bleibt für NER (single-model) unverändert.

- [ ] **Step 1: First-Launch-Ladeliste erweitern**

Ersetze `getModelsToLoadOnFirstLaunch` und `getModelsToLoad`:

```ts
/**
 * Modelle, die auf First-Launch heruntergeladen werden müssen:
 * - alle isRequired-Modelle (NER)
 * - das aktive ASR-Modell
 * - das aktive Diarization-Modell
 */
export function getModelsToLoadOnFirstLaunch(
  activeAsrId: string,
  activeDiarId: string
): ModelDefinition[] {
  const seen = new Set<string>()
  const out: ModelDefinition[] = []
  for (const m of getRequiredModels()) {
    if (!seen.has(m.id)) { seen.add(m.id); out.push(m) }
  }
  const activeAsr = getModelById(activeAsrId)
  if (activeAsr && activeAsr.group === 'asr' && !seen.has(activeAsr.id)) {
    seen.add(activeAsr.id); out.push(activeAsr)
  }
  const activeDiar = getModelById(activeDiarId)
  if (activeDiar && activeDiar.group === 'diarization' && !seen.has(activeDiar.id)) {
    seen.add(activeDiar.id); out.push(activeDiar)
  }
  return out
}

export function getModelsToLoad(): ModelDefinition[] {
  const active = getSettings().get('activeModels')
  return getModelsToLoadOnFirstLaunch(active.transcription, active.diarization)
}
```

- [ ] **Step 2: `checkRequiredAndActiveAsrExist` verallgemeinern**

Ersetze durch group-aware Variante:

```ts
export function checkRequiredAndActiveExist(
  activeAsrId: string,
  activeDiarId: string
): boolean {
  const modelsDir = getModelsDir()
  const toCheck = getModelsToLoadOnFirstLaunch(activeAsrId, activeDiarId)
  return toCheck.every((m) => existsSync(join(modelsDir, m.checkPath)))
}

// Alias für Backward-Compat mit bestehenden Call-Sites
export function checkRequiredAndActiveAsrExist(activeAsrId: string): boolean {
  const activeDiar = getSettings().get('activeModels').diarization
  return checkRequiredAndActiveExist(activeAsrId, activeDiar)
}

export function checkModelsExist(): boolean {
  const active = getSettings().get('activeModels')
  return checkRequiredAndActiveExist(active.transcription, active.diarization)
}
```

- [ ] **Step 3: `deleteModel` um Group-Required-Check erweitern**

In `deleteModel` — nach dem bestehenden `isRequired`-Check und dem `activeAsr === id`-Check:

```ts
// Group-Required: für Gruppen mit auswählbarem aktivem Modell (asr, diarization)
// darf das aktuell aktive Modell nicht gelöscht werden.
const active = settings.get('activeModels')
if (def.group === 'asr' && active.transcription === id) {
  throw new Error(
    `Löschen: "${def.label}" ist aktuell als ASR-Modell aktiv. Zuerst anderes Modell aktivieren.`
  )
}
if (def.group === 'diarization' && active.diarization === id) {
  throw new Error(
    `Löschen: "${def.label}" ist aktuell als Sprechererkennungs-Modell aktiv. Zuerst anderes Modell aktivieren.`
  )
}
```

**Hinweis:** Der bestehende ASR-spezifische Check (`activeAsr === id`) kann entfernt werden — wird durch die generalisierte Variante ersetzt. Alternativ belassen und duplizieren, aber das ist nur Noise.

- [ ] **Step 4: Bestehende Tests an neue Signatur anpassen**

`src/main/services/__tests__/ModelDownloadService.test.ts:71,81` ruft `getModelsToLoadOnFirstLaunch('whisper-...')` mit nur einem Argument auf. Die Signatur-Änderung erzwingt einen zweiten Arg — Tests sonst TypeScript-broken.

```ts
// vorher:
const loaded = getModelsToLoadOnFirstLaunch('whisper-large-v3-turbo')
// nachher:
const loaded = getModelsToLoadOnFirstLaunch(
  'whisper-large-v3-turbo',
  'pyannote-speaker-diarization-3.1'
)
```

Analog für den `'nonexistent'`-Test-Fall — zweiter Arg kann dort ein beliebiger gültiger oder invalider String sein, je nach Test-Absicht:

```ts
const loaded = getModelsToLoadOnFirstLaunch('nonexistent', 'nonexistent')
```

- [ ] **Step 5: TypeScript-Check + Tests laufen lassen**

```bash
npm run typecheck
npm run test -- ModelDownloadService
```

Expected: PASS. Der Alias `checkRequiredAndActiveAsrExist(id)` mit einzelnem Arg bleibt für andere Call-Sites grün; nur die zwei angepassten Test-Zeilen brauchen den zweiten Arg.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/ModelDownloadService.ts src/main/services/__tests__/ModelDownloadService.test.ts
git commit -m "feat: enforce group-required invariant for active diarization model"
```

---

## Task 6: `setActiveModel` generalisieren + `downloadSingleModel` für Diarization öffnen

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:334-345, 469-483`

- [ ] **Step 1: `setActiveModel` als group-aware Variante**

Ersetze `setActiveAsrModel`:

```ts
// Explizites Mapping Group → Settings-Key. Der TypeScript-Compiler erzwingt Vollständigkeit:
// Wird ModelGroup um einen neuen Wert erweitert, schlägt der Build fehl,
// solange das Mapping nicht erweitert wird. Das verhindert silent-wrong-key-writes.
const GROUP_TO_SETTINGS_KEY: Record<ModelGroup, keyof AppSettings['activeModels']> = {
  asr: 'transcription',
  diarization: 'diarization',
  ner: 'ner'
}

export function setActiveModel(group: ModelGroup, id: string): void {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Aktivieren: unbekanntes Modell "${id}"`)
  }
  if (def.group !== group) {
    throw new Error(
      `Aktivieren: "${def.label}" ist ${def.group ?? 'ungruppiert'}, erwartet wurde ${group}`
    )
  }
  if (!isModelInstalled(id)) {
    throw new Error(`Aktivieren: "${def.label}" ist nicht installiert`)
  }
  const settings = getSettings()
  const current = settings.get('activeModels')
  settings.set('activeModels', { ...current, [GROUP_TO_SETTINGS_KEY[group]]: id })
}

/** Backward-Compat-Alias. */
export function setActiveAsrModel(id: string): void {
  setActiveModel('asr', id)
}
```

**Hinweis:** `AppSettings` wird aus `SettingsService.ts` importiert. Für den Fall, dass das einen Zirkel-Import mit der Task 2.5-Migration verursacht: den Typ inline als `'transcription' | 'diarization' | 'ner'` ausschreiben. Das klassische `keyof`-Pattern ist sauberer, aber nur wenn die Imports es erlauben.

- [ ] **Step 2: `downloadSingleModel` für Diarization öffnen**

Ersetze den Check:

```ts
// Vorher:
if (def.group !== 'asr') {
  throw new Error(`Download: nur ASR-Modelle sind einzeln ladbar (id=${id})`)
}
```

durch:

```ts
if (def.group !== 'asr' && def.group !== 'diarization') {
  throw new Error(`Download: nur ASR- und Diarization-Modelle sind einzeln ladbar (id=${id})`)
}
```

NER bleibt vorerst nur über First-Launch-Flow erreichbar (ein-Modell-Gruppe, kein UX-Bedarf).

- [ ] **Step 3: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/ModelDownloadService.ts
git commit -m "refactor: generalize setActiveModel and allow diarization downloads"
```

---

## Task 7: IPC-Schemas + Handler für Multi-Group-Catalog

**Files:**
- Modify: `src/shared/validation/model-catalog-schemas.ts`
- Modify: `src/main/ipc/model-catalog-handlers.ts`

- [ ] **Step 1: Bestehenden `ModelIdPayloadSchema`-Regex erweitern**

Die neuen IDs (`pyannote-speaker-diarization-3.1`, `...community-1`) enthalten einen Punkt. Der existierende Regex `/^[a-z0-9-]+$/i` in `model-catalog-schemas.ts:26` lehnt sie ab → IPC-Payloads werden zur Laufzeit mit "ungültige Argumente" abgewiesen.

Ersetze Zeile 26:

```ts
// vorher:
.regex(/^[a-z0-9-]+$/i, 'nur a-z, 0-9 und Bindestrich erlaubt')
// nachher:
.regex(/^[a-z0-9.-]+$/i, 'nur a-z, 0-9, Bindestrich und Punkt erlaubt')
```

- [ ] **Step 2: Neue Zod-Schemas hinzufügen**

In `model-catalog-schemas.ts`:

```ts
// ModelGroupSchema + ModelCatalogEntrySchema bleiben unverändert
// (group: ModelGroupSchema ist schon im Schema).

/** Payload für modelCatalog:list(group). */
export const ListModelsPayloadSchema = z.object({
  group: ModelGroupSchema
})

/** Payload für modelCatalog:setActive — braucht group, um den Settings-Slot zu adressieren. */
export const SetActiveModelPayloadSchema = z.object({
  group: ModelGroupSchema,
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9.-]+$/i, 'nur a-z, 0-9, Bindestrich und Punkt erlaubt')
})
```

- [ ] **Step 3: Handler umbauen**

In `model-catalog-handlers.ts`:

```ts
function buildCatalogEntries(group: ModelGroup): ModelCatalogEntry[] {
  const activeId = getActiveModelId(group)
  return getModelsByGroup(group).map((def) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    sizeBytes: def.sizeBytes,
    group,
    isRequired: def.isRequired === true,
    languages: def.languages,
    accuracyScore: def.accuracyScore,
    speedScore: def.speedScore,
    isInstalled: isModelInstalled(def.id),
    isActive: def.id === activeId
  }))
}

export function registerModelCatalogHandlers(): void {
  ipcMain.handle('modelCatalog:list', (_e, payload: unknown) => {
    const { group } = validate(ListModelsPayloadSchema, payload, 'modelCatalog:list')
    return buildCatalogEntries(group)
  })

  // Backward-compat — kann nach Task 9 + UI-Migration entfernt werden
  ipcMain.handle('modelCatalog:listAsr', () => buildCatalogEntries('asr'))

  ipcMain.handle('modelCatalog:download', async (_e, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:download')
    await downloadSingleModel(id)
    const def = getModelById(id)
    return buildCatalogEntries(def?.group ?? 'asr')
  })

  ipcMain.handle('modelCatalog:delete', async (_e, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:delete')
    const groupBefore = getModelById(id)?.group ?? 'asr'
    await deleteModel(id)
    return buildCatalogEntries(groupBefore)
  })

  ipcMain.handle('modelCatalog:setActive', (_e, payload: unknown) => {
    const { group, id } = validate(
      SetActiveModelPayloadSchema,
      payload,
      'modelCatalog:setActive'
    )
    setActiveModel(group, id)
    return buildCatalogEntries(group)
  })

  ipcMain.handle('modelCatalog:cancelDownload', () => {
    abortModelDownload()
  })
}
```

- [ ] **Step 4: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/model-catalog-handlers.ts src/shared/validation/model-catalog-schemas.ts
git commit -m "feat: group-aware modelCatalog IPC handlers + relax ID regex for dots"
```

---

## Task 8: Preload + IpcApi-Typen erweitern

**Files:**
- Modify: `src/preload/index.ts:115-120`
- Modify: `src/shared/types/IpcApi.ts`

- [ ] **Step 1: Preload-API**

Ersetze den `modelCatalog`-Block:

```ts
modelCatalog: {
  list: (group: ModelGroup) => ipcRenderer.invoke('modelCatalog:list', { group }),
  // Behalten für Backward-Compat mit ungeupdateten Renderer-Imports
  listAsr: () => ipcRenderer.invoke('modelCatalog:listAsr'),
  download: (id: string) => ipcRenderer.invoke('modelCatalog:download', { id }),
  delete: (id: string) => ipcRenderer.invoke('modelCatalog:delete', { id }),
  setActive: (group: ModelGroup, id: string) =>
    ipcRenderer.invoke('modelCatalog:setActive', { group, id }),
  cancelDownload: () => ipcRenderer.invoke('modelCatalog:cancelDownload')
},
```

- [ ] **Step 2: IpcApi-Typen**

In `src/shared/types/IpcApi.ts` den `modelCatalog`-Block anpassen:

```ts
modelCatalog: {
  list(group: 'asr' | 'diarization' | 'ner'): Promise<ModelCatalogEntry[]>
  listAsr(): Promise<ModelCatalogEntry[]>
  download(id: string): Promise<ModelCatalogEntry[]>
  delete(id: string): Promise<ModelCatalogEntry[]>
  setActive(group: 'asr' | 'diarization' | 'ner', id: string): Promise<ModelCatalogEntry[]>
  cancelDownload(): Promise<void>
}
```

- [ ] **Step 3: TypeScript-Check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/shared/types/IpcApi.ts
git commit -m "feat: expose group parameter in modelCatalog preload API"
```

---

## Task 9: `ModelCard` als generische Komponente

**Files:**
- Create: `src/renderer/src/components/settings/ModelCard.tsx`
- Modify: `src/renderer/src/components/settings/AsrModelCard.tsx` (verbleibt als Alias)

**Begründung:** `AsrModelCard` ist bereits gruppen-agnostisch aufgebaut (nimmt `ModelCatalogEntry`). Wir verschieben den Inhalt nach `ModelCard.tsx` und lassen `AsrModelCard.tsx` als Re-Export bestehen, um bestehende Imports nicht zu brechen. Der einzige gruppenspezifische Text "Wird für Transkription verwendet" (Zeile 142) wird parametrisiert.

- [ ] **Step 1: `ModelCard.tsx` anlegen** — Inhalt von `AsrModelCard.tsx` kopieren, Props erweitern:

```ts
interface Props {
  model: ModelCatalogEntry
  downloading: boolean
  progress?: number
  anyBusy: boolean
  /** Anzeigetext unterhalb der Karte, wenn das Modell aktiv ist. */
  activeUsageLabel: string
  onDownload: () => void
  onCancelDownload: () => void
  onDelete: () => void
  onActivate: () => void
}
```

Den Footer-Text parametrisieren:

```tsx
{!downloading && model.isInstalled && model.isActive && (
  <span className="text-xs text-text-tertiary">{activeUsageLabel}</span>
)}
```

- [ ] **Step 2: `AsrModelCard.tsx` als Alias**

```tsx
import ModelCard from './ModelCard'
import type { ModelCatalogEntry } from '../../../../shared/validation/model-catalog-schemas'

interface Props {
  model: ModelCatalogEntry
  // ... selbe Props wie bisher ohne activeUsageLabel
}

export default function AsrModelCard(props: Props): React.JSX.Element {
  return <ModelCard {...props} activeUsageLabel="Wird für Transkription verwendet" />
}
```

- [ ] **Step 3: Visuell testen**

```bash
npm run dev
```

Settings → Modelle öffnen. Erwartet: identische ASR-Darstellung wie vor dem Refactor.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/ModelCard.tsx src/renderer/src/components/settings/AsrModelCard.tsx
git commit -m "refactor: extract generic ModelCard from AsrModelCard"
```

---

## Task 10: `ModelsSettings.tsx` um Diarization-Section erweitern

**Files:**
- Modify: `src/renderer/src/components/settings/ModelsSettings.tsx`

**Begründung:** Zweite Section "Sprechererkennungs-Modelle" analog zur ASR-Section. Die Pflicht-Modelle-Liste verliert den pyannote-Eintrag (ist jetzt im Katalog).

- [ ] **Step 1: State um `diarModels` erweitern**

```tsx
const [asrModels, setAsrModels] = useState<ModelCatalogEntry[]>([])
const [diarModels, setDiarModels] = useState<ModelCatalogEntry[]>([])

const reload = async (): Promise<void> => {
  const [asr, diar] = await Promise.all([
    window.api.modelCatalog.list('asr'),
    window.api.modelCatalog.list('diarization')
  ])
  setAsrModels(asr)
  setDiarModels(diar)
}
```

- [ ] **Step 2: Handler group-aware**

```tsx
const handleActivate = async (model: ModelCatalogEntry): Promise<void> => {
  try {
    const updated = await window.api.modelCatalog.setActive(model.group, model.id)
    if (model.group === 'asr') setAsrModels(updated)
    else if (model.group === 'diarization') setDiarModels(updated)
    toast.success(
      `"${model.label}" aktiviert. Neue Verarbeitungen verwenden ab jetzt dieses Modell — bereits verarbeitete Sitzungen bleiben unverändert.`
    )
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  }
}

// Analog für handleDeleteConfirmed (sortiert updated in die richtige State-Slot)
// + handleDownload (onStatus-Subscriber ruft weiterhin reload() auf)
```

- [ ] **Step 3: Alte pyannote-Zeile aus Pflicht-Modelle-Liste entfernen**

In `ModelsSettings.tsx:145` stand bisher:
```tsx
<li>Sprechererkennung (pyannote-community-1)</li>
<li>Anonymisierung (flair-ner-german-large)</li>
```
Nach Task 2 ist pyannote Teil des Katalogs — die Zeile muss **explizit gelöscht** werden, nicht einfach im Refactor mitschwimmen lassen. Die Pflicht-Modelle-Liste enthält nur noch flair.

- [ ] **Step 4: Zwei JSX-Sections rendern**

```tsx
return (
  <div className="space-y-8 p-6">
    <Section
      title="Transkriptions-Modelle"
      description="Wähle das Modell, das für die Transkription deiner Sitzungen verwendet werden soll. Ein Modellwechsel wirkt sich nur auf neue Transkriptionen aus."
      models={asrModels}
      activeUsageLabel="Wird für Transkription verwendet"
      /* ... Handler, anyBusy, downloadingId, progress ... */
    />
    <Section
      title="Sprechererkennungs-Modelle"
      description="Diarization-Modell zur Unterscheidung der Sprecher:innen. Ein Modellwechsel wirkt sich nur auf neue Sitzungen aus."
      models={diarModels}
      activeUsageLabel="Wird für Sprechererkennung verwendet"
      /* ... */
    />

    <section>
      <h3 className="mb-2 text-sm font-medium text-text-tertiary">Pflicht-Modelle</h3>
      <ul className="space-y-1 rounded-md border border-border bg-surface-1 p-3 text-xs text-text-tertiary">
        <li>Anonymisierung (flair-ner-german-large)</li>
      </ul>
    </section>

    {/* ConfirmDialog unverändert */}
  </div>
)
```

`Section` ist eine lokale Komponente (innerhalb der Datei, private), die Installed/Available-Splitting + `ModelCard`-Rendering kapselt. Alternative: die bestehenden Sections kopieren — aber dann doppelter Code für zwei Gruppen.

- [ ] **Step 5: Visuell testen**

```bash
npm run dev
```

- Settings → Modelle: beide Sections sichtbar.
- Diarization zeigt beide Einträge (`Diarization 3.1` als installiert/aktiv, `Community 1` als verfügbar — solange nicht heruntergeladen).

**Hinweis zu Renderer-Mocks:** `App.test.tsx:74` und `SessionDashboard.test.tsx:148` mocken aktuell nur `listAsr` — die Erweiterung um `list(group)` wurde bereits in Task 2.6 Step 1 abgearbeitet. Hier keine weitere Aktion.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/settings/ModelsSettings.tsx
git commit -m "feat: add diarization models section to settings UI"
```

---

## Task 11: `diarize.py` — `--hf-model`-Flag

**Files:**
- Modify: `python_sidecar/diarize.py:82-85`

- [ ] **Step 1: Argument-Parser erweitern**

Am Anfang der `main()`-Funktion (bzw. wo `argparse` konfiguriert wird) hinzufügen:

```python
parser.add_argument(
    "--hf-model",
    required=True,
    help="HuggingFace pipeline identifier, e.g. pyannote/speaker-diarization-3.1",
)
```

- [ ] **Step 2: Offline-Modus erzwingen (CSP-Äquivalent im Python-Subprocess)**

**Begründung:** CSP `connect-src 'none'` (siehe CLAUDE.md, Key Constraints) gilt nur im Electron-Renderer — der Python-Sidecar ist ein separater Prozess und kann theoretisch HTTP-Requests absetzen. pyannote/huggingface-hub könnte Modell-Assets nachladen, wenn der lokale Cache inkomplett ist. Um die Offline-Garantie konsistent zu halten, müssen die HF-Offline-Flags **vor** dem pyannote-Import gesetzt werden:

Ganz oben in `diarize.py` (nach `import os`, vor `from pyannote.audio import Pipeline`):

```python
# CSP-Äquivalent: Alle HuggingFace-Hub-Netzwerk-Requests blockieren.
# Falls ein Sub-Model fehlt, soll der Python-Prozess mit Offline-Error crashen,
# nicht stillschweigend über HTTP nachladen.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
```

- [ ] **Step 3: `from_pretrained()` parametrisieren UND lokalen config.yaml-Fallback entfernen**

Das bestehende Konstrukt in `diarize.py:75-85`:

```python
local_config = os.path.join(args.model_dir, "config.yaml")
if os.path.isfile(local_config):
    pipeline = Pipeline.from_pretrained(local_config)
else:
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        cache_dir=args.model_dir,
    )
```

**Problem:** Der `local_config`-Fallback liest `~/.therascript/models/diarization/config.yaml` — der HuggingFace-Cache speichert config.yaml aber tiefer verschachtelt unter `models--pyannote--speaker-diarization-3.1/snapshots/<hash>/`. Der Branch ist zwar heute effektiv toter Code, würde aber — falls jemand manuell eine config.yaml am falschen Pfad ablegt — den `--hf-model`-Param still übergehen und das falsche Modell laden. Dieser Fallback wird **komplett entfernt**, weil `--hf-model` jetzt `required=True` ist:

```python
pipeline = Pipeline.from_pretrained(
    args.hf_model,
    cache_dir=args.model_dir,
)
```

- [ ] **Step 4: Manueller Test (mit bereits installiertem 3.1-Modell)**

```bash
source python_sidecar/venv/bin/activate
python python_sidecar/diarize.py \
  --audio /tmp/test.wav \
  --model-dir ~/.therascript/models/diarization \
  --hf-model pyannote/speaker-diarization-3.1 \
  --min-speakers 1 --max-speakers 2
```

Expected: RTTM-Output auf stdout, kein "unrecognized arguments". Community-1 wird erst in Task 13 Step 2 heruntergeladen — deshalb **nur** 3.1 in diesem Step testen.

- [ ] **Step 5: Commit**

```bash
git add python_sidecar/diarize.py
git commit -m "feat: make diarize.py accept --hf-model and enforce offline mode"
```

---

## Task 12: `PyannoteSidecar.ts` — aktives Modell durchreichen

**Files:**
- Modify: `src/main/ml/PyannoteSidecar.ts:88-100, 236-250`

- [ ] **Step 1: Aktives Modell laden + `--hf-model` ergänzen**

In `runPyannote` vor dem `args`-Array:

```ts
import { getActiveModelId, getModelById } from '../services/ModelDownloadService'

// ... im runPyannote:
const activeDiarId = getActiveModelId('diarization')
const activeDef = getModelById(activeDiarId)
if (!activeDef || !activeDef.hfIdentifier) {
  throw new Error(
    `Diarization: aktives Modell "${activeDiarId}" hat keinen hfIdentifier — Konfigurationsfehler`
  )
}

const args = [
  ...prefixArgs,
  '--audio',
  audioPath,
  '--model-dir',
  modelDir,
  '--hf-model',
  activeDef.hfIdentifier,
  '--min-speakers',
  '1',
  '--max-speakers',
  '4'
]
```

- [ ] **Step 2: Metadata-Field korrekt setzen**

In `buildDiarizationData` — den hardcoded String entfernen:

```ts
export function buildDiarizationData(
  segments: SpeakerSegment[],
  duration: number,
  modelId: string // NEU
): DiarizationData {
  const uniqueSpeakers = new Set(segments.map((s) => s.label))
  return {
    speakers: segments,
    speakerCount: uniqueSpeakers.size,
    metadata: {
      model: modelId,
      duration
    }
  }
}
```

Call-Site in `execute()`:

```ts
const diarization = buildDiarizationData(segments, audioDurationEstimate, activeDiarId)
```

Signatur-Änderung betrifft **4 Call-Sites** + 1 Assertion in `PyannoteSidecar.test.ts`:

- `:114` `buildDiarizationData(segments, 15)` → `(segments, 15, 'pyannote-speaker-diarization-3.1')`
- `:119` Assertion `metadata: { model: 'pyannote-community-1', ... }` → `'pyannote-speaker-diarization-3.1'` (wird von Task 2.6 bereits mitgezogen, hier als Reminder)
- `:132` `buildDiarizationData(segments, 4)` → `(segments, 4, 'pyannote-speaker-diarization-3.1')`
- `:140` `buildDiarizationData(segments, 10)` → `(segments, 10, 'pyannote-speaker-diarization-3.1')`
- `:146` `buildDiarizationData([], 0)` → `([], 0, 'pyannote-speaker-diarization-3.1')`

**Hinweis:** In Step 2 ist die neue Signatur `(segments, duration, modelId: string)` — jede Call-Site braucht jetzt einen dritten String-Arg. Tests, die nicht speziell das Modell-Feld prüfen, können den Default-Wert `'pyannote-speaker-diarization-3.1'` hart-coden — das hält die Assertions stabil.

- [ ] **Step 3: Tests anpassen + laufen lassen**

```bash
npm run test -- PyannoteSidecar
```

Expected: PASS nach Signatur-Update.

- [ ] **Step 4: E2E-Test im Dev-Build**

```bash
npm run dev
```

Neue Session aufnehmen/importieren, transkribieren, Diarization durchlaufen lassen. Prüfen:
- Keine Fehler im Terminal (`--hf-model`-Arg wird akzeptiert)
- `~/.therascript/sessions/<id>/diarization.json` → `metadata.model` zeigt `"pyannote-speaker-diarization-3.1"`

- [ ] **Step 5: Commit**

```bash
git add src/main/ml/PyannoteSidecar.ts src/main/ml/__tests__/PyannoteSidecar.test.ts
git commit -m "feat: pass active diarization model id through to python sidecar"
```

---

## Task 13: Packaging — zwei Diarization-Tarballs

**Files:**
- Modify: `scripts/package-models.sh`
- Modify: `scripts/setup-pyannote.sh`

**Begründung:** Der bestehende `pyannote-models.tar.gz` bündelt `speaker-diarization-3.1` + `segmentation-3.0` + `wespeaker-voxceleb-resnet34-LM` (sub-models werden vom 3.1-Pipeline-Config referenziert). Für community-1 müssen wir wissen, welche sub-models dessen `config.yaml` referenziert — potenziell dieselben `segmentation-3.0` + `wespeaker`, oder neuere Varianten. Zwei separate Tarballs → atomar, kein Cross-Dependency-Graph, ~30 MB Duplikation akzeptabel.

- [ ] **Step 1: `setup-pyannote.sh` erweitert, um community-1 zu downloaden**

Neues optionales Arg `--model-id <hf-identifier>` (Default: `pyannote/speaker-diarization-3.1`):

```bash
MODEL_IDS=()
for arg in "$@"; do
  case "$arg" in
    --model) MODEL_IDS+=("pyannote/speaker-diarization-3.1") ;;
    --model-community) MODEL_IDS+=("pyannote/speaker-diarization-community-1") ;;
    --all-models)
      MODEL_IDS+=("pyannote/speaker-diarization-3.1")
      MODEL_IDS+=("pyannote/speaker-diarization-community-1") ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done
```

Download-Block in einer Schleife über `MODEL_IDS[@]`.

- [ ] **Step 2: Community-1 lokal downloaden**

```bash
huggingface-cli login  # falls noch nicht geschehen — muss community-1 Terms akzeptiert haben
scripts/setup-pyannote.sh --model-community
```

Expected: `~/.therascript/models/diarization/models--pyannote--speaker-diarization-community-1/` ist vollständig (hat `config.yaml` im snapshot). **Wichtig:** falls dort bereits ein leerer `plda`-Rest liegt (wie aktuell im Dev-Setup), Verzeichnis vorher löschen: `rm -rf ~/.therascript/models/diarization/models--pyannote--speaker-diarization-community-1`.

- [ ] **Step 3: Preflight — Sub-Model-Referenzen aus config.yaml ermitteln**

Bevor der pyannote-Block umgebaut wird, erst die tatsächlich referenzierten Sub-Models auslesen — sonst bundelt das Skript blind und lässt Sub-Models potenziell weg (CSP `connect-src 'none'` verhindert Lazy-Download zur Runtime → Diarization crasht).

Füge oben in `package-models.sh` (direkt nach `MODELS_DIR=...`) eine Helper-Funktion ein:

```bash
# Liest aus einem pyannote-Pipeline-config.yaml die referenzierten Sub-Model-Slugs
# (z.B. "pyannote/segmentation-3.0" → "models--pyannote--segmentation-3.0").
# Gibt die HuggingFace-Cache-Dir-Namen zeilenweise auf stdout aus.
pyannote_submodel_dirs() {
  local CONFIG="$1"
  [ -f "$CONFIG" ] || return 0
  grep -E '^\s+(embedding|segmentation):' "$CONFIG" \
    | awk '{print $2}' \
    | sed 's|/|--|g' \
    | sed 's|^|models--|'
}

# Bündelt ein pyannote-Modell + ALLE aus dessen config.yaml referenzierten Sub-Models in ein Tarball.
# Bricht mit exit 1 ab, wenn ein referenziertes Sub-Model im Cache fehlt.
package_pyannote_model() {
  local MODEL_SLUG="$1"      # z.B. "pyannote/speaker-diarization-3.1"
  local OUTPUT_NAME="$2"     # z.B. "pyannote-speaker-diarization-3.1.tar.gz"

  local CACHE_DIR_NAME="models--$(echo "$MODEL_SLUG" | sed 's|/|--|g')"
  local CACHE_DIR="$MODELS_DIR/diarization/$CACHE_DIR_NAME"

  if [ ! -d "$CACHE_DIR" ]; then
    echo "  SKIP: $MODEL_SLUG nicht im Cache: $CACHE_DIR"
    return 0
  fi

  local CONFIG
  CONFIG=$(find "$CACHE_DIR/snapshots" -name config.yaml -type f -o -type l 2>/dev/null | head -n1)
  if [ -z "$CONFIG" ]; then
    echo "  FEHLER: keine config.yaml in $CACHE_DIR/snapshots/"
    return 1
  fi

  local TMP_DIR
  TMP_DIR=$(mktemp -d)
  cp -R "$CACHE_DIR" "$TMP_DIR/"

  # Referenzierte Sub-Models zwingend bundeln — sonst hart fehlschlagen
  while IFS= read -r SUB_DIR; do
    [ -z "$SUB_DIR" ] && continue
    local SRC="$MODELS_DIR/diarization/$SUB_DIR"
    if [ ! -d "$SRC" ]; then
      echo "  FEHLER: $MODEL_SLUG referenziert $SUB_DIR — aber $SRC fehlt."
      echo "          Bitte zuerst scripts/setup-pyannote.sh für die fehlenden Sub-Models ausführen."
      rm -rf "$TMP_DIR"
      return 1
    fi
    cp -R "$SRC" "$TMP_DIR/"
  done < <(pyannote_submodel_dirs "$CONFIG")

  tar -czf "$OUTPUT_DIR/$OUTPUT_NAME" -C "$TMP_DIR" .
  rm -rf "$TMP_DIR"
  echo "  -> $OUTPUT_NAME"
}
```

- [ ] **Step 4: `package-models.sh` pyannote-Block ersetzen**

Alt (Zeile 26-31):

```bash
if [ -d "$MODELS_DIR/diarization" ]; then
  tar -czf "$OUTPUT_DIR/pyannote-models.tar.gz" -C "$MODELS_DIR/diarization" .
  echo "  -> pyannote-models.tar.gz"
else
  echo "  SKIP: Pyannote-Modelle nicht gefunden: $MODELS_DIR/diarization"
fi
```

Neu:

```bash
package_pyannote_model "pyannote/speaker-diarization-3.1" \
  "pyannote-speaker-diarization-3.1.tar.gz" || exit 1

package_pyannote_model "pyannote/speaker-diarization-community-1" \
  "pyannote-speaker-diarization-community-1.tar.gz" || exit 1
```

Kein `|| true` oder `2>/dev/null` — wenn ein referenziertes Sub-Model fehlt, soll das Skript hart mit nicht-null exiten.

- [ ] **Step 5: `package-models.sh` lokal laufen lassen**

```bash
scripts/package-models.sh
ls -lh r2-upload/
```

Expected: `pyannote-speaker-diarization-3.1.tar.gz` + `pyannote-speaker-diarization-community-1.tar.gz` existieren, SHA-256-Hashes werden gedruckt. **Fehlt ein Sub-Model → exit 1 mit klarer Fehlermeldung**, nicht silent-skip.

- [ ] **Step 6: Commit**

```bash
git add scripts/package-models.sh scripts/setup-pyannote.sh
git commit -m "build: split pyannote tarball into per-model archives with config-driven sub-model bundling"
```

---

## Task 14: Manifest + MODEL_DEFINITIONS SHA/Size aktualisieren

**Files:**
- Modify: `scripts/publish-manifest.sh:72-77` (MODELS-Array)
- Modify: `src/main/services/ModelDownloadService.ts` (Hashes nach Upload)

- [ ] **Step 1: `publish-manifest.sh` — zwei Diarization-Einträge**

Ersetze den pyannote-Eintrag in `MODELS=(…)`:

```bash
declare -a MODELS=(
  "whisper-large-v3-turbo|whisper-ggml-large-v3-turbo-q5_0.bin|Whisper Large V3 Turbo (Multilingual)|asr/ggml-large-v3-turbo-q5_0.bin|false|asr/ggml-large-v3-turbo-q5_0.bin"
  "whisper-large-v3-turbo-swiss|whisper-ggml-large-v3-turbo-swiss-q5_0.bin|Whisper Large V3 Turbo (Swiss-German)|asr/ggml-large-v3-turbo-swiss-q5_0.bin|false|asr/ggml-large-v3-turbo-swiss-q5_0.bin"
  "pyannote-speaker-diarization-3.1|pyannote-speaker-diarization-3.1.tar.gz|Sprechererkennung (Diarization 3.1)|diarization|true|diarization/models--pyannote--speaker-diarization-3.1"
  "pyannote-speaker-diarization-community-1|pyannote-speaker-diarization-community-1.tar.gz|Sprechererkennung (Diarization Community 1)|diarization|true|diarization/models--pyannote--speaker-diarization-community-1"
  "flair-ner-german-large|flair-ner-german-large.tar.gz|Anonymisierung (flair-ner-german-large)|ner|true|ner/models/ner-german-large"
)
```

- [ ] **Step 2: Upload + Hash-Ausgabe**

```bash
npm run sidecar:deploy   # build + package + upload (enthält Whisper + diarization + NER)
# oder nur:
scripts/publish-manifest.sh
```

Kopiere die beiden SHA-256 + sizeBytes aus der Skript-Ausgabe.

- [ ] **Step 3: Hashes in `MODEL_DEFINITIONS` setzen**

Ersetze `PENDING_REPACKAGE` + `PENDING_UPLOAD` bzw. `sizeBytes: 0` mit den tatsächlichen Werten aus manifest.json/Script-Output.

- [ ] **Step 4: First-Launch-Test**

Models-Verzeichnis temporär umbenennen + App starten:

```bash
mv ~/.therascript/models ~/.therascript/models.bak
npm run dev
```

Expected:
- First-Launch-Screen zeigt 3 Downloads an: Whisper (aktiv) + Diarization 3.1 (aktiv, default) + flair.
- Download läuft bis completion.
- App startet, Transkription + Diarization + Anonymisierung laufen normal.

Danach Models zurückspielen:
```bash
# Nur wenn alles funktioniert — sonst models.bak als Fallback:
rm -rf ~/.therascript/models
mv ~/.therascript/models.bak ~/.therascript/models
```

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-manifest.sh src/main/services/ModelDownloadService.ts
git commit -m "chore: set sha256 + size for pyannote diarization models"
```

---

## Task 15: Community-1 Activate-Smoke-Test

**Files:** (keine Code-Änderung — reiner Test)

- [ ] **Step 1: App starten, Community-1 herunterladen**

```bash
npm run dev
```

Settings → Modelle → Sprechererkennungs-Modelle → "Diarization Community 1" → Herunterladen.

Expected: Download-Progress erscheint, nach ~30 MB/wenigen Sekunden abgeschlossen, Status → "Installiert".

- [ ] **Step 2: Community-1 aktivieren**

Auf der eben heruntergeladenen Karte → Aktivieren.

Expected: Toast "… aktiviert", Karte zeigt "Wird für Sprechererkennung verwendet", 3.1-Karte zeigt "Aktivieren"-Button.

- [ ] **Step 3: Neue Session diarizieren**

Test-Audio importieren oder aufnehmen → verarbeiten lassen.

Expected:
- Terminal-Log: `pyannote/speaker-diarization-community-1` wird geladen (stderr-Ausgabe von `diarize.py`).
- `~/.therascript/sessions/<id>/diarization.json` → `metadata.model: "pyannote-speaker-diarization-community-1"`.
- Keine Netzwerk-Requests (CSP `connect-src 'none'` → alles aus lokalem Cache).

- [ ] **Step 4: Community-1 wieder deaktivieren**

Setze wieder 3.1 als aktiv, dann Community-1 löschen können.

Expected: Löschen funktioniert (nicht mehr aktiv). Danach 3.1 nicht mehr löschbar, solange aktiv.

- [ ] **Step 5: Commit (nur falls Doku-Updates erforderlich waren)**

```bash
git add .
git commit -m "docs: note multi-diarization tested end-to-end"
```

---

## Task 16: Docs + CLAUDE.md-Update

**Files:**
- Modify: `CLAUDE.md` (ML-Pipeline-Section)
- Modify: `docs/product/features/model-management.md`
- Modify: `docs/product/features/transcription-pipeline.md`
- Modify: `docs/product/decisions/003-pyannote-diarization.md`

- [ ] **Step 1: `CLAUDE.md` ML-Pipeline-Section — Diarization als auswählbar beschreiben**

Ändere die Zeile zum pyannote-Modell in "ML pipeline — Audio":

```md
2. Python sidecar — pyannote.audio diarization (auswählbares Modell aus Katalog: Default `speaker-diarization-3.1`, optional `speaker-diarization-community-1`) + alignment ✓ implemented
```

- [ ] **Step 2: `model-management.md`** — neue Sektion für Diarization-Modelle analog zu ASR.

- [ ] **Step 3: `003-pyannote-diarization.md`** — Annex zur ADR: "Update 2026-04-23: User kann zwischen 3.1 und community-1 wählen."

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/product/
git commit -m "docs: document multi-diarization model selection"
```

---

## Rollback-Strategie

Falls nach Task 14 ein Problem auftaucht:

1. **Migration-Safe:** Erledigt in Task 2.5 — einmalige Migration in `initSettings()` schreibt `active.diarization === 'pyannote-community-1'` automatisch auf den neuen Key um. Bestehende Installationen bekommen den Fix beim nächsten App-Start.

2. **Disk-Migration:** Bestehende `~/.therascript/models/diarization/` enthält 3.1 + segmentation + wespeaker. Da der neue Tarball denselben Inhalt extrahiert (nur unter einem anderen Tarball-Filename), sollte keine Aktion nötig sein — der `checkPath` (`diarization/models--pyannote--speaker-diarization-3.1`) existiert bereits.

3. **R2-Backup:** Das alte `pyannote-models.tar.gz` auf R2 nicht sofort löschen — erst nach 1-2 Releases, falls ein Rollback nötig ist.

---

## Open Questions für die Umsetzung

1. **Sub-models-Sharing:** Wenn `community-1/config.yaml` dieselben `segmentation-3.0` + `wespeaker-voxceleb-resnet34-LM` referenziert → Tarballs duplizieren (akzeptabel, ~30 MB). Wenn andere — erst im Task 13 entscheiden (ggf. eigenes Bundle oder CSP-kompatibler Lazy-Load-Workaround).

2. **Settings-Migration für bestehende User:** Entschieden — einmalige Migration in `initSettings()` (siehe Task 2.5). Alias im `getModelById`-Lookup wurde verworfen, weil er dauerhaft Altlast hinterlassen hätte.

3. **`isRequired` für NER behalten?** Ja. Bleibt als "single-mandatory"-Escape-Hatch für eine Ein-Modell-Gruppe.

---

## Acceptance Criteria (Definition of Done)

- [ ] Settings → Modelle zeigt zwei Sections: Transkriptions- und Sprechererkennungs-Modelle.
- [ ] Diarization-Section listet beide Einträge, einer ist aktiv.
- [ ] User kann Community-1 herunterladen, aktivieren, diarizieren.
- [ ] Das zuletzt aktive Modell wird auf Restart persistiert und verwendet.
- [ ] `diarization.json` `metadata.model` enthält die korrekte Modell-ID.
- [ ] Das aktive Diarization-Modell kann nicht gelöscht werden (UX-Fehlermeldung).
- [ ] First-Launch auf frischem `~/.therascript/models/` lädt das Default-Modell (3.1) automatisch.
- [ ] Alle bestehenden Tests grün (`npm run test`).
- [ ] `npm run typecheck` grün.
- [ ] `npm run lint` grün.
- [ ] Keine `pyannote-community-1`-String-Vorkommen mehr in `src/` (via `grep -rn pyannote-community-1 src/` verifizierbar).
- [ ] Bestehende Installation mit `activeModels.diarization === 'pyannote-community-1'` migriert beim ersten App-Start auf neuen Key + `installedModelVersions`-Entry umgeschrieben.
- [ ] Unbekannte/manipulierte `activeModels.diarization`-Werte werden defensiv auf Default repariert (Warning im Log).
- [ ] Python-Sidecar hat `HF_HUB_OFFLINE=1` gesetzt — kein Silent-HTTP-Load möglich.
- [ ] `ModelDefinition` mit `sha256: 'PENDING_*'` wirft bei Download-Start einen klaren Fehler (kein kryptisches SHA-Mismatch).
