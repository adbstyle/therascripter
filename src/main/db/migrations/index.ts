import initialSchema from './001-initial-schema.sql?raw'

export interface Migration {
  version: number
  sql: string
}

export const migrations: Migration[] = [
  { version: 1, sql: initialSchema }
]
