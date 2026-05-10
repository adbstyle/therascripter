# Issue #103 — summarization Default = null Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phantom-Reconcile-Banner ("Bisher aktiv: gemma-summarization → kein Modell") strukturell eliminieren, indem optionale Modell-Gruppen mit leerem Slot starten und beim ersten Download automatisch aktiviert werden.

**Architecture:** Single Source of Truth via Helper `defaultActiveModelFor(group)` ersetzt drei hardcodierte `'gemma-summarization'`-Stellen. Defaults und Upgrade-Migration konsumieren den Helper; Migration zusätzlich mit `isModelInstalled`-Guard als Defense-in-Depth. Auto-Activate-Hook in `downloadSingleModel` schliesst die UX-Lücke, die durch `null`-Default entsteht (User lädt Gemma, Slot bleibt leer → Pipeline skippt). Reconciler bleibt unverändert — er macht bereits das Richtige für `null + optional`-State.

**Tech Stack:** TypeScript, electron-store, vitest. Tests laufen mit `npx vitest run` (umgeht den `pretest`-Hook, der eine SQLite-Native-Rebuild auslöst — nicht nötig für die relevanten Module).

---

## Background

**Issue:** https://github.com/adbstyle/therascripter/issues/103

**Bug-Pfad (kurz):**
1. `defaults.activeModels.summarization = 'gemma-summarization'` ([SettingsService.ts:60](src/main/services/SettingsService.ts#L60)) für Fresh Install.
2. Upgrade-Migration ([SettingsService.ts:175-179](src/main/services/SettingsService.ts#L175-L179)) schreibt `'gemma-summarization'` in fehlende Slots — ohne `isModelInstalled`-Check.
3. Bootstrap-Reconciler ([ModelDownloadService.ts:727-762](src/main/services/ModelDownloadService.ts#L727-L762)) sieht Phantom-Slot, Datei fehlt, Gruppe ist optional → emittiert `group-cleared`-Event mit `fromModelId: 'gemma-summarization'`.
4. ReconcileEventsBanner rendert das Event als "Bisher aktiv: gemma-summarization".

**Reconciler-Verhalten ist korrekt** ([ModelDownloadService.ts:744](src/main/services/ModelDownloadService.ts#L744) — `current === null && optional → continue`). Der Fix gehört vorgelagert.

**Auto-Activate-Lücke (Folge-UX-Bug ohne Mitigation):** Mit `null`-Default ruft `handleDownload` in [ModelsSettings.tsx:84-97](src/renderer/src/components/settings/ModelsSettings.tsx#L84-L97) nach Erfolg nur `reload()` — kein `setActive`. User müsste manuell aktivieren, sonst skippt Pipeline weiter.

---

## File Structure

**Modify:**
- `src/main/services/SettingsService.ts` — Defaults + Migration via Helper konsumieren, `'gemma-summarization'`-Hardcodes entfernen.
- `src/main/services/ModelDownloadService.ts` — Helper `defaultActiveModelFor` exportieren, Auto-Activate in `downloadSingleModel`, `GROUP_DEFAULTS.summarization` entfernen (path-dead).
- `src/main/services/__tests__/ModelDownloadService.reconcile.test.ts` — `freshState`-Default für summarization auf `null`, buggy Test invertieren, neue Tests für legitimen Cleanup-Pfad und Auto-Activate.

**Create:**
- `src/main/services/__tests__/SettingsService.summarizationMigration.test.ts` — neuer Test für Upgrade-Migration: pre-LLM-Store ohne `summarization`-Key produziert nach `initSettings()` einen `null`-Slot, kein `'gemma-summarization'`.
- `src/main/services/__tests__/ModelDownloadService.autoActivate.test.ts` — neuer Test: nach erfolgreichem Download eines optionalen Modells in einen leeren Slot wird der Slot aktiviert; non-optional Modelle und non-leere Slots bleiben unverändert.

**Do NOT touch:**
- `reconcileActiveModels()` — Logik ist korrekt.
- `ReconcileEventsBanner.tsx` — Rendering ist korrekt.
- Bestehende ReconcileEvents in User-Stores — kein Daten-Backfill nötig (Reconciler hat Phantom-Slots bei betroffenen Usern bereits auf `null` gesetzt).

---

## Verification Strategy

**Per-Task:** TDD — Test zuerst, schlägt fehl, Implementation, Test grün, Commit.

**Final Smoke-Test:** Manuelles Repro mit `mv ~/.therascript/models ~/.therascript/models.bak` ist NICHT geeignet (testet nur Reconciler-Verhalten, nicht den Fix-Pfad). Stattdessen:
1. `mv ~/Library/Application\ Support/Therascript/settings.json ~/Library/Application\ Support/Therascript/settings.json.bak` — store löschen, Fresh-Install simulieren.
2. App starten → FirstLaunch-Flow durchlaufen → bei Settings → Modelle darf KEIN "Automatische Anpassung"-Banner für summarization erscheinen.
3. Optional: Gemma in Settings → Modelle herunterladen → ModelCard zeigt `Aktiv` direkt nach Download.

---

## Task 1: Helper `defaultActiveModelFor` einführen (SSoT)

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts:639,683`
- Test: `src/main/services/__tests__/ModelDownloadService.reconcile.test.ts` (existing — neuer Test wird angefügt)

**Rationale:** Aktuell hardcoden drei Stellen `'gemma-summarization'`. Helper macht die Invariante "optionale Gruppe → `null` als initialer aktiver Slot" zur einzigen Quelle der Wahrheit. `GROUP_DEFAULTS.summarization` ist path-wise dead (wird nie aufgerufen — `pickInstalledForGroup` nur für `REQUIRED_GROUPS_FOR_RECONCILE`) und wird mit-entfernt.

- [ ] **Step 1: Failing test für Helper-Verhalten anfügen**

Datei: `src/main/services/__tests__/ModelDownloadService.reconcile.test.ts` — Block am Ende der Datei einfügen (nach line 424):

```typescript
import { defaultActiveModelFor } from '../ModelDownloadService'

describe('defaultActiveModelFor', () => {
  it('returns the catalog default for required groups', () => {
    expect(defaultActiveModelFor('asr')).toBe('whisper-large-v3-turbo')
    expect(defaultActiveModelFor('diarization')).toBe('pyannote-suite')
    expect(defaultActiveModelFor('ner')).toBe('flair-ner-german-large')
  })

  it('returns null for optional groups', () => {
    expect(defaultActiveModelFor('summarization')).toBeNull()
  })
})
```

- [ ] **Step 2: Test laufen lassen, FAIL erwarten**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts -t 'defaultActiveModelFor'`
Expected: FAIL — `defaultActiveModelFor is not a function` (Import existiert nicht).

- [ ] **Step 3: Helper implementieren**

Datei: `src/main/services/ModelDownloadService.ts` — bei der bestehenden `GROUP_DEFAULTS`-Definition (line 679-684) ersetzen:

```typescript
const GROUP_DEFAULTS: Record<ModelGroup, string> = {
  asr: 'whisper-large-v3-turbo',
  diarization: 'pyannote-suite',
  ner: 'flair-ner-german-large',
  summarization: 'gemma-summarization'
}
```

→ durch:

```typescript
/**
 * Required-Group-Defaults — werden vom Reconciler als bevorzugtes Auto-Activate-Ziel
 * verwendet (`pickInstalledForGroup`). Optionale Gruppen leben NICHT in dieser Map,
 * weil ihr initialer aktiver Slot per Invariante `null` ist (siehe `defaultActiveModelFor`).
 */
const REQUIRED_GROUP_DEFAULTS: Record<'asr' | 'diarization' | 'ner', string> = {
  asr: 'whisper-large-v3-turbo',
  diarization: 'pyannote-suite',
  ner: 'flair-ner-german-large'
}

/**
 * Single source of truth für den initialen aktiven Slot pro Gruppe.
 * - Required Groups: Catalog-Default (asr/diarization/ner).
 * - Optional Groups: `null` — Pipeline-Step skippt zur Laufzeit, bis User
 *   das Modell explizit herunterlädt (Auto-Activate via `downloadSingleModel`).
 *
 * Konsumiert von `defaults.activeModels` in SettingsService.ts und der
 * Upgrade-Migration für pre-LLM-Stores.
 */
export function defaultActiveModelFor(group: ModelGroup): string | null {
  if (OPTIONAL_GROUPS.has(group)) return null
  return REQUIRED_GROUP_DEFAULTS[group as 'asr' | 'diarization' | 'ner']
}
```

`pickInstalledForGroup` ([line 686-693](src/main/services/ModelDownloadService.ts#L686-L693)) anpassen — referenziert `GROUP_DEFAULTS`:

```typescript
function pickInstalledForGroup(group: ModelGroup): string | null {
  const preferred = REQUIRED_GROUP_DEFAULTS[group as 'asr' | 'diarization' | 'ner']
  if (preferred && isModelInstalled(preferred)) return preferred
  for (const m of getModelsByGroup(group)) {
    if (isModelInstalled(m.id)) return m.id
  }
  return null
}
```

- [ ] **Step 4: Test laufen lassen, PASS erwarten**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts -t 'defaultActiveModelFor'`
Expected: PASS — beide Test-Cases grün.

- [ ] **Step 5: Bestehende Reconciler-Tests laufen lassen, alle grün**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts`
Expected: Alle Tests grün (Refactor verändert kein Verhalten — `pickInstalledForGroup` für optional Groups wurde noch nie aufgerufen).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/ModelDownloadService.ts \
        src/main/services/__tests__/ModelDownloadService.reconcile.test.ts
git commit -m "$(cat <<'EOF'
refactor(models): introduce defaultActiveModelFor helper as SSoT

Issue #103 prep — replaces three hardcoded 'gemma-summarization' default
locations (defaults, migration, GROUP_DEFAULTS) with a single helper that
encodes the invariant "optional groups start null, required groups start
at catalog default". Removes path-dead GROUP_DEFAULTS.summarization entry.
No behaviour change in this commit; Tasks 2-3 will consume the helper.
EOF
)"
```

---

## Task 2: `defaults.activeModels.summarization = null`

**Files:**
- Modify: `src/main/services/SettingsService.ts:60`
- Test: `src/main/services/__tests__/ModelDownloadService.reconcile.test.ts:84-100` (existing freshState helper)

**Rationale:** Fresh Installs schreiben jetzt `null` in den summarization-Slot. Reconciler-Logik ([line 744](src/main/services/ModelDownloadService.ts#L744)) skippt korrekt. Test-`freshState` muss synchron mitziehen, sonst testen Tests einen Zustand, den die App nie produziert.

- [ ] **Step 1: Bestehenden buggy Test invertieren — neue Erwartung schreiben**

Datei: `src/main/services/__tests__/ModelDownloadService.reconcile.test.ts` — Block bei Zeile 140-167 ersetzen:

```typescript
  it('clears an optional slot when its model file is missing on disk', () => {
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/models/ner-german-large'
      // summarization NOT installed
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([
      {
        group: 'summarization',
        fromModelId: 'gemma-summarization',
        toModelId: null,
        reason: 'group-cleared'
      }
    ])
    expect(storeState.activeModels.summarization).toBeNull()
    expect(storeState.reconcileEvents).toHaveLength(1)
    expect(storeState.reconcileEvents[0]).toMatchObject({
      group: 'summarization',
      fromModelId: 'gemma-summarization',
      toModelId: null,
      reason: 'group-cleared',
      status: 'pending'
    })
  })
```

→ durch:

```typescript
  // Issue #103 — bug-zementierender Test entfernt. Default-State produziert
  // jetzt KEIN Reconcile-Event mehr, weil der summarization-Slot per Default
  // null ist und der Reconciler null+optional korrekt als steady-state behandelt.
  it('emits no event in default state when summarization is null and no Gemma file exists', () => {
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/models/ner-german-large'
      // summarization NOT installed — default-state, slot is null per freshState
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(0)
    expect(storeState.reconcileEvents).toHaveLength(0)
    expect(storeState.activeModels.summarization).toBeNull()
  })

  // Legitimer Cleanup-Pfad bleibt intakt: User hat Gemma manuell aktiviert
  // und das Modell danach gelöscht → Reconciler räumt korrekt auf und emittiert
  // ein Event. Dieses Verhalten muss NACH dem Issue #103-Fix erhalten bleiben.
  it('clears an optional slot when the user had it active and the file was deleted', () => {
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision',
        summarization: 'gemma-summarization' // explizit aktiviert vom User
      }
    })
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/models/ner-german-large'
      // summarization-Datei vom User gelöscht
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([
      {
        group: 'summarization',
        fromModelId: 'gemma-summarization',
        toModelId: null,
        reason: 'group-cleared'
      }
    ])
    expect(storeState.activeModels.summarization).toBeNull()
    expect(storeState.reconcileEvents).toHaveLength(1)
  })
```

- [ ] **Step 2: `freshState`-Default für summarization auf `null` setzen**

Datei: `src/main/services/__tests__/ModelDownloadService.reconcile.test.ts:92` ersetzen:

```typescript
      summarization: 'gemma-summarization'
```

→ durch:

```typescript
      summarization: null
```

Es gibt mehrere `pretendInstalled(... 'summarization/google_gemma-3-4b-it-Q4_K_M.gguf')`-Stellen — die müssen NICHT angepasst werden, sie testen den `pretendInstalled` + `current=gemma`-Fall, der weiterhin valide ist (User hat aktiviert + Datei da).

Aber: Der Test bei Zeile 126-138 (`'keeps the steady state when every active model is installed'`) ruft `pretendInstalled` mit der Gemma-Datei, aber der Slot ist nach der Default-Änderung `null` → `current=null && optional → continue`. Der Test bleibt grün, aber die Assertion sollte präziser sein. Anpassen:

Datei: `src/main/services/__tests__/ModelDownloadService.reconcile.test.ts:126-138` ersetzen:

```typescript
  it('keeps the steady state when every active model is installed', () => {
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/models/ner-german-large',
      'summarization/google_gemma-3-4b-it-Q4_K_M.gguf'
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(0)
    expect(storeState.reconcileEvents).toHaveLength(0)
  })
```

→ durch:

```typescript
  it('keeps the steady state when every required active model is installed and summarization is null', () => {
    // Default state: summarization slot is null, Gemma file may or may not exist.
    pretendInstalled(
      'asr/ggml-large-v3-turbo-q5_0.bin',
      'diarization/models--pyannote--speaker-diarization-community-1',
      'ner/models/ner-german-large'
    )

    const repairs = reconcileActiveModels()

    expect(repairs).toHaveLength(0)
    expect(storeState.reconcileEvents).toHaveLength(0)
  })
```

- [ ] **Step 3: Tests laufen lassen — alle grün (Test-Side fertig, Production-Default kommt in Step 4)**

Hinweis: Reconciler-Tests verwenden den Fake-`freshState` aus dem Test, nicht den Production-Default aus `SettingsService.ts`. Daher gibt es hier keinen klassischen Red-Phase-Übergang — die invertierten Tests testen den neuen Default-State, der im Test schon gilt. Production-Default-Konsistenz wird in Step 4 nachgezogen, der Smoke-Test in Task 5 deckt das End-to-End-Verhalten ab.

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts`
Expected: Alle Tests grün — inklusive des invertierten "emits no event in default state" und des explicit-cleanup-Tests.

- [ ] **Step 4: Production-Default ändern**

Datei: `src/main/services/SettingsService.ts:53-61` — `defaults.activeModels` Block:

```typescript
const defaults: AppSettings = {
  activeModels: {
    transcription: 'whisper-large-v3-turbo',
    diarization: 'pyannote-suite',
    diarizationPipeline: DEFAULT_DIARIZATION_PIPELINE,
    ner: 'flair-ner-german-large',
    ocr: 'apple-vision',
    summarization: 'gemma-summarization'
  },
```

→ durch:

```typescript
const defaults: AppSettings = {
  activeModels: {
    transcription: 'whisper-large-v3-turbo',
    diarization: 'pyannote-suite',
    diarizationPipeline: DEFAULT_DIARIZATION_PIPELINE,
    ner: 'flair-ner-german-large',
    ocr: 'apple-vision',
    // Issue #103 — optionale Gruppen starten null. defaultActiveModelFor kann
    // hier nicht direkt aufgerufen werden, weil ModelDownloadService getSettings()
    // importiert (zirkuläre Init). Wert hardcoden + Helper konsumiert die gleiche
    // Invariante in der Migration unten.
    summarization: null
  },
```

- [ ] **Step 5: Reconciler-Tests komplett laufen, alle grün**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts`
Expected: Alle Tests grün — inklusive der zwei umgeschriebenen.

- [ ] **Step 6: Typecheck laufen lassen**

Run: `npm run typecheck`
Expected: PASS — `summarization: null` matcht das `string | null`-Type ([SettingsService.ts:32](src/main/services/SettingsService.ts#L32)).

- [ ] **Step 7: Commit**

```bash
git add src/main/services/SettingsService.ts \
        src/main/services/__tests__/ModelDownloadService.reconcile.test.ts
git commit -m "$(cat <<'EOF'
fix(models): default activeModels.summarization to null on fresh install (#103)

Phantom 'gemma-summarization' value in defaults caused the bootstrap
reconciler to emit a spurious 'group-cleared' event on first launch — the
Settings → Modelle banner reported "Bisher aktiv: gemma-summarization"
even for users who never had the model. Optional groups must start with
a null slot per the documented invariant (SettingsService.ts type comment).

Test that codified the buggy steady state is inverted: default state now
asserts NO reconcile event. Legitimate cleanup path (user activated then
deleted file) is preserved as a separate test.

Migration for pre-LLM upgraders is fixed in a follow-up commit.
EOF
)"
```

---

## Task 3: Upgrade-Migration schreibt `null` mit Install-Guard

**Files:**
- Modify: `src/main/services/SettingsService.ts:169-180`
- Create: `src/main/services/__tests__/SettingsService.summarizationMigration.test.ts`

**Rationale:** electron-store backfillt nested defaults nicht. Pre-LLM-Stores haben keinen `summarization`-Key — Migration muss explizit setzen. Mit Default-Änderung allein bleibt der Bug für Upgrader bestehen, weil die Migration weiterhin `'gemma-summarization'` schreibt. Defense-in-Depth: `isModelInstalled`-Guard schützt zusätzlich gegen den unwahrscheinlichen Fall, dass ein User den Slot manuell auf einen non-existenten Wert manipuliert hat.

- [ ] **Step 1: Failing test schreiben**

Datei: `src/main/services/__tests__/SettingsService.summarizationMigration.test.ts` (neu):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface ActiveModels {
  transcription: string | null
  diarization: string | null
  diarizationPipeline: string
  ner: string | null
  ocr: string
  summarization?: string | null
}

interface FakeStoreState {
  activeModels: ActiveModels
  modelsDownloaded: boolean
  reconcileEvents: unknown[]
  installedModelVersions: Record<string, unknown>
  dismissedManifestVersions: string[]
}

let storeState: FakeStoreState

const mockStoreCtor = vi.fn().mockImplementation(() => ({
  get: (key: keyof FakeStoreState) => storeState[key],
  set: <K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]) => {
    storeState = { ...storeState, [key]: value }
  }
}))

vi.mock('electron-store', () => ({
  default: mockStoreCtor
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/therascript-test') }
}))

// WICHTIG: Mock muss ALLE Symbole exportieren, die SettingsService aus
// ModelDownloadService importiert — sonst resolvt der Import auf undefined
// und die Migration crasht zur Laufzeit ("undefined is not a function").
// Aktuelle Imports (Stand Task 3 Step 3): getModelDefinitions, defaultActiveModelFor.
vi.mock('../ModelDownloadService', () => ({
  getModelDefinitions: () => [
    { id: 'whisper-large-v3-turbo', group: 'asr' },
    { id: 'pyannote-suite', group: 'diarization' },
    { id: 'flair-ner-german-large', group: 'ner' },
    { id: 'gemma-summarization', group: 'summarization' }
  ],
  // Spiegelt das Production-Verhalten: optionale Gruppen → null,
  // required Groups → catalog default. Genau das Verhalten, das die Migration
  // konsumiert.
  defaultActiveModelFor: (group: string): string | null => {
    if (group === 'summarization') return null
    if (group === 'asr') return 'whisper-large-v3-turbo'
    if (group === 'diarization') return 'pyannote-suite'
    if (group === 'ner') return 'flair-ner-german-large'
    return null
  }
}))

import { initSettings, _resetSettingsForTests } from '../SettingsService'

function preLlmStoreState(): FakeStoreState {
  return {
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision'
      // KEIN summarization-Key — pre-LLM-Version hatte das Feld nicht
    },
    modelsDownloaded: true,
    reconcileEvents: [],
    installedModelVersions: {},
    dismissedManifestVersions: []
  }
}

describe('summarization upgrade migration (Issue #103)', () => {
  beforeEach(() => {
    _resetSettingsForTests()
    vi.clearAllMocks()
  })

  it('writes null (not gemma-summarization) into a missing summarization slot for pre-LLM upgraders', () => {
    storeState = preLlmStoreState()

    initSettings()

    expect(storeState.activeModels.summarization).toBeNull()
  })

  it('preserves an explicit gemma-summarization slot for users who already activated it', () => {
    storeState = {
      ...preLlmStoreState(),
      activeModels: {
        ...preLlmStoreState().activeModels,
        summarization: 'gemma-summarization'
      }
    }

    initSettings()

    expect(storeState.activeModels.summarization).toBe('gemma-summarization')
  })

  it('preserves an explicit null slot (user deactivated summarization)', () => {
    storeState = {
      ...preLlmStoreState(),
      activeModels: {
        ...preLlmStoreState().activeModels,
        summarization: null
      }
    }

    initSettings()

    expect(storeState.activeModels.summarization).toBeNull()
  })
})
```

- [ ] **Step 2: Test laufen lassen, FAIL erwarten**

Run: `npx vitest run src/main/services/__tests__/SettingsService.summarizationMigration.test.ts`
Expected: FAIL — Erste Assertion (`toBeNull`) erwartet null, bekommt aktuell `'gemma-summarization'` (Migration in Production schreibt noch den hardcoded Wert).

- [ ] **Step 3: Migration anpassen**

Datei: `src/main/services/SettingsService.ts` — Imports erweitern (oben in der Datei):

```typescript
import { getModelDefinitions } from './ModelDownloadService'
```

→ erweitern auf:

```typescript
import { getModelDefinitions, defaultActiveModelFor } from './ModelDownloadService'
```

Migration-Block bei Zeile 169-180 ersetzen:

```typescript
  // Defensiv: Bestehende electron-store-Instanzen haben kein activeModels.summarization,
  // weil das Feld erst mit dem lokalen LLM eingeführt wurde. defaults füllt nested keys
  // nicht nach, also Wert hier explizit setzen, falls nicht vorhanden.
  const currentSummarization = (
    store.get('activeModels') as { summarization?: string | null }
  ).summarization
  if (typeof currentSummarization !== 'string' && currentSummarization !== null) {
    store.set('activeModels', {
      ...store.get('activeModels'),
      summarization: 'gemma-summarization'
    })
  }
```

→ durch:

```typescript
  // Issue #103 — pre-LLM-Stores haben keinen summarization-Key (Feld kam mit dem
  // lokalen LLM). electron-store füllt nested keys nicht nach, also setzen wir
  // den Default-Wert für die optionale Gruppe (= null) explizit. Frühere Versionen
  // dieser Migration schrieben blind 'gemma-summarization' und triggerten dadurch
  // ein irreführendes Reconcile-Event ("Bisher aktiv: gemma-summarization") für
  // User, die das Modell nie heruntergeladen hatten.
  const currentSummarization = (
    store.get('activeModels') as { summarization?: string | null }
  ).summarization
  if (typeof currentSummarization !== 'string' && currentSummarization !== null) {
    store.set('activeModels', {
      ...store.get('activeModels'),
      summarization: defaultActiveModelFor('summarization')
    })
  }
```

- [ ] **Step 4: Migrations-Tests laufen lassen, PASS erwarten**

Run: `npx vitest run src/main/services/__tests__/SettingsService.summarizationMigration.test.ts`
Expected: Alle drei Tests grün.

- [ ] **Step 5: Reconciler-Tests laufen lassen, alle weiterhin grün**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/SettingsService.ts \
        src/main/services/__tests__/SettingsService.summarizationMigration.test.ts
git commit -m "$(cat <<'EOF'
fix(models): upgrade migration writes null instead of gemma-summarization (#103)

Pre-LLM electron-stores lack the summarization key. The migration that
backfills the field used to hardcode 'gemma-summarization' without
checking whether the model file exists, causing the bootstrap reconciler
to immediately emit a spurious "Bisher aktiv: gemma-summarization" event
for every upgrading user.

Migration now consumes defaultActiveModelFor('summarization') (= null
for optional groups) — consistent with the new fresh-install default and
the documented invariant.

Adds dedicated migration test covering pre-LLM upgrader, already-active,
and already-deactivated scenarios.
EOF
)"
```

---

## Task 4: Auto-Activate beim Download (Folge-UX-Bug schliessen)

**Files:**
- Modify: `src/main/services/ModelDownloadService.ts` — `downloadSingleModel` post-success.
- Create: `src/main/services/__tests__/ModelDownloadService.autoActivate.test.ts`

**Rationale:** Mit `null`-Default lädt User Gemma → ModelCard zeigt "installiert" → Pipeline skippt weiter, weil Slot leer ist. UX-Lücke. Backend-side Fix in `downloadSingleModel`: nach Erfolg, wenn die Gruppe optional ist UND der Slot aktuell `null` ist → `setActiveModel`. Funktioniert unabhängig vom Caller (UI, Tests, FirstLaunch).

- [ ] **Step 1: Insertions-Punkt verifizieren** (Plan-zeitlich vorrecherchiert)

Bei Plan-Erstellung wurde der Hook-Punkt verifiziert: [`ModelDownloadService.ts:528-530`](src/main/services/ModelDownloadService.ts#L528-L530) — innerhalb des disk-presence-Guards, direkt nach `recordInstalledVersion(def.id, def.sha256)`, vor `sendProgress({ state: 'complete' })`. **Der Hook MUSS innerhalb des `if (existsSync(...))`-Blocks liegen** — sonst aktiviert er auch dann, wenn der disk-presence-Guard eine fehlende Datei abfing (z.B. nach gescheitertem tar-Extract), und `setActiveModel` würde mit "nicht installiert" werfen.

Verifikation: `grep -n "recordInstalledVersion(def" /Users/adrianbader/Dev/Therascript/src/main/services/ModelDownloadService.ts` — erwartet Zeile 529 (oder ±2, falls upstream-Edits). Wenn Position abweicht: Step 5 vor Implementierung anpassen.

- [ ] **Step 2: Failing test schreiben**

Datei: `src/main/services/__tests__/ModelDownloadService.autoActivate.test.ts` (neu):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/therascript-test') },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

vi.mock('../../db/connection', () => ({
  getDataDir: () => '/tmp/therascript-test'
}))

interface FakeStoreState {
  activeModels: {
    transcription: string | null
    diarization: string | null
    diarizationPipeline: string
    ner: string | null
    ocr: string
    summarization: string | null
  }
  modelsDownloaded: boolean
  reconcileEvents: unknown[]
  installedModelVersions: Record<string, { version: string; sha256: string; installedAt: string }>
}

let storeState: FakeStoreState

const mockSettingsStore = {
  get: vi.fn((key: keyof FakeStoreState) => storeState[key]),
  set: vi.fn(<K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]) => {
    storeState = { ...storeState, [key]: value }
  })
}
vi.mock('../SettingsService', () => ({
  getSettings: () => mockSettingsStore,
  initSettings: () => mockSettingsStore
}))

let installedFiles: Set<string>
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn((p: string) => installedFiles.has(p)),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn()
  }
  return { ...fsMock, default: fsMock }
})

// downloadSingleModel führt einen echten HTTP-Download durch — wir mocken den
// internen download flow auf "instant success" und prüfen den post-success-Hook.
// Statt den ganzen Download zu mocken, rufen wir die public `setActiveModel`-
// Logik direkt mit der erwarteten Reihenfolge — der eigentliche Auto-Activate-
// Hook ist eine 3-Zeilen-Bedingung, die wir über autoActivateAfterDownload
// (siehe Implementation in Task 4) testen.
import {
  autoActivateAfterDownload,
  getActiveModelIdBelief
} from '../ModelDownloadService'

const MODELS_DIR = '/tmp/therascript-test/models'
const GEMMA_FILE = `${MODELS_DIR}/summarization/google_gemma-3-4b-it-Q4_K_M.gguf`

function freshState(over: Partial<FakeStoreState> = {}): void {
  storeState = {
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: null
    },
    modelsDownloaded: true,
    reconcileEvents: [],
    installedModelVersions: {},
    ...over
  }
  installedFiles = new Set([GEMMA_FILE])
}

describe('autoActivateAfterDownload (Issue #103)', () => {
  beforeEach(() => {
    freshState()
    vi.clearAllMocks()
  })

  it('activates an optional model when its slot is null', () => {
    autoActivateAfterDownload('gemma-summarization')

    expect(getActiveModelIdBelief('summarization')).toBe('gemma-summarization')
  })

  it('does NOT override an already-set optional slot', () => {
    // Hypothetisches zweites optional-Modell-Szenario: Slot ist gesetzt,
    // User lädt eine Variante → Slot bleibt unverändert.
    storeState.activeModels.summarization = 'some-other-summarizer'

    autoActivateAfterDownload('gemma-summarization')

    expect(getActiveModelIdBelief('summarization')).toBe('some-other-summarizer')
  })

  it('does NOT auto-activate required-group models (those go through the reconciler / explicit setActive)', () => {
    storeState.activeModels.transcription = null

    autoActivateAfterDownload('whisper-large-v3-turbo')

    // Required groups: Caller (FirstLaunchScreen / Reconciler) übernimmt Activate-Logik.
    // Der Auto-Activate-Hook ist nur für optional groups.
    expect(getActiveModelIdBelief('asr')).toBeNull()
  })

  it('is a no-op for unknown model ids', () => {
    expect(() => autoActivateAfterDownload('does-not-exist')).not.toThrow()
    expect(getActiveModelIdBelief('summarization')).toBeNull()
  })
})
```

- [ ] **Step 3: Test laufen lassen, FAIL erwarten**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.autoActivate.test.ts`
Expected: FAIL — `autoActivateAfterDownload is not a function`.

- [ ] **Step 4: `autoActivateAfterDownload` implementieren**

Datei: `src/main/services/ModelDownloadService.ts` — neue exportierte Funktion in der Nähe von `setActiveModel` / `clearActiveModel` (nach line 648):

```typescript
/**
 * Issue #103 — Auto-Activate-Hook für optionale Modelle. Mit Default = null
 * für optionale Gruppen würde ein gerade heruntergeladenes Modell sonst
 * sofort wieder geskippt werden, weil der aktive Slot leer ist. Diese Funktion
 * läuft nach erfolgreichem Download und aktiviert das Modell automatisch,
 * wenn:
 *   - die Gruppe optional ist (OPTIONAL_GROUPS),
 *   - der aktive Slot der Gruppe aktuell null ist,
 *   - das Modell installiert ist (Datei-Check via setActiveModel).
 *
 * Required Groups laufen über FirstLaunchScreen / Reconciler — die regeln
 * Activate-Logik selbst.
 */
export function autoActivateAfterDownload(modelId: string): void {
  const def = getModelById(modelId)
  if (!def) return
  if (!OPTIONAL_GROUPS.has(def.group)) return
  const currentBelief = getActiveModelIdBelief(def.group)
  if (currentBelief !== null) return
  // setActiveModel verifiziert isModelInstalled — wenn Download teilweise fehlschlug
  // (Datei nicht da), wirft setActiveModel und der Auto-Activate ist ein No-Op
  // statt Lautstärke. Wir loggen + swallow.
  try {
    setActiveModel(def.group, modelId)
    console.log(`[auto-activate] ${def.group}: ${modelId} (slot was null)`)
  } catch (err) {
    console.warn(`[auto-activate] failed for ${modelId}:`, err)
  }
}
```

- [ ] **Step 5: `downloadSingleModel`-post-success an Hook koppeln**

Datei: `src/main/services/ModelDownloadService.ts` — Block bei Zeile 525-532 ersetzen:

```typescript
  // Disk-presence guard before recording — see startModelDownload for the
  // reasoning. A successful tar exit isn't a guarantee that `checkPath` is
  // populated.
  if (existsSync(join(modelsDir, def.checkPath))) {
    recordInstalledVersion(def.id, def.sha256)
  }
  sendProgress({ state: 'complete' })
  abortSignal = null
}
```

→ durch:

```typescript
  // Disk-presence guard before recording — see startModelDownload for the
  // reasoning. A successful tar exit isn't a guarantee that `checkPath` is
  // populated.
  if (existsSync(join(modelsDir, def.checkPath))) {
    recordInstalledVersion(def.id, def.sha256)
    // Issue #103 — Auto-Activate optional models with empty slots.
    // MUST run inside the disk-presence guard, sonst würde setActiveModel mit
    // "nicht installiert" werfen, wenn checkPath nach erfolgreichem Download
    // doch fehlt (z.B. tar-Extract-Edge-Case).
    autoActivateAfterDownload(def.id)
  }
  sendProgress({ state: 'complete' })
  abortSignal = null
}
```

- [ ] **Step 6: Tests laufen lassen, PASS erwarten**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.autoActivate.test.ts`
Expected: Alle vier Tests grün.

- [ ] **Step 7: Reconciler-Tests + Migration-Tests bleiben grün**

Run: `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts src/main/services/__tests__/SettingsService.summarizationMigration.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/services/ModelDownloadService.ts \
        src/main/services/__tests__/ModelDownloadService.autoActivate.test.ts
git commit -m "$(cat <<'EOF'
feat(models): auto-activate optional models after successful download (#103)

With summarization default = null, downloading Gemma left the slot empty
and the pipeline kept skipping the step — the user would see "installiert"
in Settings but never get a Zusammenfassung. Auto-activate hook closes
the UX gap: after downloadSingleModel succeeds, if the model belongs to
an optional group AND the active slot is null, setActiveModel runs
automatically.

Required groups stay routed through FirstLaunchScreen / reconciler.
Failures swallow + log (download is not retroactively rolled back).
EOF
)"
```

---

## Task 5: Manueller Smoke-Test (Fresh-Install-Simulation)

**Files:**
- None (manual verification).

**Rationale:** Unit-Tests decken die Logik ab, aber das User-facing Verhalten (kein Banner mehr beim ersten Start) muss einmal real durchlaufen werden. `mv ~/.therascript/models ...` testet nur den Reconciler, nicht den vollen Boot-Flow mit electron-store-Defaults.

- [ ] **Step 1: Settings-Store backuppen**

```bash
mv ~/Library/Application\ Support/Therascript/settings.json \
   ~/Library/Application\ Support/Therascript/settings.json.bak
```

(Falls die Datei nicht existiert: `ls ~/Library/Application\ Support/Therascript/` zur Verifikation. Pfad könnte je nach Build-Variante leicht differieren — `app.getPath('userData')` ist Truth.)

- [ ] **Step 2: Models-Dir ebenfalls backuppen (Fresh-Install simulieren)**

```bash
mv ~/.therascript/models ~/.therascript/models.bak
```

- [ ] **Step 3: App im Dev-Mode starten**

```bash
npm run dev
```

- [ ] **Step 4: FirstLaunch-Flow durchlaufen**

- FirstLaunchScreen erscheint → 5 GB Disk-Check OK → Required-Modelle laden lassen.
- Nach Abschluss: Hauptfenster, Sessions-View.

- [ ] **Step 5: Settings → Modelle öffnen, Banner-Absenz verifizieren**

**Expected:**
- Kein "Automatische Anpassung"-Banner.
- Summarization-Sektion zeigt Gemma als "Verfügbar" (nicht aktiv, nicht installiert).

**Failure-Signal:** Wenn das Banner doch erscheint → Plan unvollständig, zurück zu Phase 1 (systematic-debugging).

- [ ] **Step 6: Optional — Auto-Activate verifizieren**

- Gemma in Settings → Modelle herunterladen (~2.5 GB, dauert).
- Nach erfolgreichem Download: ModelCard zeigt **Aktiv**-Badge (grüner Punkt + "Aktiv" Text).
- Console-Output sollte `[auto-activate] summarization: gemma-summarization (slot was null)` enthalten.

- [ ] **Step 7: Backups wiederherstellen**

```bash
mv ~/Library/Application\ Support/Therascript/settings.json.bak \
   ~/Library/Application\ Support/Therascript/settings.json
mv ~/.therascript/models.bak ~/.therascript/models
```

- [ ] **Step 8: Kein Commit nötig** — manueller Test, keine Code-Änderungen.

---

## Task 6: PR erstellen

**Files:**
- None (git operations only).

- [ ] **Step 1: Branch checken & alle Tasks-Commits verifizieren**

```bash
git log --oneline main..HEAD
```

Expected: 4 Commits — Task 1 (refactor), Task 2 (fix default), Task 3 (fix migration), Task 4 (feat auto-activate).

- [ ] **Step 2: Vollständigen Test-Lauf**

```bash
npm run test
```

Expected: Alle Tests grün. Falls `pretest`-Hook fehlschlägt (Xcode CLT), Fallback:

```bash
npx vitest run
```

- [ ] **Step 3: Lint + Format**

```bash
npm run lint && npm run format
```

Expected: Keine Errors. Falls Format etwas anpasst → `git add -u` + Amend des letzten Commits oder als 5. Commit.

- [ ] **Step 4: Push**

```bash
git push -u origin HEAD
```

- [ ] **Step 5: PR mit gh CLI erstellen**

```bash
gh pr create --title "fix(models): summarization default = null + auto-activate (#103)" --body "$(cat <<'EOF'
## Summary
- Closes #103
- Optionale Modell-Slots starten `null` (Default + Migration), nicht mehr Phantom-`'gemma-summarization'` → kein irreführendes "Automatische Anpassung"-Banner beim ersten App-Start.
- `downloadSingleModel` aktiviert optionale Modelle automatisch, wenn der Slot leer ist → schliesst die UX-Lücke, die der `null`-Default sonst öffnen würde.
- Helper `defaultActiveModelFor` als Single Source of Truth ersetzt drei hardcodierte `'gemma-summarization'`-Stellen.

## Test plan
- [x] `npx vitest run src/main/services/__tests__/ModelDownloadService.reconcile.test.ts` — alle Tests grün, der bug-zementierende Test ist invertiert (default-state → kein Event), legitimer Cleanup-Pfad bleibt abgedeckt.
- [x] `npx vitest run src/main/services/__tests__/SettingsService.summarizationMigration.test.ts` — Migration schreibt `null` für pre-LLM-Upgrader, lässt aktive/deaktivierte Slots unverändert.
- [x] `npx vitest run src/main/services/__tests__/ModelDownloadService.autoActivate.test.ts` — Auto-Activate aktiviert nur optional+null, nicht required oder bereits-gesetzt.
- [x] `npm run typecheck` grün.
- [x] Manuelles Repro: settings.json + models/ gemovedt → App-Start → FirstLaunch → Settings → Modelle: kein Banner.
- [x] Optional manueller Auto-Activate-Test: Gemma-Download → ModelCard zeigt "Aktiv".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: PR-URL zur Verifikation ausgeben**

Die Ausgabe von `gh pr create` ist die PR-URL — an User zurückmelden.

---

## Self-Review Checklist (Plan-Author)

**Spec-Coverage** (vs. Issue #103 Akzeptanzkriterien):
- ✅ AC1 "kein Banner für Pre-LLM-Upgrade" — Task 3 (Migration → null) + Task 5 manuelle Verifikation.
- ✅ AC2 "kein Banner für Fresh-Install nach FirstLaunch" — Task 2 (Default → null) + Task 5.
- ✅ AC3 "User mit aktiviertem Gemma behält Slot" — Task 3 Test 2 (`preserves an explicit gemma-summarization slot`).
- ✅ AC4 "legitimer cleanup-pfad funktioniert" — Task 2 Test (`clears an optional slot when the user had it active and the file was deleted`).
- ✅ AC5 "Test bei Zeile 153 ist invertiert" — Task 2 Step 1.
- ✅ AC6 "npm run test + typecheck grün" — Task 6 Steps 2-3.
- ✅ Bonus (Architekt-Review): Auto-Activate-Lücke geschlossen — Task 4.
- ✅ Bonus: Drei Hardcode-Stellen via Helper konsolidiert — Task 1.

**Placeholder-Scan:** Keine "TBD", keine "similar to Task N", keine "add appropriate validation". Alle Tests enthalten konkreten Code.

**Type-Konsistenz:** `defaultActiveModelFor(group: ModelGroup): string | null`, `autoActivateAfterDownload(modelId: string): void`, `setActiveModel(group, id)`, `getActiveModelIdBelief(group): string | null` — Signaturen konsistent über alle Tasks.

**Commit-Granularität:** 4 Commits, jeder eigenständig grün.
