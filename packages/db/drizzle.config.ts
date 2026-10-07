import { defineConfig } from 'drizzle-kit';
import { loadEnvFile } from '@wa/core';

/**
 * drizzle-kit reads this to diff the schema against the database and emit
 * SQL into ./drizzle. Those files are committed — the deploy applies them,
 * it never generates them.
 */
loadEnvFile();

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
