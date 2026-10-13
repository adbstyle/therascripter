# Therascript

Lokale Therapiesitzungs-Transkription, Anonymisierung und Zusammenfassung für macOS.

Therascript ist eine Electron-basierte Desktop-App, die Therapiegespräche aufnimmt, automatisch transkribiert, Sprecher erkennt, personenbezogene Daten anonymisiert und optional eine Zusammenfassung erstellt. Die gesamte Verarbeitung erfolgt lokal auf dem Mac, die App übermittelt keine Inhalte aus Sitzungen. Mit dem Internet verbindet sich die App nur für Modell-Downloads und die Suche nach neuen Versionen (siehe [Datenschutz](#datenschutz-und-internetverbindung)).

## Features

- **Aufnahme & Transkription** — Live-Aufnahme mit automatischer Transkription (Hochdeutsch + Schweizerdeutsch)
- **Sprechererkennung** — Automatische Unterscheidung von bis zu 4 Sprechern (Einzel- und Paartherapie)
- **Anonymisierung** — Automatische Erkennung und Ersetzung von Personen, Orten, Kontaktdaten, medizinischen Identifikatoren und Geburtsdaten durch Platzhalter
- **Zusammenfassung** — Optionale lokale Zusammenfassung anonymisierter Sitzungen via llama.cpp
- **Sperrliste** — Persönliche Blocklist für wiederkehrende Begriffe mit bidirektionaler Umlaut-Normalisierung
- **PDF-Import** — Import und Anonymisierung von PDFs inkl. gescannter Dokumente via OCR
- **Review-Editor** — TipTap-basierter Editor zur Nachbearbeitung mit Clipboard-Export und Quick-Add zur Sperrliste
- **Modell-Management** — Austauschbare ML-Modelle pro Pipeline-Schritt, verwaltbar im Einstellungen-Bereich
- **Updates in der App** — signierte Update-Beschreibung (Ed25519) auf Cloudflare R2; neue App-Versionen und neue Fassungen der Sprachmodelle kommen als **ein** Update: im Hintergrund geladen, geprüft und beim Beenden, nach 10 min Leerlauf oder auf Klick gemeinsam installiert, mit einem Neustart (abschaltbar; scheitert ein Teil, bleibt alles beim bisherigen Stand)
- **Datenschutz** — keine Übermittlung von Sitzungsinhalten; Renderer ohne Netzwerkzugriff (CSP `connect-src 'none'`), Netzwerk nur im Main-Prozess für Modelle und Versionsprüfung, Electron Fuses gehärtet, FileVault-Prüfung
- **System-Tray** — App läuft im Hintergrund weiter, Aufnahme über Menüleisten-Icon stoppbar
- **Auto-Löschung** — Sitzungen werden 30 Tage nach Erstellung automatisch gelöscht

## Systemvoraussetzungen

- macOS 26 (Tahoe) oder neuer (die mitgelieferte Metal-GPU-Bibliothek für die Spracherkennung wurde gegen das macOS-26-SDK gebaut; eine niedrigere Untergrenze ist als [Issue #97](https://github.com/adbstyle/therascripter/issues/97) erfasst)
- Mac mit Apple-Chip (M1 oder neuer)
- Mindestens 8 GB RAM
- ~5 GB freier Speicherplatz (App ~1 GB + ML-Modelle ~1.8 GB; der Erststart prüft 5 GB für
  Download und Entpacken; zusätzlich ~3.4 GB optional für Zusammenfassung)

## Installation

Ausführliche Anleitung mit Erklärungen: [adbstyle.github.io/therascripter/installation.html](https://adbstyle.github.io/therascripter/installation.html). Ein Terminal ist nicht nötig. Blockiert macOS trotzdem einmal einen Teil der App, behebt Therascript das beim Start selbst oder erklärt im Hinweis oben in der App, was zu tun ist (neu herunterladen, ersetzen, Programm-Freigabe erneut erteilen).

1. [`Therascript.dmg` herunterladen](https://github.com/adbstyle/therascripter/releases/latest/download/Therascript.dmg), doppelklicken und Therascript auf den Ordner **Programme** ziehen.
2. Therascript im Ordner **Programme** öffnen. macOS meldet, Apple könne nicht überprüfen, ob die App frei von Schadsoftware ist. Auf **Fertig** klicken, nicht auf «In den Papierkorb legen».
3. Programm-Freigabe erteilen: direkt danach in **Systemeinstellungen → Datenschutz & Sicherheit** ganz nach unten scrollen, beim Hinweis zu Therascript auf **Dennoch öffnen** klicken und mit Passwort oder Touch ID bestätigen. macOS bietet die Freigabe nur kurze Zeit nach dem blockierten Start an. Fehlt der Hinweis, Therascript erneut öffnen (Schritt 2) und gleich danach zurückkehren.
4. Beim ersten Start lädt Therascript die Sprachmodelle herunter (~1.7 GB; das Zusammenfassungs-Modell ist optional und kann später nachgeladen werden).

**Warum die Programm-Freigabe?** Apple bestätigt Apps nur gegen eine jährliche Gebühr. Therascript ist kostenlos und quelloffen und verzichtet auf diese Beglaubigung. Die Freigabe gilt für die ganze App samt der eingebauten Werkzeuge für Transkription, Sprechererkennung, Pseudonymisierung, Texterkennung und Zusammenfassung. Niemand bestätigt unabhängig, dass die heruntergeladene Datei vom Projekt stammt: Laden Sie Therascript nur über die Website oder die [Release-Seite](https://github.com/adbstyle/therascripter/releases).

**Updates:** Therascript aktualisiert sich selbst — neue Versionen und neue Fassungen der Sprachmodelle werden im Hintergrund geladen und gemeinsam installiert, wenn man 10 Minuten nicht am Mac arbeitet oder Therascript beendet, nie während einer Aufnahme oder Verarbeitung. Unter **Einstellungen → Updates** lässt sich ein bereitliegendes Update sofort installieren (auch über das Menüleisten-Symbol) oder die Automatik ausschalten. Ein Update lässt sich verschieben, aber nicht überspringen.

**Von Hand aktualisieren** (Versionen ohne «Einstellungen → Updates», oder wenn Therascript nicht aus dem Ordner «Programme» läuft): Therascript über das Symbol in der Menüleiste («Therascript beenden») oder mit `⌘ Q` beenden (das Schliessen des Fensters beendet die App nicht), die neue Version herunterladen, die App im Ordner **Programme** ersetzen und Schritt 2 und 3 wiederholen. Transkriptionen, Einstellungen und Modelle bleiben erhalten. Beim ersten Update auf eine Version, die Berechtigungen über Updates hinweg behält, fragt macOS einmalig erneut: Mikrofon erlauben, beim Schlüsselbund **Immer erlauben** wählen. Spätere Updates fragen nicht mehr.

> **Empfehlung:** FileVault-Verschlüsselung aktivieren — Therascript warnt, falls deaktiviert.

## Datenschutz und Internetverbindung

Aufnahmen, Transkripte, PDFs und Zusammenfassungen übermittelt Therascript nie; sie verlassen den Mac nur, wenn man sie selbst kopiert. Mit dem Internet verbindet sich Therascript nur in drei Fällen:

- **Sprachmodelle herunterladen:** bei der Ersteinrichtung, beim Hinzufügen eines Modells in den Einstellungen und mit Updates: neue Fassungen der installierten Modelle und Modelle, die eine neue Version braucht, lädt Therascript automatisch zusammen mit dem Update; nach dem Ausschalten der automatischen Updates (Einstellungen → Updates) nur auf Klick.
- **Nach neuen Versionen suchen:** beim Start, danach alle 4 Stunden und auf Klick unter Einstellungen → Updates.
- **Neue Versionen herunterladen:** automatisch, sobald eine erscheint; nach dem Ausschalten der automatischen Updates (Einstellungen → Updates) nur auf Klick.

Modelle und Versionsliste kommen von Cloudflare R2 (Cloudflare, Inc., USA; Speicherort Osteuropa, Auslieferung über das weltweite Cloudflare-Netz), das Installationspaket neuer Versionen von GitHub (GitHub Inc., USA). Beide sehen dabei IP-Adresse, Zeitpunkt und abgerufene Datei. Die App sendet kein Konto, keine Kennung und keine Nutzungsdaten. Links zu GitHub oder Hugging Face öffnen sich nur auf Klick im Browser. Nach der Ersteinrichtung funktioniert Therascript auch ohne Internet. Die vollständigen Angaben stehen in der [Datenschutzerklärung](https://adbstyle.github.io/therascripter/impressum.html#app-datenschutz).

## Entwicklung

### Voraussetzungen

- Node.js (LTS)
- Python 3.11+ und [uv](https://docs.astral.sh/uv/)
- Xcode Command Line Tools (`xcode-select --install`)
- [Homebrew](https://brew.sh)
- HuggingFace-Account mit `huggingface-cli login` (für die Pyannote-Modelle)

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

# llama.cpp + Gemma 4 E2B GGUF (optional, für Zusammenfassungen)
scripts/setup-llama.sh --model
```

> **Hinweis:** Pyannote erfordert akzeptierte Nutzungsbedingungen für `pyannote/speaker-diarization-3.1` und `pyannote/speaker-diarization-community-1` auf HuggingFace.

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
4. **llama.cpp** (Subprocess) — Optionale Zusammenfassung (Gemma 4 E2B, Grammatik-constrained)

### ML-Pipeline (PDF)

1. **pdfjs-dist** — Textextraktion pro Seite
2. **Swift CLI** — Apple Vision OCR für gescannte Seiten
3. **Python-Sidecar** — flair NER + Regex + Sperrliste → TipTap-Dokument
4. **llama.cpp** (Subprocess) — Optionale Zusammenfassung

> Schritt 4 wird übersprungen, falls kein Summarization-Modell aktiv ist — die Sitzung erreicht trotzdem den Review-Status, `summary` bleibt leer.

### Modell-Management

- Pro Pipeline-Schritt (ASR, Diarization, Summarization) ist ein Modell-Slot in `electron-store` aktiv
- Verfügbare Modelle stehen im Modell-Katalog (`src/main/services/ModelCatalog.ts`); Nutzer aktivieren / deaktivieren / löschen sie über Einstellungen → Modelle
- Update-Check lädt die signierte `manifest.json` von Cloudflare R2; App und Modelle werden als ein Update bereitgestellt (`userData/app-update`, `models/.update`) und beim Beenden nur durch Umbenennen getauscht — Modelle zuerst, App zuletzt, bei einem Fehler alles zurück

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
- **Summarization:** llama.cpp (Gemma 4 E2B QAT q4_0, Apache 2.0, GBNF-Grammatik)
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

[MIT](LICENSE). Lizenzen der mitgelieferten Drittsoftware und der Modelle: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
