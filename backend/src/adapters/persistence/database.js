// backend/src/adapters/persistence/database.js

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` silently does
 * nothing on a database that already exists, so a schema-only change would never
 * reach a running install.
 *
 * @type {Array<{ table: string, column: string, definition: string }>}
 */
const ADDED_COLUMNS = [
  { table: 'messages', column: 'llm_reviewed_at', definition: 'TEXT' },
  { table: 'messages', column: 'moderation_reasons', definition: 'TEXT' },
  { table: 'messages', column: 'handle_censored', definition: 'INTEGER NOT NULL DEFAULT 0' }
];

/**
 * @param {DatabaseSync} db
 */
function applyMigrations(db) {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));

    if (!existing.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

/**
 * Opens the database and brings the schema up to date.
 *
 * @param {string} [location] file path, or ":memory:" for tests
 * @returns {DatabaseSync}
 */
export function createDatabase(location = ':memory:') {
  const db = new DatabaseSync(location);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  applyMigrations(db);
  return db;
}
