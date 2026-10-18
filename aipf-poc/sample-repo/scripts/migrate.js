// Applies migrations/NNN_*.sql in order, once each. Applied migrations are never edited;
// a change to the schema is a new file with the next number.
import { readdir, readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';

const dir = new URL('../migrations/', import.meta.url);
const db = createPool();
try {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, dir), 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await db.query('COMMIT');
      process.stdout.write(`applied ${file}\n`);
    } catch (error) {
      await db.query('ROLLBACK');
      throw new Error(`${file}: ${error.message}`);
    }
  }
} finally {
  await db.end();
}
