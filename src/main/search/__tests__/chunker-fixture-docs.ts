import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'

/**
 * Wandelt Dokumente im Format des Referenz-Sets (Spike #208: `T:`/`K:`/`B:`
 * je Zeile, `#`-Kopfzeile) in TipTap-Dokumente, wie die App sie speichert:
 * ein Absatz pro Beitrag, bei Sitzungen mit Sprecher- und Zeit-Knoten, Namen
 * aus `entities/<doc>.json` als Chips mit ihrem Original. Für den
 * Paritätstest des Chunkers und spätere Abnahmetests (PR S6).
 */

export interface FixtureDoc {
  id: string
  type: 'audio' | 'pdf'
  document: { type: 'doc'; content: unknown[] }
}

interface Entity {
  text: string
  type: string
}

function readEntities(root: string, doc: string): Entity[] {
  const path = join(root, 'entities', `${doc}.json`)
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { entities?: Entity[] }
  return [...(parsed.entities ?? [])].sort((a, b) => b.text.length - a.text.length)
}

/** Text mit Chips an jeder Fundstelle eines Entity-Texts (längste zuerst). */
function inlineWithChips(
  text: string,
  entities: Entity[],
  numbers: Map<string, number>
): unknown[] {
  const nodes: unknown[] = []
  let buffer = ''
  let i = 0
  outer: while (i < text.length) {
    for (const entity of entities) {
      if (entity.text.length > 0 && text.startsWith(entity.text, i)) {
        if (buffer) nodes.push({ type: 'text', text: buffer })
        buffer = ''
        const key = `${entity.type}|${entity.text}`
        if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
        nodes.push({
          type: 'placeholderChip',
          attrs: {
            entityId: key,
            type: entity.type,
            number: numbers.get(key),
            source: 'ner',
            original: entity.text
          }
        })
        i += entity.text.length
        continue outer
      }
    }
    buffer += text[i]
    i++
  }
  if (buffer) nodes.push({ type: 'text', text: buffer })
  return nodes
}

function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export function readFixtureDoc(root: string, path: string): FixtureDoc {
  const id = basename(path, '.txt')
  const entities = readEntities(root, id)
  const numbers = new Map<string, number>()
  const turns: Array<{ role: string; text: string }> = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.trim().length === 0 || line.startsWith('#')) continue
    const sep = line.indexOf(': ')
    turns.push({ role: line.slice(0, sep), text: line.slice(sep + 2) })
  }
  const isReport = turns.every((t) => t.role === 'B')
  const content = turns.map((turn, index) => {
    const inline = inlineWithChips(turn.text, entities, numbers)
    if (isReport) return { type: 'paragraph', content: inline }
    const speaker = turn.role === 'T' ? 'A' : 'B'
    return {
      type: 'paragraph',
      content: [
        { type: 'speakerLabel', attrs: { speaker, label: `Person ${speaker}` } },
        { type: 'text', text: ' ' },
        { type: 'timestamp', attrs: { seconds: index * 7, formatted: formatSeconds(index * 7) } },
        { type: 'text', text: ' ' },
        ...inline
      ]
    }
  })
  return { id, type: isReport ? 'pdf' : 'audio', document: { type: 'doc', content } }
}

/** Alle Dokumente eines Ordners im Referenz-Format, Sitzungen vor Berichten. */
export function readFixtureDocs(root: string): FixtureDoc[] {
  const docs: FixtureDoc[] = []
  for (const dir of ['sessions', 'reports']) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    for (const file of readdirSync(full)
      .filter((f) => f.endsWith('.txt'))
      .sort()) {
      docs.push(readFixtureDoc(root, join(full, file)))
    }
  }
  return docs
}
