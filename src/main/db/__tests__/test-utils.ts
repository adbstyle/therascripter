import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'

const migrationsDir = join(__dirname, '..', 'migrations')

export function applyTestSchema(db: Database.Database): void {
  db.exec(readFileSync(join(migrationsDir, '001-initial-schema.sql'), 'utf-8'))
  db.exec(readFileSync(join(migrationsDir, '002-add-diarization-path.sql'), 'utf-8'))
  db.exec(readFileSync(join(migrationsDir, '003-add-review-at.sql'), 'utf-8'))
  db.exec(readFileSync(join(migrationsDir, '004-add-task-cancelled-status.sql'), 'utf-8'))
  db.exec(
    readFileSync(
      join(migrationsDir, '005-add-aligned-transcript-and-extracted-paths.sql'),
      'utf-8'
    )
  )
}
