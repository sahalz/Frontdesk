import pg from 'pg';
import { readFile } from 'node:fs/promises';

const { Pool, types } = pg;
const schema = new URL('./schema.sql', import.meta.url);

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('mrmylkzhugfcbzadeibw');
  }

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    types: {
      getTypeParser(oid, format) {
        if (oid === types.builtins.DATE) return value => value;
        if (oid === types.builtins.TIMESTAMPTZ) {
          const parse = types.getTypeParser(oid, format);
          return value => parse(value).toISOString();
        }
        return types.getTypeParser(oid, format);
      }
    }
  });

  pool.on('error', err => console.error('Idle PostgreSQL connection failed', err));
  return {
    ...databaseQueries(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(databaseQueries(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async initialize() {
      const sql = await readFile(schema, 'utf8');
      await this.transaction(async db => {
        await db.prepare('SELECT pg_advisory_xact_lock(192937813)').get();
        await db.prepare(sql).run();
      });
    },
    close: () => pool.end()
  };
}

export function databaseQueries(client) {
  return {
    prepare(sql) {
      let index = 0;
      const statement = sql.replace(/\?/g, () => '$' + ++index);
      return {
        async get(...params) {
          const { rows } = await client.query(statement, params);
          return rows[0];
        },
        async all(...params) {
          const { rows } = await client.query(statement, params);
          return rows;
        },
        async run(...params) {
          const result = await client.query(statement, params);
          return { changes: result.rowCount ?? result.affectedRows };
        }
      };
    }
  };
}

export function inTransaction(db, work) {
  return db.transaction ? db.transaction(work) : work(db);
}
