# Therascript

Lokale Therapiesitzungs-Transkription, Anonymisierung und Zusammenfassung für macOS.

Therascript ist eine Electron-basierte Desktop-App, die Therapiegespräche aufnimmt, automatisch transkribiert, Sprecher erkennt, personenbezogene Daten anonymisiert und optional eine Zusammenfassung erstellt. Die gesamte Verarbeitung erfolgt lokal auf dem Gerät — keine Daten verlassen den Rechner.

## Features

- **Aufnahme & Transkription** — Live-Aufnahme mit automatischer Transkription (Hochdeutsch + Schweizerdeutsch)
- **Sprechererkennung** — Automatische Unterscheidung von bis zu 4 Sprechern (Einzel- und Paartherapie)
- **Anonymisierung** — Automatische Erkennung und Ersetzung von Personen, Orten, Kontaktdaten, medizinischen Identifikatoren und Geburtsdaten durch Platzhalter
- **Zusammenfassung** — Optionale lokale Zusammenfassung anonymisierter Sitzungen via llama.cpp
- **Sperrliste** — Persönliche Blocklist für wiederkehrende Begriffe mit bidirektionaler Umlaut-Normalisierung
- **PDF-Import** — Import und Anonymisierung von PDFs inkl. gescannter Dokumente via OCR
- **Review-Editor** — TipTap-basierter Editor zur Nachbearbeitung mit Clipboard-Export und Quick-Add zur Sperrliste
- **Modell-Management** — Austauschbare ML-Modelle pro Pipeline-Schritt, verwaltbar im Einstellungen-Bereich
- **Auto-Update für Modelle** — Hintergrund-Check gegen Cloudflare R2-Manifest, atomarer Tausch beim Neustart
- **Datenschutz** — Komplett offline, CSP `connect-src 'none'` in Production, Electron Fuses gehärtet, FileVault-Prüfung
- **System-Tray** — App läuft im Hintergrund weiter, Aufnahme über Menüleisten-Icon stoppbar
- **Auto-Löschung** — Sitzungen werden 30 Tage nach Erstellung automatisch gelöscht

## Systemvoraussetzungen

- macOS 26 (Tahoe) oder neuer (die mitgelieferte Metal-GPU-Bibliothek für die Spracherkennung wurde gegen das macOS-26-SDK gebaut; eine niedrigere Untergrenze ist als [Issue #97](https://github.com/adbstyle/therascripter/issues/97) erfasst)
- Apple Silicon
- Mindestens 8 GB RAM
- ~5 GB freier Speicherplatz (App + ML-Modelle, plus ~2.5 GB optional für Zusammenfassung)

## Installation

1. [DMG herunterladen](https://github.com/adbstyle/therascripter/releases)
2. DMG öffnen und Therascript in den Programme-Ordner ziehen
3. Gatekeeper-Sperre aufheben (App ist nicht notarisiert):
   ```bash
   chmod -R u+w /Applications/Therascript.app && xattr -cr /Applications/Therascript.app
   ```
   Das vorangestellte `chmod` ist für Versionen bis 0.8.7 nötig (einzelne mitgelieferte
   Dateien waren schreibgeschützt, `xattr` meldete sonst `Permission denied`) und ist
   für neuere Versionen wirkungslos, aber harmlos.

   Hinweis: Rechtsklick → Öffnen genügt **nicht** — es erlaubt nur den App-Start,
   entfernt aber die Quarantäne der mitgelieferten ML-Werkzeuge nicht (die
   Zusammenfassungs-Funktion bliebe stumm deaktiviert).
4. Therascript starten
5. Beim ersten Start lädt Therascript die ML-Modelle herunter (~4.1 GB; Zusammenfassungs-Modell ist optional und kann später nachgeladen werden)

> **Empfehlung:** FileVault-Verschlüsselung aktivieren — Therascript warnt, falls deaktiviert.

## Entwicklung

### Voraussetzungen

- Node.js (LTS)
- Python 3.11+ und [uv](https://docs.astral.sh/uv/)
- Xcode Command Line Tools (`xcode-select --install`)
- [Homebrew](https://brew.sh)
- HuggingFace-Account mit `huggingface-cli login` (für Pyannote- und Gemma-Modelle)

### Setup

```bash
# Dependencies installieren
npm install

# whisper.cpp CLI + ASR-Modell installieren
scripts/setup-whisper.sh --model

# Python-Sidecar (pyannote.audio) einrichten + Modell laden
scripts/setup-pyannote.sh --model

# flair NER in bestehende venv installieren + Modell laden
scripts/setup-ner.sh --model

# Swift Vision OCR CLI-Helper bauen
scripts/setup-vision-ocr.sh

# llama.cpp + Gemma 3 4B GGUF (optional, für Zusammenfassungen)
scripts/setup-llama.sh --model
```

> **Hinweis:** Pyannote erfordert akzeptierte Nutzungsbedingungen für `pyannote/speaker-diarization-3.1` und `pyannote/speaker-diarization-community-1` auf HuggingFace. Das Gemma-GGUF (bartowski-Mirror von `google/gemma-3-4b-it`) ist ebenfalls gated.

### Befehle

```bash
npm run dev             # Electron-App mit Vite HMR starten
npm run build           # TypeCheck + electron-vite Build
npm run test            # Alle Tests ausführen (Vitest)
npm run test:watch      # Tests im Watch-Modus
npm run lint            # ESLint mit Cache
npm run format          # Prettier-Formatierung
npm run typecheck       # TypeScript-Prüfung (Node + Web)
npm run package         # Produktions-Build → macOS DMG (arm64)
npm run sidecar:build   # Standalone Python-Sidecar via uv bauen
npm run sidecar:deploy  # Sidecar bauen, packen und nach R2 uploaden
scripts/release.sh      # Versions-Bump → DMG → GitHub-Release (interaktiv)
```

## Architektur

### Electron-Prozesse

| Prozess  | Pfad             | Beschreibung                                       |
| -------- | ---------------- | -------------------------------------------------- |
| Main     | `src/main/`      | App-Lifecycle, IPC-Handler, CSP, Sicherheit, Tray  |
| Preload  | `src/preload/`   | Context Bridge mit Zod-validiertem IPC             |
| Renderer | `src/renderer/`  | React 19 + Tailwind CSS v4 UI                      |

### ML-Pipeline (Audio)

Streng sequenziell — immer nur ein Modell geladen:

1. **whisper.cpp** (Subprocess) — ASR mit Whisper Large V3 Turbo (Q5_0, Metal GPU)
2. **Python-Sidecar** — pyannote.audio Diarization + Alignment
3. **Python-Sidecar** — flair NER + Regex + Sperrliste → TipTap-Dokument
4. **llama.cpp** (Subprocess) — Optionale Zusammenfassung (Gemma 3 4B Instruct, JSON-Schema-constrained)

### ML-Pipeline (PDF)

1. **pdfjs-dist** — Textextraktion pro Seite
2. **Swift CLI** — Apple Vision OCR für gescannte Seiten
3. **Python-Sidecar** — flair NER + Regex + Sperrliste → TipTap-Dokument
4. **llama.cpp** (Subprocess) — Optionale Zusammenfassung

> Schritt 4 wird übersprungen, falls kein Summarization-Modell aktiv ist — die Sitzung erreicht trotzdem den Review-Status, `summary` bleibt leer.

### Modell-Management

- Pro Pipeline-Schritt (ASR, Diarization, Summarization) ist ein Modell-Slot in `electron-store` aktiv
- Verfügbare Modelle stehen im Modell-Katalog (`src/main/services/ModelCatalog.ts`); Nutzer aktivieren / deaktivieren / löschen sie über Einstellungen → Modelle
- Update-Check vergleicht installierte Versionen mit `manifest.json` auf Cloudflare R2; Updates werden in einen Staging-Ordner heruntergeladen und beim Neustart atomar getauscht

### Speicherung

- **better-sqlite3** — Sitzungen, Sperrliste
- **electron-store** — Einstellungen, aktive Modelle, Update-Status
- **ML-Modelle** — `~/.therascript/models/<typ>/` (persistieren über App-Updates)
- **PDFs** — `~/.therascript/pdf/`

## Tech-Stack

- **Frontend:** React 19, Tailwind CSS v4, TipTap 3 (ProseMirror), lucide-react
- **Desktop:** Electron 34, electron-vite
- **ASR:** whisper.cpp (Whisper Large V3 Turbo Q5_0)
- **Diarization:** pyannote.audio (`speaker-diarization-3.1`, optional `speaker-diarization-community-1`)
- **NER:** flair (`ner-german-large`, F1 ~92 %)
- **Summarization:** llama.cpp (Gemma 3 4B Instruct Q4_K_M, JSON-Schema-Grammar)
- **OCR:** Apple Vision Framework (Swift CLI) mit Tesseract-Fallback
- **Datenbank:** better-sqlite3
- **Validierung:** Zod-Schemas für alle IPC-Channels
- **Testing:** Vitest, Testing Library, jsdom
- **Build:** electron-builder → DMG (arm64), Electron Fuses gehärtet, ad-hoc Codesignatur

## Projektstruktur

```
src/
  main/             # Electron Main-Prozess (IPC, ML-Orchestrierung, Tray, Update-Service)
  preload/          # Context Bridge + Zod-validiertes IPC
  renderer/         # React UI (Shell, Settings, Review-Editor)
  shared/           # Types + Zod-Schemas
python_sidecar/     # Python-Sidecar (pyannote + flair, dev venv + standalone build)
swift_cli/          # Swift Vision OCR Helper
scripts/            # Setup-, Build- und Release-Skripte
resources/          # Binaries (whisper-cli, llama-cli, vision-ocr) + Libraries
tests/              # Vitest-Setup
docs/               # Produkt- und Plan-Dokumentation
```

## Dokumentation

Lebende Produktdokumentation in [`docs/product/`](docs/product/):

- [`architecture/`](docs/product/architecture) — Architektur-Übersicht, IPC-API, ML-Pipeline, Storage, Security
- [`features/`](docs/product/features) — Aufnahme, Transkription, Anonymisierung, Sperrliste, PDF-Import, Review-Editor, Zusammenfassung, Modell-Management, Einstellungen
- [`operations/`](docs/product/operations) — Development-Setup, Modell-Pipeline, Release-Prozess
- [`decisions/`](docs/product/decisions) — Architektur-Entscheidungen (ADRs)

Historische Planungsdokumente: [`docs/archive/`](docs/archive).

## Lizenz

MIT
