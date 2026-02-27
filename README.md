# Therascript

Lokale Therapiesitzungs-Transkription und Anonymisierung für macOS.

Therascript ist eine Electron-basierte Desktop-App, die Therapiegespräche aufnimmt, automatisch transkribiert, Sprecher erkennt und personenbezogene Daten anonymisiert. Die gesamte Verarbeitung erfolgt lokal auf dem Gerät — keine Daten verlassen den Rechner.

## Features

- **Aufnahme & Transkription** — Live-Aufnahme mit automatischer Transkription (Hochdeutsch + Schweizerdeutsch)
- **Sprechererkennung** — Automatische Unterscheidung von bis zu 4 Sprechern (Einzel- und Paartherapie)
- **Anonymisierung** — Automatische Erkennung und Ersetzung von Personen, Orten, Kontaktdaten, medizinischen Identifikatoren und Geburtsdaten durch Platzhalter
- **Sperrliste** — Persönliche Blocklist für wiederkehrende Begriffe mit bidirektionaler Umlaut-Normalisierung
- **PDF-Import** — Import und Anonymisierung von PDFs inkl. gescannter Dokumente via OCR
- **Review-Editor** — TipTap-basierter Editor zur Nachbearbeitung mit Clipboard-Export
- **Datenschutz** — Komplett offline, CSP `connect-src 'none'`, Electron Fuses gehärtet, FileVault-Prüfung
- **Auto-Löschung** — Sitzungen werden 30 Tage nach Erstellung automatisch gelöscht

## Systemvoraussetzungen

- macOS 14+ (Sonoma oder neuer)
- Apple Silicon (M1–M4)
- Mindestens 8 GB RAM
- ~5 GB freier Speicherplatz (App + ML-Modelle)

## Installation

1. [DMG herunterladen](https://drive.proton.me/urls/DPYM39CKT4#V51Bl7TEvRYG)
2. DMG öffnen und Therascript in den Programme-Ordner ziehen
3. Gatekeeper-Sperre aufheben (App ist nicht notarisiert):
   ```bash
   xattr -cr /Applications/Therascript.app
   ```
   Alternativ: Rechtsklick → Öffnen
4. Therascript starten
5. Therascript lädt beim ersten Start die ML-Modelle herunter (~4.1 GB)

> **Empfehlung:** FileVault-Verschlüsselung aktivieren — Therascript warnt, falls deaktiviert.

## Entwicklung

### Voraussetzungen

- Node.js (LTS)
- Python 3.11+ und [uv](https://docs.astral.sh/uv/)
- Xcode Command Line Tools (`xcode-select --install`)
- [Homebrew](https://brew.sh)

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
```

> **Hinweis:** Pyannote erfordert einen HuggingFace-Token (`huggingface-cli login`) und akzeptierte Nutzungsbedingungen für `pyannote/speaker-diarization-3.1` und `pyannote/speaker-diarization-community-1`.

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
```

## Architektur

### Electron-Prozesse

| Prozess | Pfad | Beschreibung |
|---------|------|-------------|
| Main | `src/main/` | App-Lifecycle, IPC-Handler, CSP, Sicherheit |
| Preload | `src/preload/` | Context Bridge mit Zod-validiertem IPC |
| Renderer | `src/renderer/` | React 19 + Tailwind CSS v4 UI |

### ML-Pipeline (Audio)

Streng sequenziell — immer nur ein Modell geladen:

1. **whisper.cpp** (Subprocess) — ASR mit Whisper Large V3 Turbo (Q5_0, Metal GPU)
2. **Python-Sidecar** — pyannote.audio Diarization + Alignment
3. **Python-Sidecar** — flair NER + Regex + Sperrliste → TipTap-Dokument

### ML-Pipeline (PDF)

1. **pdfjs-dist** — Textextraktion pro Seite
2. **Swift CLI** — Apple Vision OCR für gescannte Seiten
3. **Python-Sidecar** — flair NER + Regex + Sperrliste → TipTap-Dokument

### Speicherung

- **better-sqlite3** — Sitzungen, Sperrliste
- **electron-store** — Einstellungen
- **ML-Modelle** — `~/.therascript/models/` (persistieren über App-Updates)

## Tech-Stack

- **Frontend:** React 19, Tailwind CSS v4, TipTap (ProseMirror)
- **Desktop:** Electron 34, electron-vite
- **ASR:** whisper.cpp (Whisper Large V3 Turbo Q5_0)
- **Diarization:** pyannote.audio (speaker-diarization-3.1)
- **NER:** flair (ner-german-large, F1 ~92%)
- **OCR:** Apple Vision Framework (Swift CLI)
- **Datenbank:** better-sqlite3
- **Testing:** Vitest, Testing Library, jsdom
- **Build:** electron-builder → DMG (arm64)

## Projektstruktur

```
src/
  main/           # Electron Main-Prozess
  preload/        # Context Bridge + IPC
  renderer/       # React UI
  shared/         # Types + Zod-Schemas
python_sidecar/   # Python-Sidecar (pyannote + flair)
swift_cli/        # Swift Vision OCR Helper
scripts/          # Setup- und Build-Skripte
resources/        # Binaries (whisper-cli) + Libraries
tests/            # Test-Setup
```

## Dokumentation

- [requirements.md](requirements.md) — User Stories, NFRs, Entscheidungen
- [specification.md](specification.md) — Technische Spezifikation
- [implementation-plan.md](implementation-plan.md) — Iterations-Roadmap
- [wireframes.md](wireframes.md) — 24 Screens + UX-Flows

## Lizenz

MIT
