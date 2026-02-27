import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'

const databaseUrl = process.env.DATABASE_URL?.trim()
export const isDatabaseConfigured = Boolean(databaseUrl)

const unavailableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('Database is not configured. Set DATABASE_URL to enable database-backed APIs.')
    },
  }
) as ReturnType<typeof drizzle>

const sql = isDatabaseConfigured ? neon(databaseUrl!) : null
export const db = sql ? drizzle(sql) : unavailableDb
