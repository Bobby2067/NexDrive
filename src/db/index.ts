import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing in environment variables');
}

// Neon serverless HTTP driver — one connection per request, no pool needed
const sql = neon(process.env.DATABASE_URL);

// Export the Drizzle db instance
export const db = drizzle(sql, { schema });

// Re-export for convenience
export * as schema from './schema';
