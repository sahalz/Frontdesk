import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { databaseQueries } from '../src/db.js';

export async function createTestDatabase() {
  const engine = new PGlite({
    parsers: {
      1082: value => value,
      1184: value => new Date(value).toISOString()
    }
  });
  await engine.exec(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  return {
    ...databaseQueries(engine),
    transaction: work => engine.transaction(tx => work(databaseQueries(tx))),
    close: () => engine.close()
  };
}
