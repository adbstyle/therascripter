/**
 * Messskript Suchindex (Epic #192, PR S3): synthetischer Bestand in einer
 * Datei-DB, Dauer der Textphase pro Sitzung, Grösse der DB, Dauer der
 * exakten Suche für typische Anfragen.
 *
 *   npm rebuild better-sqlite3   # System-Node-ABI (wie vor npm test)
 *   npx tsx scripts/search-bench.ts [--sessions 2000] [--dir <ordner>]
 *
 * Wortschatz: das Referenz-Set (THERASCRIPT_SEARCH_REFERENCE_DIR, sonst
 * tests/fixtures/search-reference), ersatzweise die fiktiven Dokumente des
 * Chunker-Paritätstests. Jede zehnte Sitzung ist ein PDF-Bericht mit 1'500
 * Wörtern, die übrigen sind 50-Minuten-Sitzungen (151 Wörter/min, ADR-008).
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SearchIndexService } from '../src/main/search/SearchIndexService'
import { SearchService } from '../src/main/search/SearchService'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const SESSIONS = Number(arg('sessions', '2000'))
const DIR = arg('dir', join(tmpdir(), 'therascript-search-bench'))
const ROOT = join(__dirname, '..')
const SESSION_WORDS = 50 * 151
const REPORT_WORDS = 1500
const WORDS_PER_TURN = 30

function vocabulary(): string[] {
  const candidates = [
    process.env.THERASCRIPT_SEARCH_REFERENCE_DIR,
    join(ROOT, 'tests', 'fixtures', 'search-reference'),
    join(ROOT, 'src', 'main', 'search', '__tests__', 'fixtures', 'chunker-docs')
  ].filter((p): p is string => !!p && existsSync(p))
  const words: string[] = []
  for (const dir of ['sessions', 'reports'].map((d) => join(candidates[0], d))) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
      for (const line of readFileSync(join(dir, file), 'utf-8').split('\n')) {
        if (line.startsWith('#') || !line.includes(': ')) continue
        words.push(
          ...line
            .slice(line.indexOf(': ') + 2)
            .split(/\s+/)
            .filter(Boolean)
        )
      }
    }
  }
  console.log(`Wortschatz: ${candidates[0]} (${words.length} Wörter)`)
  return words
}

/** Deterministischer Zufall (mulberry32). */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeDocument(words: string[], total: number, pdf: boolean, random: () => number): unknown {
  const content: unknown[] = []
  let written = 0
  let turn = 0
  while (written < total) {
    const start = Math.floor(random() * (words.length - WORDS_PER_TURN))
    const text = words.slice(start, start + WORDS_PER_TURN).join(' ')
    const inline: unknown[] = []
    if (!pdf) {
      const speaker = turn % 2 === 0 ? 'A' : 'B'
      inline.push({ type: 'speakerLabel', attrs: { speaker, label: `Person ${speaker}` } })
      inline.push({ type: 'text', text: ' ' })
      inline.push({ type: 'timestamp', attrs: { seconds: turn * 12, formatted: '00:00:00' } })
      inline.push({ type: 'text', text: ' ' })
    }
    inline.push({ type: 'text', text })
    if (turn % 7 === 0) {
      inline.push({ type: 'text', text: ' mit ' })
      inline.push({
        type: 'placeholderChip',
        attrs: {
          entityId: 'p1',
          type: 'PERSON',
          number: 1,
          source: 'ner',
          original: 'Anna Beispiel'
        }
      })
    }
    content.push({ type: 'paragraph', content: inline })
    written += WORDS_PER_TURN
    turn++
  }
  return { type: 'doc', content }
}

function migrate(db: Database.Database): void {
  const dir = join(ROOT, 'src', 'main', 'db', 'migrations')
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(dir, file), 'utf-8'))
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function main(): void {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  const dbPath = join(DIR, 'bench.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('secure_delete = ON')
  migrate(db)

  const words = vocabulary()
  const random = rng(42)
  const docs = new Map<string, unknown>()
  const insert = db.prepare(
    `INSERT INTO sessions (id, title, type, status, anonymized_path, summary, created_at, updated_at, search_rev)
     VALUES (?, ?, ?, 'review', ?, ?, ?, '2026-01-01T00:00:00.000Z', 1)`
  )
  db.transaction(() => {
    for (let i = 0; i < SESSIONS; i++) {
      const pdf = i % 10 === 9
      const id = `s${String(i).padStart(5, '0')}`
      const path = `/bench/${id}.json`
      docs.set(path, makeDocument(words, pdf ? REPORT_WORDS : SESSION_WORDS, pdf, random))
      const created = new Date(Date.parse('2024-01-01') + i * 3_600_000).toISOString()
      insert.run(
        id,
        `Sitzung ${i}`,
        pdf ? 'pdf' : 'audio',
        path,
        'Zusammenfassung der Sitzung.',
        created
      )
    }
  })()

  const indexer = new SearchIndexService(db, {
    now: () => Date.parse('2026-06-01'),
    readDocument: (path) => docs.get(path)
  })
  const perSession: number[] = []
  const started = performance.now()
  for (;;) {
    const t = performance.now()
    const { indexed, more } = indexer.runTextPhase(1)
    if (indexed > 0) perSession.push(performance.now() - t)
    if (!more) break
  }
  const indexSeconds = (performance.now() - started) / 1000
  db.pragma('wal_checkpoint(TRUNCATE)')
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM search_chunks').get() as { n: number }).n
  const textBytes = (
    db.prepare('SELECT SUM(length(CAST(text AS BLOB))) AS b FROM search_chunks').get() as {
      b: number
    }
  ).b
  const dbBytes = statSync(dbPath).size

  console.log(`Sitzungen: ${SESSIONS}, Abschnitte: ${chunks}`)
  console.log(
    `Textphase: gesamt ${indexSeconds.toFixed(1)} s, pro Sitzung Median ${median(perSession).toFixed(1)} ms, ` +
      `p95 ${[...perSession].sort((a, b) => a - b)[Math.floor(perSession.length * 0.95)].toFixed(1)} ms, ` +
      `max ${Math.max(...perSession).toFixed(1)} ms`
  )
  console.log(
    `DB-Datei: ${(dbBytes / 1e6).toFixed(0)} MB (Abschnittstext ${(textBytes / 1e6).toFixed(0)} MB)`
  )

  const search = new SearchService(db)
  const queries = [
    'angst',
    'ich habe',
    'Prüfungsangst',
    'schlafen',
    'Anna Beispiel',
    'und',
    'ab',
    'xq'
  ]
  for (const query of queries) {
    const times: number[] = []
    let hits = 0
    for (let r = 0; r < 5; r++) {
      const t = performance.now()
      const result = search.query({ requestId: r, query, scope: { kind: 'all' } })
      times.push(performance.now() - t)
      hits = result.results.length
    }
    console.log(
      `Suche «${query}»: Median ${median(times).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms, ${hits} Dokumente`
    )
  }
  db.close()
}

main()
