import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyTestSchema } from './test-utils'

describe('migration 008 — reset summarization parse errors', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
  })

  afterEach(() => {
    db.close()
  })

  // Helper to insert a session with given status + error_message + anonymized_path
  // (bypassing SessionRepository.update which validates transitions).
  const insert = (input: {
    id: string
    title: string
    status: string
    errorMessage: string | null
    anonymizedPath: string | null
  }): void => {
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, anonymized_path, error_message, created_at, updated_at)
       VALUES (?, ?, 'audio', ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(
      input.id,
      input.title,
      input.status,
      input.anonymizedPath,
      input.errorMessage
    )
  }

  // Migration 008 has already run via applyTestSchema. To test its effect we
  // insert AFTER, then re-run the migration SQL via direct exec.
  const rerunMigration008 = (): void => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '008-reset-summarization-parse-errors.sql'),
      'utf-8'
    )
    db.exec(sql)
  }

  it('resets sessions in error state with the parser-bug error message', () => {
    insert({
      id: 's1',
      title: '[#IES-5047] Test',
      status: 'error',
      errorMessage:
        'Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt. Rohtext: Loading model...',
      anonymizedPath: '/tmp/anonymized/s1.json'
    })

    rerunMigration008()

    const row = db.prepare('SELECT status, error_message FROM sessions WHERE id = ?').get('s1') as {
      status: string
      error_message: string | null
    }
    expect(row.status).toBe('review')
    expect(row.error_message).toBeNull()
  })

  it('does NOT touch sessions in error state with a different error message', () => {
    insert({
      id: 's2',
      title: 'Other failure',
      status: 'error',
      errorMessage: 'whisper-cli exited with code 1',
      anonymizedPath: '/tmp/anonymized/s2.json'
    })

    rerunMigration008()

    const row = db.prepare('SELECT status, error_message FROM sessions WHERE id = ?').get('s2') as {
      status: string
      error_message: string | null
    }
    expect(row.status).toBe('error')
    expect(row.error_message).toBe('whisper-cli exited with code 1')
  })

  it('does NOT touch sessions whose anonymized_path is missing (anonymization itself failed)', () => {
    insert({
      id: 's3',
      title: 'No anonymized doc',
      status: 'error',
      errorMessage:
        'Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt. Rohtext: Loading model...',
      anonymizedPath: null
    })

    rerunMigration008()

    const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get('s3') as {
      status: string
    }
    expect(row.status).toBe('error')
  })

  it('does NOT touch sessions in non-error states even if error_message somehow matches', () => {
    insert({
      id: 's4',
      title: 'Already in review',
      status: 'review',
      errorMessage:
        'Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt. Rohtext: Loading model...',
      anonymizedPath: '/tmp/anonymized/s4.json'
    })

    rerunMigration008()

    const row = db.prepare('SELECT status, error_message FROM sessions WHERE id = ?').get('s4') as {
      status: string
      error_message: string | null
    }
    // Status preserved (was review, stays review). error_message cleared because
    // the WHERE clause matched on text but we filter on status='error' too —
    // this assertion verifies the status filter works.
    expect(row.status).toBe('review')
    expect(row.error_message).toBe(
      'Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt. Rohtext: Loading model...'
    )
  })

  it('is idempotent — running twice has the same effect as once', () => {
    insert({
      id: 's5',
      title: 'Idempotent test',
      status: 'error',
      errorMessage:
        'Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt. Rohtext: Loading model...',
      anonymizedPath: '/tmp/anonymized/s5.json'
    })

    rerunMigration008()
    rerunMigration008()

    const row = db.prepare('SELECT status, error_message FROM sessions WHERE id = ?').get('s5') as {
      status: string
      error_message: string | null
    }
    expect(row.status).toBe('review')
    expect(row.error_message).toBeNull()
  })
})
