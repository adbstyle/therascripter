# Patient Dossiers

Story #204 (Epic #192). A patient dossier holds the master data and health information of one patient: first and last name (required), patient dossier ID, birth date, diagnoses, medication and a free note. Later stories assign sessions and PDF documents to dossiers (#205), take them along when a dossier is deleted (#207), start recordings and imports from a dossier (#206) and list recently opened dossiers (#213).

This page describes the backend (main process, shared code, preload) and the user interface (renderer).

## Storage

- Only local, in the SQLite database `~/.therascript/data/therascript.db`, table `dossiers` (migration 020). A dossier is stored as soon as first and last name are given.
- Kept without time limit until the user deletes it or removes Therascript completely. Updates of the app keep every dossier (migration 020 only adds tables and a column).
- Not pseudonymized and not hidden in the pseudonymized view (#204 OOS 1/5). Protection is the same as for the other app data: the FileVault warning at startup.
- Details of the table, the equality rule and the deletion: [storage.md](../architecture/storage.md) («`dossiers`», «Deleting a patient dossier»).

## Rules

| Rule | Where |
|---|---|
| First and last name required; whitespace and invisible characters (U+200B–U+200D, U+FEFF) only count as empty, invisible characters are removed and ignored for equality (AK 2) | `DossierNameSchema` (`src/shared/validation/dossier-schemas.ts`), `DossierService` |
| Names and dossier IDs are equal when they differ only in case, leading/trailing whitespace or umlaut spelling — «Müller» = « mueller » = «MÜLLER», decomposed input (NFD) included (AK 7) | `normalizeDossierKey` (`src/shared/utils/dossier-normalize.ts`), stored in the `*_norm` columns |
| A dossier ID another dossier already has is rejected — on create and on update; the answer names the owner (AK 5) | `DossierService.create/update` → `external-id-taken`; partial unique index as backstop for concurrent requests |
| An empty dossier ID means «no ID»; any number of dossiers may have none | `cleanExternalId` in `DossierService` |
| Same first and last name: `create` answers `duplicate-name` with the other dossiers and creates the dossier when called again with `confirmDuplicate: true`; `update` saves and returns the other dossiers in `duplicates` (AK 6) | `DossierService` |
| Birth date: complete, valid calendar day (29.02. only in leap years, no 31.04.), not after today in the Mac's local time (AK 8) | `PastOrTodayIsoDateSchema`, `isValidIsoDateNotAfter` / `localTodayIso` / `parseSwissDate` (`src/shared/utils/calendar-date.ts`); stored as `YYYY-MM-DD` |
| Diagnoses, medication and note: multi-line free text up to 20 000 characters each (AK 4) | `DossierFreeTextSchema`, table CHECKs |
| Control characters (U+0000–U+001F, U+007F) are rejected in names and dossier ID; in free text only line break (LF, CR) and tab are allowed | `hasControlChars` / `hasControlCharsExceptLineBreaks` in the schemas and in `DossierService` |
| Changes are saved per field (autosave, AK 10); a rejected change saves nothing of that patch | `dossier:update` with a single-field patch |
| The overview is sorted by last name, then first name, ä as ae (AK 12), and shows the number of entries and the day of the latest entry; it carries no diagnoses, medication or note | `DossierRepository.listSummaries` |
| 500 dossiers are listed without noticeable delay (AK 15) | test with 500 rows in `DossierService.test.ts` (budget 1 s — generous so slow CI machines do not flake) |

## Deleting

`dossier:deletePreview` returns what a deletion takes along; `dossier:delete` deletes only if the preview the user confirmed still matches (fingerprint). Sessions assigned only to this dossier are deleted with it via the session deletion of #202; sessions also assigned to another dossier stay. While an exclusively assigned session is being recorded, deleting is refused. The dossier row is deleted with `secure_delete` and followed by a WAL checkpoint, so it is neither findable nor recoverable in the app's files (#204 PC 4); an interrupted deletion of the sessions is completed at the next start (PC 5). Sequence: [storage.md](../architecture/storage.md) «Deleting a patient dossier».

Both confirmation dialogs of «TheraScript vollständig entfernen» — the in-app `ConfirmDialog` in `AboutPage.tsx` and the native one in `system-handlers.ts` — list «Alle Patientendossiers (Stammdaten, Diagnosen, Medikation, Notizen)» (AK 18).

## User interface

| Where | What |
|---|---|
| Sidebar | «Alle Patientendossiers» (route `dossiers`) with a «+» button «Neues Patientendossier». The row stays highlighted on a dossier page; `aria-current="page"` only on the overview. |
| `views/DossiersPage.tsx` | Heading «Patientendossiers» with the count and «Neues Patientendossier»; filter «Nach Vor- oder Nachnamen filtern»; rows «Nachname, Vorname» · «ID · Geburtsdatum» · «N Einträge»/«Keine Einträge» · «Heute»/«Gestern»/«TT.MM.» (other years «TT.MM.JJJJ», none «—»). Order as delivered by `dossier:list` (AK 12). Empty state «Noch keine Patientendossiers» with instructions (AK 13); no match: «Kein Patientendossier passt zu «…».». Arrow keys move between filter and rows. |
| Filter (`utils/dossierFilter.ts`) | Names are normalized once per list with `normalizeDossierKey`; every part of the query must occur in the first OR last name («ann mei» finds Anna Meier, «muell» finds Müller) — AK 14. Not by ID, birth date, diagnoses or medication (OOS 2). `useDeferredValue` keeps typing fluid; 500 rows are rendered without virtualization (AK 15, tests with 500 entries). |
| `components/dossier/NewDossierDialog.tsx` | Opened from the sidebar «+», the overview and its empty state via `useWorkspaceActions().openNewDossier()`. First and last name required (message at the field, focus jumps to the first invalid field), dossier ID and birth date (`TT.MM.JJJJ`, also `3.2.1978`) optional. `external-id-taken` → message at the ID field naming the owner (AK 5); `duplicate-name` → notice with ID/birth date of the other dossiers and the button «Trotzdem anlegen» (sends `confirmDuplicate`, AK 6); changing a name withdraws the notice. A technical error keeps all input. Success: dialog closes, the app opens the new dossier, toast «Patientendossier angelegt». |
| `views/DossierPage.tsx` | `DossierHeader` («Lukas Hofer», «PD-1188 · geboren 03.02.1978 · Keine Einträge» — stored state, reloads on `dossiers:changed`), `DossierHeaderActions` (menu «Weitere Aktionen» → «Patientendossier löschen»; #206 adds buttons here), on the left `DossierTimeline` (placeholder «Noch keine Sitzungen oder PDF-Dokumente zugeordnet.» until #205), on the right `DossierMasterDataForm` (all fields, AK 3/4/9; diagnoses, medication and note as multi-line text areas). |
| Autosave (`hooks/useDossierAutosave.ts`, `stores/dossierDrafts.ts`) | One editor per open dossier in renderer memory (never on disk). Local input is the truth; each field is saved 500 ms after the last keystroke or immediately on blur as a single-field `dossier:update`, strictly one request at a time. Invalid values (empty name, invalid or future birth date, control characters, too long) are not sent and show «… Diese Änderung ist noch nicht gespeichert.» at the field; valid fields still save. `external-id-taken` → message at the field, the rejected value is not resent until it changes. Exceptions/`not-found` → a clear alert with «Erneut versuchen» (except when the dossier no longer exists); input stays. Responses never overwrite the form. Status «Gespeichert / Wird gespeichert … / Nicht gespeichert» in a `role="status"` live region. Same-name notice after a name change (AK 6). Leaving the page or closing the window (`beforeunload`/`pagehide`) sends pending valid changes immediately; an editor with unsaved input or messages survives leaving the page, so returning shows both again (AK 10/11). |
| `components/dossier/DeleteDossierDialog.tsx` | Loads `dossier:deletePreview` on open and on every `sessions:changed`/`dossiers:changed` while open. Title «Patientendossier Lukas Hofer löschen?»; «Gelöscht werden:» lists «N Sitzungen und M PDF-Dokumente samt Text und Zusammenfassung» (when there are exclusive contents) and «Stammdaten, Diagnosen, Medikation und Notiz» (AK 17); «Erhalten bleiben:» lists shared contents «…, die auch im Dossier X liegt/liegen» (at most three names plus «und N weiteren») and «Einträge in der Sperrliste» whenever contents exist (#207 AK 1). Button «Dossier und N Inhalte löschen» or «Dossier löschen»; focus starts on «Abbrechen». `changed` → numbers replaced, nothing deleted, notice; `blocked-recording` or a preview with `blockedByRecording` → «Patientendossier kann gerade nicht gelöscht werden» with the reason, «Schliessen» and «Aufnahme stoppen» (#207 AK 2); an error keeps the dialog open with a message (AK 11). Success: draft discarded, overview (replacing the dossier entry; the navigation also purges it on `dossiers:changed`), toast «Patientendossier gelöscht». |
| Texts | `AboutPage` box «Daten» and the uninstall dialog; README; `website/index.html` (card «Patientendossiers» in «Daten bleiben in Ihrer Hand», FAQ «Wo werden meine Daten gespeichert?»); `website/impressum.html#app-datenschutz` (AK 18/19). |

Accessibility: every field has a label (`*` for required fields is `aria-hidden`, the field is `aria-required`), messages are linked via `aria-describedby` and set `aria-invalid`; `DialogShell` traps Tab focus inside the dialog and returns focus to the previously focused element on close.

## IPC

Channels `dossier:list`, `dossier:get`, `dossier:create`, `dossier:update`, `dossier:deletePreview`, `dossier:delete` and the event `dossiers:changed` — see [ipc-api.md](../architecture/ipc-api.md) «Dossier Handlers». In the renderer: `window.api.dossiers`.

## Tests

- `src/shared/utils/__tests__/dossier-normalize.test.ts`, `calendar-date.test.ts`
- `src/shared/validation/__tests__/dossier-schemas.test.ts`
- `src/main/db/migrations/__tests__/020-patient-dossiers.test.ts` — existing data unchanged, constraints, cascades, behaviour of a `sessions` rebuild
- `src/main/services/__tests__/DossierService.test.ts` — rules above, preview, deletion, interrupted deletion
- `src/main/services/__tests__/DossierService.secureDelete.test.ts` — marker string in `.db` and `-wal`, restart completes an interrupted deletion
- `src/main/services/__tests__/ChangeEvents.test.ts`, `src/main/ipc/__tests__/dossier-handlers.test.ts`
- Renderer: `src/renderer/src/utils/__tests__/dossierFilter.test.ts` (incl. 500 entries), `dossierFormat.test.ts` (labels, delete summary), `src/renderer/src/stores/__tests__/dossierDrafts.test.ts` (autosave rules), `src/renderer/src/views/__tests__/DossiersPage.test.tsx`, `DossierPage.test.tsx`, `src/renderer/src/components/dossier/__tests__/NewDossierDialog.test.tsx`, `DeleteDossierDialog.test.tsx`, `AboutPage.test.tsx`, `AppShell.test.tsx` (sidebar entry, create flow)
