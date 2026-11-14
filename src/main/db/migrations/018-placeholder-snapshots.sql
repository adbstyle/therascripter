-- Issue #203 — Klartext-Ansicht: Titel und Zusammenfassung enthalten
-- Platzhalter wie [PERSON 1] als blossen Text, ohne entityId. Was ein Token
-- beim Schreiben des Texts bedeutete, halten diese Spalten fest (JSON:
-- Token → Original, nur Tokens, die im Text vorkommen). Die Klartext-Ansicht
-- ersetzt ein Token nur, wenn seine aktuelle Bedeutung in entity_map dieser
-- Momentaufnahme entspricht (AK 5).
ALTER TABLE sessions ADD COLUMN title_entity_snapshot TEXT;
ALTER TABLE sessions ADD COLUMN summary_entity_snapshot TEXT;

-- Bestand: Wann eine Bedeutung sich seit dem Erstellen geändert hat, ist für
-- bestehende Sitzungen nicht mehr feststellbar. Festgehalten wird deshalb
-- der heutige, eindeutige Stand — ab dem Update erkennt die App jede weitere
-- Änderung. Tokens, die entity_map mehrdeutig oder ohne Original führt,
-- bleiben aussen vor und erscheinen auch im Klartext als Platzhalter.
UPDATE sessions SET title_entity_snapshot = (
  SELECT json_group_object(
    json_extract(e.value, '$.placeholder'),
    json_extract(e.value, '$.original')
  )
  FROM json_each(sessions.entity_map) AS e
  WHERE json_type(e.value, '$.placeholder') = 'text'
    AND json_type(e.value, '$.original') = 'text'
    AND length(trim(json_extract(e.value, '$.original'))) > 0
    AND instr(sessions.title, json_extract(e.value, '$.placeholder')) > 0
    AND (
      SELECT COUNT(*) FROM json_each(sessions.entity_map) AS d
      WHERE json_extract(d.value, '$.placeholder') = json_extract(e.value, '$.placeholder')
    ) = 1
)
WHERE instr(title, '[') > 0
  AND entity_map IS NOT NULL
  AND json_valid(entity_map)
  AND json_type(entity_map) = 'object';

UPDATE sessions SET summary_entity_snapshot = (
  SELECT json_group_object(
    json_extract(e.value, '$.placeholder'),
    json_extract(e.value, '$.original')
  )
  FROM json_each(sessions.entity_map) AS e
  WHERE json_type(e.value, '$.placeholder') = 'text'
    AND json_type(e.value, '$.original') = 'text'
    AND length(trim(json_extract(e.value, '$.original'))) > 0
    AND instr(sessions.summary, json_extract(e.value, '$.placeholder')) > 0
    AND (
      SELECT COUNT(*) FROM json_each(sessions.entity_map) AS d
      WHERE json_extract(d.value, '$.placeholder') = json_extract(e.value, '$.placeholder')
    ) = 1
)
WHERE summary IS NOT NULL
  AND instr(summary, '[') > 0
  AND entity_map IS NOT NULL
  AND json_valid(entity_map)
  AND json_type(entity_map) = 'object';
