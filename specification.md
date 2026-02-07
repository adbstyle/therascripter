# Technische Spezifikation: Therascript

> Dieses Dokument ergänzt die [Anforderungen (therapie-anon-plan.md)](therapie-anon-plan.md) mit konkreten technischen Lösungen, Architekturentscheidungen und Modellempfehlungen.

---

## 1. Systemarchitektur

### 1.1 Überblick

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Application                  │
│                                                          │
│  ┌──────────────────┐  IPC   ┌──────────────────────┐   │
│  │ Renderer Process  │ <───> │ Main Process          │   │
│  │ (React + TS)      │       │ - App Lifecycle        │   │
│  │ - UI / Dashboard  │       │ - File I/O             │   │
│  │ - Audio Capture   │       │ - Task Queue           │   │
│  │   (Web Audio API) │       │ - IPC Router           │   │
│  │ - Review Editor   │       │ - Tray / Menu Bar      │   │
│  │ - Settings        │       │ - powerSaveBlocker     │   │
│  └──────────────────┘       │ - Notifications         │   │
│                              └───┬────┬────┬──────────┘   │
│                                  │    │    │               │
│          ┌── Worker Thread ──────┘    │    └── child ──┐  │
│          │                            │      process   │  │
│  ┌───────▼────────┐  ┌───────────────▼──┐ ┌───────────▼─┐│
│  │ whisper.cpp     │  │ Python Sidecar   │ │ Swift CLI    ││
│  │ (N-API Addon)   │  │ (long-running)   │ │ (per-invoke) ││
│  │                 │  │                  │ │              ││
│  │ - Transkription │  │ - pyannote       │ │ - Apple      ││
│  │ - CoreML/Metal  │  │   (Diarization)  │ │   Vision OCR ││
│  │                 │  │ - flair (NER)    │ │              ││
│  └─────────────────┘  │ - GLiNER (PII)   │ └──────────────┘│
│                        └──────────────────┘                 │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ better-sqlite3   │  │ electron-store   │                │
│  │ - Sitzungen      │  │ - Settings       │                │
│  │ - Sperrliste     │  │ - Modellconfig   │                │
│  │ - Task-State     │  └──────────────────┘                │
│  └──────────────────┘                                      │
└─────────────────────────────────────────────────────────────┘

  Modell-Verzeichnis (~/.therascript/models/):
  ├── asr/ggml-large-v3-turbo-q5_0.bin
  ├── diarization/pyannote-community-1/
  ├── ner/flair-ner-german-large/
  └── ocr/ (Apple Vision built-in)
```

### 1.2 Tech Stack

| Komponente | Technologie | Begründung |
|------------|-------------|------------|
| Framework | Electron (latest) | NFR-6: macOS Desktop. macOS-only vereinfacht Architektur |
| UI | React + TypeScript | Modernes Ökosystem, starke Typisierung |
| Build | Vite + electron-vite | Schnelle Builds, gute DX |
| Packaging | electron-builder | Mature, macOS Code Signing, DMG |
| Daten (strukturiert) | better-sqlite3 | Schnellste SQLite-Bindung, voll SQL, Crash-Recovery |
| Daten (Settings) | electron-store | Einfaches Key-Value für App-Einstellungen |
| Dateien | Filesystem + Pfade in SQLite | Audio/Transkripte auf Disk |

### 1.3 Prozessmodell

| Prozess | Verantwortung | ML-Last |
|---------|---------------|---------|
| **Main Process** (Node.js) | App-Lifecycle, File I/O, Task Queue, IPC, Tray, Notifications | Keine |
| **Renderer Process** (Chromium/React) | UI, Audio-Aufnahme (Web Audio API), Review-Editor | Keine |
| **Worker Thread** (Node.js) | whisper.cpp N-API Addon | ASR-Inferenz (Metal GPU) |
| **Python Sidecar** (child_process) | pyannote, flair, GLiNER | Diarization + NER (MPS) |
| **Swift CLI** (child_process) | Apple Vision Framework | OCR (Neural Engine) |

---

## 2. ML-Pipeline: Transkription (Epic 2)

### 2.1 ASR-Modell

**Primärempfehlung: whisper.cpp + Whisper Large V3 Turbo**

| Eigenschaft | Wert |
|-------------|------|
| Modell | `whisper-large-v3-turbo` (809M Parameter) |
| Runtime | whisper.cpp (C++, Metal GPU, CoreML) |
| Quantisierung | Q5_0 (~1.8 GB RAM, ~1.6 GB Disk) |
| Deutsch WER | ~4-5% (Hochdeutsch, Standard-Benchmarks) |
| Schweizerdeutsch | Implizite Dialekt→Hochdeutsch-Normalisierung mit `language=de` |
| Geschwindigkeit (M1) | ~0.3-0.5x Echtzeit (60 Min Audio → 18-30 Min) |
| Geschwindigkeit (M3 Pro) | ~0.15-0.3x Echtzeit |
| Interpunktion | Built-in (Satzzeichen + Grossschreibung) |
| Word-Timestamps | Unterstützt (`--word-timestamps`) |
| Lizenz | MIT |
| Python benötigt | Nein — nativer Binary/N-API Addon |

**Begründung der Wahl:**
- Keine Python-Dependency für ASR → kleineres Bundle
- Metal GPU-Beschleunigung auf Apple Silicon → schnellste Variante
- Q5_0-Quantisierung → geringer RAM-Verbrauch bei minimalem Qualitätsverlust
- Erfüllt NFR-3 (max 2x Echtzeit) komfortabel

**Alternative (Plugin, NFR-9):** mlx-whisper (via Python Sidecar) — schnellste Implementation auf Apple Silicon (~0.15-0.3x RTF), erfordert aber Python.

### 2.2 Schweizerdeutsch-Strategie

Whisper mit `language=de` und `task=transcribe` führt bereits implizite Dialektnormalisierung durch:
- **Leichter bis mittlerer Dialekt** (Zürich, Bern): Gute Ergebnisse
- **Starker Dialekt** (Wallis, Graubünden): Qualität sinkt

**MVP-Ansatz:** Whisper's eingebaute Normalisierung genügt. Therapeuten sprechen typischerweise klarer als im Alltag.

**Post-MVP Verbesserungen:**
1. Fine-Tuning auf STT4SG-350 + SwissDial-Daten
2. Optionaler LLM-Post-Processing-Schritt für starken Dialekt

### 2.3 Filler-Word-Entfernung

Regex-basierte Nachbearbeitung (Entscheidung #33: nur "äh"/"ähm", Füllwörter bleiben):

```python
FILLER_PATTERNS = [
    r'\b[AaÄä]h+m?\b',   # äh, ähm, ah, ahm
    r'\b[Uu]h+m?\b',      # uh, uhm
    r'\b[Hh]m+\b',        # hm, hmm
    r'\b[Mm]h+m?\b',      # mhm, mh
]
```

Angewandt auf Word-Timestamps — Filler werden entfernt, Timestamps bleiben korrekt.

### 2.4 Integration mit Electron

whisper.cpp wird als nativer N-API Addon (via `cmake-js` + `node-addon-api`) eingebunden oder als Subprocess aufgerufen:

```javascript
// Subprocess-Ansatz (einfacher, robuster)
const whisper = spawn('./bin/whisper-cpp', [
  '-m', modelPath,
  '-f', audioPath,
  '-l', 'de',
  '--word-timestamps',
  '--print-progress',
  '-t', '8',  // Threads
]);
```

---

## 3. ML-Pipeline: Speaker Diarization (Epic 2)

### 3.1 Diarization-Modell

**Primärempfehlung: pyannote.audio community-1**

| Eigenschaft | Wert |
|-------------|------|
| Modell | `pyannote/speaker-diarization-community-1` |
| Pipeline | Powerset Segmentation → WeSpeaker Embeddings → VBx Clustering |
| DER (Deutsch) | **8.3%** (bester Wert aller evaluierten Modelle) |
| DER (gesamt) | ~11-13% |
| Sprecher-Erkennung | Automatisch, mit `min_speakers` / `max_speakers` Parametern |
| Exclusive Mode | Ja — zu jedem Zeitpunkt nur ein aktiver Sprecher |
| Apple Silicon | CPU (~2-4x Echtzeit), MPS experimentell |
| Lizenz | CC-BY-4.0 (kommerziell nutzbar mit Attribution) |

**Alternative (Plugin, NFR-9): Senko**
- CoreML-nativ auf Apple Silicon → **465x Echtzeit auf M3** (7.7s pro Stunde)
- DER: 13.3-13.5% (etwas schlechter als pyannote)
- MIT-Lizenz
- Ideal für User, die Speed priorisieren

**Streaming-Modus (Parallel-Transkription): Diart**
- Echtzeit-Diarization basierend auf pyannote-Modellen
- DER: 20-30% (Streaming-Tradeoff)
- Liefert vorläufige Speaker-Labels während Live-Aufnahme
- Finaler Offline-Pass nach Stop mit pyannote community-1

### 3.2 Alignment-Strategie

ASR und Diarization laufen als separate Pipelines — Alignment über Word-Timestamps:

```
Audio ──> [whisper.cpp] ──> Timestamped Words
  │
  └────> [pyannote]    ──> Speaker Segments

Merge: Word-Midpoint ∈ Speaker-Segment → Sprecher-Zuordnung
```

**Algorithmus:**
1. Für jedes Wort: Midpoint = (start + end) / 2
2. Speaker = Segment, in dem der Midpoint liegt
3. Konsekutive Wörter desselben Sprechers → ein Absatz
4. Bei Sprecherwechsel → neuer Absatz mit Zeitstempel `[HH:MM:SS]`

### 3.3 Performance-Budget (60 Min Sitzung, M1 16 GB)

| Schritt | Sequenziell | Mit Parallel-Transkription |
|---------|-------------|---------------------------|
| ASR (whisper.cpp, Q5_0) | ~20-30 Min | Bereits während Aufnahme erledigt |
| Diarization (pyannote) | ~6-18 Min | ~6-18 Min (nach Stop) |
| Alignment + Filler-Removal | ~5 Sek | ~5 Sek |
| **Total** | **~26-48 Min** | **~6-18 Min nach Stop** |

→ Sequenziell: Erfüllt NFR-3 (max 2x Echtzeit = 120 Min)
→ Parallel: Erfüllt Ziel < 5 Min nach Stop für kürzere Sitzungen

---

## 4. ML-Pipeline: Anonymisierung / NER (Epic 4)

### 4.1 Architektur: Hybrid-Pipeline

```
┌─────────────────────────────────────────────────────┐
│                    INPUT TEXT                         │
└──────────┬──────────────┬──────────────┬────────────┘
           │              │              │
           ▼              ▼              ▼
    ┌────────────┐  ┌──────────┐  ┌───────────┐
    │   REGEX    │  │  flair   │  │ SPERRLISTE│
    │   ENGINE   │  │ NER-DE   │  │  (US-5)   │
    │            │  │ -LARGE   │  │           │
    │ AHV-Nr    │  │          │  │ User-     │
    │ Telefon   │  │ PER      │  │ definierte│
    │ Email     │  │ LOC      │  │ Begriffe  │
    │ Adresse   │  │ ORG      │  │           │
    │ Geb.datum │  │ MISC     │  │           │
    │ Gesproch. │  │          │  │           │
    │ Nummern   │  │          │  │           │
    └─────┬──────┘  └────┬─────┘  └─────┬─────┘
          │               │              │
          └───────────────┼──────────────┘
                          │
                  ┌───────▼────────┐
                  │  MERGER &      │
                  │  DEDUPLIZIERUNG│
                  │  + Whole-Word  │
                  │    Check       │
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │  ENTITY        │
                  │  RESOLVER      │
                  │  (konsistente  │
                  │   Platzhalter) │
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │  Anonymisierter│
                  │  Text + Entity │
                  │  Map           │
                  └────────────────┘
```

### 4.2 Primäres NER-Modell

**flair/ner-german-large**

| Eigenschaft | Wert |
|-------------|------|
| Architektur | XLM-RoBERTa Large + FLERT (document-level context) |
| F1 (CoNLL-2003 DE) | ~92.31% |
| F1 (GermEval 2014) | ~90%+ |
| Entitätstypen | PER, LOC, ORG, MISC |
| Modellgrösse | ~2.2 GB (XLM-R Large) |
| Geschwindigkeit (MPS) | ~100-200 Tokens/Sek |
| Lizenz | MIT |

**Begründung:** Bestes F1 auf deutschen NER-Benchmarks, document-level context (FLERT) ideal für lange Therapie-Transkripte, MIT-Lizenz.

### 4.3 Ergänzendes PII-Modell (Phase 2)

**GLiNER Multi PII v1** (`urchade/gliner_multi_pii-v1`)

| Eigenschaft | Wert |
|-------------|------|
| Architektur | Bidirectional Transformer (BERT-basiert) |
| PII-Typen | 50+ (Telefon, Email, Sozialversicherung, Geburtsdatum, etc.) |
| Sprachen | 6 (inkl. Deutsch) |
| Modellgrösse | ~459M Parameter |
| Lizenz | Apache 2.0 |

**Einsatz:** Zero-Shot-Erkennung von PII-Typen, die flair nicht abdeckt. Ergänzt die Regex-Engine für nicht-standardmässige Formate.

### 4.4 Regex-Engine für strukturierte Entitäten

Regex liefert ~100% Precision für klar definierte Muster:

| Entitätstyp | Pattern-Beispiel |
|-------------|-----------------|
| **AHV-Nummer** | `756\.\d{4}\.\d{4}\.\d{2}` |
| **Schweizer Telefon** | `(\+41\|0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}` |
| **Email** | Standard-Email-Regex |
| **PLZ + Ort** | `\b\d{4}\s+[A-ZÄÖÜ][a-zäöüéèê]+\b` (CH-Format) |
| **Geburtsdatum** | `\b\d{1,2}\.\d{1,2}\.\d{2,4}\b` (mit Kontext "geb.", "geboren") |
| **Versicherungsnr.** | Schweizer Krankenversicherungs-Formate |
| **Gesprochene Nummern** | `null\|eins\|zwei\|drei\|...` Sequenz-Erkennung (best-effort) |

### 4.5 Entity Resolution (konsistente Platzhalter)

String-basierte Heuristik für MVP:
- "Dr. Müller", "Müller", "Herr Müller" → alle `[PERSON 1]`
- Titel-Prefixe werden beim Matching entfernt (Herr, Frau, Dr., Prof.)
- Substring-Match für Nachnamen: "Müller" matched "Peter Müller"
- Whole-Word-Check: "Müller" in "Müllerstrasse" wird NICHT anonymisiert

### 4.6 Entitätstyp-Mapping

| Anforderung (US-4) | Quelle | Platzhalter-Format |
|---------------------|--------|--------------------|
| Personennamen | flair PER + Sperrliste | `[PERSON A]`, `[PERSON B]` |
| Ortsnamen | flair LOC + Regex PLZ | `[ORT 1]`, `[ORT 2]` |
| Telefonnummern | Regex + GLiNER | `[TELEFON 1]` |
| Email-Adressen | Regex | `[EMAIL 1]` |
| Postadressen | Regex + flair LOC | `[ADRESSE 1]` |
| Social-Media-Handles | Regex (@-Pattern) | `[SOCIAL 1]` |
| AHV-Nummern | Regex | `[AHV-NR 1]` |
| Versicherungsnummern | Regex | `[VERS-NR 1]` |
| Fallnummern | Regex | `[FALL-NR 1]` |
| Geburtsdaten | Regex + Kontext | `[GEBURTSDATUM 1]` |
| Gesprochene Kontaktdaten | Zahlwort-Sequenz-Erkennung | `[TELEFON n]` (best-effort) |

---

## 5. ML-Pipeline: OCR (Epic 3)

### 5.1 PDF-Textextraktion

**pdfjs-dist** (Node.js, in Worker Thread)

| Eigenschaft | Wert |
|-------------|------|
| Typ | JavaScript PDF-Parser (Mozilla) |
| Text-Extraktion | `page.getTextContent()` |
| Passwort-PDFs | `getDocument({ data, password })` |
| Lizenz | Apache 2.0 |
| Bundle-Grösse | ~3 MB |
| Integration | Nativ in Electron (kein Python) |

### 5.2 OCR-Engine

**Primär: Apple Vision Framework (via Swift CLI Helper)**

| Eigenschaft | Wert |
|-------------|------|
| Engine | macOS VisionKit / VNRecognizeTextRequest |
| Deutsch | Unterstützt (`.german` Locale) |
| Genauigkeit | ~95-99% auf gedrucktem Text |
| Geschwindigkeit | Nutzt Neural Engine — sehr schnell |
| Lizenz | Kostenlos (macOS-System-API) |
| Dependencies | Keine (in macOS 13+ eingebaut) |

**Fallback (Plugin, NFR-9): Tesseract 5**

| Eigenschaft | Wert |
|-------------|------|
| Deutsch | `deu` + `deu_frak` (Fraktur) Sprachpakete |
| Genauigkeit | ~85-95% auf gedrucktem Text |
| Lizenz | Apache 2.0 |
| Bundle-Grösse | ~30 MB (Binary + Deutsch-Daten) |

### 5.3 Mixed-PDF-Erkennung

Algorithmus pro Seite:
1. Text extrahieren mit pdfjs-dist
2. Wenn `text.trim().length > 50` → Text-Seite (direkte Extraktion)
3. Sonst → Scan-Seite (Seite als Bild rendern → OCR)

---

## 6. Datenhaltung

### 6.1 SQLite-Schema (better-sqlite3)

```sql
-- Sitzungsverwaltung (Epic 0)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('audio', 'pdf')),
    status TEXT NOT NULL CHECK(status IN (
        'recording', 'transcribing', 'diarizing',
        'anonymizing', 'review', 'exported', 'error'
    )),
    audio_path TEXT,
    transcript_path TEXT,
    anonymized_path TEXT,
    pdf_path TEXT,
    speaker_labels TEXT,       -- JSON: {"A": "Therapeut", "B": "Patient"}
    entity_map TEXT,           -- JSON: Entity-Mapping für Review
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Sperrliste (Epic 5)
CREATE TABLE blocklist (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    placeholder_type TEXT NOT NULL CHECK(placeholder_type IN (
        'PERSON', 'ORT', 'TELEFON', 'EMAIL', 'ADRESSE',
        'AHV-NR', 'VERS-NR', 'FALL-NR', 'GEBURTSDATUM', 'SONSTIGES'
    )),
    created_at TEXT DEFAULT (datetime('now'))
);

-- Task Queue (Crash-Recovery)
CREATE TABLE task_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
    progress REAL DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

-- Modell-Registry (NFR-9, NFR-10)
CREATE TABLE model_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task TEXT NOT NULL CHECK(task IN ('transcription', 'diarization', 'ner', 'ocr')),
    runtime TEXT NOT NULL,
    path TEXT NOT NULL,
    size_mb INTEGER,
    bundled BOOLEAN DEFAULT FALSE,
    config TEXT,               -- JSON: Modell-spezifische Konfiguration
    added_at TEXT DEFAULT (datetime('now'))
);
```

### 6.2 App-Settings (electron-store)

```json
{
  "activeModels": {
    "transcription": "whisper-large-v3-turbo",
    "diarization": "pyannote-community-1",
    "ner": "flair-ner-german-large",
    "ocr": "apple-vision"
  },
  "parallelTranscription": true,
  "firstLaunchDone": false,
  "consentReminderShown": false
}
```

---

## 7. macOS-Integrationen

### 7.1 Menu Bar Icon (US-1, AC 7)

Electron `Tray` API:
- Template-Image für automatische Dark/Light-Mode-Adaption
- `tray.setTitle(duration)` zeigt Aufnahmedauer neben dem Icon
- Rotes Icon während Aufnahme, Standard-Icon im Leerlauf
- Context-Menu: Stop/Pause, Dauer, "Therascript öffnen"

### 7.2 Standby-Unterdrückung (US-1, AC 8)

```javascript
const { powerSaveBlocker } = require('electron');
// 'prevent-app-suspension' — Display darf schlafen, App läuft weiter
const id = powerSaveBlocker.start('prevent-app-suspension');
```

### 7.3 Audio-Aufnahme (US-1, AC 1-5)

Web Audio API + AudioWorklet im Renderer:
- `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })`
- AudioWorklet sendet PCM-Chunks via IPC an Main Process
- Main Process streamt auf Disk (WAV/raw PCM) für Auto-Recovery
- Periodischer Flush alle 60 Sekunden (US-1, AC 9)

### 7.4 Mikrofon-Berechtigung

`Info.plist`:
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Therascript benötigt Mikrofonzugriff für die Aufnahme von Therapiegesprächen.</string>
```

### 7.5 Benachrichtigungen (US-2, AC 12)

```javascript
const { Notification } = require('electron');
new Notification({
  title: 'Transkription abgeschlossen',
  body: `"${sessionTitle}" wurde erfolgreich transkribiert.`
}).show();
```

---

## 8. Plugin-Architektur (NFR-9, NFR-10)

### 8.1 Modell-Verzeichnis

```
~/.therascript/
  models/
    asr/
      ggml-large-v3-turbo-q5_0.bin    (Standard, gebündelt)
      ggml-medium-q5_0.bin            (User-hinzugefügt)
    diarization/
      pyannote-community-1/            (Standard)
      senko-coreml/                    (User-hinzugefügt)
    ner/
      flair-ner-german-large/          (Standard)
      gliner-multi-pii-v1/             (Optional, Phase 2)
    ocr/
      (Apple Vision ist System-API)
      tesseract-5/                     (Fallback)
  model-registry.json
```

### 8.2 Provider-Interface

```typescript
interface ModelProvider {
  id: string;
  task: 'transcription' | 'diarization' | 'ner' | 'ocr';

  loadModel(modelPath: string, config: Record<string, any>): Promise<void>;
  unloadModel(): Promise<void>;

  // Task-spezifische Methoden
  transcribe?(audioPath: string, onProgress: ProgressFn): Promise<TranscriptionResult>;
  diarize?(audioPath: string, options: DiarizationOptions): Promise<DiarizationResult>;
  recognizeEntities?(text: string): Promise<Entity[]>;
  ocr?(imagePath: string): Promise<string>;
}
```

### 8.3 Modell hinzufügen (User-Flow)

1. User klickt "Modell hinzufügen" in Settings
2. Dialog: Modell-Datei auswählen, Task-Typ, Runtime
3. App kopiert Modell in `~/.therascript/models/`
4. Validierung (Format-Check, ladbar?)
5. Modell erscheint in Dropdown

---

## 9. Verarbeitungs-Pipelines

### 9.1 Audio-Pipeline (Live-Aufnahme mit Parallel-Transkription)

```
┌─ Aufnahme läuft ─────────────────────────────────────┐
│                                                       │
│  Mikrofon → AudioWorklet → PCM-Chunks → Disk (WAV)  │
│                              │                        │
│                              └─→ whisper.cpp (chunked)│
│                                  Partial Transcript   │
│                                  (nicht angezeigt)    │
└──── User drückt STOP ────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │ Finaler Pass     │
         │                  │
         │ 1. pyannote      │  ← Volle Audiodatei
         │    Diarization   │
         │ 2. Alignment     │  ← Words + Speaker Segments
         │ 3. Filler-Remove │
         │ 4. Formatierung  │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ Auto-Anonymis.   │
         │ (NER + Regex     │
         │  + Sperrliste)   │
         └────────┬─────────┘
                  │
                  ▼
         Review-Modus (Epic 6)
```

### 9.2 Audio-Pipeline (Import, sequenziell)

```
Audio-Import → Queue (FIFO)
                  │
                  ▼
         ┌──────────────────┐
         │ whisper.cpp       │  Fortschritt: % + Restzeit
         │ (vollständig)     │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ pyannote          │
         │ Diarization       │
         └────────┬─────────┘
                  │
                  ▼
         Alignment → Filler → Formatierung → Auto-Anonymisierung → Review
```

### 9.3 PDF-Pipeline

```
PDF-Import → Queue (FIFO)
                  │
                  ▼
         ┌──────────────────┐
         │ Pro Seite:        │
         │ Text vorhanden?   │
         │ → JA: pdfjs-dist  │
         │ → NEIN: OCR       │
         │   (Apple Vision)  │
         └────────┬─────────┘
                  │
                  ▼
         Linearer Fliesstext → Auto-Anonymisierung → Review
```

---

## 10. Ressourcen-Budget

### 10.1 RAM-Verbrauch (gleichzeitig)

| Komponente | RAM |
|------------|-----|
| Electron App | ~500 MB |
| whisper.cpp (large-v3-turbo Q5_0) | ~1.8 GB |
| pyannote.audio | ~1.5 GB |
| flair NER (bei Anonymisierung) | ~2.2 GB |
| Audio-Buffer (60 Min) | ~300 MB |
| OS Overhead | ~2 GB |
| **Total (Peak)** | **~8.3 GB** |

**Hinweis:** Whisper und flair NER laufen nie gleichzeitig (sequentielle Pipeline). Peak ist Whisper + pyannote bei Parallel-Transkription.

**Empfohlenes Minimum:** 16 GB RAM (Standard bei allen Apple Silicon Macs)

### 10.2 Disk-Verbrauch

| Komponente | Grösse |
|------------|--------|
| Electron Runtime | ~180 MB |
| React App Code | ~5 MB |
| whisper.cpp Binary | ~5 MB |
| Whisper large-v3-turbo Q5_0 | ~1.6 GB |
| Gebündelte Python-Umgebung | ~50 MB |
| PyTorch (für pyannote + flair) | ~500 MB |
| pyannote Modelle | ~200 MB |
| flair NER German Large | ~2.2 GB |
| pdfjs-dist | ~3 MB |
| **Total (App + Modelle)** | **~4.7 GB** |

**Strategie:** App-Installer ~250 MB, Modelle werden beim ersten Start heruntergeladen (~4.5 GB).

---

## 11. Lizenz-Kompatibilität

| Modell / Library | Lizenz | Kommerziell | Therascript-kompatibel |
|-----------------|--------|-------------|----------------------|
| whisper.cpp | MIT | Ja | Ja |
| Whisper Large V3 Turbo | MIT | Ja | Ja |
| pyannote community-1 | CC-BY-4.0 | Ja (Attribution) | Ja |
| Senko | MIT | Ja | Ja |
| flair/ner-german-large | MIT | Ja | Ja |
| GLiNER Multi PII | Apache 2.0 | Ja | Ja |
| spaCy de_core_news_lg | MIT | Ja | Ja |
| Apple Vision | macOS System-API | Ja | Ja |
| Tesseract | Apache 2.0 | Ja | Ja |
| pdfjs-dist | Apache 2.0 | Ja | Ja |
| better-sqlite3 | MIT | Ja | Ja |
| Electron | MIT | Ja | Ja |

**Nicht verwendbar (NC-Lizenz):** Meta MMS (CC-BY-NC), SeamlessM4T (CC-BY-NC), Piiranha (CC-BY-NC-ND), UniNER-7B (CC-BY-NC)

---

## 12. Risiken & Mitigationen

| Risiko | Schwere | Wahrscheinlichkeit | Mitigation |
|--------|---------|---------------------|------------|
| Schweizerdeutsch WER zu hoch (>20%) | Hoch | Mittel | Fine-Tune auf STT4SG-Daten (v2); optionaler LLM-Postprocessing-Schritt |
| 2x Echtzeit auf 8 GB M1 verletzt | Mittel | Niedrig-Mittel | Q4_0-Quantisierung; Fallback auf Medium-Modell; 16 GB empfehlen |
| Whisper-Halluzinationen bei Stille | Mittel | Mittel | Silero VAD als Pre-Filter vor Whisper |
| NER verpasst Namen in gesprochener Sprache | Hoch | Mittel | Sperrliste für wiederkehrende Namen; Review-Modus als Sicherheitsnetz |
| Compound-Word False Positives ("Müller" in "Müllerstrasse") | Mittel | Mittel | Whole-Word-Matching-Check |
| Python-Sidecar-Bundling-Komplexität | Mittel | Mittel | PyInstaller oder embedded Python; alternativ reine C++ Diarization |
| flair NER RAM-Konflikt mit Whisper | Mittel | Mittel | Whisper-Modell vor Anonymisierung entladen |
| pyannote CPU-Geschwindigkeit auf Apple Silicon knapp | Mittel | Mittel | Senko als schnelle Alternative anbieten |

---

## 13. Implementations-Phasen

### Phase 1: MVP Core
- Epic 0: Sitzungsverwaltung (SQLite + React Dashboard)
- Epic 1: Audio-Aufnahme (Web Audio API + Menu Bar + Auto-Recovery)
- Epic 2: Transkription (whisper.cpp) + Diarization (pyannote) — sequenziell
- Epic 4: Anonymisierung (flair NER + Regex + Sperrliste)
- Epic 5: Sperrliste (CRUD in SQLite)
- Epic 6: Review-Modus (Basis-Editor mit Entity-Highlighting)
- Epic 7: Export (Clipboard + .txt)

### Phase 2: Erweiterungen
- Parallel-Transkription (US-1 AC 13-14)
- GLiNER PII als ergänzende NER-Schicht
- Gesprochene Nummern-Erkennung (best-effort)
- PDF-Import + OCR (Epic 3)

### Phase 3: Polish & Plugins
- Plugin-Architektur (NFR-9, NFR-10)
- Modell-Management UI
- Senko als alternative Diarization-Engine
- Batch-Import mit Queue-UI

---

## 14. Offene technische Entscheidungen

| # | Frage | Optionen | Empfehlung |
|---|-------|----------|------------|
| T1 | Python-Bundling-Strategie? | PyInstaller vs. conda-pack vs. embedded Python | PyInstaller (kleinster Footprint) |
| T2 | whisper.cpp als N-API Addon oder Subprocess? | Addon (tighter integration) vs. Subprocess (einfacher) | Subprocess für MVP, Addon für v2 |
| T3 | Modell-Download: Installer oder First-Launch? | Alles im Installer vs. On-Demand | On-Demand (kleinerer Installer) |
| T4 | Minimum macOS-Version? | macOS 13 vs. 14 | macOS 14 (für Apple Vision + CoreML Features) |
| T5 | Audio-Format auf Disk? | WAV (unkomprimiert) vs. FLAC (komprimiert) | WAV (einfacher, Auto-Recovery-freundlich) |
