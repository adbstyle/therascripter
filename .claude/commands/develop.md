---
description: Autonome, iterative Entwicklung der App anhand von Requirements und Spezifikation. Implementiert, testet und committet bis alle Anforderungen erfuellt sind.
argument-hint: "Optional: Spezifisches Epic oder User Story (z.B. 'Epic 2' oder 'US-2a'). Ohne Argument wird die gesamte App entwickelt."
---

# Autonomer Iterativer Entwicklungsmodus

Du bist ein autonomer Entwicklungsagent. Deine Aufgabe ist es, die Therascript-App vollstaendig zu implementieren, bis alle Anforderungen aus dem Requirements-Dokument und der technischen Spezifikation erfuellt sind. Du arbeitest selbststaendig und stoppst nur bei blockierenden Fehlern, die du nicht selbst loesen kannst.

**Ziel-Scope:** $ARGUMENTS
(Falls leer: Implementiere alle offenen Requirements der Reihe nach.)

---

## Eiserne Regeln

1. **Lies IMMER zuerst** - Kein Code ohne vorheriges Lesen der relevanten Requirements, Specs und bestehenden Codebase.
2. **Teste IMMER** - Kein Commit ohne gruene Tests. Schreibe Tests VOR oder WAEHREND der Implementierung.
3. **Baue IMMER** - Nach jeder Aenderung: `npm run build` muss erfolgreich sein.
4. **Committe IMMER** - Nach jeder abgeschlossenen Iteration ein aussagekraeftiger Git-Commit.
5. **Tracke IMMER** - Nutze TodoWrite durchgehend. Aktualisiere PROGRESS.md nach jeder Iteration.
6. **Frag NICHT** - Du arbeitest autonom. Triff Entscheidungen selbst basierend auf Spec und Requirements. Stoppe nur bei echten Blockern.
7. **Halte dich an die Spec** - Die Spezifikation ist die Wahrheit. Weiche nicht von den technischen Entscheidungen ab.
8. **Ein Schritt nach dem anderen** - Implementiere inkrementell. Jede Iteration muss in sich funktionsfaehig sein.

---

## Phase 0: Orientierung

**Ziel:** Vollstaendiges Verstaendnis des Ist- und Soll-Zustands.

### Aktionen:

1. **Requirements lesen** - Lies `requirements.md` vollstaendig. Erfasse:
   - Alle Epics und User Stories
   - Alle Acceptance Criteria (AC)
   - Alle Non-Functional Requirements (NFRs)
   - Alle Entscheidungen aus dem Decision Log

2. **Spezifikation lesen** - Lies `specification.md` vollstaendig. Erfasse:
   - Systemarchitektur und Prozessmodell
   - Tech Stack und Abhaengigkeiten
   - ML Pipeline Details
   - Datenmodell und API-Kontrakte

3. **Codebase scannen** - Analysiere den aktuellen Stand:
   - Welche Dateien/Module existieren bereits?
   - Welcher Code ist schon implementiert?
   - Gibt es bestehende Tests?
   - Welche Dependencies sind installiert?

4. **Gap-Analyse erstellen** - Schreibe eine Analyse in `PROGRESS.md`:

   ```markdown
   # Therascript Development Progress

   ## Gap-Analyse
   | Epic | User Story | Status | Notizen |
   |------|-----------|--------|---------|
   | Epic 0 | US-0a | ❌ Offen | ... |
   | ... | ... | ... | ... |

   ## Aktuelle Iteration
   ...

   ## Abgeschlossene Iterationen
   ...
   ```

5. **Abhaengigkeitsgraph erstellen** - Bestimme die Reihenfolge:
   - Welche Epics/Stories haengen voneinander ab?
   - Was muss zuerst gebaut werden? (Fundament → Features)
   - Typische Reihenfolge: Projekt-Setup → Datenmodell → Core-Services → UI → Integration

---

## Phase 1: Master-Plan

**Ziel:** Geordneter Implementierungsplan mit klaren Iterationen.

### Aktionen:

1. **Iterationen definieren** - Teile die Arbeit in Iterationen auf:
   - Jede Iteration = 1 User Story oder logische Einheit
   - Jede Iteration endet in einem lauffaehigen Zustand
   - Abhaengigkeiten respektieren

2. **Iteration 0 (Grundgeruest)** ist IMMER:
   - Projekt-Initialisierung (package.json, tsconfig, etc.)
   - Electron-Shell (leeres Fenster startet)
   - Build-Pipeline (TypeScript kompiliert)
   - Test-Framework eingerichtet
   - Linting konfiguriert
   - Erster gruener Test

3. **Plan in PROGRESS.md schreiben und in TodoWrite erfassen**

4. **Falls `$ARGUMENTS` ein spezifisches Epic/Story nennt:**
   - Pruefe, ob Vorbedingungen erfuellt sind
   - Falls nicht: Implementiere Vorbedingungen zuerst
   - Fokussiere dann auf das genannte Epic/Story

---

## Phase 2: Iterations-Loop

**Fuer jede Iteration wiederhole:**

### Schritt 1: Vorbereitung
- Lies die relevanten ACs der aktuellen User Story nochmals
- Identifiziere alle betroffenen Dateien
- Lies bestehenden Code in diesen Dateien
- Plane die konkreten Aenderungen

### Schritt 2: Tests schreiben
- Schreibe Tests, die die Acceptance Criteria abbilden
- Jedes AC = mindestens 1 Test
- Tests MUESSEN anfangs fehlschlagen (Red)
- Verwende das Test-Framework gemaess Spezifikation
- Fuer Unit-Tests: Vitest oder Jest
- Fuer E2E-Tests: Playwright oder Spectron (je nach Spec)
- Fuer ML-Pipeline-Tests: Mocke externe Modelle, teste Pipeline-Logik

### Schritt 3: Implementieren
- Schreibe den Code, der die Tests gruen macht
- Halte dich strikt an die Spezifikation (Tech Stack, Patterns, Architektur)
- Folge bestehenden Code-Konventionen
- Minimaler Code - nur was fuer die aktuelle Iteration noetig ist
- KEIN Over-Engineering, KEINE vorausschauende Abstraktion

### Schritt 4: Build & Test
```bash
# 1. TypeScript kompilieren
npm run build

# 2. Linting
npm run lint

# 3. Tests ausfuehren
npm test

# 4. Falls E2E-Tests existieren
npm run test:e2e
```

**Bei Fehlern:**
- Build-Fehler → Sofort fixen, erneut bauen
- Test-Fehler → Analysiere Root Cause, fixe Implementation (nicht den Test!)
- Lint-Fehler → Sofort fixen
- Nach 3 fehlgeschlagenen Fix-Versuchen → Nutze den `systematic-debugging` Skill

### Schritt 5: Verifizieren
- Gehe JEDES Acceptance Criterion einzeln durch
- Pruefe: Gibt es einen Test dafuer? Ist er gruen?
- Pruefe: Erfuellt der Code die NFRs (soweit pruefbar)?
  - NFR-1 (Lokal): Keine Netzwerk-Calls?
  - NFR-12+ (Performance): Messbar?
  - NFR-20+ (Security): Keine Vulnerabilities?

### Schritt 6: Commit
```bash
git add <spezifische-dateien>
git commit -m "<Typ>(<Scope>): <Beschreibung>

Implementiert <US-ID>: <User Story Titel>
ACs erfuellt: <Liste der ACs>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

Commit-Typen: `feat`, `fix`, `test`, `refactor`, `chore`, `docs`

### Schritt 7: Progress aktualisieren
- Aktualisiere `PROGRESS.md`: Status der User Story auf ✅
- Aktualisiere TodoWrite: Task als completed markieren
- Naechste Iteration beginnen

---

## Phase 3: Integrations-Verifikation

**Nach Abschluss aller Iterationen (oder des angegebenen Scopes):**

### Aktionen:

1. **Vollstaendiger Build**
   ```bash
   npm run build
   npm run lint
   npm test
   npm run test:e2e  # falls vorhanden
   ```

2. **Requirements-Abgleich**
   - Gehe JEDE User Story im Scope durch
   - Pruefe JEDES Acceptance Criterion
   - Markiere in PROGRESS.md als ✅ oder ❌
   - Falls ❌: Zurueck zu Phase 2 fuer diese Story

3. **NFR-Pruefung** (soweit automatisiert pruefbar)
   - Bundle-Groesse pruefen
   - Keine externen Netzwerk-Calls (NFR-1)
   - Startup-Zeit messen wenn moeglich
   - Security-Scan mit `npm audit`

4. **Abschlussbericht in PROGRESS.md**
   ```markdown
   ## Abschlussbericht - [Datum]

   ### Implementiert
   - [Liste aller implementierten User Stories]

   ### Tests
   - Unit Tests: X bestanden
   - E2E Tests: X bestanden
   - Coverage: X%

   ### Bekannte Einschraenkungen
   - [Was nicht automatisch getestet werden konnte]

   ### Naechste Schritte
   - [Was als naechstes implementiert werden sollte]
   ```

---

## Fehlerbehandlung

### Blockierende Fehler (STOPPE und melde)
- Native Dependencies kompilieren nicht (whisper.cpp, better-sqlite3)
- Python-Sidecar kann nicht gestartet werden
- Fehlende System-Tools (kein Python, kein Swift-Compiler)
- Wiederholte Test-Fehler nach 5+ Fix-Versuchen am gleichen Problem

### Selbst loesbare Fehler (FIXE autonom)
- TypeScript-Kompilierungsfehler
- Fehlende npm-Dependencies → `npm install <package>`
- Lint-Fehler
- Test-Fehler mit klarer Ursache
- Fehlende Verzeichnisse oder Dateien
- Import-Pfad-Fehler

### Strategie bei festgefahrenen Problemen
1. Nutze den `systematic-debugging` Skill
2. Suche im Web nach der Fehlermeldung
3. Pruefe die Dokumentation der betroffenen Library
4. Vereinfache: Mocke/Stubbe die problematische Komponente und fahre fort
5. Dokumentiere das Problem in PROGRESS.md unter "Bekannte Einschraenkungen"

---

## Spezifische Therascript-Hinweise

### ML-Modelle in Tests
- whisper.cpp, pyannote, flair sind NICHT in Tests verfuegbar
- Erstelle Mocks/Stubs fuer alle ML-Interfaces
- Teste die Pipeline-Logik, nicht die Modell-Ausgaben
- Verwende aufgezeichnete Fixtures fuer Integrationstests

### Electron-spezifisch
- Main-Process und Renderer-Process getrennt testen
- IPC-Kommunikation mocken wo noetig
- Fuer UI-Tests: Playwright mit Electron-Support

### Native Addons
- whisper.cpp N-API Addon: Erstelle ein Mock-Interface fuer Tests
- better-sqlite3: Verwende In-Memory-DB fuer Tests
- Swift CLI (Vision OCR): Mocke als Subprocess

---

## Qualitaetskriterien pro Iteration

Jede Iteration ist erst abgeschlossen wenn:
- [ ] Alle ACs der User Story sind durch Tests abgedeckt
- [ ] Alle Tests sind gruen
- [ ] Build ist erfolgreich
- [ ] Lint ist sauber
- [ ] Code folgt den Konventionen der Spezifikation
- [ ] Git Commit ist erstellt
- [ ] PROGRESS.md ist aktualisiert
