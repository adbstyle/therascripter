import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../index'

function migrateUpTo(db: Database.Database, version: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  const current =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ??
    0
  for (const m of migrations.filter((m) => m.version > current && m.version <= version)) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
}

describe('Migration 012 — status reduction + plannedSteps + retryCount', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrateUpTo(db, 11)
  })

  it('collapses legacy in-progress status values to processing', () => {
    const stmt = db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    const now = new Date().toISOString()
    stmt.run('s1', 't', 'audio', 'transcribing', now, now)
    stmt.run('s2', 't', 'audio', 'diarizing', now, now)
    stmt.run('s3', 't', 'pdf', 'extracting', now, now)
    stmt.run('s4', 't', 'pdf', 'anonymizing', now, now)
    stmt.run('s5', 't', 'audio', 'review', now, now)
    stmt.run('s6', 't', 'audio', 'error', now, now)
    stmt.run('s7', 't', 'audio', 'recording', now, now)

    migrateUpTo(db, 12)

    const rows = db.prepare(`SELECT id, status FROM sessions ORDER BY id`).all() as {
      id: string
      status: string
    }[]
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
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('audio1', 't', 'audio', 'transcribing', now, now)
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('pdf1', 't', 'pdf', 'extracting', now, now)
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('done1', 't', 'audio', 'review', now, now)

    migrateUpTo(db, 12)

    const rows = db.prepare(`SELECT id, planned_steps FROM sessions ORDER BY id`).all() as {
      id: string
      planned_steps: string | null
    }[]
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.planned_steps]))
    expect(JSON.parse(byId['audio1']!)).toEqual([
      'diarization',
      'transcription',
      'alignment',
      'anonymization'
    ])
    expect(JSON.parse(byId['pdf1']!)).toEqual(['extraction', 'anonymization'])
    expect(byId['done1']).toBeNull()
  })

  it('adds retry_count column defaulted to 0', () => {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('s1', 't', 'audio', 'review', now, now)

    migrateUpTo(db, 12)

    const row = db.prepare(`SELECT retry_count FROM sessions WHERE id = 's1'`).get() as {
      retry_count: number
    }
    expect(row.retry_count).toBe(0)
  })

  it('is idempotent across re-runs (no-op when already at version 12)', () => {
    migrateUpTo(db, 12)
    expect(() => migrateUpTo(db, 12)).not.toThrow()
  })
})
