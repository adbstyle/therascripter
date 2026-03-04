# Product Documentation Migration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ersetze planungsorientierte Docs (requirements, spec, wireframes, implementation-plan) durch lebendige Produktdokumentation, die beschreibt was **tatsächlich implementiert** ist.

**Architecture:** `docs/product/` enthält Feature-Docs, Architektur-Docs, ADRs und Operations-Docs. Jedes Doc wird direkt aus dem Code abgeleitet — nicht aus alten Plänen. Alte Dateien werden in `docs/archive/` verschoben.

**Tech Stack:** Markdown, Mermaid-Diagramme optional

---

## Task 1: Verzeichnisstruktur erstellen

**Files:**
- Create: `docs/product/features/` (Verzeichnis)
- Create: `docs/product/architecture/` (Verzeichnis)
- Create: `docs/product/decisions/` (Verzeichnis)
- Create: `docs/product/operations/` (Verzeichnis)
- Create: `docs/archive/` (Verzeichnis)

**Step 1: Verzeichnisse anlegen**

```bash
mkdir -p docs/product/features docs/product/architecture docs/product/decisions docs/product/operations docs/archive
```

**Step 2: Alte Planungs-Docs archivieren**

```bash
mv requirements.md docs/archive/
mv specification.md docs/archive/
mv wireframes.md docs/archive/
mv implementation-plan.md docs/archive/
```

**Step 3: README für archive/ schreiben**

Erstelle `docs/archive/README.md`:

```markdown
# Archiv

Diese Dateien sind historische Planungsdokumente aus der Entwicklungsphase.
Sie beschreiben was gebaut *werden sollte* — nicht was tatsächlich implementiert ist.

**Massgeblich ist der Code.** Für aktuelle Produktdokumentation: `docs/product/`

| Datei | Inhalt | Ersetzt durch |
|-------|--------|---------------|
| requirements.md | User Stories, NFRs, Entscheidungen | docs/product/features/* |
| specification.md | Technische Spezifikation | docs/product/architecture/* |
| wireframes.md | UX/UI Wireframes | docs/product/features/* |
| implementation-plan.md | Iterationsplan | docs/archive (abgeschlossen) |
```

**Step 4: Commit**

```bash
git add docs/
git add -u requirements.md specification.md wireframes.md implementation-plan.md
git commit -m "docs: migrate planning docs to archive, create product docs structure"
```

---

## Task 2: Architecture Overview

**Files:**
- Read: `src/main/index.ts`, `electron.vite.config.ts`, `package.json`
- Read: `CLAUDE.md` (Abschnitt Architecture)
- Create: `docs/product/architecture/overview.md`

**Step 1: Relevante Files lesen**

Lies: `src/main/index.ts` (Prozessmodell), `electron.vite.config.ts` (Build), `CLAUDE.md` (Architecture-Sektion)

**Step 2: Doc schreiben**

`docs/product/architecture/overview.md` soll enthalten:
- Systemdiagramm (ASCII oder Mermaid) mit 3 Electron-Prozessen + ML-Subprozessen
- Tech Stack Tabelle (Framework, UI, Build, Packaging, Editor, Storage, IPC-Validierung)
- Prozessmodell: Main / Renderer / Subprocess (whisper) / Python Sidecar / Swift CLI
- Dateistruktur `~/.therascript/` (models/, data/, audio/, transcripts/)
- Build-Tooling: electron-vite, Tailwind v4, React plugin

**Step 3: Commit**

```bash
git add docs/product/architecture/overview.md
git commit -m "docs: add architecture overview"
```

---

## Task 3: ML-Pipeline

**Files:**
- Read: `src/main/services/task-executors.ts`, `src/main/services/TaskQueueService.ts`
- Read: `src/main/ml/` (alle Files)
- Create: `docs/product/architecture/ml-pipeline.md`

**Step 1: ML-Code lesen**

Lies `src/main/ml/` komplett, `task-executors.ts`, Abschnitt ML Pipeline in `CLAUDE.md`

**Step 2: Doc schreiben**

`docs/product/architecture/ml-pipeline.md` soll enthalten:
- Sequenzdiagramm der Pipeline (whisper → pyannote → flair)
- Audio-Pipeline: ASR → Diarization → Alignment → NER → TipTap-Dokument
- PDF-Pipeline: pdfjs-dist → Vision OCR (falls Scan) → NER → TipTap-Dokument
- RAM-Budget Tabelle: welche Phase wie viel RAM nutzt, Peak 5.2 GB bei flair
- Modell-Specs: Name, Grösse, Quantisierung, Performance-Benchmark
- Warum strikt sequenziell (8 GB Constraint)

**Step 3: Commit**

```bash
git add docs/product/architecture/ml-pipeline.md
git commit -m "docs: add ML pipeline documentation"
```

---

## Task 4: Storage & Datenmodell

**Files:**
- Read: `src/main/db/` (alle Files, insb. Migrations)
- Read: `src/main/services/SettingsService.ts`
- Read: `src/shared/types/`
- Create: `docs/product/architecture/storage.md`

**Step 1: DB und Settings lesen**

Lies `src/main/db/migrations/` (SQL-Schema), `src/shared/types/`, `SettingsService.ts` (electron-store Keys)

**Step 2: Doc schreiben**

`docs/product/architecture/storage.md` soll enthalten:
- SQLite-Schema: alle Tabellen mit Spalten + Typen (sessions, blocklist, task_queue, model_registry)
- electron-store Keys: alle Settings mit Typ und Default
- Dateisystem-Layout: `~/.therascript/` vollständig mit allen Pfaden
- Sitzungsstatus-Enum (alle States + Übergänge)
- Auto-Deletion: 30 Tage, silent, bei welchem Event

**Step 3: Commit**

```bash
git add docs/product/architecture/storage.md
git commit -m "docs: add storage and data model documentation"
```

---

## Task 5: Security

**Files:**
- Read: `src/main/index.ts` (CSP, Fuses, BrowserWindow Config)
- Read: `afterPack.js`, `electron-builder.yml`
- Read: `src/main/services/FileVaultService.ts`
- Create: `docs/product/architecture/security.md`

**Step 1: Security-relevante Files lesen**

Lies `src/main/index.ts` (CSP-Header, Window-Config), `afterPack.js` (Fuses), `FileVaultService.ts`

**Step 2: Doc schreiben**

`docs/product/architecture/security.md` soll enthalten:
- CSP-Konfiguration: welche Direktiven, warum `connect-src 'none'`
- Electron Fuses: welche Fuses gesetzt, warum (RunAsNode disabled, OnlyLoadAppFromAsar, etc.)
- Context Isolation + Sandbox: was das bedeutet für IPC
- FileVault-Check: wann, was passiert wenn nicht enabled
- Code-Signing: kein Apple Developer Account, ad-hoc Signatur, `codesign --sign -`
- Warum User rechtsklick → Öffnen muss (Gatekeeper)

**Step 3: Commit**

```bash
git add docs/product/architecture/security.md
git commit -m "docs: add security documentation"
```

---

## Task 6: IPC API

**Files:**
- Read: `src/main/ipc/` (alle Handler-Files)
- Read: `src/preload/index.ts`
- Read: `src/shared/validation/` (Zod Schemas)
- Create: `docs/product/architecture/ipc-api.md`

**Step 1: IPC-Handlers und Schemas lesen**

Lies alle `src/main/ipc/*-handlers.ts` und `src/shared/validation/`

**Step 2: Doc schreiben**

`docs/product/architecture/ipc-api.md` soll enthalten:
- Pro Handler-Gruppe eine Tabelle: Channel-Name | Richtung | Input-Schema | Output-Schema | Beschreibung
- Handler-Gruppen: session, recording, task, review, blocklist, model-download, model-update, app-update, pdf, settings, system
- Validierungsprinzip: alle Channels durch Zod-Schema, was bei Validierungsfehler passiert
- Preload contextBridge: welche APIs exponiert werden

**Step 3: Commit**

```bash
git add docs/product/architecture/ipc-api.md
git commit -m "docs: add IPC API reference"
```

---

## Task 7: Feature — Session Management

**Files:**
- Read: `src/renderer/src/components/SessionDashboard.tsx`, `SessionCard.tsx`
- Read: `src/main/services/SessionService.ts`, `AutoDeletionService.ts`
- Create: `docs/product/features/session-management.md`

**Step 1: Session-Code lesen**

Lies `SessionDashboard.tsx`, `SessionCard.tsx`, `SessionService.ts`, `AutoDeletionService.ts`

**Step 2: Doc schreiben**

`docs/product/features/session-management.md` soll enthalten:
- Session-Typen: Audio vs. PDF (visuell unterscheidbar via Icon)
- Status-Flow: Diagramm aller States (recording → processing → review → etc.)
- Gruppierung: "Heute", "Gestern", "Diese Woche", "Letzte Woche", "Älter"
- Auto-Titel: Format "Sitzung DD.MM.YYYY HH:MM"
- Umbenennen: wann möglich, wie
- Löschen: Bestätigungsdialog, was alles gelöscht wird (Audio, Transkript, Mapping)
- Auto-Deletion: 30 Tage ab Erstellung, was alles entfernt wird
- Orphaned Sessions Recovery: was das ist, wann es passiert

**Step 3: Commit**

```bash
git add docs/product/features/session-management.md
git commit -m "docs: add session management feature doc"
```

---

## Task 8: Feature — Audio Recording

**Files:**
- Read: `src/renderer/src/components/RecordingView.tsx`, `VUMeter.tsx`, `ConsentBanner.tsx`
- Read: `src/main/ipc/recording-handlers.ts`
- Read: `src/main/services/TrayService.ts`
- Create: `docs/product/features/audio-recording.md`

**Step 1: Recording-Code lesen**

Lies `RecordingView.tsx`, `recording-handlers.ts`, `TrayService.ts`, `ConsentBanner.tsx`

**Step 2: Doc schreiben**

`docs/product/features/audio-recording.md` soll enthalten:
- Recording-Flow: Start → Aufnahme läuft → Stop → Processing beginnt
- Audio-Format: WAV, Sample Rate, Kanäle
- VU-Meter: was angezeigt wird (Pegel, Dauer)
- System Tray: Icon (rot = aktiv), Menu-Items, Stop-Aktion
- ConsentBanner: wann gezeigt (erstes Mal), was der Inhalt ist, electron-store Key
- Auto-Stop: 2 Stunden, was dann passiert
- Hintergrundverhalten: App bleibt offen, Aufnahme läuft weiter

**Step 3: Commit**

```bash
git add docs/product/features/audio-recording.md
git commit -m "docs: add audio recording feature doc"
```

---

## Task 9: Feature — Transcription Pipeline

**Files:**
- Read: `src/main/ml/` (whisper, pyannote files)
- Read: `src/main/services/task-executors.ts` (ASR + Diarization Tasks)
- Create: `docs/product/features/transcription-pipeline.md`

**Step 1: Transkriptions-Code lesen**

Lies `src/main/ml/`, `task-executors.ts` (ASR- und Diarization-Executors)

**Step 2: Doc schreiben**

`docs/product/features/transcription-pipeline.md` soll enthalten:
- ASR: whisper-cli Aufruf, Flags (language=de, model path), Output-Format
- Diarization: pyannote Sidecar-Aufruf, Speaker-Segmente, Alignment
- Kombination: wie Transkript + Speaker-Segmente zusammengeführt werden
- Swiss German: wie Dialekt-Normalisierung durch whisper funktioniert
- Fehlerbehandlung: was bei whisper-Fehler / pyannote-Fehler passiert
- Modell-Dateipfade: wo ASR- und Diarization-Modelle liegen

**Step 3: Commit**

```bash
git add docs/product/features/transcription-pipeline.md
git commit -m "docs: add transcription pipeline feature doc"
```

---

## Task 10: Feature — Anonymisierung

**Files:**
- Read: `src/main/ml/` (NER/flair files)
- Read: `src/main/services/task-executors.ts` (NER Executor)
- Read: `src/shared/types/` (Placeholder Types)
- Create: `docs/product/features/anonymization.md`

**Step 1: NER-Code lesen**

Lies NER-relevante Files in `src/main/ml/`, NER-Executor in `task-executors.ts`, Shared Types

**Step 2: Doc schreiben**

`docs/product/features/anonymization.md` soll enthalten:
- Entity-Typen: alle 7 user-sichtbaren Typen (PERSON, ORT, etc.) mit Beispielen
- Placeholder-Format: `[PERSON 1]`, `[ORT 1]` — nummerisch, typenspezifisch
- Erkennungs-Pipeline: flair NER + Regex + Sperrliste (Reihenfolge + Priorität)
- Longest-Match-First: warum, Beispiel
- Umlaut-Normalisierung: bidirektional, Beispiel (ü ↔ ue)
- Was IGNORIERT wird: flair ORG (Institutionen), warum
- Retroaktive Re-Anonymisierung: was passiert wenn Sperrliste nach Verarbeitung ergänzt wird

**Step 3: Commit**

```bash
git add docs/product/features/anonymization.md
git commit -m "docs: add anonymization feature doc"
```

---

## Task 11: Feature — Sperrliste (Blocklist)

**Files:**
- Read: `src/renderer/src/components/BlocklistManager.tsx`, `BlocklistDialog.tsx`
- Read: `src/main/ipc/blocklist-handlers.ts`
- Read: `src/renderer/src/components/editor/BlocklistConfirmDialog.tsx`
- Create: `docs/product/features/blocklist.md`

**Step 1: Sperrliste-Code lesen**

Lies `BlocklistManager.tsx`, `BlocklistDialog.tsx`, `blocklist-handlers.ts`, `BlocklistConfirmDialog.tsx`

**Step 2: Doc schreiben**

`docs/product/features/blocklist.md` soll enthalten:
- Was die Sperrliste ist: ergänzt automatische NER um wiederkehrende Begriffe
- Entity-Typen: alle 7 verfügbaren Typen für manuelle Einträge
- CRUD: Hinzufügen, Bearbeiten, Löschen — wo (Settings Tab "Sperrliste")
- Quick-Add aus Review Editor: Text selektieren → Kontextmenü → zu Sperrliste hinzufügen
- Retroaktive Re-Anonymisierung: Bestätigungsdialog, was passiert (alle offenen Review-Sessions)
- Umlaut-Normalisierung: wie Einträge normalisiert gespeichert werden

**Step 3: Commit**

```bash
git add docs/product/features/blocklist.md
git commit -m "docs: add blocklist feature doc"
```

---

## Task 12: Feature — PDF Import

**Files:**
- Read: `src/main/ipc/pdf-handlers.ts`
- Read: `src/main/services/PDFExtractionExecutor.ts`
- Read: `src/renderer/src/components/SessionDashboard.tsx` (Import-UI)
- Create: `docs/product/features/pdf-import.md`

**Step 1: PDF-Code lesen**

Lies `pdf-handlers.ts`, `PDFExtractionExecutor.ts`, Import-Logik in `SessionDashboard.tsx`

**Step 2: Doc schreiben**

`docs/product/features/pdf-import.md` soll enthalten:
- Import-Wege: Drag-and-Drop + Button in SessionDashboard
- Speicherort: Datei wird nach `~/.therascript/pdf/` kopiert
- Import-Guard: Duplikat-Erkennung, was bei Duplikat passiert
- Copy-Failure Rollback: was wenn Datei nicht kopiert werden kann
- PDF-Pipeline: pdfjs-dist (Text) → Vision OCR (Scan-Seiten) → NER
- OCR-Entscheidung: wann Vision OCR verwendet wird (Seite ohne extrahierbarem Text)
- Nicht unterstützt: Passwortgeschützte PDFs — was die App macht (Fehlermeldung)

**Step 3: Commit**

```bash
git add docs/product/features/pdf-import.md
git commit -m "docs: add PDF import feature doc"
```

---

## Task 13: Feature — Review Editor

**Files:**
- Read: `src/renderer/src/extensions/` (alle TipTap Extensions)
- Read: `src/renderer/src/components/editor/` (alle NodeViews)
- Read: `src/main/ipc/review-handlers.ts`
- Read: `src/main/services/ReviewService.ts`
- Create: `docs/product/features/review-editor.md`

**Step 1: Editor-Code lesen**

Lies alle Extensions und NodeViews, `review-handlers.ts`, `ReviewService.ts`

**Step 2: Doc schreiben**

`docs/product/features/review-editor.md` soll enthalten:
- TipTap-Grundlage: ProseMirror, warum atomare Nodes
- Drei Custom Extensions: placeholderChip, speakerLabel, timestamp — je mit Beschreibung
- PlaceholderChip: wie er aussieht, Klick-Interaktion (Typ wechseln / aufheben)
- SpeakerLabel: wie Sprecher-Segmente im Text dargestellt werden
- Timestamp: Format, Verwendungszweck
- Export: Clipboard-Export, was exportiert wird (anonymisierter Text, Format)
- Kontextmenü: welche Aktionen verfügbar (Quick-Add Sperrliste, etc.)

**Step 3: Commit**

```bash
git add docs/product/features/review-editor.md
git commit -m "docs: add review editor feature doc"
```

---

## Task 14: Feature — Model Management & Updates

**Files:**
- Read: `src/main/services/UpdateCheckService.ts`
- Read: `src/main/ipc/model-update-handlers.ts`, `app-update-handlers.ts`
- Read: `src/main/services/ModelDownloadService.ts`
- Read: `src/renderer/src/components/FirstLaunchScreen.tsx`, `ModelUpdateScreen.tsx`, `UpdateBanner.tsx`
- Create: `docs/product/features/model-management.md`

**Step 1: Update-System-Code lesen**

Lies `UpdateCheckService.ts`, beide Update-Handler, `ModelDownloadService.ts`, Screen-Components

**Step 2: Doc schreiben**

`docs/product/features/model-management.md` soll enthalten:
- First Launch Flow: Disk-Check (5 GB), Modell-Download (~4.1 GB), Fortschrittsanzeige
- Modell-Pfade: wo jedes Modell liegt (`~/.therascript/models/<type>/`)
- R2 Manifest: was geprüft wird, Format, Caching
- Model Update Flow: Download → Staging → Swap bei Neustart
- App Update Flow: nicht-blockierender Hinweis (UpdateBanner), About-Tab Button, öffnet GitHub Releases
- ModelUpdateScreen: wann gezeigt (pending updates nach Neustart), Optionen

**Step 3: Commit**

```bash
git add docs/product/features/model-management.md
git commit -m "docs: add model management feature doc"
```

---

## Task 15: Feature — Settings

**Files:**
- Read: `src/renderer/src/components/AppearanceSettings.tsx`
- Read: `src/renderer/src/components/AboutPage.tsx`
- Read: `src/main/services/SettingsService.ts`
- Read: `src/renderer/src/contexts/ThemeContext.tsx`
- Create: `docs/product/features/settings.md`

**Step 1: Settings-Code lesen**

Lies alle Settings-Components, `SettingsService.ts`, `ThemeContext.tsx`

**Step 2: Doc schreiben**

`docs/product/features/settings.md` soll enthalten:
- Settings-Tabs: Sperrliste / Darstellung / Modelle / Über
- Darstellung: Light/Dark/System, wie Theme-Switching funktioniert (ThemeContext + nativeTheme)
- Modelle: Modell-Status, Update-Check, welche Infos angezeigt werden
- Über: App-Version, App-Update-Status, Link zu GitHub Releases
- electron-store Keys für alle Settings

**Step 3: Commit**

```bash
git add docs/product/features/settings.md
git commit -m "docs: add settings feature doc"
```

---

## Task 16: Operations — Development Setup

**Files:**
- Read: `CLAUDE.md` (Commands-Sektion, Gotchas)
- Read: `scripts/setup-*.sh`
- Create: `docs/product/operations/development-setup.md`

**Step 1: Setup-Scripts und CLAUDE.md lesen**

Lies alle `scripts/setup-*.sh` und CLAUDE.md Commands + Gotchas

**Step 2: Doc schreiben**

`docs/product/operations/development-setup.md` soll enthalten:
- Voraussetzungen: Node.js, npm, Homebrew, Python 3.11+, Xcode CLI Tools
- Fresh Clone Setup (Reihenfolge ist wichtig):
  1. `npm install`
  2. `npm run postinstall` (electron-rebuild)
  3. `scripts/setup-whisper.sh --model`
  4. `scripts/setup-pyannote.sh --model`
  5. `scripts/setup-ner.sh --model`
  6. `scripts/setup-vision-ocr.sh`
  7. `npm run dev`
- Häufige Fehler: better-sqlite3 ABI mismatch → `npm run postinstall`, ELECTRON_RUN_AS_NODE fix
- Python Sidecar Modes: Dev (venv) vs. Production (standalone)
- Hugging Face Token: welche Modelle Token brauchen, wie setzen

**Step 3: Commit**

```bash
git add docs/product/operations/development-setup.md
git commit -m "docs: add development setup operations doc"
```

---

## Task 17: Operations — Release Process

**Files:**
- Read: `scripts/release.sh`
- Read: `electron-builder.yml`, `afterPack.js`
- Read: `CLAUDE.md` (Code signing Gotcha)
- Create: `docs/product/operations/release.md`

**Step 1: Release-Scripts lesen**

Lies `scripts/release.sh`, `electron-builder.yml`, `afterPack.js`

**Step 2: Doc schreiben**

`docs/product/operations/release.md` soll enthalten:
- Release-Flow: `scripts/release.sh` — interaktiv, was es tut (Version bump → Build → GitHub Release)
- Build: `npm run package` → DMG (arm64 only), wo es landet
- Code-Signing: `identity: null`, ad-hoc Signatur via `afterPack.js`, `codesign --sign -`
- Electron Fuses: was `afterPack.js` flippt, Reihenfolge wichtig
- Gatekeeper: was User tun muss (rechtsklick → Öffnen), warum
- GitHub Release: `gh` CLI, was hochgeladen wird

**Step 3: Commit**

```bash
git add docs/product/operations/release.md
git commit -m "docs: add release process operations doc"
```

---

## Task 18: Operations — Model Pipeline (R2)

**Files:**
- Read: `docs/r2-publish-runbook.md`
- Read: `scripts/publish-manifest.sh`
- Read: `package.json` (sidecar:* Scripts)
- Create: `docs/product/operations/model-pipeline.md`

**Step 1: R2-Runbook und Scripts lesen**

Lies `docs/r2-publish-runbook.md`, `scripts/publish-manifest.sh`, sidecar-Scripts in `package.json`

**Step 2: Doc schreiben**

`docs/product/operations/model-pipeline.md` soll enthalten:
- Sidecar Build: `npm run sidecar:build` — was es tut (uv, python-build-standalone)
- Model Packaging: `npm run sidecar:package` — Output in `r2-upload/`
- R2 Upload: `npm run sidecar:upload` — Cloudflare R2, `.env` File
- Manifest: `scripts/publish-manifest.sh` — generiert `manifest.json` + Upload
- Vollständiger Deploy: `npm run sidecar:deploy` (build + package + upload)
- `.env` Format: welche Keys nötig (R2 credentials)

**Step 3: Commit**

```bash
git add docs/product/operations/model-pipeline.md
git commit -m "docs: add model pipeline operations doc"
```

---

## Task 19: ADRs — Kernentscheidungen

**Files:**
- Read: `docs/archive/specification.md` (Modell-Begründungen)
- Read: `docs/archive/requirements.md` (NFR-1, NFR-4 etc.)
- Create: `docs/product/decisions/001-local-only-processing.md`
- Create: `docs/product/decisions/002-whisper-cpp-asr.md`
- Create: `docs/product/decisions/003-pyannote-diarization.md`
- Create: `docs/product/decisions/004-flair-ner.md`
- Create: `docs/product/decisions/005-electron-framework.md`

**Step 1: Archivierte Spec lesen** (Begründungsabschnitte)

Lies `docs/archive/specification.md` (Modell-Vergleichstabellen, Begründungen)

**Step 2: Jedes ADR im Format schreiben:**

```markdown
# ADR-00X: [Titel]

**Status:** Accepted
**Datum:** [Datum der Entscheidung]

## Kontext
[Was war die Situation, was wurde gebraucht]

## Entscheidung
[Was wurde entschieden]

## Begründung
[Warum diese Option, Alternativen die verworfen wurden]

## Konsequenzen
[Was folgt daraus, Einschränkungen, Trade-offs]
```

- `001-local-only-processing.md`: NFR-1 (keine Cloud), DSGVO-Konformität für Therapeuten
- `002-whisper-cpp-asr.md`: whisper.cpp vs. faster-whisper, Metal GPU, WER auf Deutsch
- `003-pyannote-diarization.md`: pyannote community-1 DER 8.3%, HF token requirement
- `004-flair-ner.md`: flair/ner-german-large F1 ~92%, ORG ignoriert
- `005-electron-framework.md`: macOS-only vereinfacht Architektur, kein Tauri/Swift native

**Step 3: Commit**

```bash
git add docs/product/decisions/
git commit -m "docs: add architecture decision records (ADRs)"
```

---

## Task 20: CLAUDE.md aktualisieren

**Files:**
- Modify: `CLAUDE.md`

**Step 1: CLAUDE.md lesen**

Lies das aktuelle CLAUDE.md komplett.

**Step 2: References aktualisieren**

In `CLAUDE.md`:
- Ersetze `requirements.md (user stories, NFRs, decisions)` → `docs/product/` (Produktdokumentation)
- Ersetze `specification.md (architecture, ML pipeline, data model)` → entsprechende `docs/product/architecture/` Refs
- Ersetze `implementation-plan.md (iteration roadmap)` → `docs/archive/implementation-plan.md (abgeschlossen)`
- Ersetze `wireframes.md (24 screens + UX flows)` → `docs/product/features/` Refs

Die neue Key-Docs Zeile könnte lauten:
```
Key docs: `docs/product/` (Produktdokumentation), `docs/archive/` (historische Planungsdocs)
```

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md to reference new product documentation"
```

---

## Zusammenfassung

Nach Abschluss existiert:

```
docs/
  product/
    architecture/
      overview.md           # System, Tech Stack, Prozessmodell
      ml-pipeline.md        # ASR → Diarization → NER, RAM-Budget
      storage.md            # SQLite Schema, electron-store, Dateipfade
      security.md           # CSP, Fuses, Sandbox, FileVault, Signing
      ipc-api.md            # Alle IPC Channels mit Schemas
    features/
      session-management.md
      audio-recording.md
      transcription-pipeline.md
      anonymization.md
      blocklist.md
      pdf-import.md
      review-editor.md
      model-management.md
      settings.md
    decisions/
      001-local-only-processing.md
      002-whisper-cpp-asr.md
      003-pyannote-diarization.md
      004-flair-ner.md
      005-electron-framework.md
    operations/
      development-setup.md
      release.md
      model-pipeline.md
  archive/
    README.md
    requirements.md          # historisch
    specification.md         # historisch
    wireframes.md            # historisch
    implementation-plan.md   # historisch
  plans/                     # bestehend
  r2-publish-runbook.md      # bestehend
```
