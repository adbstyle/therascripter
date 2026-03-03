import initialSchema from './001-initial-schema.sql?raw'
import addDiarizationPath from './002-add-diarization-path.sql?raw'
import addReviewAt from './003-add-review-at.sql?raw'

export interface Migration {
  version: number
  sql: string
}

export const migrations: Migration[] = [
  { version: 1, sql: initialSchema },
  { version: 2, sql: addDiarizationPath },
  { version: 3, sql: addReviewAt }
]
