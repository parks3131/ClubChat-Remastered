import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://clubchat:clubchat@localhost:5432/clubchat',
  },
  // Migrations are the schema's source of truth and must replay cleanly from zero.
  // A correction is always a NEW numbered migration; an applied migration is never
  // edited (AGENTS.md non-negotiable 2).
  strict: true,
  verbose: true,
});
