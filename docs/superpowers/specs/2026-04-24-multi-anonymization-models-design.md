# Multi-Modell-Architektur für Anonymisierung (NER)

**Status:** Design · **Datum:** 2026-04-24 · **Autor:** @adbstyle + Claude · **Revision:** r1 (post-code-review)

## Ziel

Die aus ASR und Diarization bekannte Multi-Modell-Auswahl (Download/Delete/Activate via Settings → Modelle) auf die Anonymisierungs-/NER-Gruppe ausweiten. User kann aus drei Modellen wählen, die sich in Grösse, Geschwindigkeit und Qualität unterscheiden. Die bestehende Merge-Pipeline (NER + Regex + Sperrliste) bleibt backend-agnostisch.

**Als Seiten-Effekt** bekommt der User bei Wahl von GLiNER produktive `ORGANISATION`/`MEDIZINISCH`-Entitäts-Erkennung. Beide `PlaceholderType`-Werte existieren in [EntityMap.ts](src/shared/types/EntityMap.ts) bereits und sind in UI/Sperrliste verdrahtet — flair emittiert sie nur nicht zuverlässig (Decision #5/#158). Mit einem ORG-fähigen Backend ist diese Nutzung der existierenden Typen natürlich, kein neues Feature.

## Scope

**In Scope:**

- Drei auswählbare Anonymisierungs-Backends:
  - **flair/ner-german-large** (bestehend, ~2.2 GB, 92.3% F1 CoNLL-03 DE, High-Accuracy)
  - **ai4privacy OpenPII (ModernBERT-basiert)** (neu, ~400 MB, MIT, schnell, 8 Sprachen) — **neuer Default**
  - **urchade/gliner_multi-v2.1** (neu, ~800 MB, Apache-2.0, zero-shot flexibel)
- Canonical-Schema-Mapping in TypeScript (konsistent mit bestehender `entity-merger.ts`-Konvention)
- Group-Required-Semantik: mindestens ein NER-Modell muss installiert + aktiv sein
- Eine zusätzliche Section "Anonymisierungs-Modelle" in Settings → Modelle
- Migrations-Pfad für Bestandsuser (flair bleibt aktiv, solange installiert)
- Pre-Ship-Eval-Gate auf echten (anonymisierten) Transkripten

**Out of Scope:**

- Model-natives Schema (keine neuen UI-Chip-Typen, kein dynamisches Sperrliste-Dropdown)
- Neue `PlaceholderType`-Werte (die existierenden 7 reichen)
- Änderungen an Regex-Patterns oder Sperrliste-Logik
- Änderungen an der Merger-Priorität (NER > Blocklist > Regex bleibt)
- Automatische Qualitäts-Vergleiche im Produkt (nur im Eval-Script)

## Architektur-Überblick

```
SettingsService.activeModels.ner: ModelId      (bestehender Schlüssel, kein Rename)
         │
         ▼
NerSidecar.run({ backend, hfIdentifier })
         │
         ▼
python_sidecar/ner_service.py --backend <flair|gliner|ai4privacy> --hf-id <...>
         │
         ├── ner_backends/flair_backend.py      → native: PER, LOC, MISC
         ├── ner_backends/gliner_backend.py     → native: Labels aus LABELS_DE[]
         └── ner_backends/ai4privacy_backend.py → native: GIVENNAME, SURNAME, CITY, …
         │
         ▼
stdout JSON: { entities: [...], metadata: { backend, model } }   (Schema erweitert um backend-Feld)
         │
         ▼
TS entity-merger.ts  →  mapNativeType(backend, nativeType) → PlaceholderType | null
         │
         ▼
Merger mit bestehender Priorität: NER > Blocklist > Regex
  – Native Types fliessen durch zu canonical Types
  – Der Merger dedupliziert per charStart/charEnd; Overlaps gewinnt höhere Priorität
  – Kein Pre-Merge-Strip — Native+Regex bilden eine Union
         │
         ▼
Sperrliste (unverändert) → TipTap-Dokument
```

**Design-Prinzipien:**

- **Einzige Grenze:** `NerServiceOutput.metadata.backend` ist die Ground-Truth für TS, welche Mapping-Funktion anzuwenden ist. Darunter bleibt alles austauschbar (NFR-9/10).
- **TS backend-agnostisch auf der Merger-Grenze:** `entity-merger.ts` hat eine kleine Dispatch-Tabelle, aber der Rest der Pipeline (coreference, placeholder-generation, tiptap-serialization) weiss nichts vom Backend.
- **Python backend-isoliert:** Jedes Backend-Modul implementiert ein schmales Interface (`predict(segments) -> list[NativeEntity]`). Lazy-Import — nur das aktive Backend lädt seine Library.

## Komponenten-Design

### 1. Python Sidecar — `ner_service.py` als Dispatcher

**Neue Datei-Struktur:**

```
python_sidecar/
  ner_service.py                  # CLI-Dispatcher (thin)
  ner_backends/
    __init__.py
    base.py                       # Abstract Base: predict(segments) -> list[dict]
    flair_backend.py              # Current flair logic (moved out)
    gliner_backend.py             # NEW
    ai4privacy_backend.py         # NEW
```

**CLI-Signatur:**

```bash
python3 ner_service.py \
  --transcript <path> \
  --backend <flair|gliner|ai4privacy> \
  --hf-id <huggingface-identifier> \
  --model-dir <cache-root>
```

`--backend` ersetzt die hartcodierte flair-Logik. `--hf-id` wird vom Backend an die jeweilige Library durchgereicht (`Classifier.load(hf_id)` / `GLiNER.from_pretrained(hf_id)` / `AutoModelForTokenClassification.from_pretrained(hf_id)`).

**Output-Schema (erweitert um `metadata.backend`):**

```json
{
  "entities": [
    { "text": "...", "type": "<native-type>", "segmentIndex": N, "charStart": N, "charEnd": N, "confidence": 0.XX }
  ],
  "metadata": {
    "model": "flair/ner-german-large",
    "backend": "flair",
    "segmentCount": N,
    "entityCount": N
  }
}
```

`metadata.backend` ist **neu** und erforderlich — TS wählt darüber die Mapping-Funktion. Schema-Änderung muss in [NerTypes.ts](src/shared/types/NerTypes.ts) + Zod-Schema mitgezogen werden.

### 2. TypeScript — `ModelDownloadService.ts` Erweiterung

Drei neue `ModelDefinition`-Einträge mit `group: 'ner'`:

```ts
{
  id: 'flair-ner-german-large',            // bestehend — bleibt
  hfIdentifier: 'flair/ner-german-large',
  nerBackend: 'flair',                     // NEU: Feld für NerSidecar
  // ... rest unverändert
},
{
  id: 'ai4privacy-openpii-modernbert',     // NEU (Default)
  hfIdentifier: 'ai4privacy/llama-ai4privacy-multilingual-categorical-anonymiser-openpii',
  nerBackend: 'ai4privacy',
  sizeBytes: ~400_000_000,                 // ModernBERT-base, ~100M params (Name trägt "llama-" historisch, Architektur ist ModernBERT)
  // ...
},
{
  id: 'gliner-multi-v2.1',                 // NEU
  hfIdentifier: 'urchade/gliner_multi-v2.1',
  nerBackend: 'gliner',
  sizeBytes: ~1_200_000_000,               // safetensors ist 1.16 GB (FP32, 209M params)
  // ...
}
```

**Aktive-Modell-Referenz im Store:** Bleibt `activeModels.ner` (existierend in [SettingsService.ts](src/main/services/SettingsService.ts)). **Kein Rename** auf `activeModels.anonymization` — das wäre Breaking Change ohne Mehrwert.

**Neues Feld `nerBackend: 'flair' | 'gliner' | 'ai4privacy' | undefined`** — parallel zu `hfIdentifier` aus dem Multi-Diarization-Plan, aber nur für NER-Gruppe gesetzt.

**Group-Required-Invariante:** `deleteModel()` verbietet das Löschen, wenn es das einzige installierte Modell mit `group: 'ner'` ist. Same pattern wie für Diarization.

### 3. TypeScript — `entity-merger.ts` Erweiterung

Heute: Single-Funktion `mapNerType(type) -> PlaceholderType | null` mit flair-Switch.

Neu: Dispatch nach Backend:

```ts
function mapNativeType(backend: NerBackend, nativeType: string): PlaceholderType | null {
  switch (backend) {
    case 'flair': return mapFlairType(nativeType)
    case 'ai4privacy': return mapAi4PrivacyType(nativeType)
    case 'gliner': return mapGlinerType(nativeType)
  }
}
```

`NerServiceOutput.metadata.backend` wird in den Merger durchgereicht (neuer Parameter).

### 4. UI — Settings → Modelle → Anonymisierung

Neue Section analog zur geplanten Diarization-Section (s. Multi-Diarization-Plan). Drei `ModelCard`-Instanzen mit:

- Modell-Name + Beschreibung
- Size (~MB), Accuracy-Score, Speed-Score (aus `ModelDefinition`)
- Status (Installed/Downloading/Not Installed) + Active-Radio
- Download-/Delete-/Activate-Buttons (bestehende IPC-Channels generalisiert)
- Default-Badge bei ai4privacy: "Empfohlen — klein & schnell"
- High-Accuracy-Badge bei flair: "Höchste Genauigkeit (DE)"

Einbau in [ModelsSettings.tsx](src/renderer/src/components/settings/ModelsSettings.tsx) als zweite Section **nach** der geplanten Diarization-Section.

### 5. Python Deps

**Compatibility-Check bestätigt (uv pip compile):** Alle drei Libraries koexistieren in derselben Python-Umgebung ohne Konflikt.

**Neue `requirements-ner.txt` (alle Runtime-Deps explizit — CLAUDE.md "sole dependency source"-Regel):**

```
flair>=0.13.0           # bestehend
gliner>=0.2.0           # NEU — für GLiNER-Backend
transformers>=4.48.0    # NEU — explizit (ModernBERT-Support), auch wenn bereits als Transient von flair gezogen
```

Alles bleibt im gemeinsamen `python_sidecar/standalone/` — kein separater Sidecar pro Backend. Delta: ~5 MB für `gliner`-Python-Code + minor torch-Bump (2.10 → 2.11). Standalone-Rebuild via `scripts/build-sidecar.sh --clean` ist Pflicht wegen torch-Bump + neuer `.dylib`/`.so`-Codesigning (CLAUDE.md-Gotcha).

### 6. Offline-Loading (Produktion: `connect-src 'none'`)

**Alle drei Backends müssen vollständig offline laden.** Bestehendes Pattern in [diarize.py:37](python_sidecar/diarize.py#L37): `os.environ.setdefault("HF_HUB_OFFLINE", "1")` beim Modul-Load.

**Dispatcher `ner_service.py` setzt vor jedem Backend-Import:**

```python
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
```

**Backend-spezifische Lade-Patterns:**

| Backend | Load-Call | Offline-Schalter |
|---|---|---|
| flair | `Classifier.load(hf_id)` | `FLAIR_CACHE_ROOT=<model-dir>` (bestehend) |
| gliner | `GLiNER.from_pretrained(hf_id, local_files_only=True)` | `local_files_only=True` Parameter |
| ai4privacy | `AutoModelForTokenClassification.from_pretrained(hf_id, local_files_only=True, cache_dir=<model-dir>)` | `local_files_only=True` Parameter |

**Tarball-Layout (erzeugt von `scripts/package-models.sh`):**

Der HuggingFace-Cache erwartet eine spezifische Verzeichnisstruktur (`models--<org>--<name>/snapshots/<hash>/...`). Das Packaging-Skript erzeugt diese bereits für pyannote (bestehend) und muss für die neuen Modelle analog angepasst werden. **Flat-Extract funktioniert nicht** — das ist die gleiche Falle, die uns bei pyannote gebissen hat. Konkret: `scripts/package-models.sh` muss drei neue Einträge bekommen, die das HF-Cache-Layout mit dem jeweils aktuellen HF-Snapshot-Hash (aus `~/.cache/huggingface/hub/...`) kopieren.

## Entity-Mapping-Tabellen

### flair → canonical (unverändert)

| flair | → | canonical | Notes |
|---|---|---|---|
| PER | | PERSON | |
| LOC | | ORT | |
| MISC | | SONSTIGES | |
| ORG | | `null` | ignoriert (Decision #5/#158) |

### ai4privacy → canonical (neu)

**Authoritative Label-Liste (21 Klassen, verifiziert gegen HF-Model-Card des `ai4privacy/llama-ai4privacy-multilingual-categorical-anonymiser-openpii`):**

| ai4privacy (native) | → | canonical | Notes |
|---|---|---|---|
| O | | `null` | Non-PII / Outside any entity |
| GIVENNAME | | PERSON | |
| SURNAME | | PERSON | |
| TITLE | | PERSON | z. B. "Dr.", "Herr" — zieht mit dem Namen-Span zusammen |
| CITY | | ORT | |
| STREET | | ORT | |
| BUILDINGNUM | | ORT | Hausnummer — gehört zum Adress-Span |
| ZIPCODE | | ORT | **Flow-through** — Merger deduped mit Regex-PLZ_ORT bei Overlap |
| EMAIL | | KONTAKT | **Flow-through** — Merger deduped mit Regex-EMAIL bei Overlap |
| TELEPHONENUM | | KONTAKT | **Flow-through** — Merger deduped mit Regex-TELEFON bei Overlap |
| DATE | | DATUM | **Flow-through** — Merger deduped mit Regex-GEBURTSDATUM bei Overlap |
| TIME | | DATUM | |
| AGE | | SONSTIGES | z. B. "42 Jahre" — datenschutzrelevant, aber nicht PERSON/ORT |
| SEX | | SONSTIGES | |
| GENDER | | SONSTIGES | |
| CREDITCARDNUMBER | | KONTAKT | Finanzdaten |
| SOCIALNUM | | SONSTIGES | SSN-Äquivalent — in CH selten, aber present |
| IDCARDNUM | | SONSTIGES | |
| PASSPORTNUM | | SONSTIGES | |
| DRIVERLICENSENUM | | SONSTIGES | |
| TAXNUM | | SONSTIGES | |

**Flow-through-Semantik:** Native Types für EMAIL/PHONE/DATE/ZIPCODE werden **nicht pre-merge gestrippt**. Sie fliessen als KONTAKT/DATUM/ORT durch. Der existierende Merger (`entity-merger.ts`) dedupliziert per `charStart/charEnd` mit NER-Priorität — wenn beide Pipelines dieselbe Span detektieren, gewinnt NER; wenn nur eine es findet, bleibt diese eine. Das ist eine **Union** statt eine einseitige Strip-Operation und liefert messbar bessere Recall-Werte.

**Laufzeit-Schutz gegen Schema-Drift:** `mapAi4PrivacyType` hat einen **Catch-All-Branch** für unbekannte Native-Types → `SONSTIGES` + `console.warn` mit dem unbekannten Type. Verhindert Silent-PII-Leak bei Modell-Updates, die neue Klassen einführen. Unit-Test enumeriert die obige Tabelle und bricht bei Diff zum code-seitigen Mapping ab.

### GLiNER → canonical (neu)

GLiNER ist zero-shot. Wir definieren eine fixe Label-Liste, die 1:1 auf die kanonischen Typen mappt:

```python
GLINER_LABELS_DE = [
    "Person",          # → PERSON
    "Ort",             # → ORT
    "Organisation",    # → ORGANISATION  (nutzt existierenden PlaceholderType, flair emittierte ORG nur mit Noise)
    "Krankheit",       # → MEDIZINISCH
    "Medikament",      # → MEDIZINISCH
]
```

Mapping ist trivial: `{"Person": "PERSON", "Ort": "ORT", "Organisation": "ORGANISATION", "Krankheit": "MEDIZINISCH", "Medikament": "MEDIZINISCH"}`. EMAIL/PHONE/DATE bewusst **nicht** in der Label-Liste — die liefert Regex (+ ai4privacy wenn aktiv).

**Backend-Parität vs. GLiNER-Mehrwert:** flair und ai4privacy produzieren kein ORGANISATION; GLiNER schon. Das ist kein Feature-Drift, sondern nutzt die existierenden `PlaceholderType`-Werte besser aus. Konsequenz: User, die GLiNER aktivieren, sehen mehr Chips in Therapie-Transkripten mit Versicherungs-/Klinik-Namen. User bei flair/ai4privacy verlassen sich weiterhin auf Sperrliste für diese Klasse — unverändertes Verhalten.

**Label-Engineering ist ein Risiko** (s. Pre-Ship-Eval — zwei Label-Sets werden gebencht, bestes gewinnt).

## Merger-Verhalten (bestehend, nicht geändert)

[entity-merger.ts:47-141](src/main/ml/entity-merger.ts#L47-L141) implementiert: **NER > Blocklist > Regex** mit position-basierter Deduplizierung. Diese Priorität bleibt unverändert.

**Konsequenz für Native-Types, die mit Regex überlappen:**

| Szenario | Ergebnis |
|---|---|
| NER + Regex finden dieselbe Span | NER gewinnt (Merger-Priorität) — beide mappen auf gleichen Placeholder, funktional äquivalent |
| Nur NER findet (z. B. ai4privacy-Phone in ungewöhnlichem Format) | NER-Entity wird geführt — **safer** als heute |
| Nur Regex findet (z. B. AHV-Nummer, die Neural nicht kennt) | Regex-Entity wird geführt — unverändert zu heute |

**GLiNER-Label-Auswahl als implizite Policy:** EMAIL/PHONE/DATE sind **nicht** Teil von `GLINER_LABELS_DE`, weil Regex das deterministisch mit CH-Kalibrierung abdeckt. Wir wählen die Strategie bewusst pro Backend:

- **flair:** kein Overlap — flair emittiert keine EMAIL/PHONE/DATE-Klassen
- **ai4privacy:** voller Overlap möglich — lassen wir durch (Flow-through), Merger reguliert
- **GLiNER:** Overlap per Label-Set-Design ausgeschlossen

**Kein Pre-Merge-Strip.** Der ursprüngliche R1-Policy-Vorschlag (native Types unbedingt droppen) wurde verworfen, weil er einseitig PII-Leaks erzeugen könnte (z. B. Neural-erkannte Nummer im Format, das Regex verpasst).

## Migrations-Strategie (M1)

**Bestandsuser (flair bereits installiert):** Bleiben auf flair aktiv. Bei App-Update:

- `flair-ner-german-large` bleibt `activeModels.ner`
- `ai4privacy-openpii-modernbert` erscheint in Modell-Liste als "Not Installed"
- Keine Zwangsmigration, kein Download-Prompt

**Neue User (First-Launch):**

- FirstLaunchScreen lädt `ai4privacy-openpii-modernbert` (neuer Default, ~400 MB) statt flair (~2.2 GB)
- Effekt: First-Launch-Download schrumpft von ~4.1 GB auf ~2.3 GB
- flair + GLiNER sind nachträglich in Settings ladbar

**Stichhaltiger Upgrade-Hinweis:** In der Release-Note + Settings-Panel kurze Erklärung: "Neuer Anonymisierungs-Default verfügbar. Deine bestehende Einstellung wurde nicht geändert."

## Pre-Ship-Eval-Gate

**Zwingend bevor ai4privacy als Default ausgeliefert wird:**

Neues Script `scripts/eval-ner-backends.ts` (oder Python-äquivalent):

- Input: 20-30 anonymisierte Test-Transkripte mit Gold-Labels (PER/LOC/ORG) — einmalig aus echten Sessions erstellt, in `tests/fixtures/ner-eval/` abgelegt
- Output: Precision/Recall/F1 pro Backend, pro Entity-Typ
- Akzeptanz-Kriterium: ai4privacy muss **≥ 95% Recall auf PER** erreichen (wichtigster Typ für Anonymisierung — Miss-Rate = PII-Leak). Wenn nicht → Default bleibt flair.
- Akzeptanz-Kriterium GLiNER: Label-Set wird gegen mindestens 2 Alternativen gebencht (z. B. `["Person", "Ort"]` vs. `["Name einer Person", "Ortsname"]`); bestes gewinnt.

Gate ist Teil der Implementations-Plan-Task, nicht optionaler Nachtrag.

## Testing

- **Unit-Tests:** Je Backend eine `mapNativeType`-Test-Suite, neue Mapping-Zeilen in `entity-merger.test.ts`.
- **Integration-Tests:** `NerSidecar.test.ts` mit Mock-Sidecar, der für jeden Backend-String das erwartete Native-Schema liefert → TS merged → canonical Output identisch.
- **E2E:** Manuelle Runs mit einem echten Sample-Transkript auf allen drei Backends.

## Risiken & Mitigationen

| # | Risiko | Schwere | Mitigation |
|---|---|---|---|
| 1 | ai4privacy hat niedrige Recall auf GIVENNAME/SURNAME in conversational German → PII-Leak | **Hoch** | Pre-Ship-Eval-Gate (≥ 95% Recall auf PERSON-Äquivalent); wenn Recall < 95% → flair bleibt Default |
| 2 | GLiNER-Labels suboptimal gewählt → Qualität schwankt | Mittel | A/B-Eval im selben Script, bestes Label-Set in Code hardcoden |
| 3 | torch 2.10 → 2.11 Bump bricht bestehende pyannote/flair/whisper-Integration | Mittel | `scripts/build-sidecar.sh --clean` + Vollen CI-Run + manuell beide Pipelines durchspielen vor Merge + neue `.dylib`-Codesigning-Runde |
| 4 | User löscht alle NER-Modelle → App nicht funktionsfähig | Niedrig | Group-Required-Invariante in `deleteModel()` (blockiert Löschen des letzten Modells) |
| 5 | Bestands-User verwirrt durch neue Section | Niedrig | Release-Note + keine Auto-Migration |
| 6 | Modell-Entity-Schema ändert sich mit HF-Update | Niedrig | Pin auf konkreten HF-Snapshot-Commit für **alle drei** Modelle (nicht "latest"); Catch-All-Branch in Mapping-Funktionen + Warn-Log bei unbekannten Labels |
| 7 | HF-Cache-Layout beim Packaging falsch → Modell-Load crasht offline | **Hoch** | `scripts/package-models.sh` kopiert die HF-Snapshot-Struktur 1:1 (Pattern bereits bei pyannote etabliert); E2E-Test auf frischem Mac ohne Internet |
| 8 | Ai4privacy-Name "llama-..." verwirrt Reviewer/User | Niedrig | README-Notiz + UI-Label "ai4privacy OpenPII (ModernBERT)" — Modellname nur als interne ID |

## Open Questions (für Folge-Arbeit, nicht diesen Scope)

- **Q1:** Soll `AnonymizationPanel` das aktive Backend anzeigen ("Anonymisiert mit ai4privacy")? Nice-to-have, transparency-fördernd.
- **Q2:** Benötigen wir einen Fallback-Mechanismus (Modell crasht → anderes Backend versuchen)? Vermutlich nein — wenn das aktive Modell crasht, Recording bleibt manuell editierbar.
- **Q3:** Soll nach der ersten Produktiv-Phase ein **Ensemble-Mode** evaluiert werden (flair + ai4privacy parallel, Union der Detektionen)? Könnte Recall weiter erhöhen zu Kosten von 2x RAM-Peak.

## Nicht-Ziele / Explizit NICHT in diesem Change

- Kein Fine-Tuning eigener Modelle
- Kein Swiss-German-Dialekt-Training
- Keine Änderungen an Regex-Patterns
- Keine Änderungen an Sperrliste-CRUD
- Kein automatisches Modell-Switching nach Session-Sprache
- Keine Cloud-Evaluation (alles lokal)

## Implementierungs-Sequenz (High-Level)

Der vollständige Task-Plan entsteht im nächsten Schritt (writing-plans). High-Level-Reihenfolge:

1. `ModelDefinition` um `nerBackend`-Feld erweitern, Typen aktualisieren
2. `ModelDownloadService` um drei neue NER-Einträge + Group-Required-Logik (nutzt `activeModels.ner`, **kein Rename**)
3. `NerServiceOutput`-Schema + Zod-Schema um `metadata.backend` erweitern
4. `ner_service.py` zu Dispatcher refactoren, `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` setzen, flair-Code nach `ner_backends/flair_backend.py` verschieben
5. `ner_backends/gliner_backend.py` + `ner_backends/ai4privacy_backend.py` implementieren (inkl. `local_files_only=True`)
6. `requirements-ner.txt` um `gliner` + `transformers` erweitern, `scripts/build-sidecar.sh --clean` + Re-Codesigning
7. `entity-merger.ts` Dispatch + drei Mapping-Funktionen + Catch-All-Warnings + Tests
8. `NerSidecar.ts` liest `activeModels.ner`, reicht `--backend` + `--hf-id` durch
9. IPC `modelCatalog`-Channels für NER-Gruppe öffnen (via Multi-Diarization-Plan-Generalisierung — s. Pre-Requisites)
10. UI-Section in `ModelsSettings.tsx`
11. `scripts/package-models.sh` um drei neue Einträge mit HF-Cache-Layout erweitern; R2-Upload
12. **SHA-256 + sizeBytes-Sync in `MODEL_DEFINITIONS`** nach R2-Upload (CLAUDE.md-Gotcha, separater Commit)
13. `scripts/eval-ner-backends.ts` schreiben, auf Eval-Fixtures laufen lassen
14. Wenn Eval passt → ai4privacy-Default aktivieren. Wenn nicht → flair-Default, Rest als Opt-In.

## Abhängigkeiten / Pre-Requisites

**Blockiert von:** Multi-Diarization-Plan ([docs/plans/2026-04-23-multi-diarization-models.md](docs/plans/2026-04-23-multi-diarization-models.md)) — aktuell auf Branch `feature/multi-diarization-models`, noch nicht gemerged. Diese NER-Erweiterung setzt folgende Artefakte aus diesem Plan voraus:

- [ ] `ModelDefinition.hfIdentifier`-Feld existiert
- [ ] `ModelDownloadService.getModelsByGroup(group)` existiert
- [ ] `deleteModel()` kennt Group-Required-Invariante (verhindert Löschen des letzten Modells einer Gruppe)
- [ ] `GROUP_TO_SETTINGS_KEY`-Record mappt `ner` → `activeModels.ner`
- [ ] IPC-Channels `modelCatalog:list/download/delete/setActive` akzeptieren `group`-Parameter
- [ ] Generalisierte `ModelCard.tsx` (aus `AsrModelCard.tsx` extrahiert)
- [ ] `ModelIdPayloadSchema`-Regex erlaubt Punkte (für `gliner-multi-v2.1`)

**Wenn Multi-Diarization-Plan nicht gemerged ist:** Obige Punkte müssen im NER-Plan vorgezogen werden. **Präferenz:** Multi-Diarization zuerst mergen, dann dieser Change — halbiert Review-Komplexität.

**Weitere Voraussetzungen:**

- 20-30 anonymisierte Test-Transkripte mit Gold-Labels (PER/LOC/ORG) für Pre-Ship-Eval, abgelegt in `tests/fixtures/ner-eval/`. Einmalig aus echten Sessions erstellt, Gold-Labels manuell verifiziert.
- HuggingFace-Account mit akzeptierten Terms für die drei Modelle (nur einmal pro Entwicklungsmaschine; Produktion lädt offline).
- Frischer `scripts/build-sidecar.sh --clean`-Durchlauf nach torch-Bump inkl. Codesigning-Runde.
