-- Issue #203 — Klartext-Ansicht. Titel und Zusammenfassung enthalten
-- Platzhalter wie [PERSON 1] als blossen Text, ohne entityId.
--
-- *_entity_snapshot: was ein Token beim Schreiben des Texts bedeutete (JSON:
--   Token → Original; null = Token stand im Text, war aber nicht eindeutig
--   auflösbar und bleibt dauerhaft Platzhalter). Die Klartext-Ansicht ersetzt
--   ein Token nur, wenn entity_map ihm noch dieselbe Bedeutung gibt (AK 5).
-- *_plain: Titel/Zusammenfassung in der Klartext-Ansicht, beim Schreiben
--   berechnet (SessionRepository). Die Sitzungsliste liest nur diese Spalten —
--   weder entity_map noch Snapshots. NULL = enthält keinen Platzhalter.
-- Alle vier Spalten enthalten Klarnamen und werden beim Löschen geleert.
ALTER TABLE sessions ADD COLUMN title_entity_snapshot TEXT;
ALTER TABLE sessions ADD COLUMN summary_entity_snapshot TEXT;
ALTER TABLE sessions ADD COLUMN title_plain TEXT;
ALTER TABLE sessions ADD COLUMN summary_plain TEXT;

-- Bestand: Ob sich eine Bedeutung schon vor dem Update geändert hat, ist nicht
-- mehr feststellbar. Festgehalten wird der heutige, eindeutige Stand — ab dem
-- Update erkennt die App jede weitere Änderung.
--
-- Diese Migration darf an keinen Bestandsdaten scheitern: nur gültige
-- JSON-Objekte werden gelesen, nur Einträge, die selbst Objekte sind (CASE
-- vor jedem json_extract — json_extract auf einem String-Eintrag bräche mit
-- «malformed JSON» ab), und nur Text-Werte. Alles andere bleibt NULL.
UPDATE sessions SET title_entity_snapshot = (
  SELECT json_group_object(t.placeholder, t.original)
  FROM (
    SELECT
      json_extract(CASE WHEN e.type = 'object' THEN e.value END, '$.placeholder') AS placeholder,
      MIN(json_extract(CASE WHEN e.type = 'object' THEN e.value END, '$.original')) AS original
    FROM json_each(sessions.entity_map) AS e
    WHERE json_type(CASE WHEN e.type = 'object' THEN e.value END, '$.placeholder') = 'text'
      AND json_type(CASE WHEN e.type = 'object' THEN e.value END, '$.original') = 'text'
    GROUP BY 1
    HAVING COUNT(*) = 1
  ) AS t
  WHERE length(trim(t.original)) > 0
    AND instr(sessions.title, t.placeholder) > 0
)
WHERE instr(title, '[') > 0
  AND entity_map IS NOT NULL
  AND json_valid(entity_map)
  AND json_type(entity_map) = 'object';

UPDATE sessions SET summary_entity_snapshot = (
  SELECT json_group_object(t.placeholder, t.original)
  FROM (
    SELECT
      json_extract(CASE WHEN e.type = 'object' THEN e.value END, '$.placeholder') AS placeholder,
      MIN(json_extract(CASE WHEN e.type = 'object' THEN e.value END, '$.original')) AS original
    FROM json_each(sessions.entity_map) AS e
    WHERE json_type(CASE WHEN e.type = 'object' THEN e.value END, '$.placeholder') = 'text'
      AND json_type(CASE WHEN e.type = 'object' THEN e.value END, '$.original') = 'text'
    GROUP BY 1
    HAVING COUNT(*) = 1
  ) AS t
  WHERE length(trim(t.original)) > 0
    AND instr(sessions.summary, t.placeholder) > 0
)
WHERE summary IS NOT NULL
  AND instr(summary, '[') > 0
  AND entity_map IS NOT NULL
  AND json_valid(entity_map)
  AND json_type(entity_map) = 'object';

-- Ein leeres Objekt trägt nichts bei
UPDATE sessions SET title_entity_snapshot = NULL WHERE title_entity_snapshot = '{}';
UPDATE sessions SET summary_entity_snapshot = NULL WHERE summary_entity_snapshot = '{}';

-- title_plain / summary_plain berechnet runStartupMaintenance einmalig nach
-- den Migrationen (Platzhalter ersetzen ist in SQL nicht sinnvoll lösbar).
INSERT OR IGNORE INTO app_maintenance (task, done_at) VALUES ('placeholder-plain-backfill', NULL);
