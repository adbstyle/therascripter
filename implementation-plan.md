# Therascript Implementierungsplan

## Context

Therascript ist eine Electron-basierte macOS-Desktop-App für Therapiesitzungs-Transkription + Anonymisierung. Das Projekt ist **Greenfield** — es existiert kein Code, nur `requirements.md` und `specification.md`. Ziel ist ein iterativer Aufbau in 16 Schritten, wobei jede Iteration ein testbares Ergebnis liefert.

**Constraints:** macOS 14+, ARM64-only, 8 GB RAM Minimum, strikt sequenzielle ML-Verarbeitung, 100% lokal (kein Cloud), MIT-Lizenz.

**ML-Strategie:** Echte Modelle ab sofort (keine Mocks). Automatisierte Tests nutzen Fixtures, manuelle Verifikation nutzt echte Modelle.

---

## Iteration 1: Projekt-Scaffold & Electron-Shell

**Scope:** Projekt initialisieren, Build-Pipeline, leeres Electron-Fenster mit Security-Hardening

**Deliverables:**
- `package.json` (electron-vite, React 18, TypeScript, Vitest, ESLint, Prettier)
- `electron.vite.config.ts`
- `tsconfig.json` (Main + Renderer + Shared)
- `src/main/index.ts` — Main Process (BrowserWindow, contextIsolation, sandbox, nodeIntegration:false)
- `src/renderer/index.html` + `src/renderer/main.tsx` — React Entry
- `src/preload/index.ts` — Preload mit contextBridge
- `.eslintrc.js`, `.prettierrc`
- `vitest.config.ts` + erster Smoke-Test
- `.gitignore` (aktualisiert)

**Security ab Tag 1:** contextIsolation, sandbox, nodeIntegration:false, CSP Header

**Verifikation:**
```
npm install && npm run dev    → Fenster öffnet mit "Therascript"
npm run build                 → Build erfolgreich
npm test                      → 1 Test grün
npm run lint                  → 0 Fehler
```

---

## Iteration 2: Datenbank-Layer & Session-Modell (Epic 0 Fundament)

**Scope:** better-sqlite3, Schema-Migration, Session-CRUD

**Deliverables:**
- `src/main/db/connection.ts` — SQLite-Verbindung + Migrations-System
- `src/main/db/migrations/001-initial-schema.sql` — Tabellen: sessions, blocklist, task_queue, model_registry
- `src/main/db/repositories/SessionRepository.ts` — CRUD
- `src/shared/types/Session.ts` — TypeScript Interfaces
- `src/main/services/SessionService.ts` — Geschäftslogik
- Unit-Tests für SessionRepository (in-memory SQLite)

**Verifikation:**
```
npm test                      → Repository-Tests grün
npm run dev                   → therascript.db wird in ~/.therascript/data/ erstellt
```

---

## Iteration 3: Session-Dashboard UI (Epic 0 — US-0)

**Scope:** React-UI für Sitzungsliste, IPC, Zod-Validierung, Zeitgruppierung

**Deliverables:**
- `src/renderer/components/SessionDashboard.tsx` — Sitzungsliste
- `src/renderer/components/SessionCard.tsx` — Einzelne Sitzung
- `src/renderer/hooks/useSessions.ts` — React Hook
- `src/main/ipc/session-handlers.ts` — IPC Handler (session:list, session:delete, session:rename)
- `src/shared/validation/session-schemas.ts` — Zod Schemas für IPC (NFR-15)
- Zeitgruppierung: "Heute", "Gestern", "Diese Woche", "Letzte Woche", "Älter"
- Umbenennen + Löschen mit Bestätigungsdialog
- electron-store Setup für Settings (`src/main/services/SettingsService.ts`)

**Verifikation:**
```
npm run dev                   → Dashboard zeigt leere Liste
                              → Session via DevTools erstellen → erscheint in Liste
                              → Umbenennen funktioniert
                              → Löschen mit Bestätigung funktioniert
                              → Zeitgruppierung korrekt
```

**AC abgedeckt:** US-0 AC 1-7, 9-10

---

## Iteration 4: Audio-Aufnahme Basis (Epic 1 — US-1 Teil 1)

**Scope:** Web Audio API Recording, WAV-Speicherung, Session-Erstellung

**Deliverables:**
- `src/renderer/services/AudioRecorder.ts` — Web Audio API + AudioWorklet
- `src/renderer/components/RecordButton.tsx` — Start/Stop UI
- `src/main/services/AudioFileService.ts` — WAV auf Disk schreiben
- Auto-Titel: "Sitzung DD.MM.YYYY HH:MM"
- Aufnahmedauer-Anzeige
- Audio-Pegel-Visualisierung (VU-Meter)
- Auto-Recovery: periodische Buffer-Dumps nach `~/.therascript/data/recovery/`

**Verifikation:**
```
npm run dev                   → Record-Button klicken → sprechen → Stop
                              → WAV in ~/.therascript/data/audio/ prüfen
                              → Session erscheint im Dashboard
                              → WAV in QuickTime abspielen → Audio korrekt
```

**AC abgedeckt:** US-1 AC 1-4, 9

---

## Iteration 5: Menu Bar, Standby-Schutz & Auto-Stop (Epic 1 — US-1 Teil 2)

**Scope:** Tray-Icon, powerSaveBlocker, 3h Auto-Stop, Einwilligungshinweis

**Deliverables:**
- `src/main/services/TrayService.ts` — Menu Bar Icon (rot=Aufnahme, grau=idle)
- Tray-Kontextmenü: Stop, Fenster zeigen
- Timer-Tooltip im Tray
- `powerSaveBlocker` während Aufnahme (NFR-24)
- 3h Auto-Stop mit Benachrichtigung
- Einwilligungshinweis beim ersten Aufnahmestart (electron-store Flag)

**Verifikation:**
```
npm run dev                   → Aufnahme starten → rotes Tray-Icon sichtbar
                              → App minimieren → Tray zeigt Dauer
                              → Stop via Tray-Menü funktioniert
                              → Mac geht nicht in Standby während Aufnahme
                              → Erster Start: Einwilligungsdialog erscheint
```

**AC abgedeckt:** US-1 AC 5-8, 10-12

---

## Iteration 6: Task Queue (Epic 1 Erweiterung)

**Scope:** Task-Queue-Grundgerüst für sequenzielle ML-Pipeline

**Deliverables:**
- `src/main/services/TaskQueue.ts` — FIFO-Queue mit SQLite-Persistenz (task_queue Tabelle)
- Queue verarbeitet Tasks sequenziell, überlebt Crashes (Recovery beim Start)
- IPC: `task:progress`, `task:completed`, `task:error` Events an Renderer

**Verifikation:**
```
npm run dev                   → Task-Queue-Status in DevTools prüfen
                              → Queue verarbeitet Tasks sequenziell
                              → Nach App-Neustart: unerledigte Tasks werden fortgesetzt
```

---

## Iteration 7: whisper.cpp Transkription (Epic 2 — US-2 Teil 1: ASR)

**Scope:** whisper.cpp Subprocess, echtes Modell, Wort-Zeitstempel

**Deliverables:**
- `src/main/ml/WhisperService.ts` — Subprocess-Wrapper für whisper.cpp CLI
- whisper.cpp ARM64 Binary herunterladen/bauen
- Whisper Large V3 Turbo Q5_0 Modell (~1.6 GB) Download + SHA-256 Verifikation
- model_registry Einträge in SQLite
- Fortschrittsanzeige (stdout-Parsing)
- JSON-Output mit Wort-Zeitstempeln
- Filler-Wort-Entfernung ("äh", "ähm") als Regex-Postprocessing
- Task-Queue-Integration: Transkription startet automatisch nach Aufnahme-Stop
- QoS: `nice -n 10` für Subprocess (NFR-23)

**Verifikation:**
```
npm run dev                   → Audio aufnehmen → Transkription startet
                              → Fortschritt im Dashboard sichtbar
                              → Nach Abschluss: Transkript-JSON mit Zeitstempeln prüfen
                              → Filler-Wörter entfernt
                              → ~/.therascript/models/asr/ enthält Modell
```

**AC abgedeckt:** US-2 AC 1, 5-7, 10, 14

---

## Iteration 8: Diarization & Sprecher-Alignment (Epic 2 — US-2 Teil 2)

**Scope:** Python-Sidecar mit pyannote, Sprecher-Segmente, Alignment

**Deliverables:**
- `python_sidecar/` — Python-Projekt mit pyannote.audio
- `python_sidecar/diarization_service.py` — CLI/API für Diarization
- PyInstaller Build-Script für gebündelten Sidecar
- `src/main/ml/PyannoteSidecar.ts` — Subprocess-Lifecycle-Management
- pyannote community-1 Modell Download (~200 MB) + Verifikation
- Auto-Erkennung 1-4 Sprecher
- Alignment: Wort-Zeitstempel → Sprecher-Segmente zuordnen
- Speaker-Labels ("Person A", "Person B") + Zeitstempel [HH:MM:SS] bei Sprecherwechsel
- Absatzumbrüche bei Sprecherwechsel
- 1 Sprecher = keine Labels

**Verifikation:**
```
npm run dev                   → Mehrere-Sprecher-Audio transkribieren
                              → Transkript zeigt Speaker-Labels + Zeitstempel
                              → Absätze bei Sprecherwechsel
                              → Ein-Sprecher-Audio: keine Labels
```

**AC abgedeckt:** US-2 AC 2-4, 8-9, 13-14

---

## Iteration 9: Anonymisierung (Epic 4 — US-4)

**Scope:** flair NER + Regex + GLiNER im Python-Sidecar, Platzhalter-Erzeugung

**Deliverables:**
- `python_sidecar/ner_service.py` — flair/ner-german-large + GLiNER PII Inference
- flair Modell Download (~2.2 GB) + Verifikation
- Entitäten: PERSON, ORT, DATUM, KONTAKT, ORGANISATION (flair) + GEBURTSDATUM, TELEFON, EMAIL (GLiNER/Regex)
- `src/main/services/AnonymizationService.ts` — Orchestrierung NER + Platzhalter
- Platzhalter-Format: [PERSON 1], [ORT 1] etc. (typ-spezifische Nummerierung)
- entity_map in Session speichern (Original ↔ Platzhalter Mapping)
- Coreference-Resolution (basic: "Dr. Müller" = "Müller" → [PERSON 1])
- Whole-Word-Matching (kein "Müller" in "Müllerstrasse")
- Pipeline: Transkription → Diarization → **Anonymisierung** → Status "review"

**Verifikation:**
```
npm run dev                   → Audio mit Namen/Orten aufnehmen
                              → Pipeline läuft durch bis Anonymisierung
                              → Session-Status wechselt zu "review"
                              → entity_map prüfen: Namen/Orte → Platzhalter
                              → Konsistenz: gleicher Name → gleicher Platzhalter
```

**AC abgedeckt:** US-4 AC 1-13

---

## Iteration 10: Sperrliste (Epic 5 — US-5)

**Scope:** CRUD, Matching-Engine, Settings-UI, Integration in Anonymisierung

**Deliverables:**
- `src/main/db/repositories/BlocklistRepository.ts` — CRUD
- `src/renderer/components/Settings/BlocklistManager.tsx` — Verwaltungs-UI
- Settings-Panel mit Sperrliste-Tab
- Hinzufügen/Bearbeiten/Löschen von Einträgen
- 7 Platzhalter-Typen (PERSON, ORT, DATUM, KONTAKT, ORGANISATION, MEDIZINISCH, SONSTIGES)
- Mehrwort-Phrasen-Support
- Case-insensitive + Umlaut-Normalisierung (ü↔ue, ä↔ae, ö↔oe, ß↔ss)
- Longest-Match-Algorithmus
- Integration in AnonymizationService (nach NER, vor Platzhalter-Erzeugung)
- NER hat Vorrang vor Sperrliste (Entscheidung #68)
- Bestätigungsdialog beim Hinzufügen

**Verifikation:**
```
npm run dev                   → Settings öffnen → Sperrliste-Tab
                              → "Mueller" als PERSON hinzufügen
                              → Audio mit "Mueller" transkribieren → wird anonymisiert
                              → "Mueller" auch als "Müller" erkannt (Umlaut-Normalisierung)
                              → Mehrwort: "Dr. Hans Mueller" als ein Eintrag → Longest Match
```

**AC abgedeckt:** US-5 AC 1-10, 13

---

## Iteration 11: PDF-Import & OCR (Epic 3 — US-3)

**Scope:** pdfjs-dist Text-Extraktion, Apple Vision OCR, Mixed-PDF

**Deliverables:**
- `src/main/services/PDFService.ts` — Import, Text/Scan-Erkennung pro Seite
- pdfjs-dist Integration (Worker Thread) für Text-PDFs
- `swift_cli/vision_ocr` — Swift CLI Helper für Apple Vision OCR
- `src/main/ml/VisionOCRService.ts` — Swift CLI Subprocess
- Mixed-PDF: pro Seite automatisch Text vs. OCR
- Passwort-geschützte PDFs: Passwort-Dialog
- Batch-Import via Drag-Drop
- Session-Typ 'pdf' (kein Transkriptions-Schritt, direkt → Anonymisierung)
- Visuell unterscheidbare PDF-Sessions im Dashboard

**Verifikation:**
```
npm run dev                   → Text-PDF importieren → Text korrekt extrahiert
                              → Scan-PDF importieren → OCR läuft, Text extrahiert
                              → Mixed-PDF → beide Methoden korrekt
                              → Passwort-PDF → Dialog erscheint, nach Eingabe extrahiert
                              → Anonymisierung startet automatisch nach Extraktion
```

**AC abgedeckt:** US-3 AC 1-13

---

## Iteration 12: Review-Editor Basis (Epic 6 — US-6a)

**Scope:** TipTap-Editor mit atomaren Custom Nodes, Auto-Save

**Deliverables:**
- `src/renderer/components/ReviewEditor/ReviewEditor.tsx` — TipTap v2 Integration
- Custom TipTap Nodes:
  - `PlaceholderChip` (atomar, farbig nach Typ, nicht teilbar)
  - `SpeakerLabel` (atomar, löschbar)
  - `Timestamp` (atomar, löschbar)
- Anonymisierten Text + Platzhalter in Editor laden
- Freies Text-Editieren (Cursor, Tippen, Löschen, Copy-Paste)
- Auto-Save (debounced ~2s, persistiert Document + EntityMap)
- Herkunfts-Anzeige per Tooltip (NER/Sperrliste/Manuell)
- Chip-Farben nach Typ (PERSON=blau, ORT=grün, etc.)
- Chips: Copy-Paste intern = Chip bleibt, extern = Platzhalter-String

**Verifikation:**
```
npm run dev                   → Session im Review-Modus öffnen
                              → Anonymisierter Text mit farbigen Chips sichtbar
                              → Text frei editieren → Auto-Save (prüfen in DB)
                              → Chip-Hover → Typ + Herkunft im Tooltip
                              → Chip kann nicht teilweise selektiert werden
                              → Copy-Paste Chip in TextEdit → "[PERSON 1]" als String
```

**AC abgedeckt:** US-6a AC 1-11

---

## Iteration 13: False-Positive/Negative-Korrektur (Epic 6 — US-6b)

**Scope:** Chip löschen = Undo (Batch), manuelles Anonymisieren per Kontextmenü

**Deliverables:**
- Chip-Löschung: Delete/Backspace → Original-Text erscheint (Batch: alle gleichen Chips)
- Kontextmenü bei Text-Selektion: "Anonymisieren" + Typ-Auswahl (5 Typen)
- Manueller Platzhalter: nächste verfügbare Nummer pro Typ
- Selektion erweitert sich automatisch auf überlappende Chips
- Undo/Redo (Cmd+Z/Shift+Z, ~100 Schritte, nicht persistiert)
- Herkunft "Manuell" für vom User erstellte Platzhalter

**Verifikation:**
```
npm run dev                   → Chip löschen → Original-Text erscheint
                              → Einen [PERSON 1] löschen → ALLE [PERSON 1] gelöscht
                              → Text selektieren → Rechtsklick → "Als PERSON anonymisieren"
                              → Neuer Chip mit nächster Nummer erstellt
                              → Undo (Cmd+Z) → Änderung rückgängig
                              → App neustarten → Undo-History leer
```

**AC abgedeckt:** US-6b AC 1-7

---

## Iteration 14: Sperrliste-Schnellaktion im Review (Epic 6 — US-6c)

**Scope:** "Zur Sperrliste hinzufügen" aus Review, retroaktive Anwendung

**Deliverables:**
- Kontextmenü-Erweiterung: "Zur Sperrliste hinzufügen" + Typ-Auswahl
- Bestätigungsdialog: "[Begriff] als [Typ] hinzufügen?"
- Retroaktive Anwendung: gesamten Text der aktuellen Sitzung neu scannen
- Alle Treffer (case-insensitive + Umlaut) als neue Platzhalter einfügen
- Herkunft "Sperrliste" für retroaktiv erstellte Chips
- Undo: Cmd+Z macht Sperrlisten-Eintrag + alle retroaktiven Chips rückgängig
- Sofortige Persistierung in SQLite (nicht nur in-memory)

**Verifikation:**
```
npm run dev                   → Im Review "Sonnenhalde" selektieren
                              → "Zur Sperrliste hinzufügen" als ORGANISATION
                              → Bestätigung → alle "Sonnenhalde" im Text anonymisiert
                              → Settings prüfen: Eintrag in Sperrliste vorhanden
                              → Undo → Sperrlisten-Eintrag + Chips rückgängig
                              → Neue Session: "Sonnenhalde" wird automatisch anonymisiert
```

**AC abgedeckt:** US-6c AC 1-6, US-5 AC 11-12

---

## Iteration 15: Export in Zwischenablage (Epic 7 — US-7)

**Scope:** Kopieren-Button, Text-Serialisierung, Bestätigungsmeldung

**Deliverables:**
- `src/renderer/components/ReviewEditor/ExportButton.tsx` — "In Zwischenablage kopieren"
- Serialisierung: TipTap-Document → Plaintext (Platzhalter als Strings, Speaker-Labels + Zeitstempel)
- PDF-Sessions: Fliesstext ohne Zeitstempel/Speaker-Labels
- Electron clipboard API
- Erfolgs-Toast nach Kopieren
- Jederzeit verfügbar (kein Finalisierungs-Schritt)
- Mehrfach kopierbar (immer aktueller Editor-Stand)

**Verifikation:**
```
npm run dev                   → Kopieren-Button klicken
                              → In TextEdit einfügen → Inhalt korrekt
                              → Speaker-Labels + Zeitstempel vorhanden
                              → Platzhalter als "[PERSON 1]" etc.
                              → Text editieren → erneut kopieren → neuer Inhalt
                              → PDF-Session: kein Speaker-Label im Export
```

**AC abgedeckt:** US-7 AC 1-6

---

## Iteration 16: Auto-Löschung, First-Launch & Distribution (Epic 0 + Epic 8)

**Scope:** 30-Tage-Auto-Löschung, Modell-Download-UI, .dmg-Packaging, Uninstaller

**Deliverables:**
- `src/main/services/AutoDeletionService.ts` — Täglich prüfen, Sessions > 30 Tage löschen
- SQLite VACUUM nach Batch-Löschung (NFR-17)
- `.metadata_never_index` in Datenverzeichnis (Spotlight-Ausschluss)
- FileVault-Check beim App-Start (NFR-13) — Warnung wenn deaktiviert
- First-Launch UI: Ersteinrichtung mit Download-Fortschritt pro Modell + gesamt
- Speicherplatz-Prüfung (~5 GB frei) vor Download
- Resume-fähiger Download (Entscheidung #109 revidiert)
- `electron-builder.yml` — .dmg ARM64-only Konfiguration
- Electron Fuses (RunAsNode=false, etc.)
- In-App-Uninstaller: Menüpunkt "Therascript vollständig entfernen"
- Uninstaller löscht ~/.therascript/ + Application Support

**Verifikation:**
```
npm run dev                   → Session mit created_at 31 Tage zurück → wird gelöscht
                              → FileVault deaktiviert → Warnung erscheint
npm run package               → .dmg wird erstellt
                              → .dmg auf sauberem Mac installieren → App startet
                              → First-Launch: Download-Fortschritt sichtbar
                              → Nach Download: App voll funktionsfähig
                              → Menüpunkt "Deinstallieren" → Daten entfernt
```

**AC abgedeckt:** US-0 AC 8, US-8a AC 1-8, US-8b AC 1-5

---

## Abhängigkeitskette

```
Iter 1 (Scaffold)
  → Iter 2 (DB)
    → Iter 3 (Dashboard UI)          ← Epic 0 komplett
      → Iter 4 (Audio Basis)
        → Iter 5 (Menu Bar)
          → Iter 6 (Task Queue)      ← Epic 1 komplett
            → Iter 7 (whisper.cpp)
              → Iter 8 (Diarization) ← Epic 2 komplett
                → Iter 9 (NER)       ← Epic 4 komplett
                  → Iter 10 (Blocklist)  ← Epic 5 komplett
                    → Iter 11 (PDF/OCR)  ← Epic 3 komplett
                      → Iter 12 (Review Editor)  ← Epic 6a komplett
                        → Iter 13 (FP/FN)        ← Epic 6b komplett
                          → Iter 14 (Blocklist Quick-Add) ← Epic 6c komplett
                            → Iter 15 (Export)    ← Epic 7 komplett
                              → Iter 16 (Distribution) ← Epic 8 komplett
```

---

## Verifikations-Workflow (jede Iteration)

```bash
npm run build                 # TypeScript kompiliert fehlerfrei
npm run lint                  # Keine Lint-Fehler
npm test                      # Alle Unit-Tests grün
npm run dev                   # Manuelle Verifikation der Iteration
git add <files> && git commit # Nur wenn alles grün
```

---

## Kritische Dateien

| Datei | Iteration | Bedeutung |
|-------|-----------|-----------|
| `src/main/index.ts` | 1 | Main Process Entry, orchestriert alles |
| `src/main/db/connection.ts` | 2 | SQLite-Verbindung, Foundation |
| `src/main/services/TaskQueue.ts` | 6 | FIFO Queue, steuert ML-Pipeline |
| `src/main/ml/WhisperService.ts` | 7 | ASR-Integration |
| `src/main/ml/PyannoteSidecar.ts` | 8 | Diarization-Integration |
| `src/main/services/AnonymizationService.ts` | 9 | Kern-Geschäftslogik |
| `src/renderer/components/ReviewEditor/ReviewEditor.tsx` | 12 | Komplexeste UI-Komponente |
| `python_sidecar/` | 8-9 | ML-Runtime für pyannote + flair |
| `swift_cli/vision_ocr` | 11 | Apple Vision OCR Helper |

---

## Geschätzter Aufwand

| Iteration | Tage | Kumulativ |
|-----------|------|-----------|
| 1 Scaffold | 1 | 1 |
| 2 DB | 1 | 2 |
| 3 Dashboard | 2 | 4 |
| 4 Audio Basis | 2 | 6 |
| 5 Menu Bar | 1 | 7 |
| 6 Task Queue | 1 | 8 |
| 7 whisper.cpp | 2-3 | 11 |
| 8 Diarization | 2-3 | 14 |
| 9 Anonymisierung | 2-3 | 17 |
| 10 Sperrliste | 2 | 19 |
| 11 PDF/OCR | 2-3 | 22 |
| 12 Review Editor | 2 | 24 |
| 13 FP/FN | 2 | 26 |
| 14 Blocklist Quick-Add | 2 | 28 |
| 15 Export | 1 | 29 |
| 16 Distribution | 2 | 31 |
| **Total** | **~31 Tage** | **~6 Wochen** |
