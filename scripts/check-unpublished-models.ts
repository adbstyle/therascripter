#!/usr/bin/env -S npx tsx
/**
 * Release-Vorbedingung (Epic #192, Review PR #224): bricht mit Exit 1 ab,
 * solange ein Pflichtmodell im Katalog noch `published: false` trägt.
 *
 *   npx tsx scripts/check-unpublished-models.ts
 *
 * README und Website beschreiben ab dem Merge nach main den Zielzustand
 * (Download inkl. Suchmodell). Ein Release mit unveröffentlichtem Suchmodell
 * hiesse: Texte und App stimmen nicht überein. Vorgehen zum Veröffentlichen:
 * docs/product/operations/model-pipeline.md, «Publishing a new model».
 * release.sh übersteuert nur mit --allow-unpublished-models "<Begründung>".
 */
import { MODEL_DEFINITIONS, unpublishedRequiredModels } from '../src/shared/model-catalog'

const ids = unpublishedRequiredModels(MODEL_DEFINITIONS)
if (ids.length > 0) {
  console.error(
    `❌ Pflichtmodell(e) noch nicht veröffentlicht (published: false): ${ids.join(', ')}`
  )
  console.error('   Erst hochladen, Werte des hochgeladenen Objekts prüfen, Schalter umlegen —')
  console.error('   docs/product/operations/model-pipeline.md, «Publishing a new model».')
  process.exit(1)
}
console.log('✓ Alle Pflichtmodelle im Katalog sind veröffentlicht.')
