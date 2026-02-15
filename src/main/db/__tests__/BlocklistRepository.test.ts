import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BlocklistRepository } from '../repositories/BlocklistRepository'

function applySchema(db: Database.Database): void {
  const sql = readFileSync(
    join(__dirname, '..', 'migrations', '001-initial-schema.sql'),
    'utf-8'
  )
  db.exec(sql)
}

describe('BlocklistRepository', () => {
  let db: Database.Database
  let repo: BlocklistRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchema(db)
    repo = new BlocklistRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('findAll', () => {
    it('returns empty array when no entries exist', () => {
      expect(repo.findAll()).toEqual([])
    })

    it('returns entries ordered by created_at ascending', () => {
      repo.create('Zürich', 'ORT')
      repo.create('Dr. Müller', 'PERSON')

      const all = repo.findAll()

      expect(all).toHaveLength(2)
      expect(all[0].term).toBe('Zürich')
      expect(all[1].term).toBe('Dr. Müller')
    })
  })

  describe('findById', () => {
    it('returns the entry when found', () => {
      const created = repo.create('Zürich', 'ORT')
      const found = repo.findById(created.id)

      expect(found).toEqual(created)
    })

    it('returns null for non-existent id', () => {
      expect(repo.findById('non-existent')).toBeNull()
    })
  })

  describe('create', () => {
    it('creates an entry with a UUID', () => {
      const entry = repo.create('Zürich', 'ORT')

      expect(entry.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )
      expect(entry.term).toBe('Zürich')
      expect(entry.placeholderType).toBe('ORT')
      expect(entry.createdAt).toBeTruthy()
    })

    it('supports all 7 placeholder types', () => {
      const types = [
        'PERSON',
        'ORT',
        'DATUM',
        'KONTAKT',
        'ORGANISATION',
        'MEDIZINISCH',
        'SONSTIGES'
      ] as const

      for (const type of types) {
        const entry = repo.create(`Test ${type}`, type)
        expect(entry.placeholderType).toBe(type)
      }

      expect(repo.findAll()).toHaveLength(7)
    })

    it('supports multi-word terms', () => {
      const entry = repo.create('Dr. Hans Müller-Meier', 'PERSON')
      expect(entry.term).toBe('Dr. Hans Müller-Meier')
    })

    it('supports terms with Umlauts', () => {
      const entry = repo.create('Zürich Hönggerberg', 'ORT')
      expect(entry.term).toBe('Zürich Hönggerberg')
    })
  })

  describe('update', () => {
    it('updates term and placeholderType', () => {
      const entry = repo.create('Zürich', 'ORT')
      const updated = repo.update(entry.id, 'Bern', 'ORT')

      expect(updated?.term).toBe('Bern')
      expect(updated?.placeholderType).toBe('ORT')
    })

    it('changes placeholder type', () => {
      const entry = repo.create('Klinik Hirslanden', 'SONSTIGES')
      const updated = repo.update(entry.id, 'Klinik Hirslanden', 'ORGANISATION')

      expect(updated?.placeholderType).toBe('ORGANISATION')
    })

    it('preserves createdAt on update', () => {
      const entry = repo.create('Zürich', 'ORT')
      const updated = repo.update(entry.id, 'Bern', 'ORT')

      expect(updated?.createdAt).toBe(entry.createdAt)
    })

    it('returns null for non-existent id', () => {
      expect(repo.update('non-existent', 'Test', 'PERSON')).toBeNull()
    })
  })

  describe('delete', () => {
    it('deletes an existing entry', () => {
      const entry = repo.create('Zürich', 'ORT')

      expect(repo.delete(entry.id)).toBe(true)
      expect(repo.findById(entry.id)).toBeNull()
    })

    it('returns false for non-existent entry', () => {
      expect(repo.delete('non-existent')).toBe(false)
    })

    it('does not affect other entries', () => {
      const e1 = repo.create('Zürich', 'ORT')
      const e2 = repo.create('Dr. Müller', 'PERSON')

      repo.delete(e1.id)

      expect(repo.findAll()).toHaveLength(1)
      expect(repo.findById(e2.id)).toBeTruthy()
    })
  })
})
