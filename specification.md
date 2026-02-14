# Technische Spezifikation: Therascript

> Dieses Dokument ergänzt die [Anforderungen (requirements.md)](requirements.md) mit konkreten technischen Lösungen, Architekturentscheidungen und Modellempfehlungen.

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
│  │   (TipTap)        │       │ - powerSaveBlocker     │   │
│  │ - Settings        │       │ - Notifications        │   │
│  └──────────────────┘       │ - Auto-Deletion Cron   │   │
│                              └───┬────┬────┬──────────┘   │
│                                  │    │    │               │
│          ┌── Worker Thread ──────┘    │    └── child ──┐  │
│          │                            │      process   │  │
│  ┌───────▼────────┐  ┌───────────────▼──┐ ┌───────────▼─┐│
│  │ whisper.cpp     │  │ Python Sidecar   │ │ Swift CLI    ││
│  │ (Subprocess)    │  │ (long-running)   │ │ (per-invoke) ││
│  │                 │  │                  │ │              ││
│  │ - Transkription │  │ - pyannote       │ │ - Apple      ││
│  │ - Metal GPU     │  │   (Diarization)  │ │   Vision OCR ││
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

  Datenverzeichnis (~/.therascript/):
  ├── models/
  │   ├── asr/ggml-large-v3-turbo-q5_0.bin
  │   ├── diarization/pyannote-community-1/
  │   ├── ner/flair-ner-german-large/
  │   └── ocr/ (Apple Vision built-in)
  ├── data/
  │   ├── therascript.db          (SQLite)
  │   ├── audio/                  (WAV-Dateien)
  │   ├── transcripts/            (JSON)
  │   └── recovery/               (Auto-Recovery PCM)
  └── .metadata_never_index       (Spotlight-Ausschluss)
```

### 1.2 Tech Stack

| Komponente | Technologie | Begründung |
|------------|-------------|------------|
| Framework | Electron (latest) | NFR-6: macOS Desktop. macOS-only vereinfacht Architektur |
| UI | React + TypeScript | Modernes Ökosystem, starke Typisierung |
| Build | Vite + electron-vite | Schnelle Builds, gute DX |
| Packaging | electron-builder | Mature, macOS Code Signing, DMG |
| Review Editor | TipTap (ProseMirror) | Atomare Node Views, Undo/Redo, Custom Nodes |
| Daten (strukturiert) | better-sqlite3 | Schnellste SQLite-Bindung, voll SQL, Crash-Recovery |
| Daten (Settings) | electron-store | Einfaches Key-Value für App-Einstellungen |
| Dateien | Filesystem + Pfade in SQLite | Audio/Transkripte auf Disk |
| IPC-Validierung | zod | Schema-basierte Validierung aller IPC-Messages (NFR-15) |

### 1.3 Prozessmodell

| Prozess | Verantwortung | ML-Last |
|---------|---------------|---------|
| **Main Process** (Node.js) | App-Lifecycle, File I/O, Task Queue, IPC, Tray, Notifications, Auto-Deletion | Keine |
| **Renderer Process** (Chromium/React) | UI, Audio-Aufnahme (Web Audio API), Review-Editor (TipTap) | Keine |
| **Subprocess** (whisper.cpp Binary) | whisper.cpp CLI | ASR-Inferenz (Metal GPU) |
| **Python Sidecar** (child_process) | pyannote, flair, GLiNER | Diarization + NER (MPS/CPU) |
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
| Python benötigt | Nein — nativer Binary |

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

whisper.cpp wird als Subprocess aufgerufen (Entscheidung T2: Subprocess für MVP):

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

**QoS-Drosselung (NFR-23):** `nice -n 10` oder `RLIMIT_CPU` um Mac-Responsiveness sicherzustellen.

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

### 3.2 Alignment-Strategie

ASR und Diarization laufen sequenziell — Alignment über Word-Timestamps:

```
Audio ──> [whisper.cpp] ──> Timestamped Words  (Modell laden → entladen)
                │
                ▼
Audio ──> [pyannote]    ──> Speaker Segments   (Modell laden → entladen)
                │
                ▼
         [Alignment]    ──> Zugeordneter Text  (kein ML-Modell)
```

**Algorithmus:**
1. Für jedes Wort: Midpoint = (start + end) / 2
2. Speaker = Segment, in dem der Midpoint liegt
3. Konsekutive Wörter desselben Sprechers → ein Absatz
4. Bei Sprecherwechsel → neuer Absatz mit Zeitstempel `[HH:MM:SS]`

**Speaker-Label-Logik (Entscheidung #38):**
- 1 Sprecher erkannt → kein Label, einfacher Fliesstext
- 2-4 Sprecher → Labels: `[Person A]`, `[Person B]`, `[Person C]`, `[Person D]`
- 5+ Sprecher → best-effort (Stimmen können zusammengefasst werden)

### 3.3 Performance-Budget (60 Min Sitzung, sequenziell)

> **Hinweis:** Alle ML-Verarbeitung erfolgt strikt sequenziell — immer nur ein Modell gleichzeitig geladen (8 GB RAM-Constraint, Entscheidung #125/#126). Keine ML-Verarbeitung während Aufnahme.

| Schritt | M3 8 GB (Zielgerät) | M1 Pro 16 GB |
|---------|---------------------|--------------|
| ASR (whisper.cpp, Q5_0) | ~15-25 Min | ~20-30 Min |
| Diarization (pyannote) | ~6-15 Min | ~6-18 Min |
| Alignment + Filler-Removal | ~5 Sek | ~5 Sek |
| Anonymisierung (flair NER) | < 30 Sek | < 30 Sek |
| **Total nach Stop** | **~21-40 Min** | **~26-48 Min** |

→ Erfüllt NFR-3 (max 2x Echtzeit = 120 Min) auf allen unterstützten Geräten
→ Modelle werden nach jedem Schritt entladen, bevor das nächste geladen wird

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
    │ Adresse   │  │ ORG      │  │ (7 Typen) │
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
                  │  + NER-Vorrang │
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │  ENTITY        │
                  │  RESOLVER      │
                  │  (konsistente  │
                  │   Platzhalter  │
                  │   + Herkunft)  │
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │  Anonymisierter│
                  │  Text + Entity │
                  │  Map + Herkunft│
                  └────────────────┘
```

**Merger-Priorität (Entscheidung #68):** NER hat Vorrang → Sperrliste ergänzt nur, was NER nicht erkennt. Bei Typ-Konflikt gilt der NER-Typ.

**Herkunfts-Tracking (Entscheidung #132):** Jeder Platzhalter speichert seine Herkunft:
- `ner` — automatisch durch flair/Regex erkannt
- `blocklist` — durch Sperrliste-Match erkannt
- `manual` — vom User im Review markiert

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

User-sichtbare Platzhalter-Typen (7 Typen, Entscheidung #146):

| User-Typ | NER-Quellen | Platzhalter-Format |
|----------|-------------|-------------------|
| PERSON | flair PER + Sperrliste | `[PERSON 1]`, `[PERSON 2]` |
| ORT | flair LOC + Regex PLZ + Sperrliste | `[ORT 1]`, `[ORT 2]` |
| DATUM | Regex Geburtsdatum + Sperrliste | `[DATUM 1]`, `[DATUM 2]` |
| KONTAKT | Regex (Telefon, Email, Adresse, Social Media, AHV-Nr, Vers-Nr) + Sperrliste | `[KONTAKT 1]`, `[KONTAKT 2]` |
| ORGANISATION | nur Sperrliste + manuell (flair ORG wird ignoriert — Institutionsnamen sind Out of Scope, Entscheidung #5/#158) | `[ORGANISATION 1]`, `[ORGANISATION 2]` |
| MEDIZINISCH | nur Sperrliste | `[MEDIZINISCH 1]`, `[MEDIZINISCH 2]` |
| SONSTIGES | flair MISC + Sperrliste | `[SONSTIGES 1]`, `[SONSTIGES 2]` |

**NER→User-Typ-Mapping:**
| flair/Regex-Typ | → User-Typ |
|-----------------|-----------|
| PER | PERSON |
| LOC | ORT |
| ORG | **ignoriert** (Institutionsnamen Out of Scope, Entscheidung #5/#158) |
| MISC | SONSTIGES |
| Regex: Geburtsdatum | DATUM |
| Regex: Telefon, Email, Adresse, Social Media, AHV-Nr, Vers-Nr, Fall-Nr | KONTAKT |
| Regex: Gesprochene Nummern | KONTAKT (best-effort) |

**Nummerierung (Entscheidung #140):** Typ-spezifisch fortlaufend. Lücken werden NICHT gefüllt (z.B. [PERSON 1] + [PERSON 3] → nächster wird [PERSON 4]).

**False-Negative-Typen im Review (Entscheidung #151):** Manuelle Markierung bietet 5 Typen: PERSON, ORT, DATUM, KONTAKT, ORGANISATION. MEDIZINISCH + SONSTIGES nur via Sperrliste.

---

## 5. ML-Pipeline: OCR (Epic 3)

### 5.1 PDF-Textextraktion

**pdfjs-dist** (Node.js, in Worker Thread)

| Eigenschaft | Wert |
|-------------|------|
| Typ | JavaScript PDF-Parser (Mozilla) |
| Text-Extraktion | `page.getTextContent()` |
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
| Geschwindigkeit | Nutzt Neural Engine — < 3 Sek/Seite (NFR-26) |
| Lizenz | Kostenlos (macOS-System-API) |
| Dependencies | Keine (in macOS 14+ eingebaut) |

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
        'extracting', 'anonymizing', 'review', 'error'
    )),
    audio_path TEXT,
    transcript_path TEXT,        -- JSON: Timestamped words + speaker segments
    anonymized_path TEXT,        -- JSON: TipTap document state
    pdf_path TEXT,
    entity_map TEXT,             -- JSON: {id: {original, type, source, placeholder}}
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Sperrliste (Epic 5)
-- 7 Platzhalter-Typen (Entscheidung #146)
CREATE TABLE blocklist (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    placeholder_type TEXT NOT NULL CHECK(placeholder_type IN (
        'PERSON', 'ORT', 'DATUM', 'KONTAKT',
        'ORGANISATION', 'MEDIZINISCH', 'SONSTIGES'
    )),
    created_at TEXT DEFAULT (datetime('now'))
);

-- Task Queue (Crash-Recovery, ML-Job-Serialisierung)
CREATE TABLE task_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (
        'transcription', 'diarization', 'alignment',
        'extraction', 'ocr', 'anonymization'
    )),
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
    sha256 TEXT,                -- Hash für Integritätsprüfung (NFR-16)
    bundled BOOLEAN DEFAULT FALSE,
    config TEXT,               -- JSON: Modell-spezifische Konfiguration
    added_at TEXT DEFAULT (datetime('now'))
);

-- Indizes
CREATE INDEX idx_sessions_created_at ON sessions(created_at);
CREATE INDEX idx_task_queue_status ON task_queue(status);
CREATE INDEX idx_task_queue_session ON task_queue(session_id);
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
  "firstLaunchDone": false,
  "consentReminderShown": false,
  "modelsDownloaded": false
}
```

### 6.3 Dateisystem-Layout

```
~/.therascript/
├── data/
│   ├── therascript.db                    (SQLite)
│   ├── audio/
│   │   └── {session-id}.wav              (Aufnahmen, ~115 MB/h)
│   ├── transcripts/
│   │   └── {session-id}.json             (Timestamped words + speakers)
│   ├── anonymized/
│   │   └── {session-id}.json             (TipTap document + entity map)
│   ├── pdf/
│   │   └── {session-id}.pdf              (Importierte PDFs)
│   └── recovery/
│       └── {session-id}.pcm              (Auto-Recovery Chunks)
├── models/                               (siehe Sektion 8.1)
└── .metadata_never_index                 (NFR-17: Spotlight-Ausschluss)
```

**Berechtigungen (NFR-18):** `chmod 700` auf `~/.therascript/` — nur Owner hat Zugriff.

---

## 7. Review Editor (Epic 6)

### 7.1 Technologie: TipTap (ProseMirror)

**Begründung:** TipTap ist ein headless Rich-Text-Editor-Framework auf ProseMirror-Basis. Es bietet:
- Atomare Custom Nodes (für Platzhalter-Chips, Speaker-Labels, Zeitstempel)
- Transaction-basiertes Undo/Redo mit nativer Batch-Unterstützung
- JSON-basiertes Dokumentmodell (einfach persistierbar)
- React-Integration via `@tiptap/react`
- Aktive Community, MIT-Lizenz

### 7.2 Dokumentmodell

```typescript
// TipTap Custom Nodes

// Platzhalter-Chip (atomar, nicht editierbar)
const PlaceholderChip = Node.create({
  name: 'placeholderChip',
  group: 'inline',
  inline: true,
  atom: true,  // Cursor springt darüber
  attrs: {
    entityId: { default: '' },        // z.B. "person-1"
    type: { default: 'PERSON' },      // PERSON | ORT | DATUM | KONTAKT | ORGANISATION | MEDIZINISCH | SONSTIGES
    number: { default: 1 },           // Fortlaufende Nummer pro Typ
    source: { default: 'ner' },       // ner | blocklist | manual
    original: { default: '' },        // Originaltext (für Undo)
  },
});

// Speaker-Label (atomar, löschbar)
const SpeakerLabel = Node.create({
  name: 'speakerLabel',
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    speaker: { default: 'A' },        // A | B | C | D
    label: { default: 'Person A' },
  },
});

// Zeitstempel (atomar, löschbar)
const Timestamp = Node.create({
  name: 'timestamp',
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    time: { default: '00:00:00' },    // HH:MM:SS
  },
});
```

### 7.3 Platzhalter-Chip-Darstellung (US-6a)

- **Farbcodierung nach Typ:**
  | Typ | Farbe (Vorschlag) |
  |-----|-------------------|
  | PERSON | Blau |
  | ORT | Grün |
  | DATUM | Orange |
  | KONTAKT | Violett |
  | ORGANISATION | Türkis |
  | MEDIZINISCH | Rot |
  | SONSTIGES | Grau |

- **Herkunfts-Indikator (Entscheidung #132):** Kleines Icon oder Badge auf dem Chip:
  - NER: Kein Extra-Indikator (Standard)
  - Sperrliste: Kleines Buch-Icon
  - Manuell: Kleines Stift-Icon

- **Copy-Paste (Entscheidung #138):**
  - Innerhalb Therascript: Chips bleiben als atomare Nodes
  - Extern: `clipboardTextSerializer` gibt `[PERSON 1]` als Plain Text aus

### 7.4 False-Positive-Korrektur (US-6b AC 1-2)

**Batch-Rückgängig (Entscheidung #142):**
1. User drückt Delete/Backspace auf einem Chip ODER Rechtsklick → "Rückgängig machen"
2. System sammelt alle Chips mit derselben `entityId` im gesamten Dokument
3. Alle werden durch ihren jeweiligen `original`-Text ersetzt
4. Die gesamte Batch-Operation wird als **ein** ProseMirror-Transaction ausgeführt → **ein** Undo-Schritt

```typescript
function batchUndoPlaceholder(editor: Editor, entityId: string) {
  const { tr } = editor.state;
  // Alle Positionen mit dieser entityId finden (rückwärts iterieren)
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'placeholderChip' && node.attrs.entityId === entityId) {
      tr.replaceWith(pos, pos + node.nodeSize, schema.text(node.attrs.original));
    }
  });
  editor.view.dispatch(tr);  // Eine Transaction = ein Undo-Schritt
}
```

### 7.5 False-Negative-Markierung (US-6b AC 3-4)

1. User selektiert Text im Editor
2. Rechtsklick → Kontextmenü "Anonymisieren"
3. Typ-Auswahl: PERSON, ORT, DATUM, KONTAKT, ORGANISATION (5 Typen, Entscheidung #151)
4. Bei Überlappung mit bestehendem Chip: Selektion wird automatisch auf ganzen Chip erweitert (Entscheidung #139)
5. System ersetzt Selektion durch neuen PlaceholderChip mit:
   - `source: 'manual'`
   - `number`: nächste freie Nummer des gewählten Typs
   - `original`: selektierter Text

### 7.6 Sperrliste-Schnellaktion (US-6c)

1. Im Kontextmenü (nach Selektion) zusätzlich: "Zur Sperrliste hinzufügen"
2. Bestätigungsdialog: "[Begriff] als [Typ] zur Sperrliste hinzufügen?"
3. Bei Bestätigung:
   a. Begriff wird in `blocklist`-Tabelle geschrieben
   b. Selektierter Text wird als Chip anonymisiert
   c. **Retroaktive Anwendung:** Gesamter Text wird re-scannt (case-insensitive + Umlaut-Normalisierung)
   d. Alle weiteren Treffer werden als Chips mit `source: 'blocklist'` eingefügt
   e. Alles als **eine** ProseMirror-Transaction → **ein** Undo-Schritt
4. **Undo (Entscheidung #141):** Cmd+Z macht alles rückgängig: Sperrliste-Eintrag wird entfernt + alle retroaktiv anonymisierten Chips werden durch Original ersetzt
5. **Performance (NFR-27):** < 2 Sekunden für Re-Scan bei ~15'000 Wörtern

### 7.7 Undo/Redo (Entscheidung #130)

- Standard ProseMirror History-Plugin
- `Cmd+Z` (Undo), `Cmd+Shift+Z` (Redo)
- Gruppierte Schritte (z.B. "ein Wort tippen" = 1 Schritt)
- Mindestens 100 Schritte Tiefe
- **Nicht persistiert** — History geht bei App-Neustart verloren

### 7.8 Auto-Save (Entscheidung #133)

```typescript
// Debounced Auto-Save (~2 Sekunden Inaktivität)
const debouncedSave = useDebouncedCallback(async (doc: JSONContent) => {
  await ipcRenderer.invoke('session:save-review', {
    sessionId,
    document: doc,           // TipTap JSON
    entityMap,               // Entity-Mapping
  });
}, 2000);

editor.on('update', ({ editor }) => {
  debouncedSave(editor.getJSON());
});
```

**Persistiert:** Text + Platzhalter-Positionen + Herkunfts-Metadaten.
**Nicht persistiert:** Undo/Redo-History.

### 7.9 Editor-Performance (NFR-25)

- Ziel: Flüssig bei ~15'000 Wörtern mit ~100+ Platzhalter-Chips
- ProseMirror virtualisiert Rendering nicht nativ → bei Bedarf:
  - Lazy Rendering für Off-Screen-Nodes
  - `shouldComponentUpdate`-Optimierungen für Chip-Render
  - Batch-DOM-Updates über ProseMirror Transactions

---

## 8. Sperrliste: Matching-Engine (Epic 5)

### 8.1 Matching-Algorithmus

```typescript
function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    // Bidirektionale Umlaut-Normalisierung (Entscheidung #147)
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

function applyBlocklist(text: string, blocklist: BlocklistEntry[]): Match[] {
  // Longest Match zuerst (Entscheidung #81)
  const sorted = [...blocklist].sort((a, b) => b.term.length - a.term.length);

  const matches: Match[] = [];
  const normalizedText = normalizeForMatching(text);

  for (const entry of sorted) {
    const normalizedTerm = normalizeForMatching(entry.term);
    // Whole-word matching (Entscheidung #73)
    const regex = new RegExp(`\\b${escapeRegex(normalizedTerm)}\\b`, 'gi');

    let match;
    while ((match = regex.exec(normalizedText)) !== null) {
      // Prüfen ob Position nicht bereits von NER oder längerem Match belegt
      if (!isOverlapping(matches, match.index, match.index + match[0].length)) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          type: entry.placeholder_type,
          source: 'blocklist',
          original: text.substring(match.index, match.index + match[0].length),
        });
      }
    }
  }
  return matches;
}
```

**Umlaut-Normalisierung:** Bidirektional — "Müller" findet "Mueller" und "Mueller" findet "Müller". Normalisierung erfolgt auf beiden Seiten (Text + Suchbegriff).

---

## 9. Export (Epic 7)

### 9.1 Clipboard-Export (US-7)

```typescript
async function exportToClipboard(sessionId: string): Promise<void> {
  const doc = await loadReviewDocument(sessionId);
  const session = await getSession(sessionId);

  // TipTap-Dokument zu Plain Text serialisieren
  let text = '';
  doc.content.forEach(block => {
    block.content?.forEach(node => {
      if (node.type === 'text') {
        text += node.text;
      } else if (node.type === 'placeholderChip') {
        text += `[${node.attrs.type} ${node.attrs.number}]`;
      } else if (node.type === 'speakerLabel' && session.type === 'audio') {
        text += `[${node.attrs.label}]:`;
      } else if (node.type === 'timestamp' && session.type === 'audio') {
        text += `[${node.attrs.time}]`;
      }
    });
    text += '\n';
  });

  await clipboard.writeText(text.trim());
}
```

**Inhalt (Entscheidung #113):** Nur anonymisierter Text + Speaker-Labels + Zeitstempel. Keine Metadaten (Titel, Datum, Dauer) — bewusste Datenschutz-Entscheidung.

**PDF-Sitzungen:** Gleiches Kopieren, aber ohne Zeitstempel und Speaker-Labels (nur Fliesstext mit Platzhaltern).

---

## 10. macOS-Integrationen

### 10.1 Menu Bar Icon (US-1, AC 6)

Electron `Tray` API:
- Template-Image für automatische Dark/Light-Mode-Adaption
- `tray.setTitle(duration)` zeigt Aufnahmedauer neben dem Icon
- Rotes Icon während Aufnahme, Standard-Icon im Leerlauf
- Context-Menu: Stop, Dauer, "Therascript öffnen"

### 10.2 Standby-Unterdrückung (US-1, AC 8)

```javascript
const { powerSaveBlocker } = require('electron');
// 'prevent-app-suspension' — Display darf schlafen, App läuft weiter
const id = powerSaveBlocker.start('prevent-app-suspension');
// Bei Aufnahme-Stop: powerSaveBlocker.stop(id);
```

### 10.3 Audio-Aufnahme (US-1, AC 1-5, 9)

Web Audio API + AudioWorklet im Renderer:
- `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })`
- AudioWorklet sendet PCM-Chunks via IPC an Main Process
- Main Process streamt auf Disk (WAV/raw PCM) für Auto-Recovery
- Periodischer Flush alle 60 Sekunden (US-1, AC 9)
- **Auto-Stop nach 2 Stunden** (US-1, AC 11) mit macOS-Benachrichtigung

### 10.4 Crash-Recovery (US-1, AC 9-10)

1. Während Aufnahme: PCM-Chunks werden alle 60s in `recovery/{session-id}.pcm` geschrieben
2. Beim App-Start: Main Process prüft `recovery/`-Verzeichnis
3. Falls Dateien vorhanden:
   - Session-Status in DB prüfen (Status `recording` ohne ordentlichen Stop)
   - Recovery-PCM in WAV konvertieren
   - Session-Status auf `'error'` setzen mit Hinweis "Wiederhergestellt"
   - User wird im Dashboard informiert und kann Verarbeitung starten
4. Recovery-Dateien werden nach erfolgreicher Übernahme gelöscht

### 10.5 Einwilligungs-Hinweis (US-1, AC 12)

Beim erstmaligen Start einer Aufnahme (wenn `consentReminderShown === false`):
- Toast/Banner: "Bitte holen Sie die Einwilligung des Patienten zur Aufnahme ein (StGB Art. 179bis)."
- Checkbox "Nicht mehr anzeigen"
- Aufnahme wird **nicht** blockiert

### 10.6 Mikrofon-Berechtigung

`Info.plist`:
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Therascript benötigt Mikrofonzugriff für die Aufnahme von Therapiegesprächen.</string>
```

### 10.7 Benachrichtigungen (US-2 AC 12, US-3 AC 12)

```javascript
const { Notification } = require('electron');
new Notification({
  title: 'Verarbeitung abgeschlossen',
  body: `"${sessionTitle}" ist bereit zur Überprüfung.`
}).show();
```

Benachrichtigungen bei: Transkription fertig, PDF-Verarbeitung fertig, Auto-Stop nach 2h.

---

## 11. Sitzungsverwaltung (Epic 0)

### 11.1 Dashboard-Gruppierung (US-0, AC 8-9)

Sitzungen chronologisch absteigend sortiert (fest, nicht umschaltbar) und nach relativen Zeiträumen gruppiert:

```typescript
type TimeGroup = 'Heute' | 'Gestern' | 'Diese Woche' | 'Letzte Woche' | 'Älter';

function groupSessions(sessions: Session[]): Map<TimeGroup, Session[]> {
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = subDays(today, 1);
  const thisWeekStart = startOfWeek(now, { weekStartsOn: 1 }); // Montag
  const lastWeekStart = subWeeks(thisWeekStart, 1);

  // Leere Gruppen werden nicht angezeigt
  return sessions.reduce((groups, session) => {
    const created = new Date(session.created_at);
    let group: TimeGroup;
    if (created >= today) group = 'Heute';
    else if (created >= yesterday) group = 'Gestern';
    else if (created >= thisWeekStart) group = 'Diese Woche';
    else if (created >= lastWeekStart) group = 'Letzte Woche';
    else group = 'Älter';
    // ...
  });
}
```

### 11.2 Auto-Löschung (US-0, AC 7)

**30 Tage nach Erstellung** — stille Löschung ohne Vorwarnung (Entscheidung #119).

```typescript
// Beim App-Start + alle 6 Stunden
async function cleanupExpiredSessions(): Promise<void> {
  const cutoff = subDays(new Date(), 30);
  const expired = db.prepare(`
    SELECT id, audio_path, transcript_path, anonymized_path, pdf_path
    FROM sessions WHERE created_at < ?
  `).all(cutoff.toISOString());

  for (const session of expired) {
    // 1. Dateien löschen (Audio, Transkript, Anonymisiert, PDF)
    await deleteSessionFiles(session);
    // 2. DB-Einträge löschen (CASCADE löscht auch task_queue)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  }

  // 3. SQLite VACUUM (NFR-17: sichere Löschung)
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
}
```

### 11.3 Manuelle Löschung (US-0, AC 5)

1. Bestätigungsdialog: "Sitzung und alle zugehörigen Daten unwiderruflich löschen?"
2. Alle Dateien löschen (Audio, Transkript, Anonymisiert, PDF, Recovery)
3. DB-Einträge löschen
4. SQLite VACUUM
5. **Performance (NFR-29):** < 5 Sekunden auch bei 60-Min-Sitzungen (~115 MB)

### 11.4 Auto-Titel (US-0, AC 2)

Format: `"Sitzung DD.MM.YYYY HH:MM"` (z.B. "Sitzung 07.02.2026 14:30")

---

## 12. Security Architecture

### 12.1 Netzwerk-Isolation (NFR-1, NFR-12)

```javascript
// Electron BrowserWindow
const mainWindow = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,    // NFR-14
    nodeIntegration: false,    // NFR-14
    sandbox: true,             // NFR-14
  }
});

// Content Security Policy im Renderer
// Verhindert jegliche Netzwerk-Requests
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'; " +
        "connect-src 'none'; " +        // NFR-12: Kein Netzwerk
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'"
      ]
    }
  });
});
```

### 12.2 Electron Hardening (NFR-14)

```javascript
// Electron Fuses (build-time)
// In electron-builder Konfiguration:
{
  "electronFuses": {
    "RunAsNode": false,
    "EnableNodeCliInspectArguments": false,
    "EnableCookieEncryption": true,
    "EnableNodeOptionsEnvironmentVariable": false
  }
}
```

- `contextIsolation: true` — Renderer hat keinen Zugriff auf Node.js
- `nodeIntegration: false` — Kein `require()` im Renderer
- `sandbox: true` — Chromium-Sandbox aktiviert
- Keine Remote-Inhalte (keine `loadURL` auf externe URLs)
- Electron Auto-Updater **deaktiviert** (manuelle Updates via Website)

### 12.3 IPC-Schema-Validierung (NFR-15)

```typescript
import { z } from 'zod';

// Jeder IPC-Channel hat ein definiertes Schema
const SessionSaveSchema = z.object({
  sessionId: z.string().uuid(),
  document: z.object({}).passthrough(),
  entityMap: z.record(z.object({
    original: z.string(),
    type: z.enum(['PERSON', 'ORT', 'DATUM', 'KONTAKT', 'ORGANISATION', 'MEDIZINISCH', 'SONSTIGES']),
    source: z.enum(['ner', 'blocklist', 'manual']),
  })),
});

// Im Main Process: Validierung vor Verarbeitung
ipcMain.handle('session:save-review', async (event, args) => {
  const validated = SessionSaveSchema.parse(args);
  // ... verarbeiten
});
```

### 12.4 Modell-Integrität (NFR-16)

- Gebündelte Modelle: SHA-256 Hash im `model_registry` gespeichert, bei Laden verifiziert
- PyTorch: `weights_only=True` beim Laden (verhindert Pickle-Exploits)
- Pfad-Beschränkung: Modell-Pfade müssen unter `~/.therascript/models/` liegen (Path-Traversal-Schutz)

```typescript
async function verifyModelIntegrity(modelPath: string, expectedHash: string): Promise<boolean> {
  const hash = await computeSHA256(modelPath);
  return hash === expectedHash;
}
```

### 12.5 FileVault-Prüfung (NFR-13)

```typescript
// Beim App-Start
async function checkFileVault(): Promise<boolean> {
  const { stdout } = await exec('fdesetup status');
  return stdout.includes('FileVault is On');
}

// Falls deaktiviert: Warnung im Dashboard (nicht blockierend)
```

### 12.6 App Sandbox (NFR-18)

macOS App Sandbox Entitlements (`entitlements.mac.plist`):

```xml
<key>com.apple.security.app-sandbox</key>        <true/>
<key>com.apple.security.device.audio-input</key>  <true/>
<key>com.apple.security.files.user-selected.read-write</key> <true/>
```

### 12.7 Sichere Löschung (NFR-17)

- SQLite `VACUUM` nach Sitzungslöschung
- Temp-/Recovery-Dateien konsequent aufräumen
- `.metadata_never_index` im Datenverzeichnis (Spotlight-Ausschluss)
- Kein byte-level Overwrite auf SSD (ineffektiv bei TRIM)

### 12.8 Code Signing & Notarization (NFR-19)

- Apple Developer Certificate für Code Signing
- Notarization via `xcrun notarytool` für Gatekeeper-Kompatibilität
- Konfiguriert in `electron-builder.yml`

**⚠️ Offene Entscheidung:** Code Signing erfordert Apple Developer Account (99€/Jahr). Entscheidung #104 sagt "Pflicht", aber Kosten wurden als Hindernis genannt (Entscheidung #153). Ohne Notarization zeigt Gatekeeper nicht-technischen Nutzern eine Blockier-Warnung. **Muss vor Distribution an Dritte entschieden werden.**

### 12.9 Supply-Chain-Hygiene (NFR-20)

- `npm audit` in CI-Pipeline
- Lockfile (`package-lock.json`) versioniert
- Python-Dependencies gepinnt mit Hash-Verification (`pip install --require-hashes`)
- Electron regelmässig aktualisieren (Chromium-Patches)

---

## 13. IPC-Channel-Design

### 13.1 Renderer → Main (invoke/handle)

| Channel | Payload | Antwort | Beschreibung |
|---------|---------|---------|--------------|
| `recording:start` | — | `{ sessionId }` | Aufnahme starten |
| `recording:stop` | `{ sessionId }` | — | Aufnahme stoppen |
| `session:list` | — | `Session[]` | Alle Sitzungen laden |
| `session:delete` | `{ sessionId }` | — | Sitzung löschen |
| `session:rename` | `{ sessionId, title }` | — | Titel ändern |
| `session:save-review` | `{ sessionId, document, entityMap }` | — | Review-State speichern |
| `session:load-review` | `{ sessionId }` | `{ document, entityMap }` | Review-State laden |
| `session:export-clipboard` | `{ sessionId }` | — | In Zwischenablage kopieren |
| `import:pdf` | `{ filePaths }` | `{ sessionIds }` | PDF importieren |
| `blocklist:list` | — | `BlocklistEntry[]` | Sperrliste laden |
| `blocklist:add` | `{ term, type }` | `{ id }` | Eintrag hinzufügen |
| `blocklist:update` | `{ id, term, type }` | — | Eintrag bearbeiten |
| `blocklist:delete` | `{ id }` | — | Eintrag löschen |
| `settings:get` | — | `Settings` | Einstellungen laden |
| `settings:set` | `Partial<Settings>` | — | Einstellungen ändern |
| `models:list` | — | `ModelInfo[]` | Verfügbare Modelle |
| `models:add` | `{ filePath, task, runtime }` | `{ id }` | Modell hinzufügen |
| `system:filevault-status` | — | `{ enabled }` | FileVault-Status |

### 13.2 Main → Renderer (send/on)

| Channel | Payload | Beschreibung |
|---------|---------|--------------|
| `recording:level` | `{ level: number }` | Audio-Pegel (für VU-Meter) |
| `recording:duration` | `{ seconds: number }` | Aufnahmedauer |
| `task:progress` | `{ sessionId, type, progress, eta }` | ML-Fortschritt |
| `task:completed` | `{ sessionId, type }` | ML-Schritt fertig |
| `task:error` | `{ sessionId, type, error }` | ML-Fehler |
| `session:status-changed` | `{ sessionId, status }` | Status-Update |

---

## 14. First-Launch & Modell-Download (NFR-28)

### 14.1 Flow

1. App startet zum ersten Mal (`firstLaunchDone === false`)
2. **Speicherplatz-Prüfung**: System prüft ob ~5 GB freier Speicher vorhanden sind; bei zu wenig Platz verständliche Fehlermeldung
3. Dashboard zeigt "Ersteinrichtung" mit Download-Übersicht:
   - whisper-large-v3-turbo Q5_0 (~1.6 GB)
   - pyannote-community-1 (~200 MB)
   - flair-ner-german-large (~2.2 GB)
   - **Total: ~4.0 GB**
4. Fortschrittsanzeige pro Modell + gesamt
5. Download sequenziell (ein Modell nach dem anderen)
6. SHA-256-Verification nach jedem Download (NFR-16)
7. Bei Abbruch: **Resume-fähig** — unterbrochener Download wird beim nächsten Start fortgesetzt (Entscheidung #109, revidiert)
8. App ist erst nach vollständigem Download einsatzbereit
9. `firstLaunchDone = true` + `modelsDownloaded = true` setzen

### 14.2 Download-Quellen

Modelle werden von Hugging Face Hub heruntergeladen:
- `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`
- pyannote/flair: Komplette Modell-Verzeichnisse via `huggingface_hub` Download

**Netzwerk-Ausnahme:** Modell-Download ist der **einzige** erlaubte Netzwerk-Zugriff (NFR-1/NFR-12). Erfolgt nur beim First-Launch oder wenn User explizit ein neues Modell hinzufügt.

---

## 15. Task Queue & Pipeline-Orchestrierung

### 15.1 Queue-Design

Die Task Queue serialisiert alle ML-Jobs (FIFO). Immer nur **ein** ML-Modell gleichzeitig geladen.

```typescript
class TaskQueue {
  private running = false;

  async enqueue(sessionId: string, tasks: TaskType[]): Promise<void> {
    for (const type of tasks) {
      db.prepare(`INSERT INTO task_queue (id, session_id, type, status)
                  VALUES (?, ?, ?, 'pending')`).run(uuid(), sessionId, type);
    }
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.running) return;

    const next = db.prepare(`
      SELECT * FROM task_queue WHERE status = 'pending'
      ORDER BY created_at ASC LIMIT 1
    `).get();

    if (!next) return;
    this.running = true;

    try {
      await this.execute(next);
      db.prepare(`UPDATE task_queue SET status = 'completed', completed_at = datetime('now')
                  WHERE id = ?`).run(next.id);
    } catch (error) {
      db.prepare(`UPDATE task_queue SET status = 'failed', error = ? WHERE id = ?`)
        .run(error.message, next.id);
      // Session-Status auf 'error' setzen
      db.prepare(`UPDATE sessions SET status = 'error', error_message = ? WHERE id = ?`)
        .run(error.message, next.session_id);
    } finally {
      this.running = false;
      this.processNext();  // Nächsten Task verarbeiten
    }
  }
}
```

### 15.2 Audio-Pipeline (Tasks)

Nach Recording-Stop werden folgende Tasks eingereiht:
1. `transcription` — whisper.cpp (laden → transkribieren → entladen)
2. `diarization` — pyannote (laden → diarisieren → entladen)
3. `alignment` — Word-Midpoint-Alignment + Filler-Removal (kein ML-Modell)
4. `anonymization` — flair NER + Regex + Sperrliste (laden → anonymisieren → entladen)

### 15.3 PDF-Pipeline (Tasks)

Nach PDF-Import:
1. `extraction` — pdfjs-dist Textextraktion (kein ML-Modell)
2. `ocr` — Apple Vision für Scan-Seiten (nur bei Bedarf)
3. `anonymization` — flair NER + Regex + Sperrliste

### 15.4 Crash-Recovery

Beim App-Start: Tasks mit Status `running` werden auf `pending` zurückgesetzt und erneut verarbeitet.

---

## 16. Plugin-Architektur (NFR-9, NFR-10)

### 16.1 Modell-Verzeichnis

```
~/.therascript/models/
  asr/
    ggml-large-v3-turbo-q5_0.bin    (Standard, heruntergeladen)
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
```

### 16.2 Provider-Interface

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

### 16.3 Modell hinzufügen (User-Flow)

1. User klickt "Modell hinzufügen" in Settings
2. Dialog: Modell-Datei auswählen, Task-Typ, Runtime
3. App kopiert Modell in `~/.therascript/models/` (Pfad-Validierung gegen Path-Traversal)
4. SHA-256 Hash berechnen und in `model_registry` speichern
5. Validierung (Format-Check, ladbar?)
6. Modell erscheint in Dropdown

---

## 17. Verarbeitungs-Pipelines

### 17.1 Audio-Pipeline (Live-Aufnahme)

> Keine ML-Verarbeitung während Aufnahme (8 GB RAM-Constraint, NFR-24: < 5% CPU).

```
┌─ Aufnahme läuft ─────────────────────────────────────┐
│                                                       │
│  Mikrofon → AudioWorklet → PCM-Chunks → Disk (WAV)  │
│  (Nur Recording, keine ML-Last, < 5% CPU)            │
│  Auto-Save alle 60s in recovery/{id}.pcm             │
│                                                       │
│  Auto-Stop nach 2 Stunden (US-1 AC 11)               │
│                                                       │
└──── User drückt STOP ────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │ 1. whisper.cpp   │  ← Volle Audiodatei
         │    ASR (Q5_0)    │     (Modell laden → transkribieren → entladen)
         │    nice -n 10    │     (NFR-23: Mac bleibt benutzbar)
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ 2. pyannote      │  ← Volle Audiodatei
         │    Diarization   │     (Modell laden → diarisieren → entladen)
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ 3. Alignment     │
         │    + Filler-Rem. │  ← Words + Speaker Segments
         │    + Formatierung│     (kein ML-Modell nötig)
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ 4. Anonymisierung│  ← flair NER + Regex + Sperrliste
         │    (NER laden    │     (Modell laden → anonymisieren → entladen)
         │     → entladen)  │     (NFR-11: < 30 Sek)
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ macOS-Benachrich-│
         │ tigung + Status  │
         │ → 'review'       │
         └────────┬─────────┘
                  │
                  ▼
         Review-Modus (Epic 6)
```

### 17.2 PDF-Pipeline

```
PDF-Import → Queue (FIFO)
                  │
                  ▼
         ┌──────────────────┐
         │ Pro Seite:        │
         │ Text vorhanden?   │  Status: 'extracting'
         │ → JA: pdfjs-dist  │
         │ → NEIN: OCR       │  (NFR-26: Text < 5s, OCR < 3s/Seite)
         │   (Apple Vision)  │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ Anonymisierung    │  Status: 'anonymizing'
         │ (flair NER +      │
         │  Regex + Sperrli.)│
         └────────┬─────────┘
                  │
                  ▼
         Linearer Fliesstext → macOS-Benachrichtigung → Review
```

---

## 18. Performance-Budgets

### 18.1 RAM-Verbrauch (strikt sequenziell)

> **Zielgerät:** MacBook Air M3 8 GB (Entscheidung #125). Alle ML-Modelle laufen nacheinander — immer nur eines gleichzeitig geladen.

| Phase | Aktive Komponenten | RAM |
|-------|-------------------|-----|
| **Aufnahme** | Electron + Audio-Buffer | ~800 MB |
| **ASR** | Electron + whisper.cpp Q5_0 | ~2.3 GB |
| **Diarization** | Electron + pyannote | ~2.0 GB |
| **Anonymisierung** | Electron + flair NER large | ~2.7 GB |
| **Review/Export** | Electron + TipTap Editor | ~600 MB |
| OS Overhead (macOS 14) | | ~2.5 GB |
| **Peak (Anonymisierung)** | Electron + flair + OS | **~5.2 GB** |

**Headroom auf 8 GB:** ~2.8 GB für andere Apps (Safari, Praxis-SW)

**Minimum:** 8 GB RAM (Apple Silicon). Strikt sequenzielle Pipeline — Modell wird nach jedem Schritt entladen.

### 18.2 Disk-Verbrauch

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

**Strategie:** ARM64-only .dmg-Installer ~250 MB, Modelle werden beim ersten Start heruntergeladen (~4.0 GB, resume-fähig). Mindestens ~5 GB freier Speicherplatz erforderlich.

### 18.3 Distribution & Packaging (NFR-31, Epic 8)

**Format:** macOS .dmg mit Drag-to-Applications-Fenster (Standard-macOS-Installationskonvention)

**Build-Konfiguration (electron-builder):**

```yaml
# electron-builder.yml
mac:
  target:
    - target: dmg
      arch: arm64          # Nur Apple Silicon (Entscheidung #154)
  category: public.app-category.medical
  # Code Signing: siehe offene Entscheidung in 12.8

dmg:
  contents:
    - x: 130
      y: 220
    - x: 410
      y: 220
      type: link
      path: /Applications
```

**Architektur:** Ausschliesslich ARM64 (Apple Silicon M1-M4). Kein Intel-Support, kein Universal Binary (Entscheidung #154).

**Vertriebskanal:** Direktdownload (kein Mac App Store). Gründe: Kontrolle über Distribution, Vermeidung von MAS Sandbox-Einschränkungen und Apple Developer Program Kosten (Entscheidung #152, #153).

**Update-Mechanismus:** Manuell — neue Version = neue .dmg herunterladen und installieren. Electron Auto-Updater bleibt deaktiviert (Entscheidung #155). Kein Sparkle/electron-updater.

**Lizenz:** MIT (Open Source, kostenlos) — Entscheidung #156. Kompatibel mit allen Dependencies (siehe Kap. 19).

### 18.4 Deinstallation (NFR-32, US-8b)

In-App-Menüpunkt "Therascript vollständig entfernen" mit Bestätigungsdialog.

**Entfernt:**
- `~/.therascript/models/` (~4 GB ML-Modelle)
- `~/.therascript/data/` (SQLite, Audio, Transkripte, Recovery)
- `~/Library/Application Support/therascript/` (electron-store Settings)
- Temp-Dateien und Logs

**Nicht entfernbar durch die App:**
- `/Applications/Therascript.app` (macOS-Limitation — User muss .app manuell in Papierkorb ziehen)

**Sichere Löschung:** SQLite VACUUM + Temp-Cleanup gemäss NFR-17. Kein Byte-Level-Overwrite (ineffektiv bei SSD TRIM).

### 18.5 Performance-Zielwerte (NFR-Zusammenfassung)

| NFR | Zielwert |
|-----|----------|
| NFR-3: Transkription | Max. 2x Echtzeit (60 Min → max. 120 Min) |
| NFR-11: Anonymisierung | < 30 Sekunden |
| NFR-21: App-Start (Cold) | < 5 Sekunden bis Dashboard interaktiv |
| NFR-24: Recording-Overhead | < 5% CPU |
| NFR-25: Editor-Performance | Flüssig bei ~15'000 Wörtern + ~100 Chips |
| NFR-26: OCR | Text-PDF < 5s (50 Seiten), Scan < 3s/Seite |
| NFR-27: Sperrliste retroaktiv | < 2 Sekunden |
| NFR-29: Sitzungslöschung | < 5 Sekunden |
| NFR-30: Dashboard | Performant bis ~100 Sitzungen |

---

## 19. Lizenz-Kompatibilität

| Modell / Library | Lizenz | Kommerziell | Therascript-kompatibel |
|-----------------|--------|-------------|----------------------|
| whisper.cpp | MIT | Ja | Ja |
| Whisper Large V3 Turbo | MIT | Ja | Ja |
| pyannote community-1 | CC-BY-4.0 | Ja (Attribution) | Ja |
| Senko | MIT | Ja | Ja |
| flair/ner-german-large | MIT | Ja | Ja |
| GLiNER Multi PII | Apache 2.0 | Ja | Ja |
| Apple Vision | macOS System-API | Ja | Ja |
| Tesseract | Apache 2.0 | Ja | Ja |
| pdfjs-dist | Apache 2.0 | Ja | Ja |
| better-sqlite3 | MIT | Ja | Ja |
| Electron | MIT | Ja | Ja |
| TipTap | MIT | Ja | Ja |
| zod | MIT | Ja | Ja |

**Nicht verwendbar (NC-Lizenz):** Meta MMS (CC-BY-NC), SeamlessM4T (CC-BY-NC), Piiranha (CC-BY-NC-ND), UniNER-7B (CC-BY-NC)

**Therascript-Lizenz:** MIT (Entscheidung #156) — alle obigen Dependencies sind MIT-kompatibel. Attribution erforderlich für pyannote community-1 (CC-BY-4.0).

---

## 20. Risiken & Mitigationen

| Risiko | Schwere | Wahrscheinlichkeit | Mitigation |
|--------|---------|---------------------|------------|
| Schweizerdeutsch WER zu hoch (>20%) | Hoch | Mittel | Fine-Tune auf STT4SG-Daten (v2); optionaler LLM-Postprocessing-Schritt |
| 2x Echtzeit auf 8 GB M1 verletzt | Mittel | Niedrig-Mittel | Q4_0-Quantisierung; Fallback auf Medium-Modell; 16 GB empfehlen |
| Whisper-Halluzinationen bei Stille | Mittel | Mittel | Silero VAD als Pre-Filter vor Whisper |
| NER verpasst Namen in gesprochener Sprache | Hoch | Mittel | Sperrliste für wiederkehrende Namen; Review-Modus als Sicherheitsnetz |
| Compound-Word False Positives ("Müller" in "Müllerstrasse") | Mittel | Mittel | Whole-Word-Matching-Check |
| Python-Sidecar-Bundling-Komplexität | Mittel | Mittel | PyInstaller oder embedded Python; alternativ reine C++ Diarization |
| flair NER RAM-Konflikt mit Whisper | Mittel | Mittel | Strikt sequenzielle Pipeline — Modell vor nächstem Schritt entladen |
| pyannote CPU-Geschwindigkeit auf Apple Silicon knapp | Mittel | Mittel | Senko als schnelle Alternative anbieten |
| TipTap-Performance bei ~15'000 Wörtern | Mittel | Niedrig | Lazy Rendering; Virtualisierung bei Bedarf |
| Modell-Download bei First-Launch bricht ab | Mittel | Mittel | Resume-fähiger Download; Fortschritt wird gespeichert; Fehlermeldung mit Retry-Option (Entscheidung #109, revidiert) |

---

## 21. Implementations-Phasen

### Phase 1: MVP Core
- Epic 0: Sitzungsverwaltung (SQLite + React Dashboard + Auto-Löschung)
- Epic 1: Audio-Aufnahme (Web Audio API + Menu Bar + Auto-Recovery)
- Epic 2: Transkription (whisper.cpp) + Diarization (pyannote) — sequenziell
- Epic 3: PDF-Import + OCR (pdfjs-dist + Apple Vision)
- Epic 4: Anonymisierung (flair NER + Regex + Sperrliste)
- Epic 5: Sperrliste (CRUD in SQLite + Matching-Engine)
- Epic 6: Review-Modus (TipTap Editor + False Positive/Negative + Sperrliste-Schnellaktion)
- Epic 7: Export (Clipboard)
- Epic 8: Distribution (.dmg ARM64-only, First-Launch Modell-Download, Uninstaller)
- Security: Electron Hardening + CSP + IPC-Validierung + FileVault-Check

### Phase 2: Erweiterungen
- GLiNER PII als ergänzende NER-Schicht
- Gesprochene Nummern-Erkennung (best-effort)
- Tesseract als Fallback-OCR

### Phase 3: Polish & Plugins
- Plugin-Architektur (NFR-9, NFR-10) — Modell-Management UI
- Senko als alternative Diarization-Engine
- PDF-Batch-Import mit Queue-UI
- Performance-Optimierungen (Editor-Virtualisierung, etc.)

---

## 22. Offene technische Entscheidungen

| # | Frage | Optionen | Empfehlung |
|---|-------|----------|------------|
| T1 | Python-Bundling-Strategie? | PyInstaller vs. conda-pack vs. embedded Python | PyInstaller (kleinster Footprint) |
| T2 | whisper.cpp als N-API Addon oder Subprocess? | Addon (tighter integration) vs. Subprocess (einfacher) | Subprocess für MVP, Addon für v2 |
| T3 | Modell-Download: Installer oder First-Launch? | Alles im Installer vs. On-Demand | On-Demand (kleinerer Installer, ~250 MB .dmg); resume-fähiger Download — Entscheidung #109 (revidiert) |
| T4 | Minimum macOS-Version? | macOS 13 vs. 14 | macOS 14 (für Apple Vision + CoreML Features) |
| T5 | Audio-Format auf Disk? | WAV (unkomprimiert) vs. FLAC (komprimiert) | WAV (einfacher, Auto-Recovery-freundlich) |
| T6 | TipTap Version? | TipTap v2 (stable) vs. v3 (beta) | v2 (stable, production-ready) |
