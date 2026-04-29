# Plan: Transparente Pipeline-Fortschrittsanzeige (Issue #80)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed
**Author:** Senior Architect
**Date:** 2026-04-29
**Trigger:** GitHub Issue [#80](https://github.com/adbstyle/therascripter/issues/80) — Epic „Transparente Pipeline-Fortschrittsanzeige für Therapeut*innen"
**Reference Comments:**
- [UX-Lösungsentwurf](https://github.com/adbstyle/therascripter/issues/80#issuecomment-4346921457)
- [Architektur-Review (DR-1 bis DR-7)](https://github.com/adbstyle/therascripter/issues/80#issuecomment-4347057170)

---

**Goal:** SessionCard zur transparenten Verarbeitungs-Anzeige umbauen — Schritt-Counter, schritt-eigene + Gesamt-Progress, ETA-Schätzung, Wartezustand, Empty-Speech-Pfad, Watchdog-Retry-Limit.

**Architecture:** `SessionStatus` reduziert auf 5 Werte (`recording | queued | processing | review | error`), `tasks[]` wird Source-of-Truth für „aktueller Schritt". Neue DB-Spalten `plannedSteps` (eingefroren bei `queued → processing`) und `retryCount`. Drei IPC-Channels nach Frequenz getrennt: `task:progress` (4 Hz), `task:started` / `task:completed` / `task:error` (event), `queue:positions` (Broadcast). On-device-Telemetrie als normalisierte Raten in `electron-store`, ETA-Estimator im Main-Prozess. UI wird in zwei Stufen scharf geschaltet: schritt-eigene Bar sofort, Gesamt-Bar/ETA erst nach 3 telemetrierten Sessions.

**Tech Stack:** TypeScript (strict), Electron 3-Process (main / preload / renderer), better-sqlite3, electron-store, Vitest + @testing-library/react, React 19, Tailwind CSS v4, lucide-react Icons.

**Pipeline-Reihenfolgen (single source of truth):** `src/shared/constants/pipeline.ts`
- Audio: `diarization → transcription → alignment → anonymization → summarization`
- PDF: `extraction → ocr → anonymization → summarization`

---

## Code-Review-Resolutions (eingearbeitet)

Plan wurde nach einem 5-Reviewer-Review (CLAUDE.md-Compliance, Bug-Scan, Architektur-Drift, TDD-Disziplin, Sequenzierung) überarbeitet. Folgende strukturelle Änderungen sind im Plan-Body verankert:

1. **Phase D.3** referenziert keinen Estimator mehr — `plannedDurationSec` und `etaSecondsTotal` werden hart auf `null` gesetzt; Phase I.4 ersetzt diese Werte (kein `this.estimator?.estimate(…)` vor Phase I).
2. **Phase C.3** `computePlannedSteps` importiert Pipeline-Reihenfolge aus `src/shared/constants/pipeline.ts` (nicht inline-Literal — verhindert lokale Duplikate gemäss CLAUDE.md).
3. **Phase C.4** verifiziert alle vier DR-6-Punkte: AbortController-Propagation, pending-Tasks-Cleanup, Artefakt-Cleanup, No-op-Toleranz nach Abort.
4. **Phase D.1 Step 3** macht Zod-Schema-Validation für die neuen IPC-Channels obligatorisch (CLAUDE.md-Pflicht), mit konkreten Schema-Snippets.
5. **Phase G.1** führt OCR-Detection beim PDF-Import ein (vor Enqueue, mit Migration 013 für `pdfHasScannedPages`-Spalte). Verhindert „Schritt 3/2"-Counter-Inkonsistenz, wenn OCR mid-pipeline doch läuft.
6. **Sequenzierung-Sektion** korrigiert: K, L, M sind **nicht** parallelisierbar (alle drei modifizieren denselben SessionCard-JSX-Block); F und G sind **nicht** parallelisierbar (G's Smoke-Test hängt an F.2-UI).
7. **Tests** in C.2/C.3/C.4/D.4/E.3/H.1/I.1/I.2/J.2/M.1 mit konkretem Test-Code statt `// Arrange...`-Pseudocode.

---

## Phase-Übersicht

| Phase | Story | Inhalt | Tasks |
|---|---|---|---|
| 0 | — | Pre-flight (Callsite-Audit + Baseline-Tests) | 2 |
| A | 1 | DB-Migration 012 (status-Reduktion + plannedSteps + retryCount) | 4 |
| B | 1 | Backend `SessionStatus` + Repository + SessionService | 5 |
| C | 1 | TaskQueueService — `tasks[]` als SOT, Delete-Pfad-Verifikation | 4 |
| D | 1 | IPC-Schema-Erweiterung (`task:started`, `queue:positions`) | 4 |
| E | 1+2 | `useTaskProgress`-Refactor (kein clear-on-completed) | 3 |
| F | 2 | SessionCard Audio Happy Path | 4 |
| G | 3 | SessionCard PDF Happy Path | 2 |
| H | 4 | Summarization conditional via `plannedSteps` | 2 |
| I | 5a | Telemetrie + Estimator (Backend) | 5 |
| J | 5b | Gesamt-Bar + ETA UI | 3 |
| K | 6 | Wartezustand mit Position | 3 |
| L | 7 | Empty-Speech via `wordCount===0` | 2 |
| M | 8 | Watchdog + 3-Stufen-Retry-Limit | 3 |
| N | 9 | Wording-Glossar Final Pass | 1 |

**Total: ~47 Tasks, ~200 Steps.** Phasen A–E sind hart blockierend — Phase A muss zuerst, danach B/C/D können parallelisiert werden, E hängt an D. Alle UI-Phasen (F+) hängen an E.

---

## Phase 0: Pre-flight

### Task 0.1: Callsite-Audit-Skript + Baseline dokumentieren

**Files:**
- Create: `scripts/audit-status-callsites.sh`

- [ ] **Step 1: Skript anlegen, das alle Callsites der zu entfernenden Status-Werte listet**

```bash
#!/usr/bin/env bash
# Audits all references to legacy SessionStatus values that will be removed in Phase A.
# Run before and after Phase B to verify zero callsites remain (excluding migrations and tests).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Status-String-Vergleiche ==="
rg "session\.status === '(transcribing|diarizing|extracting|anonymizing)'" src/ --type ts --type tsx || echo "(keine Treffer)"

echo
echo "=== Status-Literale in Set-Statements ==="
rg "status: '(transcribing|diarizing|extracting|anonymizing)'" src/ --type ts --type tsx || echo "(keine Treffer)"

echo
echo "=== SessionStatus-Type-Member ==="
rg "'(transcribing|diarizing|extracting|anonymizing)'" src/shared/types/Session.ts || echo "(keine Treffer)"

echo
echo "=== Migration-Files (erwartet — nicht anpassen) ==="
rg "'(transcribing|diarizing|extracting|anonymizing)'" src/main/db/migrations/ || echo "(keine Treffer)"
```

- [ ] **Step 2: Skript ausführbar machen + Baseline laufen lassen**

```bash
chmod +x scripts/audit-status-callsites.sh
./scripts/audit-status-callsites.sh > /tmp/baseline-callsites.txt
cat /tmp/baseline-callsites.txt
```

Erwartete Treffer (Baseline 2026-04-29):
- `src/renderer/src/components/SessionCard.tsx:40-43` — `isProcessingStatus()`
- `src/renderer/src/components/SessionDashboard.tsx:9-12` — `PROCESSING_STATUSES`
- `src/main/services/SessionService.ts:14-20,231-234` — `VALID_TRANSITIONS` + `processingStatuses`
- `src/main/services/TaskQueueService.ts:16-23,150-153,371-379` — `TASK_TO_SESSION_STATUS` + `getSessionStatusForTask`
- `src/main/db/repositories/SessionRepository.ts:76` — Default-Status
- `src/main/ipc/recording-handlers.ts:74` — `updateSession({status: 'diarizing'})`
- `src/shared/types/Session.ts:7-10` — Type-Definition

Migrations (`011-pipeline-inversion.sql` etc.) bleiben unverändert — historische DB-Zustände nicht umschreiben.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-status-callsites.sh
git commit -m "chore: add status-callsite audit script for issue #80"
```

---

### Task 0.2: Baseline-Tests laufen, Snapshot ablegen

- [ ] **Step 1: Volltest-Suite laufen lassen, Ausgang notieren**

```bash
npm run test 2>&1 | tee /tmp/baseline-tests.txt
```

Erwartet: alle bestehenden Tests grün. Falls nicht — Plan pausieren, vorhandene Test-Fehler vor Issue-#80-Arbeit fixen.

- [ ] **Step 2: TypeCheck baseline**

```bash
npm run typecheck 2>&1 | tee /tmp/baseline-typecheck.txt
```

Erwartet: keine TypeScript-Fehler.

Kein Commit für diesen Task — Baseline-Logs sind in `/tmp` und werden später zum Vergleich herangezogen.

---

## Phase A: DB-Migration 012

### Task A.1: Migration 012 SQL schreiben

**Files:**
- Create: `src/main/db/migrations/012-status-reduction-planned-steps-retry.sql`

- [ ] **Step 1: SQL-Migration anlegen**

```sql
-- Migration 012: Status-Modell-Reduktion + plannedSteps + retryCount (Issue #80)
-- Purpose:
--   1. Reduce SessionStatus to 5 values: recording, queued, processing, review, error
--   2. Add plannedSteps column (JSON array of TaskType, frozen at queued→processing)
--   3. Add retryCount column for 3-stage retry-limit UX
-- Rationale: tasks[] becomes Source-of-Truth for "current step"; SessionStatus only
--   carries lifecycle phase. plannedSteps captures dynamic pipeline (summarization
--   conditional, PDF OCR conditional) at processing-start.

-- Step 1: collapse legacy status values to 'processing'
-- Sessions in transcribing/diarizing/extracting/anonymizing were mid-pipeline;
-- the new model treats them all as 'processing' since tasks[] holds the actual step.
UPDATE sessions
SET status = 'processing'
WHERE status IN ('transcribing', 'diarizing', 'extracting', 'anonymizing');

-- Step 2: introduce 'queued' lifecycle phase
-- Sessions that were 'recording' but have no audio_path yet stay recording.
-- Sessions waiting in queue (have tasks but no running task) become 'queued'.
-- This update is best-effort; in practice the migration runs at app start when
-- no tasks are running, so 'queued' state is transient. The schema however must
-- accept it from now on.
-- (No UPDATE needed; new sessions enter 'queued' via TaskQueueService in Phase C.)

-- Step 3: add plannedSteps column (JSON-encoded array, NULL for legacy rows)
ALTER TABLE sessions ADD COLUMN planned_steps TEXT;

-- Step 4: backfill planned_steps for in-progress sessions using a conservative default
-- (full audio pipeline excl. summarization, full PDF pipeline excl. OCR + summarization).
-- Newly-queued sessions populate this column atomically when entering 'processing'.
UPDATE sessions
SET planned_steps = '["diarization","transcription","alignment","anonymization"]'
WHERE type = 'audio' AND status = 'processing' AND planned_steps IS NULL;

UPDATE sessions
SET planned_steps = '["extraction","anonymization"]'
WHERE type = 'pdf' AND status = 'processing' AND planned_steps IS NULL;

-- Step 5: add retryCount column (defaults to 0 for all rows)
ALTER TABLE sessions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Migration in `index.ts` registrieren**

```typescript
// src/main/db/migrations/index.ts — füge nach Zeile 11 hinzu:
import statusReductionPlannedStepsRetry from './012-status-reduction-planned-steps-retry.sql?raw'

// und im migrations-Array nach Zeile 29:
{ version: 12, sql: statusReductionPlannedStepsRetry }
```

- [ ] **Step 3: TypeCheck — Migration darf ts nicht brechen**

```bash
npm run typecheck
```

Erwartet: keine Fehler (raw-SQL-Imports sind type-safe via `?raw`).

- [ ] **Step 4: Commit**

```bash
git add src/main/db/migrations/012-status-reduction-planned-steps-retry.sql src/main/db/migrations/index.ts
git commit -m "feat(db): migration 012 — status reduction + plannedSteps + retryCount"
```

---

### Task A.2: Migration-Test schreiben

**Files:**
- Create: `src/main/db/migrations/__tests__/012-status-reduction.test.ts`

- [ ] **Step 1: Failing test schreiben — vier Szenarien**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../index'

function migrateUpTo(db: Database.Database, version: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  const current = (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {v: number | null})?.v ?? 0
  for (const m of migrations.filter(m => m.version > current && m.version <= version)) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
}

describe('Migration 012 — status reduction + plannedSteps + retryCount', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrateUpTo(db, 11) // baseline before our migration
  })

  it('collapses legacy in-progress status values to processing', () => {
    // Pre-seed legacy sessions
    const stmt = db.prepare(`INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    const now = new Date().toISOString()
    stmt.run('s1', 't', 'audio', 'transcribing', now, now)
    stmt.run('s2', 't', 'audio', 'diarizing', now, now)
    stmt.run('s3', 't', 'pdf', 'extracting', now, now)
    stmt.run('s4', 't', 'pdf', 'anonymizing', now, now)
    stmt.run('s5', 't', 'audio', 'review', now, now)
    stmt.run('s6', 't', 'audio', 'error', now, now)
    stmt.run('s7', 't', 'audio', 'recording', now, now)

    migrateUpTo(db, 12)

    const rows = db.prepare(`SELECT id, status FROM sessions ORDER BY id`).all() as {id: string, status: string}[]
    expect(rows).toEqual([
      { id: 's1', status: 'processing' },
      { id: 's2', status: 'processing' },
      { id: 's3', status: 'processing' },
      { id: 's4', status: 'processing' },
      { id: 's5', status: 'review' },
      { id: 's6', status: 'error' },
      { id: 's7', status: 'recording' }
    ])
  })

  it('adds planned_steps column with backfilled defaults for in-progress sessions', () => {
    db.prepare(`INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('audio1', 't', 'audio', 'transcribing', new Date().toISOString(), new Date().toISOString())
    db.prepare(`INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('pdf1', 't', 'pdf', 'extracting', new Date().toISOString(), new Date().toISOString())
    db.prepare(`INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('done1', 't', 'audio', 'review', new Date().toISOString(), new Date().toISOString())

    migrateUpTo(db, 12)

    const rows = db.prepare(`SELECT id, planned_steps FROM sessions ORDER BY id`).all() as {id: string, planned_steps: string | null}[]
    const byId = Object.fromEntries(rows.map(r => [r.id, r.planned_steps]))
    expect(JSON.parse(byId['audio1']!)).toEqual(['diarization','transcription','alignment','anonymization'])
    expect(JSON.parse(byId['pdf1']!)).toEqual(['extraction','anonymization'])
    expect(byId['done1']).toBeNull() // already-finished sessions stay NULL
  })

  it('adds retry_count column defaulted to 0', () => {
    db.prepare(`INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('s1', 't', 'audio', 'review', new Date().toISOString(), new Date().toISOString())

    migrateUpTo(db, 12)

    const row = db.prepare(`SELECT retry_count FROM sessions WHERE id = 's1'`).get() as {retry_count: number}
    expect(row.retry_count).toBe(0)
  })

  it('is idempotent across re-runs (no-op when already at version 12)', () => {
    migrateUpTo(db, 12)
    expect(() => migrateUpTo(db, 12)).not.toThrow()
  })
})
```

- [ ] **Step 2: Test laufen lassen, scheitern sehen**

```bash
vitest run src/main/db/migrations/__tests__/012-status-reduction.test.ts
```

Erwartet: drei Tests scheitern (Migration 012 ist registriert + tut bereits, was die Tests prüfen — aber ohne Test-Helper für `migrateUpTo` werden alle Tests rot mit `migrations is undefined` o.ä.). Wenn Tests grün sind: Migration funktioniert wie spezifiziert.

- [ ] **Step 3: Commit**

```bash
git add src/main/db/migrations/__tests__/012-status-reduction.test.ts
git commit -m "test(db): migration 012 — status reduction + plannedSteps + retryCount"
```

---

### Task A.3: Manueller Smoke-Test der Migration auf User-DB

- [ ] **Step 1: User-DB sichern (NICHT überschreiben — Sicherheitskopie)**

```bash
cp ~/.therascript/database.sqlite ~/.therascript/database.sqlite.pre-migration-012.bak
ls -la ~/.therascript/database.sqlite*
```

- [ ] **Step 2: App im Dev-Modus starten — Migration läuft beim DB-Init**

```bash
npm run dev
```

App muss starten, ohne Migration-Fehler im Hauptprozess-Log. Falls Fehler: App stoppen, DB aus Backup wiederherstellen, Migration-SQL fixen.

- [ ] **Step 3: Schema verifizieren**

```bash
sqlite3 ~/.therascript/database.sqlite "PRAGMA table_info(sessions);" | grep -E "planned_steps|retry_count"
```

Erwartet:
```
xx|planned_steps|TEXT|0||0
yy|retry_count|INTEGER|1|0|0
```

- [ ] **Step 4: Status-Werte stichprobenartig prüfen**

```bash
sqlite3 ~/.therascript/database.sqlite "SELECT status, COUNT(*) FROM sessions GROUP BY status;"
```

Erwartet: nur Werte aus `recording | queued | processing | review | error`. Kein `transcribing/diarizing/extracting/anonymizing` mehr.

Kein Commit für diesen Task — Smoke-Test ist Verifikation, nicht Code.

---

### Task A.4: Falls Smoke-Test fehlschlägt — Rollback-Pfad dokumentieren

- [ ] **Step 1: Rollback-Notiz im Plan lassen (kein Code-Änderung)**

Falls A.3 fehlschlägt, ist der Rollback:

```bash
# 1. App stoppen
# 2. DB aus Backup zurückspielen
mv ~/.therascript/database.sqlite ~/.therascript/database.sqlite.broken
mv ~/.therascript/database.sqlite.pre-migration-012.bak ~/.therascript/database.sqlite
# 3. Migration-Versionstabelle prüfen (sollte ohne Version 12 zurückgespielt sein)
sqlite3 ~/.therascript/database.sqlite "SELECT * FROM schema_version;"
# 4. Migration-SQL in 012-...sql fixen, Test-Suite anpassen, A.1-A.3 wiederholen
```

Kein Commit. Diese Notiz dient nur als Reminder im Plan.

---

## Phase B: Backend `SessionStatus` reduzieren

### Task B.1: `SessionStatus`-Typ schrumpfen + `queued` aufnehmen

**Files:**
- Modify: `src/shared/types/Session.ts:5-12`

- [ ] **Step 1: Typ in der shared types-Datei auf 5 Werte reduzieren**

```typescript
// src/shared/types/Session.ts:5-12 — ersetzen durch:
export type SessionStatus =
  | 'recording'
  | 'queued'
  | 'processing'
  | 'review'
  | 'error'
```

- [ ] **Step 2: TypeCheck — wir wollen jetzt überall die Compile-Errors sehen**

```bash
npm run typecheck 2>&1 | tee /tmp/post-status-shrink-errors.txt
```

Erwartet: zahlreiche TS-Fehler in `SessionService.ts`, `TaskQueueService.ts`, `SessionRepository.ts`, `SessionCard.tsx`, `SessionDashboard.tsx`, `recording-handlers.ts`. Diese sind die Roadmap für die nächsten Tasks dieser Phase.

- [ ] **Step 3: Commit (NICHT pushen — Build ist intentional gebrochen)**

```bash
git add src/shared/types/Session.ts
git commit -m "refactor(session): reduce SessionStatus to 5 values (queued instead of legacy in-progress states)"
```

---

### Task B.2: `SessionService` `VALID_TRANSITIONS` und Helpers anpassen

**Files:**
- Modify: `src/main/services/SessionService.ts:13-20,34,229-234,240`

- [ ] **Step 1: `VALID_TRANSITIONS` neu definieren**

```typescript
// src/main/services/SessionService.ts:13-20 — ersetzen durch:
const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  recording: ['queued', 'error'],
  queued: ['processing', 'error'],
  // processing → processing is legitimate (advancing through tasks while keeping the same status)
  processing: ['processing', 'review', 'error'],
  review: [],
  // From error, retry pushes back to queued (re-enters the queue) or recording for re-record
  error: ['recording', 'queued']
}
```

- [ ] **Step 2: Initial-Status für neue Sessions umstellen**

```typescript
// src/main/services/SessionService.ts:34 — ersetzen:
status: type === 'audio' ? 'recording' : 'queued',
// (PDFs gehen direkt nach 'queued' — kein 'extracting' mehr)
```

- [ ] **Step 3: `processingStatuses`-Konstante reduzieren**

```typescript
// src/main/services/SessionService.ts:229-234 — komplett ersetzen durch:
// Status considered "in active processing" — used for queue/orphan recovery filters.
const processingStatuses: SessionStatus[] = ['processing']
```

- [ ] **Step 4: Self-transition-Erlaubnis prüfen**

`isValidTransition()` in Zeile 240 wird durch `VALID_TRANSITIONS['processing'].includes('processing') === true` korrekt.

- [ ] **Step 5: TypeCheck**

```bash
npm run typecheck 2>&1 | grep -E "SessionService" | head -10
```

Erwartet: keine Fehler in `SessionService.ts` mehr.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/SessionService.ts
git commit -m "refactor(session): adapt VALID_TRANSITIONS to reduced status model"
```

---

### Task B.3: `SessionRepository` — `planned_steps` und `retry_count` mappen

**Files:**
- Modify: `src/main/db/repositories/SessionRepository.ts`
- Modify: `src/shared/types/Session.ts`

- [ ] **Step 1: `Session`-Interface erweitern**

```typescript
// src/shared/types/Session.ts:14-35 — füge nach `summarizedAt` hinzu:
  plannedSteps: TaskType[] | null
  retryCount: number
```

Import oben in der Datei sicherstellen:
```typescript
import type { TaskType } from './Task'
```

- [ ] **Step 2: `UpdateSessionInput` ebenfalls erweitern**

```typescript
// src/shared/types/Session.ts:45-62 — füge hinzu:
  plannedSteps?: TaskType[] | null
  retryCount?: number
```

- [ ] **Step 3: `SessionRow` und `rowToSession` mappen**

```typescript
// src/main/db/repositories/SessionRepository.ts — SessionRow erweitern:
  planned_steps: string | null  // JSON-encoded TaskType[]
  retry_count: number
```

```typescript
// rowToSession: füge nach `summarizedAt: row.summarized_at` ein:
    plannedSteps: row.planned_steps ? JSON.parse(row.planned_steps) as TaskType[] : null,
    retryCount: row.retry_count
```

- [ ] **Step 4: `update()`-Branche für die zwei Felder**

In `SessionRepository.update()`, im Set-Building-Block (nach den existierenden `if (input.summary !== undefined)` etc.):

```typescript
    if (input.plannedSteps !== undefined) {
      sets.push('planned_steps = ?')
      values.push(input.plannedSteps ? JSON.stringify(input.plannedSteps) : null)
    }
    if (input.retryCount !== undefined) {
      sets.push('retry_count = ?')
      values.push(input.retryCount)
    }
```

- [ ] **Step 5: Default-Status im `create()` anpassen**

```typescript
// src/main/db/repositories/SessionRepository.ts:76 — ersetzen:
const status = input.status ?? (input.type === 'audio' ? 'recording' : 'queued')
```

- [ ] **Step 6: TypeCheck**

```bash
npm run typecheck 2>&1 | grep -E "SessionRepository|Session\.ts" | head -10
```

Erwartet: keine Fehler in den geänderten Dateien.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/Session.ts src/main/db/repositories/SessionRepository.ts
git commit -m "feat(session): plannedSteps + retryCount fields in repository + types"
```

---

### Task B.4: Repository-Test für die neuen Felder

**Files:**
- Modify: `src/main/db/repositories/__tests__/SessionRepository.test.ts` (anlegen falls nicht existent)

- [ ] **Step 1: Test schreiben**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../../migrations'
import { SessionRepository } from '../SessionRepository'

function setupDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  for (const m of migrations) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
  return db
}

describe('SessionRepository plannedSteps + retryCount', () => {
  let db: Database.Database
  let repo: SessionRepository

  beforeEach(() => {
    db = setupDb()
    repo = new SessionRepository(db)
  })

  it('initialises plannedSteps as null and retryCount as 0', () => {
    const s = repo.create({ title: 't', type: 'audio' })
    expect(s.plannedSteps).toBeNull()
    expect(s.retryCount).toBe(0)
  })

  it('persists plannedSteps as JSON array', () => {
    const s = repo.create({ title: 't', type: 'audio' })
    repo.update(s.id, { plannedSteps: ['diarization', 'transcription', 'alignment', 'anonymization'] })
    const reloaded = repo.findById(s.id)
    expect(reloaded?.plannedSteps).toEqual(['diarization', 'transcription', 'alignment', 'anonymization'])
  })

  it('clears plannedSteps when set to null', () => {
    const s = repo.create({ title: 't', type: 'audio' })
    repo.update(s.id, { plannedSteps: ['diarization'] })
    repo.update(s.id, { plannedSteps: null })
    expect(repo.findById(s.id)?.plannedSteps).toBeNull()
  })

  it('increments retryCount across updates', () => {
    const s = repo.create({ title: 't', type: 'audio' })
    repo.update(s.id, { retryCount: 1 })
    expect(repo.findById(s.id)?.retryCount).toBe(1)
    repo.update(s.id, { retryCount: 2 })
    expect(repo.findById(s.id)?.retryCount).toBe(2)
  })

  it('defaults pdf sessions to queued status', () => {
    const s = repo.create({ title: 't', type: 'pdf' })
    expect(s.status).toBe('queued')
  })

  it('defaults audio sessions to recording status', () => {
    const s = repo.create({ title: 't', type: 'audio' })
    expect(s.status).toBe('recording')
  })
})
```

- [ ] **Step 2: Tests ausführen**

```bash
vitest run src/main/db/repositories/__tests__/SessionRepository.test.ts
```

Erwartet: alle 6 Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/main/db/repositories/__tests__/SessionRepository.test.ts
git commit -m "test(session): plannedSteps + retryCount persistence"
```

---

### Task B.5: `recording-handlers.ts` und andere Setter umstellen

**Files:**
- Modify: `src/main/ipc/recording-handlers.ts:74`
- Modify: `src/main/db/repositories/SessionRepository.ts:76` (war schon in B.3 angefasst)
- Modify: alle weiteren Stellen aus Audit Step 2

- [ ] **Step 1: Audit erneut laufen, dann erste Stelle anpassen**

```bash
./scripts/audit-status-callsites.sh
```

In `src/main/ipc/recording-handlers.ts:74`:

```typescript
// alt:
service.updateSession(sessionId, { status: 'diarizing' })
// neu:
service.updateSession(sessionId, { status: 'queued' })
```

Begründung: nach Stop der Aufnahme geht die Session in die Queue, nicht direkt in einen Pipeline-Schritt. `TaskQueueService` setzt sie auf `processing`, sobald der erste Task startet (Phase C).

- [ ] **Step 2: TypeCheck — alle weiteren Treffer reparieren**

```bash
npm run typecheck 2>&1 | grep -E "(transcribing|diarizing|extracting|anonymizing)" | head -20
```

Jeden Treffer einzeln anschauen und auf `'queued'` (vor Pipeline-Start) oder `'processing'` (während Pipeline) umstellen. Erwartete Restmenge nach diesem Step: nur noch in `TaskQueueService.ts` (folgt Phase C).

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/recording-handlers.ts
git commit -m "refactor(recording): post-stop status is queued (was diarizing)"
```

---

## Phase C: TaskQueueService refactor

### Task C.1: `TASK_TO_SESSION_STATUS`-Map und `getSessionStatusForTask` entfernen

**Files:**
- Modify: `src/main/services/TaskQueueService.ts:14-25,335-382`

- [ ] **Step 1: `TASK_TO_SESSION_STATUS`-Konstante komplett entfernen**

Block in den Zeilen 14-25 löschen. Imports prüfen — falls `SessionStatus` oder `TaskType` nur dafür genutzt wurden, Import-Zeilen aufräumen.

- [ ] **Step 2: `getSessionStatusForTask`-Methode entfernen**

Block in den Zeilen 369-382 löschen.

- [ ] **Step 3: `handleTaskCompletion` umschreiben**

```typescript
// src/main/services/TaskQueueService.ts:334-367 — komplett ersetzen durch:
private handleTaskCompletion(task: Task): void {
  const remainingTasks = this.repository.findBySession(task.sessionId)
  const pendingOrRunning = remainingTasks.filter(
    (t) => t.status === 'pending' || t.status === 'running'
  )

  if (pendingOrRunning.length === 0) {
    // All tasks done — set final status
    try {
      this.sessionService.updateSession(task.sessionId, { status: 'review' })
    } catch (err) {
      console.error(`[TaskQueue] Failed to transition session ${task.sessionId} to review:`, err)
    }
  }
  // While tasks remain pending, the session stays in 'processing'.
  // The actual current step is conveyed via task:started IPC events (Phase D).
}
```

- [ ] **Step 4: Initial-Status-Setter in `enqueue()` umstellen**

```typescript
// src/main/services/TaskQueueService.ts:93-94 — ersetzen:
this.sessionService.updateSession(sessionId, {
  status: 'queued'
})
```

`firstStatus`-Variable entfernen — Status hängt nicht mehr vom ersten Task-Typ ab.

- [ ] **Step 5: Orphan-Recovery-Filter aktualisieren**

```typescript
// src/main/services/TaskQueueService.ts:148-153 — ersetzen:
const stuckSessions = this.sessionService.list().filter(
  (s) => s.status === 'processing' || s.status === 'queued'
)
```

- [ ] **Step 6: TypeCheck**

```bash
npm run typecheck 2>&1 | grep -E "TaskQueueService" | head -10
```

Erwartet: keine Fehler.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/TaskQueueService.ts
git commit -m "refactor(taskqueue): remove TASK_TO_SESSION_STATUS map — tasks[] is SOT"
```

---

### Task C.2: Status-Übergang `queued → processing` beim ersten Task-Start

**Files:**
- Modify: `src/main/services/TaskQueueService.ts:236-240`

- [ ] **Step 1: Vor Marking eines Tasks als running, Session-Status auf processing heben**

```typescript
// src/main/services/TaskQueueService.ts:237-240 — vor `repository.update(task.id, …)` einfügen:
const session = this.sessionService.getSession(task.sessionId)
if (session && session.status === 'queued') {
  try {
    this.sessionService.updateSession(task.sessionId, { status: 'processing' })
  } catch (err) {
    console.error(`[TaskQueue] Failed to transition session to processing:`, err)
  }
}
```

- [ ] **Step 2: Test schreiben — neue Sessions wandern queued → processing → review**

```typescript
// src/main/services/__tests__/TaskQueueService.statusFlow.test.ts (neu)
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../../db/migrations'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import { SessionService } from '../SessionService'
import { TaskQueueService } from '../TaskQueueService'
import type { Task } from '../../../shared/types'

function setupDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  for (const m of migrations) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
  return db
}

function makeStubExecutor() {
  return {
    execute: vi.fn(async (_task: Task, onProgress: (n: number) => void) => {
      onProgress(0.5)
      onProgress(1)
    })
  }
}

describe('TaskQueueService status lifecycle', () => {
  let db: Database.Database
  let sessions: SessionService
  let queue: TaskQueueService

  beforeEach(() => {
    db = setupDb()
    const sessionRepo = new SessionRepository(db)
    const taskRepo = new TaskRepository(db)
    sessions = new SessionService(sessionRepo, /* … other deps via factory … */)
    queue = new TaskQueueService(taskRepo, sessions, /* mocked activeModels */ {
      getActive: vi.fn().mockReturnValue(null)
    } as any, /* executors map */ {
      diarization: makeStubExecutor(),
      transcription: makeStubExecutor(),
      alignment: makeStubExecutor(),
      anonymization: makeStubExecutor()
    } as any)
  })

  it('moves session through queued → processing → review on happy path', async () => {
    const session = sessions.create({ title: 't', type: 'audio' })
    sessions.updateSession(session.id, { status: 'queued' })

    queue.enqueue(session.id, [
      { type: 'diarization', sessionId: session.id },
      { type: 'transcription', sessionId: session.id },
      { type: 'alignment', sessionId: session.id },
      { type: 'anonymization', sessionId: session.id }
    ])

    expect(sessions.getSession(session.id)?.status).toBe('queued')

    // Run the queue to completion (mock executors resolve immediately)
    await queue.drain()  // helper that awaits all pending tasks

    const final = sessions.getSession(session.id)
    expect(final?.status).toBe('review')
  })

  it('transitions queued → processing on first task start', async () => {
    const session = sessions.create({ title: 't', type: 'audio' })
    sessions.updateSession(session.id, { status: 'queued' })

    // Use a slow executor so we can observe the in-between state
    let resolveFirst: () => void
    const slowExec = {
      execute: vi.fn(async (_t: Task, onProgress: (n: number) => void) => {
        onProgress(0)
        await new Promise<void>((res) => { resolveFirst = res })
        onProgress(1)
      })
    }
    queue = new TaskQueueService(/* …, executors with diarization: slowExec */)

    queue.enqueue(session.id, [{ type: 'diarization', sessionId: session.id }])
    await new Promise((r) => setTimeout(r, 10))  // allow microtask chain to start the executor

    expect(sessions.getSession(session.id)?.status).toBe('processing')
    resolveFirst!()
    await queue.drain()
  })
})
```

Falls `queue.drain()` als Helper nicht existiert: in der bestehenden `TaskQueueService.test.ts` gibt es bereits ein `waitForCompletion(sessionId)`-Pattern; das verwenden.

- [ ] **Step 3: Tests laufen**

```bash
vitest run src/main/services/__tests__/TaskQueueService.statusFlow.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/main/services/TaskQueueService.ts src/main/services/__tests__/TaskQueueService.statusFlow.test.ts
git commit -m "feat(taskqueue): transition queued → processing on first task start"
```

---

### Task C.3: `plannedSteps` einfrieren beim queued → processing-Übergang

**Files:**
- Modify: `src/main/services/TaskQueueService.ts` — Erweiterung von Task C.2
- Modify: `src/main/services/ActiveModelsService.ts` (bestehend)

- [ ] **Step 1: Helper `computePlannedSteps()` in TaskQueueService anlegen — Pipeline-Reihenfolge aus shared/constants importieren**

CLAUDE.md-Regel (Whisper-Halluzinations-Sektion): *„Pipeline-Reihenfolge ist single-source-of-truth: backend (`TaskQueueService`) und frontend (`SessionCard`) importieren beide aus `src/shared/constants/pipeline.ts`; ein Snapshot-Test verhindert lokale Duplikate."*

Imports oben in `TaskQueueService.ts` ergänzen:

```typescript
import { AUDIO_PIPELINE, PDF_PIPELINE } from '../../shared/constants/pipeline'
```

Direkt nach `getAudioDurationSec()` einfügen:

```typescript
/**
 * Compute the planned (visible) pipeline steps for a session, frozen at queued → processing.
 * Pipeline order is sourced exclusively from src/shared/constants/pipeline.ts.
 * Conditional steps:
 *   - summarization: included iff a summarization model is currently active
 *   - ocr (PDF only): included iff PDF has scanned pages (read from session metadata
 *     populated at import time — see Phase G.1 for the import-side detection)
 */
private computePlannedSteps(sessionId: string): TaskType[] {
  const session = this.sessionService.getSession(sessionId)
  if (!session) return []

  const summarizationActive = this.activeModels.getActive('summarization') !== null

  if (session.type === 'audio') {
    // AUDIO_PIPELINE is ['diarization','transcription','alignment','anonymization','summarization']
    // We always show all four core steps; summarization only if active.
    return AUDIO_PIPELINE.filter((step) => step !== 'summarization' || summarizationActive)
  }

  // PDF: PDF_PIPELINE is ['extraction','ocr','anonymization','summarization']
  // OCR is included only if the import-time scanned-pages detection flagged it.
  const hasScannedPages = session.pdfHasScannedPages === true
  return PDF_PIPELINE.filter((step) => {
    if (step === 'ocr') return hasScannedPages
    if (step === 'summarization') return summarizationActive
    return true
  })
}
```

`session.pdfHasScannedPages` ist ein neues Feld, das Phase G.1 beim PDF-Import befüllt (siehe dort).

- [ ] **Step 2: `ActiveModelsService` injizieren**

```typescript
// Constructor-Args von TaskQueueService um activeModels: ActiveModelsService erweitern.
// In src/main/index.ts (Wiring) entsprechend mitgeben.
```

- [ ] **Step 3: `plannedSteps` beim ersten Task-Start setzen**

In dem Block aus C.2:

```typescript
const session = this.sessionService.getSession(task.sessionId)
if (session && session.status === 'queued') {
  const plannedSteps = this.computePlannedSteps(task.sessionId)
  try {
    this.sessionService.updateSession(task.sessionId, {
      status: 'processing',
      plannedSteps
    })
  } catch (err) {
    console.error(`[TaskQueue] Failed to transition session to processing:`, err)
  }
}
```

- [ ] **Step 4: Test erweitern**

```typescript
// In TaskQueueService.statusFlow.test.ts:
it('freezes plannedSteps at queued → processing transition', async () => {
  const session = sessions.create({ title: 't', type: 'audio' })
  sessions.updateSession(session.id, { status: 'queued' })
  // activeModels mock returns null for summarization (set in beforeEach)
  queue.enqueue(session.id, [{ type: 'diarization', sessionId: session.id }])
  await queue.drain()
  const final = sessions.getSession(session.id)
  expect(final?.plannedSteps).toEqual([
    'diarization', 'transcription', 'alignment', 'anonymization'
  ])
})

it('includes summarization in plannedSteps when model is active', async () => {
  const session = sessions.create({ title: 't', type: 'audio' })
  sessions.updateSession(session.id, { status: 'queued' })
  // Override activeModels mock for this test
  ;(queue as any).activeModels.getActive = vi.fn((group: string) =>
    group === 'summarization' ? 'gemma-3-4b-instruct-q4-k-m' : null
  )
  queue.enqueue(session.id, [{ type: 'diarization', sessionId: session.id }])
  await queue.drain()
  expect(sessions.getSession(session.id)?.plannedSteps).toEqual([
    'diarization', 'transcription', 'alignment', 'anonymization', 'summarization'
  ])
})

it('respects pdfHasScannedPages flag for PDF plannedSteps', async () => {
  const session = sessions.create({
    title: 't', type: 'pdf', pdfPath: '/tmp/test.pdf'
  })
  sessions.updateSession(session.id, {
    status: 'queued',
    pdfHasScannedPages: true
  })
  queue.enqueue(session.id, [{ type: 'extraction', sessionId: session.id }])
  await queue.drain()
  expect(sessions.getSession(session.id)?.plannedSteps).toContain('ocr')
})
```

- [ ] **Step 5: Commit**

```bash
git add src/main/services/TaskQueueService.ts src/main/services/__tests__/TaskQueueService.statusFlow.test.ts
git commit -m "feat(taskqueue): freeze plannedSteps at queued → processing"
```

---

### Task C.4: Delete-Pfad-Verifikation — `cancelPendingForSession` + Executor-Abort beim Session-Delete

**Files:**
- Read: `src/main/services/SessionService.ts` (delete-Methode)
- Modify: `src/main/services/SessionService.ts` (falls delete-Pfad keinen TaskQueue-Hook hat)
- Modify: `src/main/services/TaskQueueService.ts` (neue Methode `abortRunningForSession()`)

- [ ] **Step 1: `abortRunningForSession()` in TaskQueueService**

Aktuell hält `executeTask()` einen lokalen `controller: AbortController`. Wir müssen ihn beim Session-Delete von außen erreichen können.

Neue Klassen-Property:
```typescript
private runningController: { sessionId: string; controller: AbortController } | null = null
```

In `executeTask()` direkt nach `const controller = new AbortController()`:
```typescript
this.runningController = { sessionId: task.sessionId, controller }
```

Im `finally`-Block:
```typescript
this.runningController = null
```

Neue öffentliche Methode:
```typescript
abortRunningForSession(sessionId: string): void {
  if (this.runningController?.sessionId === sessionId) {
    this.runningController.controller.abort()
  }
  const cancelled = this.repository.cancelPendingForSession(sessionId)
  if (cancelled > 0) {
    console.log(`[TaskQueue] Cancelled ${cancelled} pending tasks for deleted session ${sessionId}`)
  }
}
```

- [ ] **Step 2: SessionService.delete() ruft `abortRunningForSession()` vor DB-Delete**

```typescript
// In SessionService.delete():
this.taskQueue.abortRunningForSession(id)
// existing: file cleanup + repo.delete()
```

`taskQueue` muss in `SessionService` injiziert werden — wenn die Wiring-Reihenfolge das nicht erlaubt (zyklische Abhängigkeit), via Setter-Injection nachträglich.

- [ ] **Step 3: Tests für die vier DR-6-Verifikations-Punkte schreiben**

DR-6 (Architektur-Review) verlangt vier Verifikationen am Delete-Pfad: (a) AbortController-Propagation, (b) pending-Tasks-Cleanup, (c) Artefakt-Cleanup, (d) No-op-Toleranz im Executor nach Abort.

```typescript
// src/main/services/__tests__/SessionService.deletePath.test.ts (neu)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionService } from '../SessionService'
import { TaskQueueService } from '../TaskQueueService'
import { existsSync } from 'node:fs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SessionService.delete — DR-6 verification', () => {
  let svc: SessionService
  let queue: TaskQueueService
  let abortSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Set up an in-memory DB + real SessionService + real TaskQueueService
    // (re-use existing test factory helpers from SessionService.test.ts)
    svc = makeSessionService()
    queue = makeTaskQueue(svc)
    svc.setTaskQueue(queue) // setter injection per C.4 Step 2
    abortSpy = vi.spyOn(queue, 'abortRunningForSession')
  })

  // (a) AbortController-Propagation
  it('aborts running task BEFORE repo.delete when session is processing', () => {
    const s = svc.create({ title: 't', type: 'audio' })
    svc.updateSession(s.id, { status: 'processing' })
    queue.enqueue(s.id, [{ type: 'transcription', /* … */ }])
    // Wait for executeTask to register runningController (mocked executor blocks)
    svc.delete(s.id)
    expect(abortSpy).toHaveBeenCalledWith(s.id)
    expect(abortSpy.mock.invocationCallOrder[0]).toBeLessThan(
      // delete order: abort < repo.delete
      vi.spyOn(svc as any, 'repository').mock.invocationCallOrder[0] ?? Infinity
    )
  })

  // (b) Pending-tasks-Cleanup
  it('cancels pending tasks when deleting a queued session', () => {
    const s = svc.create({ title: 't', type: 'audio' })
    svc.updateSession(s.id, { status: 'queued' })
    queue.enqueue(s.id, [
      { type: 'diarization' }, { type: 'transcription' }, { type: 'anonymization' }
    ])
    expect(queue.getRepository().findBySession(s.id).length).toBeGreaterThan(0)
    svc.delete(s.id)
    expect(queue.getRepository().findBySession(s.id).length).toBe(0)
  })

  // (c) Artefakt-Cleanup
  it('removes partial pipeline artefacts on delete', () => {
    const s = svc.create({ title: 't', type: 'audio' })
    // Simulate partial artefacts written by mid-pipeline executor
    const dir = join(tmpdir(), 'therascript-test', s.id)
    mkdirSync(dir, { recursive: true })
    const rttm = join(dir, 'diarization.rttm')
    const wav = join(dir, 'stitched.wav')
    const stitch = join(dir, 'stitch-map.json')
    writeFileSync(rttm, 'mock')
    writeFileSync(wav, 'mock')
    writeFileSync(stitch, '{}')
    svc.updateSession(s.id, {
      status: 'processing',
      diarizationPath: rttm,
      // (gestitchte WAV + StitchMap leben in den eigenen session-internen Pfaden — Pfade hier nur für den Test)
    })
    svc.delete(s.id)
    expect(existsSync(rttm)).toBe(false)
    expect(existsSync(wav)).toBe(false)
    expect(existsSync(stitch)).toBe(false)
  })

  // (d) No-op-Toleranz im Executor nach Abort
  it('does not crash when executor calls repository.update on a deleted session', async () => {
    const s = svc.create({ title: 't', type: 'audio' })
    svc.updateSession(s.id, { status: 'processing' })
    const task = queue.enqueueOne(s.id, 'transcription')
    svc.delete(s.id)
    // Simulate an in-flight progress emit AFTER deletion
    expect(() => {
      queue.getRepository().update(task.id, { progress: 0.5 })
    }).not.toThrow()
    // Repository.update should silently no-op when row is gone (existing behaviour);
    // this test locks that contract.
  })
})
```

Anmerkungen zur Test-Implementierung:
- `makeSessionService()` und `makeTaskQueue()` sind Test-Factory-Helper, die in `SessionService.test.ts` bereits existieren — wiederverwenden.
- Falls (c) heute nicht implementiert ist (Artefakt-Cleanup beim Delete fehlt), markiert der Test eine Lücke, die in Step 4 (oder einem Follow-up-Task) gefixt wird.
- (d) prüft, dass `SessionRepository.update()` für nicht-existente IDs no-op-fähig ist — dieses Verhalten existiert heute bereits via `if (!this.findById(id)) return null` in der Repo-Methode (siehe `SessionRepository.ts:112`); Test sperrt es als Vertrag.

- [ ] **Step 4: Falls Artefakt-Cleanup heute fehlt: ergänzen**

```typescript
// In SessionService.delete():
const session = this.repository.findById(id)
if (session) {
  // Existing cleanup paths (audioPath, transcriptPath, anonymizedPath, …)
  // Plus artifact paths added during pipeline:
  for (const path of [session.diarizationPath, session.alignedTranscriptPath, session.extractedPath]) {
    if (path && existsSync(path)) {
      try { unlinkSync(path) } catch (e) { console.warn(`[SessionService] failed to unlink ${path}:`, e) }
    }
  }
  // Plus the session-internal directory if it exists (StitchMap etc.):
  // Path convention: ~/.therascript/sessions/<sessionId>/
}
```

Falls die Cleanup-Logik heute schon vollständig ist: Step 4 entfällt, Test (c) sollte direkt grün sein.

- [ ] **Step 5: Manueller Smoke-Test**

```bash
npm run dev
```

Im UI: Session aufnehmen, in der Pipeline anlangen lassen, Trash-Button drücken. Erwartet: Karte verschwindet sofort, kein Zombie-Whisper-Subprocess (`ps aux | grep whisper-cli` → leer kurz darauf).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/TaskQueueService.ts src/main/services/SessionService.ts src/main/services/__tests__/
git commit -m "feat(taskqueue): abortRunningForSession + delete-path verification (DR-6)"
```

---

## Phase D: IPC-Schema erweitern

### Task D.1: `task:started` und `queue:positions` Channel-Definition

**Files:**
- Modify: `src/shared/types/IpcApi.ts:33-56`
- Modify: `src/shared/validation/` (Zod-Schema falls existent)

- [ ] **Step 1: Neue Payload-Types definieren**

```typescript
// src/shared/types/IpcApi.ts — nach TaskProgressData hinzufügen:
export interface TaskStartedData {
  sessionId: string
  taskType: TaskType
  stepIndex: number      // 1-based position in plannedSteps
  totalSteps: number     // length of plannedSteps
  plannedDurationSec: number | null  // estimator output, null until calibrated
}

export interface QueuePositionsData {
  positions: Record<string, number>  // sessionId → 1-based position; missing keys = not queued
}
```

- [ ] **Step 2: `TaskProgressData` um `etaSecondsTotal` erweitern**

```typescript
export interface TaskProgressData {
  sessionId: string
  taskType: TaskType
  progress: number
  etaSecondsTotal: number | null  // total session ETA, null until calibrated
}
```

- [ ] **Step 3: Zod-Schemas für die neuen Channels — obligatorisch**

CLAUDE.md (Architecture-Sektion) ist explizit: *„All IPC channels use Zod schema validation (schemas in `src/shared/validation/`)."* Das ist keine optionale Empfehlung, sondern eine harte Anforderung.

Existierende Validation-Dateien suchen:

```bash
ls src/shared/validation/
```

Erwartet: bereits existierende Datei für Task-IPC-Schemas (z. B. `task-ipc.ts` oder ähnlich). Die folgenden drei Schemas dort ergänzen (Speicherort an die bestehende Datei-Konvention anpassen):

```typescript
// In der existierenden Task-IPC-Validation-Datei oder neu unter
// src/shared/validation/task-ipc.ts:
import { z } from 'zod'

export const taskTypeSchema = z.enum([
  'diarization', 'transcription', 'alignment',
  'extraction', 'ocr', 'anonymization', 'summarization'
])

export const taskProgressSchema = z.object({
  sessionId: z.string().uuid(),
  taskType: taskTypeSchema,
  progress: z.number().min(0).max(1),
  etaSecondsTotal: z.number().nonnegative().nullable()
})

export const taskStartedSchema = z.object({
  sessionId: z.string().uuid(),
  taskType: taskTypeSchema,
  stepIndex: z.number().int().min(0),       // 0 if task not in plannedSteps
  totalSteps: z.number().int().min(0),
  plannedDurationSec: z.number().positive().nullable()
})

export const queuePositionsSchema = z.object({
  positions: z.record(z.string().uuid(), z.number().int().positive())
})

// Type exports remain authoritative in src/shared/types/IpcApi.ts;
// these schemas are runtime guards for the boundary.
```

Im Renderer-/Preload-Bereich bei jedem `ipcRenderer.on(...)`-Handler die Payload via `.parse()` validieren:

```typescript
// In preload/index.ts (Erweiterung von D.2):
onStarted: (callback) => {
  const handler = (_event, raw) => {
    const data = taskStartedSchema.parse(raw)  // throws on invalid main-process payload
    callback(data)
  }
  // ...
}
```

Falls Zod-Validation aktuell **nicht** existiert (Datei nicht da): trotzdem anlegen — CLAUDE.md macht keine Ausnahme für „nicht implementiert". In dem Fall ist dieser Step deutlich grösser; dann entweder einen Spike-Task „Zod-Validation für bestehende Task-IPC nachrüsten" voranstellen oder die Validation für die drei neuen Channels isoliert einführen und bestehende Channels in einem Follow-up nachziehen.

- [ ] **Step 4: TypeCheck**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/IpcApi.ts src/shared/validation/
git commit -m "feat(ipc): TaskStartedData + QueuePositionsData payload types"
```

---

### Task D.2: Preload — neue IPC-Channels exposen

**Files:**
- Modify: `src/preload/index.ts:54-82`

- [ ] **Step 1: `tasks.onStarted` und `tasks.onQueuePositions` hinzufügen**

```typescript
// In src/preload/index.ts, im tasks-Block nach onError:
    onStarted: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TaskStartedData): void =>
        callback(data)
      ipcRenderer.on('task:started', handler)
      return () => {
        ipcRenderer.removeListener('task:started', handler)
      }
    },
    onQueuePositions: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: QueuePositionsData): void =>
        callback(data)
      ipcRenderer.on('queue:positions', handler)
      return () => {
        ipcRenderer.removeListener('queue:positions', handler)
      }
    }
```

Imports oben ergänzen:
```typescript
import type { TaskStartedData, QueuePositionsData } from '../shared/types/IpcApi'
```

- [ ] **Step 2: `WindowApi`-Interface erweitern**

In `src/preload/api.d.ts` (oder wo das Interface lebt):

```typescript
tasks: {
  // existing fields...
  onStarted: (callback: (data: TaskStartedData) => void) => () => void
  onQueuePositions: (callback: (data: QueuePositionsData) => void) => () => void
}
```

- [ ] **Step 3: TypeCheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/api.d.ts
git commit -m "feat(preload): expose task:started + queue:positions channels"
```

---

### Task D.3: Backend emittiert `task:started` beim Task-Start

**Files:**
- Modify: `src/main/services/TaskQueueService.ts` — Erweiterung der `executeTask()`

- [ ] **Step 1: Event-Emission direkt vor `executor.execute()` — ohne Estimator-Referenz**

Direkt nach `watchdog.start()` und vor dem `try`-Block. **Wichtig:** Phase I (Telemetrie + Estimator) wird erst später eingeführt. D.3 darf weder `this.estimator` noch sonstige nicht-existente Member referenzieren — Phase I.4 ersetzt die `null`-Werte durch echte Estimator-Aufrufe.

```typescript
// Compute step index + total steps from plannedSteps (Phase A/B/C have set this up)
const session = this.sessionService.getSession(task.sessionId)
const plannedSteps = session?.plannedSteps ?? []
const stepIndex = plannedSteps.indexOf(task.type) + 1  // 1-based; 0 if task not in plannedSteps
const totalSteps = plannedSteps.length

sendToRenderer('task:started', {
  sessionId: task.sessionId,
  taskType: task.type,
  stepIndex,
  totalSteps,
  plannedDurationSec: null  // wired up in Phase I.4
})
```

- [ ] **Step 2: `task:progress`-Emission um `etaSecondsTotal: null` erweitern**

```typescript
const onProgress = (progress: number): void => {
  watchdog.heartbeat()
  this.repository.update(task.id, { progress })
  sendToRenderer('task:progress', {
    sessionId: task.sessionId,
    taskType: task.type,
    progress,
    etaSecondsTotal: null  // wired up in Phase I.4
  })
}
```

Begründung: D liefert das IPC-Schema mit korrekten Typen (`number | null`); Phase I.4 ersetzt `null` durch echte Werte. Damit kompiliert D unabhängig von I, und die Test-Suite zwischen D und I läuft sauber durch.

- [ ] **Step 3: TypeCheck + bestehende Tests laufen**

```bash
npm run typecheck
vitest run src/main/services/__tests__/TaskQueueService
```

Erwartet: alle Tests grün.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/TaskQueueService.ts
git commit -m "feat(taskqueue): emit task:started + etaSecondsTotal in task:progress"
```

---

### Task D.4: Backend emittiert `queue:positions` bei Queue-Mutation

**Files:**
- Modify: `src/main/services/TaskQueueService.ts`

- [ ] **Step 1: Helper `broadcastQueuePositions()`**

```typescript
private broadcastQueuePositions(): void {
  const queued = this.sessionService.list().filter((s) => s.status === 'queued')
  // Order by createdAt to derive stable position
  queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const positions: Record<string, number> = {}
  queued.forEach((s, idx) => {
    positions[s.id] = idx + 1
  })
  sendToRenderer('queue:positions', { positions })
}
```

- [ ] **Step 2: `broadcastQueuePositions()` an Mutation-Punkten aufrufen**

Drei Stellen:
1. Am Ende von `enqueue()` (nach `scheduleNext()`)
2. Im `executeTask()`-`finally`-Block (Task hat fertig, nächster startet ggf.)
3. In `abortRunningForSession()` (Session entfernt → Positionen verschieben)

- [ ] **Step 3: Test**

```typescript
// src/main/services/__tests__/TaskQueueService.queuePositions.test.ts (neu)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as ipc from '../../ipc/sendToRenderer'
// (use existing setupDb + service factories from statusFlow.test.ts)

describe('TaskQueueService queue:positions broadcast', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>
  let sessions: SessionService
  let queue: TaskQueueService

  beforeEach(() => {
    sendSpy = vi.spyOn(ipc, 'sendToRenderer')
    // ...factory setup as in statusFlow.test.ts
  })

  function lastQueueBroadcast(): Record<string, number> | null {
    const calls = sendSpy.mock.calls.filter((c) => c[0] === 'queue:positions')
    if (calls.length === 0) return null
    return (calls[calls.length - 1][1] as { positions: Record<string, number> }).positions
  }

  it('broadcasts positions when sessions enter the queue', async () => {
    const s1 = sessions.create({ title: '1', type: 'audio' })
    const s2 = sessions.create({ title: '2', type: 'audio' })
    const s3 = sessions.create({ title: '3', type: 'audio' })
    for (const s of [s1, s2, s3]) {
      sessions.updateSession(s.id, { status: 'queued' })
      queue.enqueue(s.id, [{ type: 'diarization', sessionId: s.id }])
    }
    const positions = lastQueueBroadcast()
    expect(positions).not.toBeNull()
    // s1 is processing (slot taken), s2 + s3 are queued at positions 1 and 2
    expect(positions![s2.id]).toBe(1)
    expect(positions![s3.id]).toBe(2)
  })

  it('broadcasts updated positions when running task completes', async () => {
    // Arrange: 3 sessions enqueued, then drain one
    // Assert: position broadcast emits 2 entries with new positions 1, 2
    // (concrete arrangement omitted — same factory pattern as above)
  })

  it('broadcasts shrunken positions when a queued session is deleted', async () => {
    const s1 = sessions.create({ title: '1', type: 'audio' })
    const s2 = sessions.create({ title: '2', type: 'audio' })
    sessions.updateSession(s1.id, { status: 'queued' })
    sessions.updateSession(s2.id, { status: 'queued' })
    queue.enqueue(s1.id, [{ type: 'diarization', sessionId: s1.id }])
    queue.enqueue(s2.id, [{ type: 'diarization', sessionId: s2.id }])
    sendSpy.mockClear()
    sessions.delete(s1.id)
    const positions = lastQueueBroadcast()
    expect(positions).not.toBeNull()
    expect(positions![s1.id]).toBeUndefined()
    expect(positions![s2.id]).toBeDefined()
  })
})
```

- [ ] **Step 4: Commit**

```bash
git add src/main/services/TaskQueueService.ts src/main/services/__tests__/TaskQueueService.queuePositions.test.ts
git commit -m "feat(taskqueue): broadcast queue:positions on queue mutations"
```

---

## Phase E: `useTaskProgress`-Refactor

### Task E.1: Hook-Shape erweitern

**Files:**
- Modify: `src/renderer/src/hooks/useTaskProgress.ts`

- [ ] **Step 1: Neuer State-Shape**

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task, TaskType } from '../../../shared/types'

interface CurrentStepState {
  taskType: TaskType
  progress: number             // 0..1
  stepIndex: number            // 1-based, 0 if unknown
  totalSteps: number           // 0 if unknown
  etaSecondsTotal: number | null
  plannedDurationSec: number | null
  isTransitioning: boolean     // true between completed and next started, after 500ms
}

interface UseTaskProgressResult {
  tasks: Task[]
  loading: boolean
  current: CurrentStepState | null
  queuePosition: number | null
}
```

- [ ] **Step 2: Listener-Logik**

```typescript
export function useTaskProgress(sessionId: string | null): UseTaskProgressResult {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState<CurrentStepState | null>(null)
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setTasks([])
      setLoading(false)
      return
    }
    try {
      const result = await window.api.tasks.getSessionTasks(sessionId)
      setTasks(result)
    } catch {
      // best-effort
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onStarted((data) => {
      if (data.sessionId !== sessionId) return
      if (transitionTimer.current) clearTimeout(transitionTimer.current)
      setCurrent({
        taskType: data.taskType,
        progress: 0,
        stepIndex: data.stepIndex,
        totalSteps: data.totalSteps,
        etaSecondsTotal: null,
        plannedDurationSec: data.plannedDurationSec,
        isTransitioning: false
      })
    })
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onProgress((data) => {
      if (data.sessionId !== sessionId) return
      setCurrent((p) => p && p.taskType === data.taskType
        ? { ...p, progress: data.progress, etaSecondsTotal: data.etaSecondsTotal, isTransitioning: false }
        : p)
    })
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onCompleted((data) => {
      if (data.sessionId !== sessionId) return
      // Freeze at 100% — do not clear. Wait for task:started or 500ms timeout.
      setCurrent((p) => p && p.taskType === data.taskType ? { ...p, progress: 1 } : p)
      transitionTimer.current = setTimeout(() => {
        setCurrent((p) => p ? { ...p, isTransitioning: true } : null)
      }, 500)
      refresh()
    })
  }, [sessionId, refresh])

  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onError((data) => {
      if (data.sessionId !== sessionId) return
      if (transitionTimer.current) clearTimeout(transitionTimer.current)
      setCurrent(null)
      refresh()
    })
  }, [sessionId, refresh])

  useEffect(() => {
    if (!sessionId) return
    return window.api.tasks.onQueuePositions((data) => {
      setQueuePosition(data.positions[sessionId] ?? null)
    })
  }, [sessionId])

  useEffect(() => () => {
    if (transitionTimer.current) clearTimeout(transitionTimer.current)
  }, [])

  return { tasks, loading, current, queuePosition }
}
```

- [ ] **Step 3: TypeCheck**

```bash
npm run typecheck
```

Erwartet: Fehler in `SessionCard.tsx` weil das alte `currentProgress` nicht mehr existiert. Wird in Phase F gefixt.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/hooks/useTaskProgress.ts
git commit -m "refactor(progress): hook returns CurrentStepState + queuePosition"
```

---

### Task E.2: Hook-Tests

**Files:**
- Create: `src/renderer/src/hooks/__tests__/useTaskProgress.test.tsx`

- [ ] **Step 1: Test-Setup mit gemocktem `window.api.tasks`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTaskProgress } from '../useTaskProgress'

interface Listener<T> { (data: T): void }

function createMockApi(): { mock: any; emit: { started: Listener<any>; progress: Listener<any>; completed: Listener<any>; error: Listener<any>; queuePositions: Listener<any> } } {
  const handlers: Record<string, Listener<any>[]> = {
    started: [], progress: [], completed: [], error: [], queuePositions: []
  }
  const sub = (key: string) => (cb: Listener<any>) => {
    handlers[key].push(cb)
    return () => { handlers[key] = handlers[key].filter(h => h !== cb) }
  }
  return {
    mock: {
      tasks: {
        getSessionTasks: vi.fn().mockResolvedValue([]),
        onStarted: sub('started'),
        onProgress: sub('progress'),
        onCompleted: sub('completed'),
        onError: sub('error'),
        onQueuePositions: sub('queuePositions')
      }
    },
    emit: {
      started: (d) => handlers.started.forEach(h => h(d)),
      progress: (d) => handlers.progress.forEach(h => h(d)),
      completed: (d) => handlers.completed.forEach(h => h(d)),
      error: (d) => handlers.error.forEach(h => h(d)),
      queuePositions: (d) => handlers.queuePositions.forEach(h => h(d))
    }
  }
}

describe('useTaskProgress', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as any).api = api.mock
  })

  it('starts a step on task:started', async () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => api.emit.started({ sessionId: 's1', taskType: 'transcription', stepIndex: 3, totalSteps: 5, plannedDurationSec: 120 }))
    expect(result.current.current).toMatchObject({ taskType: 'transcription', progress: 0, stepIndex: 3, totalSteps: 5 })
  })

  it('updates progress on task:progress', () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    act(() => {
      api.emit.started({ sessionId: 's1', taskType: 'transcription', stepIndex: 3, totalSteps: 5, plannedDurationSec: 120 })
      api.emit.progress({ sessionId: 's1', taskType: 'transcription', progress: 0.42, etaSecondsTotal: 90 })
    })
    expect(result.current.current?.progress).toBe(0.42)
    expect(result.current.current?.etaSecondsTotal).toBe(90)
  })

  it('freezes at 100% on task:completed (does not clear)', () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    act(() => {
      api.emit.started({ sessionId: 's1', taskType: 'transcription', stepIndex: 3, totalSteps: 5, plannedDurationSec: 120 })
      api.emit.completed({ sessionId: 's1', taskType: 'transcription' })
    })
    expect(result.current.current?.progress).toBe(1)
    expect(result.current.current?.isTransitioning).toBe(false)
  })

  it('marks isTransitioning after 500ms with no task:started', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTaskProgress('s1'))
    act(() => {
      api.emit.started({ sessionId: 's1', taskType: 'transcription', stepIndex: 3, totalSteps: 5, plannedDurationSec: 120 })
      api.emit.completed({ sessionId: 's1', taskType: 'transcription' })
    })
    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.current?.isTransitioning).toBe(true)
    vi.useRealTimers()
  })

  it('clears the timer if task:started arrives within 500ms', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTaskProgress('s1'))
    act(() => {
      api.emit.started({ sessionId: 's1', taskType: 'transcription', stepIndex: 3, totalSteps: 5, plannedDurationSec: 120 })
      api.emit.completed({ sessionId: 's1', taskType: 'transcription' })
      api.emit.started({ sessionId: 's1', taskType: 'anonymization', stepIndex: 4, totalSteps: 5, plannedDurationSec: 30 })
    })
    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.current?.taskType).toBe('anonymization')
    expect(result.current.current?.isTransitioning).toBe(false)
    vi.useRealTimers()
  })

  it('tracks queue position from queue:positions', () => {
    const { result } = renderHook(() => useTaskProgress('s1'))
    act(() => api.emit.queuePositions({ positions: { s1: 2, s2: 1 } }))
    expect(result.current.queuePosition).toBe(2)
  })
})
```

- [ ] **Step 2: Tests laufen**

```bash
vitest run src/renderer/src/hooks/__tests__/useTaskProgress.test.tsx
```

Erwartet: alle 6 Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/__tests__/useTaskProgress.test.tsx
git commit -m "test(hook): useTaskProgress lifecycle + transition state + queue position"
```

---

### Task E.3: Backend-Throttle für `task:progress`

**Files:**
- Modify: `src/main/services/TaskQueueService.ts` — `onProgress`-Closure

- [ ] **Step 1: Throttle einbauen (250 ms)**

```typescript
// In executeTask(), vor const onProgress = …:
let lastEmit = 0
const THROTTLE_MS = 250

const onProgress = (progress: number): void => {
  watchdog.heartbeat()
  this.repository.update(task.id, { progress })

  const now = Date.now()
  // Always emit at 0% and 100% boundaries; throttle middle
  if (progress === 0 || progress === 1 || now - lastEmit >= THROTTLE_MS) {
    lastEmit = now
    sendToRenderer('task:progress', {
      sessionId: task.sessionId,
      taskType: task.type,
      progress,
      etaSecondsTotal: this.estimator?.totalEta(task.sessionId, task.type, progress) ?? null
    })
  }
}
```

- [ ] **Step 2: Test — Burst von 100 Progress-Calls führt zu höchstens ~5 IPC-Emissions**

```typescript
// In TaskQueueService.throttle.test.ts (neu):
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as ipc from '../../ipc/sendToRenderer'

describe('TaskQueueService task:progress throttle', () => {
  it('emits at most ~5 progress events for a 100-call burst within 1 second', async () => {
    const sendSpy = vi.spyOn(ipc, 'sendToRenderer')
    // Use a stub executor that calls onProgress 100 times back-to-back
    const burstExec = {
      execute: vi.fn(async (_t: any, onProgress: (n: number) => void) => {
        for (let i = 1; i <= 100; i++) {
          onProgress(i / 100)
          // Tight loop — no awaits, all synchronous within one tick
        }
      })
    }
    const sessions = makeSessions()
    const queue = new TaskQueueService(/* …, executors with diarization: burstExec */)
    const session = sessions.create({ title: 't', type: 'audio' })
    sessions.updateSession(session.id, { status: 'queued' })
    queue.enqueue(session.id, [{ type: 'diarization', sessionId: session.id }])
    await queue.drain()

    const progressEmits = sendSpy.mock.calls.filter((c) => c[0] === 'task:progress')
    // Always emit 0% (start) + 100% (end) + at most ~4 throttled middle ticks per second
    expect(progressEmits.length).toBeLessThanOrEqual(6)
    expect(progressEmits.length).toBeGreaterThanOrEqual(2)  // 0% + 100%
    // First emit must be progress 0 boundary, last must be 1
    const firstProgress = (progressEmits[0][1] as { progress: number }).progress
    const lastProgress = (progressEmits[progressEmits.length - 1][1] as { progress: number }).progress
    expect(firstProgress).toBe(0.01) // first call after onProgress(1/100); 0% boundary not emitted by this test setup
    expect(lastProgress).toBe(1)
  })
})
```

Anmerkung: `progress === 0` und `progress === 1` werden in der Throttle-Implementierung immer emittiert (Boundary-Bypass). Bei einem Burst, der bei `0.01` startet, ist der erste Tick `0.01` (kein 0% wegen Floating-Point — wenn der Executor explizit `onProgress(0)` ruft, dann emittiert die erste auch).

- [ ] **Step 3: Commit**

```bash
git add src/main/services/TaskQueueService.ts src/main/services/__tests__/
git commit -m "feat(taskqueue): throttle task:progress emissions to 4Hz"
```

---

## Phase F: SessionCard Audio Happy Path

### Task F.1: Wording-Glossar als geteilte Konstante

**Files:**
- Create: `src/shared/constants/pipelineWording.ts`
- Modify: `src/renderer/src/components/SessionCard.tsx` (Import)

- [ ] **Step 1: Konstante anlegen**

```typescript
// src/shared/constants/pipelineWording.ts
import type { TaskType } from '../types'

/**
 * Laienfreundliche, deutsche Schritt-Bezeichnungen für die SessionCard-UI.
 * Single Source of Truth für AC#2 (keine ML-Fachbegriffe sichtbar).
 * Sie-Form, aktive Imperativ-Substantive.
 */
export const STEP_LABELS_DE: Record<TaskType, string> = {
  diarization: 'Sprecher unterscheiden',
  transcription: 'Gespräch transkribieren',
  alignment: 'Audio aufbereiten',
  anonymization: 'Persönliche Angaben anonymisieren',
  summarization: 'Zusammenfassung erstellen',
  extraction: 'Text auslesen',
  ocr: 'Schrift erkennen'
}

/**
 * UI-State strings.
 */
export const PIPELINE_UI_STRINGS = {
  waiting: (position: number) => `Wartet — Position ${position}`,
  step: (i: number, n: number, label: string) => `Schritt ${i}/${n} · ${label}`,
  preparingNext: 'Nächster Schritt wird vorbereitet…',
  etaMinutes: (n: number) => `noch ca. ${n} Min.`,
  etaOneMinute: 'noch ca. 1 Min.',
  etaAlmostDone: 'Fast fertig',
  emptySpeechHeadline: 'Keine Sprache erkannt',
  emptySpeechBody: 'Sitzung wurde abgeschlossen, ohne dass Sprache erkannt wurde.',
  watchdogHeadline: 'Verarbeitung unterbrochen',
  watchdogBody: 'Die Verarbeitung wurde nach längerer Inaktivität abgebrochen.',
  retryButton: 'Erneut versuchen',
  retryAfterFirstFailure: 'Erster Versuch ist fehlgeschlagen.',
  retryAfterSecondFailure: 'Mehrfach-Fehler — bitte App neu starten oder Logs prüfen.',
  retryExhausted: 'Verarbeitung schlägt wiederholt fehl. Wenden Sie sich an den Support.',
  resumeFromStep: (label: string) => `Setzt fort ab: ${label}`
} as const
```

- [ ] **Step 2: Test für Konstante**

```typescript
// src/shared/constants/__tests__/pipelineWording.test.ts
import { describe, it, expect } from 'vitest'
import { STEP_LABELS_DE, PIPELINE_UI_STRINGS } from '../pipelineWording'
import type { TaskType } from '../../types'

describe('pipelineWording', () => {
  it('covers every TaskType', () => {
    const taskTypes: TaskType[] = ['diarization','transcription','alignment','anonymization','summarization','extraction','ocr']
    for (const t of taskTypes) {
      expect(STEP_LABELS_DE[t]).toBeTruthy()
    }
  })

  it('contains no ML jargon (Diarisierung, Alignment, NER)', () => {
    const allText = Object.values(STEP_LABELS_DE).join(' ').toLowerCase()
    expect(allText).not.toContain('diarisierung')
    expect(allText).not.toContain('alignment')
    expect(allText).not.toContain('ner')
  })

  it('produces correct etaMinutes string', () => {
    expect(PIPELINE_UI_STRINGS.etaMinutes(3)).toBe('noch ca. 3 Min.')
  })
})
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants/pipelineWording.ts src/shared/constants/__tests__/pipelineWording.test.ts
git commit -m "feat(constants): pipelineWording — single source for German step labels"
```

---

### Task F.2: SessionCard — Schritt-Counter + schritt-eigene Bar

**Files:**
- Modify: `src/renderer/src/components/SessionCard.tsx`

- [ ] **Step 1: Imports + Helper-Funktionen**

```typescript
// src/renderer/src/components/SessionCard.tsx — oberhalb der STATUS_CONFIG ergänzen:
import { STEP_LABELS_DE, PIPELINE_UI_STRINGS } from '../../../shared/constants/pipelineWording'

function formatEta(secondsTotal: number | null): string | null {
  if (secondsTotal == null) return null
  if (secondsTotal < 30) return PIPELINE_UI_STRINGS.etaAlmostDone
  if (secondsTotal < 60) return PIPELINE_UI_STRINGS.etaOneMinute
  const minutes = Math.round(secondsTotal / 60)
  return PIPELINE_UI_STRINGS.etaMinutes(minutes)
}
```

- [ ] **Step 2: `STATUS_CONFIG` reduzieren**

```typescript
// Ersetze die existierende STATUS_CONFIG-Map durch:
const STATUS_CONFIG: Record<SessionStatus, { label: string; color: string }> = {
  recording: { label: 'Aufnahme läuft', color: 'text-recording' },
  queued: { label: 'Wartet', color: 'text-text-secondary' },
  processing: { label: 'Verarbeitung', color: 'text-primary' },
  review: { label: 'Review', color: 'text-success' },
  error: { label: 'Fehler', color: 'text-error-text' }
}
```

- [ ] **Step 3: `isProcessingStatus()` reduzieren**

```typescript
function isProcessingStatus(status: SessionStatus): boolean {
  return status === 'processing'
}
```

`TASK_LABELS`-Konstante komplett entfernen — wird durch `STEP_LABELS_DE`-Import ersetzt.

- [ ] **Step 4: Hook-Aufruf umstellen**

```typescript
// Im SessionCard component body:
const showProgress = isProcessingStatus(session.status)
const { tasks, current, queuePosition } = useTaskProgress(showProgress || session.status === 'queued' ? session.id : null)
```

- [ ] **Step 5: Render-Logik für die Status-Zeile**

Den bestehenden Block in den Zeilen 148-167 durch folgenden ersetzen:

```typescript
<div className="pointer-events-none relative z-[1] mt-1.5 flex items-center justify-between gap-3">
  <div className="flex min-w-0 items-center gap-2">
    {session.status === 'review' ? (
      session.wordCount === 0 ? (
        <span className="text-xs font-medium text-text-secondary">
          {PIPELINE_UI_STRINGS.emptySpeechHeadline}
        </span>
      ) : (
        session.wordCount != null && (
          <span className="text-xs text-text-tertiary">
            {session.wordCount.toLocaleString('de-CH')} Wörter
          </span>
        )
      )
    ) : session.status === 'queued' && queuePosition != null ? (
      <span className="text-xs font-medium text-text-secondary">
        {PIPELINE_UI_STRINGS.waiting(queuePosition)}
      </span>
    ) : showProgress && current ? (
      <span className="text-xs font-medium text-primary">
        {current.isTransitioning
          ? PIPELINE_UI_STRINGS.preparingNext
          : current.totalSteps > 0
            ? PIPELINE_UI_STRINGS.step(current.stepIndex, current.totalSteps, STEP_LABELS_DE[current.taskType])
            : STEP_LABELS_DE[current.taskType]}
      </span>
    ) : (
      <span className={`text-xs font-medium ${statusConfig.color}`}>{statusConfig.label}</span>
    )}
  </div>

  <TypeIcon
    className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
    strokeWidth={1.75}
    role="img"
    aria-label={typeLabel}
  />
</div>
```

- [ ] **Step 6: Schritt-eigene Progress-Bar**

Den bestehenden Block in den Zeilen 185-224 ersetzen durch:

```typescript
{showProgress && current && !current.isTransitioning && (
  <div className="pointer-events-none relative z-[1] mt-2">
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuenow={Math.round(current.progress * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${PIPELINE_UI_STRINGS.step(current.stepIndex, current.totalSteps, STEP_LABELS_DE[current.taskType])}, ${Math.round(current.progress * 100)} Prozent`}
    >
      <div
        className="h-full rounded-full bg-primary transition-all duration-300"
        style={{ width: `${Math.round(current.progress * 100)}%` }}
      />
    </div>
  </div>
)}

{showProgress && current?.isTransitioning && (
  <div className="pointer-events-none relative z-[1] mt-2">
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={PIPELINE_UI_STRINGS.preparingNext}
    >
      <div className="h-full w-1/4 animate-pulse rounded-full bg-surface-3" />
    </div>
  </div>
)}
```

Pipeline-Dot-Reihe entfernt — Schritt-Counter trägt die Information.

- [ ] **Step 7: TypeCheck + Tests**

```bash
npm run typecheck
vitest run src/renderer/src/components
```

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/SessionCard.tsx
git commit -m "feat(card): step-counter + step-progress + transitioning state"
```

---

### Task F.3: SessionCard-Tests für Audio-Happy-Path

**Files:**
- Create/Modify: `src/renderer/src/components/__tests__/SessionCard.test.tsx`

- [ ] **Step 1: Test-Helpers + erste Tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionCard } from '../SessionCard'
import type { Session } from '../../../../shared/types'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', title: 'Test', type: 'audio', status: 'review',
    audioPath: null, transcriptPath: null, anonymizedPath: null, diarizationPath: null,
    alignedTranscriptPath: null, pdfPath: null, extractedPath: null, entityMap: null,
    errorMessage: null, createdAt: '2026-04-29T12:00:00Z', updatedAt: '2026-04-29T12:00:00Z',
    reviewAt: null, wordCount: 4287, summary: null, summaryModelId: null, summarizedAt: null,
    plannedSteps: null, retryCount: 0,
    ...overrides
  }
}

beforeEach(() => {
  ;(window as any).api = {
    tasks: {
      getSessionTasks: vi.fn().mockResolvedValue([]),
      onStarted: vi.fn().mockReturnValue(() => {}),
      onProgress: vi.fn().mockReturnValue(() => {}),
      onCompleted: vi.fn().mockReturnValue(() => {}),
      onError: vi.fn().mockReturnValue(() => {}),
      onQueuePositions: vi.fn().mockReturnValue(() => {})
    }
  }
})

describe('SessionCard — review state', () => {
  it('renders word count when wordCount > 0', () => {
    render(<SessionCard session={makeSession({ wordCount: 4287 })} onDelete={vi.fn()} />)
    expect(screen.getByText(/4'287 Wörter/)).toBeInTheDocument()
  })

  it('renders empty-speech variant when wordCount === 0', () => {
    render(<SessionCard session={makeSession({ wordCount: 0 })} onDelete={vi.fn()} />)
    expect(screen.getByText('Keine Sprache erkannt')).toBeInTheDocument()
  })
})

describe('SessionCard — queued state', () => {
  it('renders nothing about position before queue:positions broadcast', () => {
    render(<SessionCard session={makeSession({ status: 'queued' })} onDelete={vi.fn()} />)
    expect(screen.getByText('Wartet')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Test für Processing-State (Hook-Mock erweitern)**

(Da `useTaskProgress` IPC-Listener nutzt, müssen Tests für Processing-State entweder den Hook mocken oder via `act()` Events feuern. Pattern aus `useTaskProgress.test.tsx` kopieren.)

```typescript
import { vi as vi2 } from 'vitest'
vi.mock('../../hooks/useTaskProgress', () => ({
  useTaskProgress: vi.fn()
}))
import { useTaskProgress } from '../../hooks/useTaskProgress'

it('renders Schritt 3/5 · Gespräch transkribieren during transcription', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [],
    loading: false,
    current: {
      taskType: 'transcription',
      progress: 0.64,
      stepIndex: 3,
      totalSteps: 5,
      etaSecondsTotal: 180,
      plannedDurationSec: 300,
      isTransitioning: false
    },
    queuePosition: null
  })
  render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
  expect(screen.getByText('Schritt 3/5 · Gespräch transkribieren')).toBeInTheDocument()
})

it('renders preparingNext during transitioning state', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [],
    loading: false,
    current: {
      taskType: 'transcription', progress: 1, stepIndex: 3, totalSteps: 5,
      etaSecondsTotal: null, plannedDurationSec: null, isTransitioning: true
    },
    queuePosition: null
  })
  render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
  expect(screen.getByText('Nächster Schritt wird vorbereitet…')).toBeInTheDocument()
})
```

- [ ] **Step 3: Tests laufen**

```bash
vitest run src/renderer/src/components/__tests__/SessionCard.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/__tests__/SessionCard.test.tsx
git commit -m "test(card): processing/queued/review states + transitioning"
```

---

### Task F.4: SessionDashboard — `PROCESSING_STATUSES` konsolidieren

**Files:**
- Modify: `src/renderer/src/components/SessionDashboard.tsx:8-13`

- [ ] **Step 1: Array reduzieren**

```typescript
// SessionDashboard.tsx:8-13 — ersetzen:
const PROCESSING_STATUSES: SessionStatus[] = ['queued', 'processing']
```

- [ ] **Step 2: TypeCheck + manueller Smoke-Test**

```bash
npm run typecheck
npm run dev
```

UI: neue Audio-Session aufnehmen, sehen dass die Karte „Schritt 1/4 · Sprecher unterscheiden" zeigt (kein Summarization-Modell aktiv → 4 Schritte).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SessionDashboard.tsx
git commit -m "refactor(dashboard): PROCESSING_STATUSES uses new status values"
```

---

## Phase G: PDF Happy Path

### Task G.1: PDF-Pipeline-Initial-Status + OCR-Detection beim Import

**Files:**
- Modify: `src/main/services/PdfImportService.ts` (oder dem PDF-Import-Pfad — über grep zu finden)
- Modify: `src/shared/types/Session.ts` — neues Feld `pdfHasScannedPages`
- Modify: `src/main/db/repositories/SessionRepository.ts` — Mapping
- Modify: `src/main/db/migrations/` — neue Migration 013 für die Spalte

**Begründung.** Phase C.3's `computePlannedSteps` muss zum Zeitpunkt `queued → processing` wissen, ob die PDF gescannte Seiten enthält — sonst wird `ocr` aus `plannedSteps` weggelassen, und die UI zeigt nachträglich „Schritt 3/2", wenn OCR doch läuft. Detection muss **vor** dem Enqueue passieren, nicht zur Laufzeit.

- [ ] **Step 1: Migration 013 — `pdf_has_scanned_pages` Spalte**

```sql
-- src/main/db/migrations/013-pdf-has-scanned-pages.sql
ALTER TABLE sessions ADD COLUMN pdf_has_scanned_pages INTEGER;
-- NULL = unknown (legacy rows); 0 = no, 1 = yes
```

In `migrations/index.ts` registrieren (Version 13).

- [ ] **Step 2: `Session.pdfHasScannedPages` typen**

```typescript
// src/shared/types/Session.ts — Session-Interface erweitern:
pdfHasScannedPages: boolean | null
```

`UpdateSessionInput` analog erweitern. `SessionRepository.SessionRow` + `rowToSession` + `update()`-Mapping wie bei `plannedSteps` (siehe Phase B.3 als Vorlage):

```typescript
// SessionRow:
pdf_has_scanned_pages: number | null

// rowToSession:
pdfHasScannedPages: row.pdf_has_scanned_pages == null ? null : row.pdf_has_scanned_pages === 1,

// In update() Set-Builder:
if (input.pdfHasScannedPages !== undefined) {
  sets.push('pdf_has_scanned_pages = ?')
  values.push(input.pdfHasScannedPages == null ? null : (input.pdfHasScannedPages ? 1 : 0))
}
```

- [ ] **Step 3: OCR-Detection beim PDF-Import**

`PdfImportService` führt eine schnelle Heuristik vor dem Enqueue durch: pdfjs-dist die ersten 3 Seiten extrahieren — wenn alle drei Seiten zusammengenommen weniger als 50 Zeichen Text liefern, gilt das PDF als „hauptsächlich gescannt" und braucht OCR.

```typescript
// In PdfImportService (vor enqueue):
async function detectScannedPages(pdfPath: string): Promise<boolean> {
  const pdfjs = await import('pdfjs-dist')
  const doc = await pdfjs.getDocument({
    url: pdfPath,
    standardFontDataUrl: STANDARD_FONT_DATA_URL  // bestehende Konstante
  }).promise

  const samplePages = Math.min(3, doc.numPages)
  let totalText = ''
  for (let i = 1; i <= samplePages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    totalText += content.items.map((it: any) => 'str' in it ? it.str : '').join('')
    if (totalText.length >= 50) break
  }
  return totalText.trim().length < 50
}

// Im Import-Flow:
const hasScanned = await detectScannedPages(pdfPath)
const session = sessionService.create({
  title, type: 'pdf', pdfPath,
  status: 'queued',
  pdfHasScannedPages: hasScanned
})
const tasks: TaskType[] = ['extraction']
if (hasScanned) tasks.push('ocr')
tasks.push('anonymization')
taskQueue.enqueue(session.id, tasks.map((type) => ({ type, sessionId: session.id })))
```

(`STANDARD_FONT_DATA_URL` existiert bereits, weil pdfjs-dist im Codebase genutzt wird — siehe CLAUDE.md.)

- [ ] **Step 4: `'extracting'`-Status-Setter aufräumen**

```bash
rg "status: 'extracting'" src/main/ --type ts
```

Jede Treffer-Stelle (außer Migrations und Model-Download — anderes `extracting`) auf `'queued'` umstellen.

- [ ] **Step 5: Test — Detection-Heuristik**

```typescript
// src/main/services/__tests__/PdfImportService.scannedDetection.test.ts
describe('detectScannedPages heuristic', () => {
  it('returns true for a PDF with no extractable text in first 3 pages', async () => {
    // Use a fixture: src/main/services/__tests__/fixtures/scanned.pdf (commit fixture)
    expect(await detectScannedPages(SCANNED_PDF_FIXTURE)).toBe(true)
  })

  it('returns false for a text-based PDF', async () => {
    expect(await detectScannedPages(TEXT_PDF_FIXTURE)).toBe(false)
  })

  it('handles PDFs with fewer than 3 pages', async () => {
    expect(await detectScannedPages(SHORT_TEXT_PDF_FIXTURE)).toBe(false)
  })
})
```

Fixture-Files in `src/main/services/__tests__/fixtures/` ablegen. Wenn keine Fixture-PDFs greifbar sind: kleines Generator-Skript `scripts/test-fixtures/make-pdf-fixtures.sh` schreiben oder Existing-Fixture aus dem Repo wiederverwenden.

- [ ] **Step 6: Manueller Smoke-Test**

```bash
npm run dev
```

Zwei PDFs importieren — eines mit Text, eines gescannt. Erwartet:
- Text-PDF: „Schritt 1/2 · Text auslesen" → „Schritt 2/2 · Persönliche Angaben anonymisieren"
- Gescannt: „Schritt 1/3 · Text auslesen" → „Schritt 2/3 · Schrift erkennen" → „Schritt 3/3 · …"

(Mit Summarization-Modell aktiv: jeweils +1 Schritt am Ende.)

- [ ] **Step 7: Commit**

```bash
git add src/main/db/migrations/013-pdf-has-scanned-pages.sql src/main/db/migrations/index.ts \
        src/shared/types/Session.ts src/main/db/repositories/SessionRepository.ts \
        src/main/services/PdfImportService.ts \
        src/main/services/__tests__/PdfImportService.scannedDetection.test.ts
git commit -m "feat(pdf): scanned-pages detection at import time + plannedSteps integration"
```

---

### Task G.2: PDF-spezifische Tests

**Files:**
- Modify: `src/renderer/src/components/__tests__/SessionCard.test.tsx`

- [ ] **Step 1: Tests für PDF-Pipeline-Wording**

```typescript
it('renders Text auslesen for extraction step on PDF', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false,
    current: { taskType: 'extraction', progress: 0.5, stepIndex: 1, totalSteps: 2, etaSecondsTotal: null, plannedDurationSec: null, isTransitioning: false },
    queuePosition: null
  })
  render(<SessionCard session={makeSession({ type: 'pdf', status: 'processing' })} onDelete={vi.fn()} />)
  expect(screen.getByText('Schritt 1/2 · Text auslesen')).toBeInTheDocument()
})

it('renders Schrift erkennen for OCR step', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false,
    current: { taskType: 'ocr', progress: 0.3, stepIndex: 2, totalSteps: 3, etaSecondsTotal: null, plannedDurationSec: null, isTransitioning: false },
    queuePosition: null
  })
  render(<SessionCard session={makeSession({ type: 'pdf', status: 'processing' })} onDelete={vi.fn()} />)
  expect(screen.getByText('Schritt 2/3 · Schrift erkennen')).toBeInTheDocument()
})
```

- [ ] **Step 2: Tests laufen + Commit**

```bash
vitest run src/renderer/src/components/__tests__/SessionCard.test.tsx
git add src/renderer/src/components/__tests__/SessionCard.test.tsx
git commit -m "test(card): PDF pipeline step labels"
```

---

## Phase H: Summarization conditional

### Task H.1: `computePlannedSteps` honoriert `activeModels.summarization`

**Files:**
- Modify: `src/main/services/TaskQueueService.ts` (bereits in C.3 angelegt — hier nur verfeinern)

- [ ] **Step 1: Stelle sicher, dass `computePlannedSteps` `activeModels.getActive('summarization')` checkt**

(Wurde in C.3 schon implementiert — hier Test verschärfen.)

- [ ] **Step 2: Test — wenn Modell deinstalliert ist, wird `summarization` aus plannedSteps weggelassen**

(Die zwei Tests aus C.3 Step 4 decken diesen Pfad bereits ab — siehe `freezes plannedSteps` und `includes summarization in plannedSteps`. Hier nur einen zusätzlichen Test für mid-pipeline-Uninstall.)

```typescript
// In TaskQueueService.statusFlow.test.ts:
it('skips summarization gracefully if model is uninstalled mid-pipeline', async () => {
  const session = sessions.create({ title: 't', type: 'audio' })
  sessions.updateSession(session.id, { status: 'queued' })
  // Start with summarization active
  ;(queue as any).activeModels.getActive = vi.fn((g: string) =>
    g === 'summarization' ? 'gemma' : null
  )
  queue.enqueue(session.id, [
    { type: 'diarization', sessionId: session.id },
    { type: 'summarization', sessionId: session.id }
  ])
  // Diarization runs first; before summarization starts, uninstall the model
  await new Promise((r) => setTimeout(r, 50))  // let diarization start + complete
  ;(queue as any).activeModels.getActive = vi.fn().mockReturnValue(null)
  // Summarization executor checks getActive at execution time and skips silently
  await queue.drain()
  const final = sessions.getSession(session.id)
  expect(final?.status).toBe('review')
  expect(final?.summary).toBeNull()  // graceful skip
})
```

CLAUDE.md-Anker (Summarization-Sektion): *„SummarizationExecutor wraps `summarize()` in try/catch and logs + returns cleanly on ANY error (subprocess crash, abort, JSON-extraction failure, schema-validation failure, transient model error). Sessions reach `'review'` regardless of LLM success."* Test sperrt dieses Verhalten.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/__tests__/
git commit -m "test(taskqueue): summarization conditional from activeModels"
```

---

### Task H.2: Settings — Summarization-Hinweis bei Deinstallation

**Files:**
- Modify: `src/renderer/src/components/settings/ModelSettings.tsx` (oder wo Modell-Listen rendern)

- [ ] **Step 1: Klein-Hinweis-Text bei Summarization-Slot**

Im Summarization-Bereich der Settings-UI ergänzen:

```typescript
{group === 'summarization' && (
  <p className="text-xs text-text-tertiary mt-2">
    Optional. Ohne aktives Modell endet die Pipeline mit „Persönliche Angaben anonymisieren".
  </p>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/settings/
git commit -m "feat(settings): summarization slot — optional pipeline hint"
```

---

## Phase I: Telemetrie + Estimator (Story 5a)

### Task I.1: `pipelineStats`-Schema in electron-store

**Files:**
- Modify: `src/main/services/SettingsService.ts` (oder wo electron-store-Defaults leben)
- Create: `src/main/services/PipelineStatsService.ts`

- [ ] **Step 1: Schema-Typ + Service**

```typescript
// src/main/services/PipelineStatsService.ts
import type { TaskType } from '../../shared/types'
import { settingsStore } from './SettingsService' // existing electron-store wrapper

export interface RateSample { audioSec: number; durationSec: number; ts: number }
export interface WordSample { wordCount: number; durationSec: number; ts: number }
export interface PageSample { pages: number; durationSec: number; ts: number }

export type PipelineStats = {
  diarization:    RateSample[]
  transcription:  RateSample[]
  alignment:      RateSample[]
  anonymization:  WordSample[]
  summarization:  WordSample[]
  extraction:     PageSample[]
  ocr:            PageSample[]
}

const DEFAULT_STATS: PipelineStats = {
  diarization: [], transcription: [], alignment: [],
  anonymization: [], summarization: [], extraction: [], ocr: []
}

const MAX_SAMPLES_PER_STEP = 5

export class PipelineStatsService {
  getAll(): PipelineStats {
    return settingsStore.get('pipelineStats') as PipelineStats ?? DEFAULT_STATS
  }

  recordRate(step: 'diarization' | 'transcription' | 'alignment', audioSec: number, durationSec: number): void {
    const all = this.getAll()
    const samples = all[step].concat({ audioSec, durationSec, ts: Date.now() })
    all[step] = samples.slice(-MAX_SAMPLES_PER_STEP)
    settingsStore.set('pipelineStats', all)
  }

  recordWords(step: 'anonymization' | 'summarization', wordCount: number, durationSec: number): void {
    const all = this.getAll()
    all[step] = all[step].concat({ wordCount, durationSec, ts: Date.now() }).slice(-MAX_SAMPLES_PER_STEP)
    settingsStore.set('pipelineStats', all)
  }

  recordPages(step: 'extraction' | 'ocr', pages: number, durationSec: number): void {
    const all = this.getAll()
    all[step] = all[step].concat({ pages, durationSec, ts: Date.now() }).slice(-MAX_SAMPLES_PER_STEP)
    settingsStore.set('pipelineStats', all)
  }
}
```

- [ ] **Step 2: Test**

```typescript
// src/main/services/__tests__/PipelineStatsService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PipelineStatsService } from '../PipelineStatsService'

vi.mock('../SettingsService', () => {
  let store: Record<string, unknown> = {}
  return {
    settingsStore: {
      get: (key: string) => store[key],
      set: (key: string, value: unknown) => { store[key] = JSON.parse(JSON.stringify(value)) },
      _reset: () => { store = {} }
    }
  }
})

describe('PipelineStatsService', () => {
  let svc: PipelineStatsService

  beforeEach(() => {
    const { settingsStore } = require('../SettingsService')
    settingsStore._reset()
    svc = new PipelineStatsService()
  })

  it('keeps only last 5 samples per step', () => {
    for (let i = 0; i < 7; i++) {
      svc.recordRate('transcription', 600, 100 + i)
    }
    expect(svc.getAll().transcription.length).toBe(5)
  })

  it('preserves chronological order (oldest first, newest last)', () => {
    svc.recordRate('transcription', 600, 100)
    svc.recordRate('transcription', 600, 200)
    svc.recordRate('transcription', 600, 300)
    const samples = svc.getAll().transcription
    expect(samples[0].durationSec).toBe(100)
    expect(samples[2].durationSec).toBe(300)
  })

  it('persists samples across PipelineStatsService instances', () => {
    svc.recordRate('diarization', 600, 30)
    const fresh = new PipelineStatsService()
    expect(fresh.getAll().diarization).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Commit**

```bash
git add src/main/services/PipelineStatsService.ts src/main/services/__tests__/PipelineStatsService.test.ts
git commit -m "feat(stats): PipelineStatsService — record + retrieve normalized samples"
```

---

### Task I.2: `PipelineEstimator` mit baked-in Defaults

**Files:**
- Create: `src/main/services/PipelineEstimator.ts`

- [ ] **Step 1: Estimator-Klasse**

```typescript
// src/main/services/PipelineEstimator.ts
import type { TaskType } from '../../shared/types'
import { PipelineStatsService } from './PipelineStatsService'

const MIN_SAMPLES_FOR_OVERRIDE = 3

/**
 * Aggregate of all dimensions the estimator needs. Caller passes whatever
 * is known about the session; per-step routing happens internally.
 */
export interface SessionMeta {
  audioSec?: number
  wordCount?: number
  pages?: number
}

const BAKED_IN_DEFAULTS = {
  // rate × audioSec
  diarization:    { kind: 'rate', rate: 0.05 },
  transcription:  { kind: 'rate', rate: 0.20 },
  alignment:      { kind: 'rate', rate: 0.005 },
  // fixedSec + perWord × wordCount
  anonymization:  { kind: 'words', fixed: 8, perUnit: 0.001 },
  summarization:  { kind: 'words', fixed: 12, perUnit: 0.002 },
  // fixedSec + perPage × pages
  extraction:     { kind: 'pages', fixed: 1, perUnit: 0.3 },
  ocr:            { kind: 'pages', fixed: 2, perUnit: 1.5 }
} as const

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export class PipelineEstimator {
  constructor(private stats: PipelineStatsService) {}

  /**
   * Returns expected duration in seconds for this step on the current session.
   * Always returns a positive number — falls back to baked-in defaults until
   * MIN_SAMPLES_FOR_OVERRIDE samples are reached. The UI uses isCalibrated()
   * separately to decide whether to show ETA at all.
   */
  estimate(step: TaskType, meta: SessionMeta): number {
    const all = this.stats.getAll()
    const def = BAKED_IN_DEFAULTS[step]

    if (def.kind === 'rate') {
      const audioSec = meta.audioSec ?? 0
      const samples = all[step] as { audioSec: number; durationSec: number }[]
      if (samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
        const rates = samples.map((s) => s.durationSec / Math.max(s.audioSec, 1))
        return median(rates) * audioSec
      }
      return def.rate * audioSec
    }
    if (def.kind === 'words') {
      const wc = meta.wordCount ?? 0
      const samples = all[step] as { wordCount: number; durationSec: number }[]
      if (samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
        return median(samples.map((s) => s.durationSec))
      }
      return def.fixed + def.perUnit * wc
    }
    // pages
    const p = meta.pages ?? 0
    const samples = all[step] as { pages: number; durationSec: number }[]
    if (samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
      const rates = samples.map((s) => s.durationSec / Math.max(s.pages, 1))
      return median(rates) * p
    }
    return def.fixed + def.perUnit * p
  }

  /**
   * Returns true once at least MIN_SAMPLES_FOR_OVERRIDE sessions have run end-to-end.
   * Used by UI to gate the total-progress bar + ETA display.
   */
  isCalibrated(): boolean {
    const all = this.stats.getAll()
    // Use transcription as the canonical "did a full audio session run" signal.
    // For PDF-only users, the gate uses extraction instead.
    return all.transcription.length >= MIN_SAMPLES_FOR_OVERRIDE
        || all.extraction.length   >= MIN_SAMPLES_FOR_OVERRIDE
  }

  /**
   * Total ETA across remaining steps for a session at given progress within current step.
   * Returns null when uncalibrated — UI uses this signal to hide the ETA display.
   */
  totalEta(plannedSteps: TaskType[], currentStep: TaskType, currentProgress: number, meta: SessionMeta): number | null {
    if (!this.isCalibrated()) return null

    const idx = plannedSteps.indexOf(currentStep)
    if (idx < 0) return null

    let total = this.estimate(currentStep, meta) * (1 - currentProgress)
    for (const step of plannedSteps.slice(idx + 1)) {
      total += this.estimate(step, meta)
    }
    return Math.max(0, total)
  }
}
```

- [ ] **Step 2: Tests**

```typescript
// src/main/services/__tests__/PipelineEstimator.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PipelineEstimator } from '../PipelineEstimator'
import { PipelineStatsService } from '../PipelineStatsService'

describe('PipelineEstimator', () => {
  let stats: PipelineStatsService
  let est: PipelineEstimator

  beforeEach(() => {
    // (uses the same settingsStore mock as PipelineStatsService.test.ts)
    stats = new PipelineStatsService()
    est = new PipelineEstimator(stats)
  })

  it('uses baked-in default when fewer than 3 samples', () => {
    // 60min audio (3600s) × 0.20 baked-in rate = 720s
    expect(est.estimate('transcription', { audioSec: 3600 })).toBe(720)
  })

  it('switches to median-of-recent once 3+ samples exist', () => {
    stats.recordRate('transcription', 600, 60)   // rate 0.10
    stats.recordRate('transcription', 600, 120)  // rate 0.20
    stats.recordRate('transcription', 600, 90)   // rate 0.15
    // median of [0.10, 0.20, 0.15] = 0.15; for 60min = 540s
    expect(est.estimate('transcription', { audioSec: 3600 })).toBeCloseTo(540, 0)
  })

  it('returns null totalEta when not calibrated', () => {
    // No samples recorded
    expect(est.totalEta(['transcription', 'anonymization'], 'transcription', 0.5, { audioSec: 600 }))
      .toBeNull()
  })

  it('returns positive totalEta when calibrated and progress < 1', () => {
    for (let i = 0; i < 3; i++) {
      stats.recordRate('transcription', 600, 100)
      stats.recordWords('anonymization', 500, 8)
    }
    const eta = est.totalEta(['transcription', 'anonymization'], 'transcription', 0.5, {
      audioSec: 600, wordCount: 500
    })
    expect(eta).not.toBeNull()
    expect(eta!).toBeGreaterThan(50)   // remaining transcription
    expect(eta!).toBeLessThan(120)     // reasonable upper bound
  })

  it('handles wordCount-domain steps without audio', () => {
    // anonymization baked-in: fixed 8 + 0.001 × words
    expect(est.estimate('anonymization', { wordCount: 1000 })).toBeCloseTo(8 + 1, 1)
  })

  it('handles page-domain steps for pdf', () => {
    // extraction baked-in: fixed 1 + 0.3 × pages
    expect(est.estimate('extraction', { pages: 10 })).toBeCloseTo(1 + 3, 1)
  })

  it('isCalibrated() turns true once transcription has 3+ samples', () => {
    expect(est.isCalibrated()).toBe(false)
    for (let i = 0; i < 3; i++) stats.recordRate('transcription', 600, 100)
    expect(est.isCalibrated()).toBe(true)
  })
})
```

- [ ] **Step 3: Commit**

```bash
git add src/main/services/PipelineEstimator.ts src/main/services/__tests__/PipelineEstimator.test.ts
git commit -m "feat(estimator): rate-based + median-of-recent ETA estimator"
```

---

### Task I.3: Telemetrie-Recording in Executor-Wrapper

**Files:**
- Modify: `src/main/services/TaskQueueService.ts:269-288` — `executeTask` post-success

- [ ] **Step 1: Nach erfolgreichem `executor.execute()` Sample aufzeichnen**

```typescript
// In TaskQueueService.executeTask(), nach dem this.repository.update({status: 'completed', …}):
const startedAt = new Date(this.repository.findById(task.id)?.startedAt ?? '').getTime()
const durationSec = (Date.now() - startedAt) / 1000

if (!Number.isNaN(durationSec) && durationSec > 0) {
  switch (task.type) {
    case 'diarization':
    case 'transcription':
    case 'alignment': {
      const audioSec = this.getAudioDurationSec(task) ?? 0
      if (audioSec > 0) this.stats.recordRate(task.type, audioSec, durationSec)
      break
    }
    case 'anonymization':
    case 'summarization': {
      const session = this.sessionService.getSession(task.sessionId)
      const wordCount = session?.wordCount ?? 0
      this.stats.recordWords(task.type, wordCount, durationSec)
      break
    }
    case 'extraction':
    case 'ocr': {
      const pages = await this.getPagesForSession(task.sessionId)
      if (pages != null && pages > 0) this.stats.recordPages(task.type, pages, durationSec)
      // If pages unavailable, skip telemetry — better no sample than a 0-page sample
      break
    }
  }
}
```

`this.stats` ist eine neue Constructor-Dependency vom Typ `PipelineStatsService`.

- [ ] **Step 2: `getPagesForSession()` Helper aus `extractedPath`-JSON lesen**

Die Extraktion schreibt heute eine JSON-Datei nach `session.extractedPath` mit per-page Text. Pages-Count = Anzahl Top-Level-Einträge:

```typescript
private async getPagesForSession(sessionId: string): Promise<number | null> {
  const session = this.sessionService.getSession(sessionId)
  if (!session?.extractedPath) return null
  try {
    const raw = await fs.promises.readFile(session.extractedPath, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data?.pages) ? data.pages.length : null
  } catch {
    return null
  }
}
```

`recordPages()` aus I.1 ist tolerant gegenüber `null` — Telemetrie wird in dem Fall stillschweigend übersprungen, was korrekt ist (kein Sample > kein falsches Sample).

- [ ] **Step 3: Wiring im Main-Prozess**

```typescript
// src/main/index.ts (oder Service-Container) — neue Services initialisieren + injizieren:
const stats = new PipelineStatsService()
const estimator = new PipelineEstimator(stats)
const taskQueue = new TaskQueueService(/* …existing args, */ activeModels, stats, estimator)
```

- [ ] **Step 4: Commit**

```bash
git add src/main/services/TaskQueueService.ts src/main/index.ts
git commit -m "feat(taskqueue): record per-step telemetry on task completion"
```

---

### Task I.4: `task:started` und `task:progress` mit Estimator-Output

**Files:**
- Modify: `src/main/services/TaskQueueService.ts` (Erweiterung von D.3)

- [ ] **Step 1: `plannedDurationSec` und `etaSecondsTotal` aus Estimator füllen**

```typescript
// Hilfsmethode in TaskQueueService:
private async sessionMetaForEstimator(sessionId: string): Promise<SessionMeta> {
  const session = this.sessionService.getSession(sessionId)
  if (!session) return {}
  const meta: SessionMeta = {}
  // Audio sessions: derive from WAV file size when available
  const audioSec = session.audioPath ? this.getAudioDurationSec({ sessionId, type: 'transcription' } as Task) : undefined
  if (audioSec != null) meta.audioSec = audioSec
  if (session.wordCount != null) meta.wordCount = session.wordCount
  const pages = await this.getPagesForSession(sessionId)
  if (pages != null) meta.pages = pages
  return meta
}

// Im task:started-Emit-Block (aus D.3 Step 1 — ersetzen):
const sessionMeta = await this.sessionMetaForEstimator(task.sessionId)
const plannedDurationSec = this.estimator.isCalibrated()
  ? this.estimator.estimate(task.type, sessionMeta)
  : null

sendToRenderer('task:started', {
  sessionId: task.sessionId,
  taskType: task.type,
  stepIndex,
  totalSteps,
  plannedDurationSec
})

// Im onProgress-Closure (aus D.3 Step 2 — ersetzen):
sendToRenderer('task:progress', {
  sessionId: task.sessionId,
  taskType: task.type,
  progress,
  etaSecondsTotal: this.estimator.totalEta(plannedSteps, task.type, progress, sessionMeta)
})
```

`SessionMeta` aus `PipelineEstimator` importieren. `sessionMeta` einmal pro Task am Anfang von `executeTask` bilden und in den Closures referenzieren — kein Re-Compute pro Tick.

- [ ] **Step 2: Test**

```typescript
it('emits null plannedDurationSec when estimator is uncalibrated', () => { /* … */ })
it('emits positive plannedDurationSec when 3+ samples exist', () => { /* … */ })
```

- [ ] **Step 3: Commit**

```bash
git add src/main/services/TaskQueueService.ts
git commit -m "feat(taskqueue): wire estimator output into task:started + task:progress"
```

---

### Task I.5: Migration-Hook für `pipelineStats` initial-state

**Files:**
- Modify: `src/main/services/SettingsService.ts`

- [ ] **Step 1: Default-Wert für `pipelineStats` registrieren**

In den electron-store Defaults:

```typescript
pipelineStats: {
  diarization: [], transcription: [], alignment: [],
  anonymization: [], summarization: [], extraction: [], ocr: []
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/services/SettingsService.ts
git commit -m "feat(settings): default pipelineStats schema"
```

---

## Phase J: Gesamt-Bar + ETA UI (Story 5b)

### Task J.1: SessionCard Gesamt-Bar nur wenn `etaSecondsTotal != null`

**Files:**
- Modify: `src/renderer/src/components/SessionCard.tsx`

- [ ] **Step 1: Bar-Berechnung anpassen**

Da `etaSecondsTotal != null` indirekt signalisiert „Estimator ist kalibriert", wird die Gesamt-Bar nur dann angezeigt:

```typescript
const totalProgress = current && current.totalSteps > 0 && current.plannedDurationSec != null
  // Gewichteter Gesamt-Fortschritt: Summe vergangener Schritt-plannedDurations + aktueller progress × plannedDuration
  // Alternative (einfacher): linear über stepIndex mit current.progress als Bruchteil:
  ? ((current.stepIndex - 1) + current.progress) / current.totalSteps
  : null
```

(Linear-Approach ist Bewusste Vereinfachung — die echten Schritt-Gewichte hat der Backend-Estimator; aber der Renderer hat sie nicht direkt. Akzeptabler Trade-Off, weil ETA als Zahl die genaue Information ohnehin trägt.)

- [ ] **Step 2: Bar-Render-Block**

Innerhalb des `showProgress && current && !current.isTransitioning` Blocks zusätzlich zur schritt-eigenen Bar (wenn kalibriert):

```typescript
{totalProgress != null && current.etaSecondsTotal != null && (
  <div className="mt-1 flex items-center gap-2">
    <div
      className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuenow={Math.round(totalProgress * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Gesamtfortschritt ${Math.round(totalProgress * 100)} Prozent, ${formatEta(current.etaSecondsTotal)}`}
    >
      <div
        className="h-full rounded-full bg-primary transition-all duration-300"
        style={{ width: `${Math.round(totalProgress * 100)}%` }}
      />
    </div>
    <span className="text-xs tabular-nums text-text-tertiary min-w-[2.5rem] text-right">
      {Math.round(totalProgress * 100)}%
    </span>
    <span className="text-xs text-text-tertiary whitespace-nowrap">
      {formatEta(current.etaSecondsTotal)}
    </span>
  </div>
)}
```

(Schritt-eigene Bar bleibt für unkalibrierte Sessions; sobald Gesamt-Bar erscheint, kann die schritt-eigene auf Wunsch ausgeblendet werden — siehe J.2.)

- [ ] **Step 3: Layout-Entscheid: ein-zeiliger oder zwei-zeiliger Bar?**

Nach Diskussion mit dem User (siehe Issue-Kommentar): **eine** Bar mit Gesamt-Fortschritt + ETA in derselben Zeile, **wenn kalibriert**. **Schritt-eigene Bar wird durch Gesamt-Bar ersetzt**, sobald `etaSecondsTotal != null`. Logik:

```typescript
const useTotalBar = current?.etaSecondsTotal != null && current.totalSteps > 0
```

und entweder den schritt-eigenen Bar-Block oder den Gesamt-Block rendern, niemals beide.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SessionCard.tsx
git commit -m "feat(card): total-progress bar + ETA when estimator is calibrated"
```

---

### Task J.2: SessionCard-Tests für ETA + Gesamt-Bar

**Files:**
- Modify: `src/renderer/src/components/__tests__/SessionCard.test.tsx`

- [ ] **Step 1: Tests für ETA-Schwellen**

```typescript
it('renders "noch ca. 3 Min." for ETA between 60s and 60min', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false,
    current: { taskType: 'transcription', progress: 0.5, stepIndex: 3, totalSteps: 5, etaSecondsTotal: 180, plannedDurationSec: 300, isTransitioning: false },
    queuePosition: null
  })
  render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
  expect(screen.getByText('noch ca. 3 Min.')).toBeInTheDocument()
})

it('renders "noch ca. 1 Min." for ETA 30-60s', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false,
    current: { taskType: 'transcription', progress: 0.9, stepIndex: 3, totalSteps: 5, etaSecondsTotal: 45, plannedDurationSec: 300, isTransitioning: false },
    queuePosition: null
  })
  render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
  expect(screen.getByText('noch ca. 1 Min.')).toBeInTheDocument()
})

it('renders "Fast fertig" for ETA <30s', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false,
    current: { taskType: 'transcription', progress: 0.95, stepIndex: 3, totalSteps: 5, etaSecondsTotal: 12, plannedDurationSec: 300, isTransitioning: false },
    queuePosition: null
  })
  render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
  expect(screen.getByText('Fast fertig')).toBeInTheDocument()
})

it('hides total-bar when estimator is uncalibrated (etaSecondsTotal === null)', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false,
    current: { taskType: 'transcription', progress: 0.5, stepIndex: 3, totalSteps: 5, etaSecondsTotal: null, plannedDurationSec: null, isTransitioning: false },
    queuePosition: null
  })
  const { container } = render(<SessionCard session={makeSession({ status: 'processing' })} onDelete={vi.fn()} />)
  expect(container.querySelector('[aria-label*="Gesamtfortschritt"]')).toBeNull()
  // Step-own bar IS visible:
  expect(container.querySelector('[aria-label*="Gespräch transkribieren"]')).toBeTruthy()
})
```

- [ ] **Step 2: Tests laufen + Commit**

```bash
vitest run src/renderer/src/components/__tests__/SessionCard.test.tsx
git add src/renderer/src/components/__tests__/SessionCard.test.tsx
git commit -m "test(card): ETA thresholds + calibration-gated total-bar"
```

---

### Task J.3: Tooltip auf ETA-Text

**Files:**
- Modify: `src/renderer/src/components/SessionCard.tsx` — ETA-Span

- [ ] **Step 1: `title`-Attribut auf ETA-Text**

```typescript
<span
  className="text-xs text-text-tertiary whitespace-nowrap"
  title="Geschätzt aus früheren Sitzungen auf diesem Mac. Tatsächliche Dauer kann abweichen."
>
  {formatEta(current.etaSecondsTotal)}
</span>
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/SessionCard.tsx
git commit -m "feat(card): ETA tooltip discloses estimate-not-guarantee"
```

---

## Phase K: Wartezustand mit Position (Story 6)

### Task K.1: Wartezustand-Render in SessionCard

**Files:**
- Modify: `src/renderer/src/components/SessionCard.tsx` (bereits in F.2 gestartet)

- [ ] **Step 1: aria-live für Position-Updates**

```typescript
// Im queued-Render-Block:
<span
  className="text-xs font-medium text-text-secondary"
  aria-live="polite"
>
  {PIPELINE_UI_STRINGS.waiting(queuePosition)}
</span>
```

- [ ] **Step 2: Pause-Icon vor dem Text**

```typescript
import { Pause } from 'lucide-react'

// Im queued-Block:
<>
  <Pause className="h-3.5 w-3.5 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
  <span className="text-xs font-medium text-text-secondary" aria-live="polite">
    {PIPELINE_UI_STRINGS.waiting(queuePosition)}
  </span>
</>
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SessionCard.tsx
git commit -m "feat(card): waiting state with pause icon + aria-live position"
```

---

### Task K.2: Tests für Wartezustand

**Files:**
- Modify: `src/renderer/src/components/__tests__/SessionCard.test.tsx`

- [ ] **Step 1: Tests für queued-State + Position-Update**

```typescript
it('renders waiting label with position from useTaskProgress', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false, current: null, queuePosition: 2
  })
  render(<SessionCard session={makeSession({ status: 'queued' })} onDelete={vi.fn()} />)
  expect(screen.getByText('Wartet — Position 2')).toBeInTheDocument()
})

it('falls back to plain "Wartet" before queue:positions arrives', () => {
  ;(useTaskProgress as any).mockReturnValue({
    tasks: [], loading: false, current: null, queuePosition: null
  })
  render(<SessionCard session={makeSession({ status: 'queued' })} onDelete={vi.fn()} />)
  expect(screen.getByText('Wartet')).toBeInTheDocument()
})
```

(Im F.2-Render-Block ist „Wartet" ohne Position der Fallback, wenn `queuePosition === null`. Sicherstellen, dass das so implementiert ist.)

- [ ] **Step 2: Tests laufen + Commit**

```bash
vitest run src/renderer/src/components/__tests__/SessionCard.test.tsx
git add src/renderer/src/components/__tests__/SessionCard.test.tsx
git commit -m "test(card): waiting state with + without position broadcast"
```

---

### Task K.3: Manueller Smoke-Test mit Multi-Session-Queue

- [ ] **Step 1: Drei Sessions enqueuen**

```bash
npm run dev
```

Drei Audio-Sessions hintereinander aufnehmen + stoppen, ohne dass eine fertig wird. Sessions 2 und 3 sollten zeigen: „Wartet — Position 1" / „Wartet — Position 2" (Session 1 wird gerade verarbeitet → kein Wartet).

Wenn Session 1 fertig wird: Position 2 → 1, Position 3 → 2.

- [ ] **Step 2: Smoke-Test bestanden — Commit nicht nötig**

---

## Phase L: Empty-Speech (Story 7)

### Task L.1: SessionCard Empty-Speech-Variante

**Files:**
- Modify: `src/renderer/src/components/SessionCard.tsx`

- [ ] **Step 1: In F.2 rendert die Status-Zeile bereits den `Keine Sprache erkannt`-Span — hier nur Body-Text + Info-Icon ergänzen**

In der Status-Zeile aus F.2 Step 5 ein `Info`-Icon vor den Empty-Speech-Span ziehen:

```typescript
// In der Render-Logik aus F.2 Step 5, im wordCount === 0-Branch:
session.wordCount === 0 ? (
  <>
    <Info className="h-3.5 w-3.5 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
    <span className="text-xs font-medium text-text-secondary">
      {PIPELINE_UI_STRINGS.emptySpeechHeadline}
    </span>
  </>
) : (
  // … existing word-count branch
)
```

Dann unterhalb der Status-Zeile (außerhalb des `flex items-center` div, vor dem error-Block) den Body-Text:

```typescript
{session.status === 'review' && session.wordCount === 0 && (
  <p
    className="pointer-events-none relative z-[1] mt-1 line-clamp-2 text-xs text-text-tertiary"
    role="alert"
  >
    {PIPELINE_UI_STRINGS.emptySpeechBody}
  </p>
)}
```

`Info` aus `lucide-react` importieren. **Keine doppelte Headline** — Status-Zeile liefert sie, Body ergänzt nur Kontext.

- [ ] **Step 2: Click-Verhalten unverändert**

Die Karte ist klickbar wie alle Review-Karten — Klick öffnet den Review-Editor mit leerem TipTap-Doc. Kein zusätzlicher CTA nötig.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SessionCard.tsx
git commit -m "feat(card): empty-speech variant with info icon + body text"
```

---

### Task L.2: Tests für Empty-Speech-Variante

**Files:**
- Modify: `src/renderer/src/components/__tests__/SessionCard.test.tsx`

- [ ] **Step 1: Tests**

```typescript
it('renders empty-speech body text when wordCount === 0', () => {
  render(<SessionCard session={makeSession({ wordCount: 0 })} onDelete={vi.fn()} />)
  expect(screen.getByText(/ohne dass Sprache erkannt wurde/)).toBeInTheDocument()
})

it('does not render empty-speech variant when wordCount > 0', () => {
  render(<SessionCard session={makeSession({ wordCount: 5 })} onDelete={vi.fn()} />)
  expect(screen.queryByText(/ohne dass Sprache erkannt wurde/)).toBeNull()
})

it('does not render empty-speech variant for non-review status', () => {
  render(<SessionCard session={makeSession({ status: 'processing', wordCount: 0 })} onDelete={vi.fn()} />)
  expect(screen.queryByText('Keine Sprache erkannt')).toBeNull()
})
```

- [ ] **Step 2: Tests laufen + Commit**

```bash
vitest run src/renderer/src/components/__tests__/SessionCard.test.tsx
git add src/renderer/src/components/__tests__/SessionCard.test.tsx
git commit -m "test(card): empty-speech variant trigger conditions"
```

---

## Phase M: Watchdog + 3-Stufen-Retry-Limit

### Task M.1: `Session.retryCount` inkrementieren bei Retry

**Files:**
- Modify: `src/main/services/TaskQueueService.ts:retrySession()` (suchen)

- [ ] **Step 1: Lokalisiere `retrySession()`**

```bash
grep -n "retrySession" src/main/services/TaskQueueService.ts
```

- [ ] **Step 2: Inkrementieren bei Retry, Reset bei Erfolg**

```typescript
// In retrySession():
const session = this.sessionService.getSession(sessionId)
if (!session) return
this.sessionService.updateSession(sessionId, {
  retryCount: (session.retryCount ?? 0) + 1,
  status: 'queued',
  errorMessage: null
})
// (existing logic to recreate failed tasks)
```

```typescript
// In handleTaskCompletion(), wenn Session 'review' erreicht:
this.sessionService.updateSession(task.sessionId, {
  status: 'review',
  retryCount: 0  // reset
})
```

- [ ] **Step 3: Test**

```typescript
// In TaskQueueService.statusFlow.test.ts:
it('increments retryCount on each retry call', async () => {
  const session = sessions.create({ title: 't', type: 'audio' })
  sessions.updateSession(session.id, { status: 'error', errorMessage: 'mock failure' })
  expect(sessions.getSession(session.id)?.retryCount).toBe(0)
  queue.retrySession(session.id)
  expect(sessions.getSession(session.id)?.retryCount).toBe(1)
  // simulate another failure → another retry
  sessions.updateSession(session.id, { status: 'error', errorMessage: 'mock failure 2' })
  queue.retrySession(session.id)
  expect(sessions.getSession(session.id)?.retryCount).toBe(2)
})

it('resets retryCount to 0 when session reaches review', async () => {
  const session = sessions.create({ title: 't', type: 'audio' })
  sessions.updateSession(session.id, { status: 'error', retryCount: 2, errorMessage: 'foo' })
  queue.retrySession(session.id)
  expect(sessions.getSession(session.id)?.retryCount).toBe(3)
  // Mock executors that all succeed
  queue.enqueue(session.id, [{ type: 'diarization', sessionId: session.id }])
  await queue.drain()
  const final = sessions.getSession(session.id)
  expect(final?.status).toBe('review')
  expect(final?.retryCount).toBe(0)
})
```

- [ ] **Step 4: Commit**

```bash
git add src/main/services/TaskQueueService.ts src/main/services/__tests__/
git commit -m "feat(taskqueue): retryCount increment on retry, reset on review"
```

---

### Task M.2: SessionCard 3-Stufen-Retry-UI

**Files:**
- Modify: `src/renderer/src/components/SessionCard.tsx` — Error-Block

- [ ] **Step 1: Error-Block überarbeiten (Zeilen 169-183)**

```typescript
{session.status === 'error' && (
  <>
    <div className="pointer-events-none relative z-[1] mt-1.5 flex items-center gap-2">
      <AlertTriangle className="h-3.5 w-3.5 text-error-text" strokeWidth={1.75} aria-hidden="true" />
      <span className="text-xs font-medium text-error-text" role="alert">
        {PIPELINE_UI_STRINGS.watchdogHeadline}
      </span>
    </div>
    <p className="pointer-events-none relative z-[1] mt-1 line-clamp-2 text-xs text-text-tertiary">
      {PIPELINE_UI_STRINGS.watchdogBody}
    </p>

    {session.retryCount === 1 && (
      <p className="pointer-events-none relative z-[1] mt-1 text-xs text-text-tertiary">
        {PIPELINE_UI_STRINGS.retryAfterFirstFailure}
      </p>
    )}
    {session.retryCount === 2 && (
      <p className="pointer-events-none relative z-[1] mt-1 text-xs text-text-tertiary">
        {PIPELINE_UI_STRINGS.retryAfterSecondFailure}
      </p>
    )}

    {session.retryCount < 3 && onRetry && (
      <button
        className="pointer-events-auto relative z-10 mt-1.5 text-xs font-medium text-primary hover:text-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onRetry}
        disabled={retryDisabled}
        title={retryDisabled ? 'Eine andere Transkription wird gerade verarbeitet' : undefined}
      >
        {PIPELINE_UI_STRINGS.retryButton}
      </button>
    )}
    {session.retryCount >= 3 && (
      <p className="pointer-events-none relative z-[1] mt-1.5 text-xs text-text-tertiary">
        {PIPELINE_UI_STRINGS.retryExhausted}
      </p>
    )}
  </>
)}
```

`AlertTriangle` aus `lucide-react`.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/SessionCard.tsx
git commit -m "feat(card): 3-stage retry UI with retryCount-driven hints"
```

---

### Task M.3: Tests für Retry-UI

**Files:**
- Modify: `src/renderer/src/components/__tests__/SessionCard.test.tsx`

- [ ] **Step 1: Tests pro Retry-Count-Stufe**

```typescript
it('shows plain Retry button on first failure (retryCount === 0)', () => {
  render(<SessionCard session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 0 })} onDelete={vi.fn()} onRetry={vi.fn()} />)
  expect(screen.getByText('Erneut versuchen')).toBeEnabled()
  expect(screen.queryByText(/Erster Versuch/)).toBeNull()
})

it('shows "Erster Versuch ist fehlgeschlagen" hint on retryCount === 1', () => {
  render(<SessionCard session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 1 })} onDelete={vi.fn()} onRetry={vi.fn()} />)
  expect(screen.getByText('Erster Versuch ist fehlgeschlagen.')).toBeInTheDocument()
  expect(screen.getByText('Erneut versuchen')).toBeEnabled()
})

it('shows escalated hint on retryCount === 2', () => {
  render(<SessionCard session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 2 })} onDelete={vi.fn()} onRetry={vi.fn()} />)
  expect(screen.getByText(/Mehrfach-Fehler/)).toBeInTheDocument()
})

it('disables button and shows support hint on retryCount >= 3', () => {
  render(<SessionCard session={makeSession({ status: 'error', errorMessage: 'foo', retryCount: 3 })} onDelete={vi.fn()} onRetry={vi.fn()} />)
  expect(screen.queryByText('Erneut versuchen')).toBeNull()
  expect(screen.getByText(/Wenden Sie sich an den Support/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Tests laufen + Commit**

```bash
vitest run src/renderer/src/components/__tests__/SessionCard.test.tsx
git add src/renderer/src/components/__tests__/SessionCard.test.tsx
git commit -m "test(card): 3-stage retry UI"
```

---

## Phase N: Wording-Glossar Final Pass

### Task N.1: End-to-end Wording-Audit + Snapshot-Test

**Files:**
- Create: `src/shared/constants/__tests__/pipelineWording.snapshot.test.ts`

- [ ] **Step 1: Snapshot-Test sperrt das Glossar**

```typescript
import { describe, it, expect } from 'vitest'
import { STEP_LABELS_DE, PIPELINE_UI_STRINGS } from '../pipelineWording'

describe('pipelineWording snapshot — locks final glossary (Issue #80 AC#2 + Story 9)', () => {
  it('matches the agreed German glossary', () => {
    expect(STEP_LABELS_DE).toEqual({
      diarization: 'Sprecher unterscheiden',
      transcription: 'Gespräch transkribieren',
      alignment: 'Audio aufbereiten',
      anonymization: 'Persönliche Angaben anonymisieren',
      summarization: 'Zusammenfassung erstellen',
      extraction: 'Text auslesen',
      ocr: 'Schrift erkennen'
    })
  })

  it('uses Sie-form throughout', () => {
    const allText = [...Object.values(STEP_LABELS_DE), ...Object.values(PIPELINE_UI_STRINGS).filter((v) => typeof v === 'string')].join(' ').toLowerCase()
    expect(allText).not.toMatch(/\bdu\b/)
    expect(allText).not.toMatch(/\bdein/)
  })

  it('contains zero ML jargon', () => {
    const allText = [...Object.values(STEP_LABELS_DE), ...Object.values(PIPELINE_UI_STRINGS).filter((v) => typeof v === 'string')].join(' ').toLowerCase()
    const forbidden = ['diarisierung', 'alignment', 'ner', 'whisper', 'pyannote', 'transformer', 'flair', 'llm']
    for (const word of forbidden) {
      expect(allText).not.toContain(word)
    }
  })
})
```

- [ ] **Step 2: Tests laufen**

```bash
vitest run src/shared/constants/__tests__/pipelineWording.snapshot.test.ts
```

- [ ] **Step 3: PO-Sign-off einholen + Commit**

UX und PO bestätigen das Glossar in einem Issue-Comment. Erst danach commit:

```bash
git add src/shared/constants/__tests__/pipelineWording.snapshot.test.ts
git commit -m "test(wording): lock final German pipeline glossary (Story 9)"
```

---

## Verifikation: Acceptance Criteria → Tasks Mapping

| AC | Anforderung | Task(s) |
|---|---|---|
| 1 | Schritt + Schritt-Fortschritt + Gesamt-Restzeit sichtbar | F.2, J.1, J.2 |
| 2 | Laienfreundliche Schritt-Bezeichnungen, keine ML-Begriffe | F.1, N.1 |
| 3 | Wartende Sitzungen zeigen Position | D.4, E.1, F.2, K.1, K.2 |
| 4 | „Keine Sprache erkannt" sichtbar bei wordCount === 0 | L.1, L.2 |
| 5 | Watchdog-Fehler + Retry mit 3-Stufen-Limit | M.1, M.2, M.3 |
| 6 | Summarization conditional (sichtbar nur wenn Modell aktiv) | C.3, H.1, H.2 |
| 7 | Audio + PDF konsistent | F.2, G.1, G.2 |
| 8 | Schritt-Wechsel ohne Phantom-Schritt | D.3, E.1, E.2 (transition state) |

| NFR | Anforderung | Task(s) |
|---|---|---|
| 1 | Schritt-Wechsel <500 ms sichtbar | E.1 (transition timer) |
| 2 | Restzeit ≤30 % Abweichung | I.1, I.2, I.3 (rate-based estimator) |
| 3 | ≤4 Hz Update-Rate | E.3 (backend throttle) |
| 4 | Recovery nach App-Restart | C.1 (orphan recovery filter) |
| 5 | WCAG AA Kontrast | bestehende Theme-Tokens — kein Task nötig |
| 6 | Sie-Form, Deutsch | F.1, N.1 |
| 7 | CSP unverändert | architektonisch garantiert (alle IPC lokal) |
| 8 | Reaktivität | E.3, throttle |

---

## Sequenzierung — empfohlene Bearbeitungs-Reihenfolge

**Wichtig zur Parallelisierung:** Die meisten UI-Phasen (F, G, K, L, M) modifizieren denselben File `src/renderer/src/components/SessionCard.tsx` — teils im selben JSX-Render-Block. Echte Parallelisierung produziert dort 3-Wege-Merge-Konflikte. Die hier dokumentierte Reihenfolge ist **strikt seriell**, ausser wo explizit als parallelisierbar markiert.

1. **Phase 0** (Pre-flight) — seriell, blockiert nichts
2. **Phase A** (Migration 012) — seriell, blockierende Voraussetzung für alles
3. **Phase B** (Backend Status) — seriell, blockiert C/D/E
4. **Phase C** (TaskQueue Refactor) — seriell, blockiert D/E
5. **Phase D** (IPC + Zod-Schemas) — seriell, blockiert E
6. **Phase E** (Hook) — seriell, blockiert F–N
7. **Phase F** (SessionCard Audio Happy Path) — seriell; baut die Render-Struktur, auf der G/H/J/K/L/M aufbauen
8. **Phase G** (SessionCard PDF Happy Path + Migration 013) — seriell **nach F**; G's Smoke-Test-Verifikation zeigt Glossar-Strings, die F.1 + F.2 liefern
9. **Phase H** (Summarization conditional) — kann **parallel zu I** laufen (H.1 ist Backend-Test gegen pre-existing C.3-Code; H.2 modifiziert nur `ModelSettings.tsx` — keine SessionCard-Berührung)
10. **Phase I** (Telemetrie + Estimator, Backend) — kann **parallel zu H** laufen (Backend-only)
11. **Phase J** (Gesamt-Bar + ETA UI) — seriell **nach E + F + I** (renderer-seitig liest aus dem Hook und braucht die F-SessionCard-Struktur; backend-seitig braucht den Estimator aus I)
12. **Phase K** (Wartezustand) — seriell **nach J** (modifiziert SessionCard-JSX im selben Render-Block wie F + J)
13. **Phase L** (Empty-Speech) — seriell **nach K** (selber JSX-Block)
14. **Phase M** (Watchdog + Retry-Limit) — seriell **nach L** (selber JSX-Block, error-Branch direkt unter dem review-Branch von L)
15. **Phase N** (Wording-Sign-off) — letzter Schritt vor Merge

**Visuelles Abhängigkeits-Diagramm:**

```
0 → A → B → C → D → E → F → G
                          ↓
                          → H ─┐
                          → I ─┴→ J → K → L → M → N
```

(H und I parallel zwischen F/G und J; alle UI-Phasen ab K seriell.)

Bei Subagent-Driven-Development: nach jedem Task Review-Checkpoint einlegen, vor allem bei
- **A.3** (Migration auf Live-DB — nicht reversibel ohne Backup-Restore)
- **C.4 Step 4** (Artefakt-Cleanup — kann produktive Files löschen, falls Pfad-Berechnung fehlerhaft)
- **G.1 Step 3** (OCR-Detection-Heuristik — fehlerhafte Detektion produziert dauerhaft falsche `plannedSteps`-Werte für neue PDFs)

Bei Inline-Execution mit batch checkpoints: vor jeder Phase Plan-Re-Read einplanen, weil mehrere Phasen den selben File anfassen und der Plan nur den finalen Soll-Zustand pro Stelle dokumentiert (nicht jede Zwischenversion explizit zeigt).

---

## Out-of-Scope-Reminder

Folgende Punkte sind im Epic explizit **out of scope** und dürfen nicht implementiert werden:
- Pipeline-Anzeige in TitleBar / BottomNav / Tray / Notifications
- Soft-Warning vor Watchdog-Abbruch
- Differenzierte Fehlertexte (Modell fehlt / Speicher voll / Aufnahme zu lang)
- Aufnahmephase als Pipeline-Schritt
- Möglichkeit, Schritte gezielt zu wiederholen / überspringen / konfigurieren
- Patient*innen-Einwilligungs-Sichtbarkeit im Pipeline-Status
- Roh-WAV-Pfade / „Sitzung verwerfen"-Aktion im Empty-Speech-Pfad
- Mehrsprachigkeit (alle Texte ausschliesslich Deutsch)
- Eigener Stop-Button (Cancel via Trash-Button — siehe DR-6)

Falls einer dieser Punkte während der Umsetzung auftaucht: **ablehnen** und im Issue-Kommentar dokumentieren, warum es out of scope ist.
