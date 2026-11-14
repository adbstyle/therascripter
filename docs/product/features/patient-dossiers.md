# Patient Dossiers

Story #204 (Epic #192). A patient dossier holds the master data and health information of one patient: first and last name (required), patient dossier ID, birth date, diagnoses, medication and a free note. Later stories assign sessions and PDF documents to dossiers (#205), take them along when a dossier is deleted (#207), start recordings and imports from a dossier (#206) and list recently opened dossiers (#213).

This page describes the backend (main process, shared code, preload). The user interface is added by the UI part of #204.

## Storage

- Only local, in the SQLite database `~/.therascript/data/therascript.db`, table `dossiers` (migration 020). A dossier is stored as soon as first and last name are given.
- Kept without time limit until the user deletes it or removes Therascript completely. Updates of the app keep every dossier (migration 020 only adds tables and a column).
- Not pseudonymized and not hidden in the pseudonymized view (#204 OOS 1/5). Protection is the same as for the other app data: the FileVault warning at startup.
- Details of the table, the equality rule and the deletion: [storage.md](../architecture/storage.md) («`dossiers`», «Deleting a patient dossier»).

## Rules

| Rule | Where |
|---|---|
| First and last name required; whitespace only counts as empty (AK 2) | `DossierNameSchema` (`src/shared/validation/dossier-schemas.ts`), `DossierService` |
| Names and dossier IDs are equal when they differ only in case, leading/trailing whitespace or umlaut spelling — «Müller» = « mueller » = «MÜLLER», decomposed input (NFD) included (AK 7) | `normalizeDossierKey` (`src/shared/utils/dossier-normalize.ts`), stored in the `*_norm` columns |
| A dossier ID another dossier already has is rejected — on create and on update; the answer names the owner (AK 5) | `DossierService.create/update` → `external-id-taken`; partial unique index as backstop for concurrent requests |
| An empty dossier ID means «no ID»; any number of dossiers may have none | `cleanExternalId` in `DossierService` |
| Same first and last name: `create` answers `duplicate-name` with the other dossiers and creates the dossier when called again with `confirmDuplicate: true`; `update` saves and returns the other dossiers in `duplicates` (AK 6) | `DossierService` |
| Birth date: complete, valid calendar day (29.02. only in leap years, no 31.04.), not after today in the Mac's local time (AK 8) | `PastOrTodayIsoDateSchema`, `isValidIsoDateNotAfter` / `localTodayIso` / `parseSwissDate` (`src/shared/utils/calendar-date.ts`); stored as `YYYY-MM-DD` |
| Diagnoses, medication and note: multi-line free text up to 20 000 characters each (AK 4) | `DossierFreeTextSchema`, table CHECKs |
| Changes are saved per field (autosave, AK 10); a rejected change saves nothing of that patch | `dossier:update` with a single-field patch |
| The overview is sorted by last name, then first name, ä as ae (AK 12), and shows the number of entries and the day of the latest entry; it carries no diagnoses, medication or note | `DossierRepository.listSummaries` |
| 500 dossiers are listed without noticeable delay (AK 15) | test with 500 rows in `DossierService.test.ts` (budget 100 ms) |

## Deleting

`dossier:deletePreview` returns what a deletion takes along; `dossier:delete` deletes only if the preview the user confirmed still matches (fingerprint). Sessions assigned only to this dossier are deleted with it via the session deletion of #202; sessions also assigned to another dossier stay. While an exclusively assigned session is being recorded, deleting is refused. The dossier row is deleted with `secure_delete` and followed by a WAL checkpoint, so it is neither findable nor recoverable in the app's files (#204 PC 4); an interrupted deletion of the sessions is completed at the next start (PC 5). Sequence: [storage.md](../architecture/storage.md) «Deleting a patient dossier».

The native confirmation dialog of «TheraScript vollständig entfernen» (`system-handlers.ts`) lists «Alle Patientendossiers (Stammdaten, Diagnosen, Medikation, Notizen)» (AK 18).

## IPC

Channels `dossier:list`, `dossier:get`, `dossier:create`, `dossier:update`, `dossier:deletePreview`, `dossier:delete` and the event `dossiers:changed` — see [ipc-api.md](../architecture/ipc-api.md) «Dossier Handlers». In the renderer: `window.api.dossiers`.

## Tests

- `src/shared/utils/__tests__/dossier-normalize.test.ts`, `calendar-date.test.ts`
- `src/shared/validation/__tests__/dossier-schemas.test.ts`
- `src/main/db/migrations/__tests__/020-patient-dossiers.test.ts` — existing data unchanged, constraints, cascades, behaviour of a `sessions` rebuild
- `src/main/services/__tests__/DossierService.test.ts` — rules above, preview, deletion, interrupted deletion
- `src/main/services/__tests__/DossierService.secureDelete.test.ts` — marker string in `.db` and `-wal`, restart completes an interrupted deletion
- `src/main/services/__tests__/ChangeEvents.test.ts`, `src/main/ipc/__tests__/dossier-handlers.test.ts`
