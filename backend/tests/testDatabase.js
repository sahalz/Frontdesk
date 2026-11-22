import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { databaseQueries } from '../src/db.js';

const accountIds = new Map(['agent-1', 'agent-2', 'agent-3', 'mgr-1', 'cust-1', 'cust-2'].map(
  (id, index) => [id, '00000000-0000-4000-8000-00000000000' + (index + 1)]
));

export const testAuth = {
  signIn: async (email, password) => {
    const id = email.replace(/@example\.test$/, '');
    if (!['cust-1', 'agent-1'].includes(id) || password !== 'fixture-password') return { status: 400 };
    return {
      status: 200,
      data: { access_token: id, expires_in: 3600, user: { id: accountIds.get(id) } }
    };
  },
  getUser: async token => ({ status: 200, data: { id: accountIds.get(token) } })
};

export function testSessionHeaders(userId) {
  const sessionId = '10000000000000000000000000000001';
  return {
    Cookie: 'frontdesk_session_' + sessionId + '=' + userId,
    'X-Frontdesk-Session': sessionId
  };
}

export async function createTestDatabase() {
  const engine = new PGlite({
    parsers: {
      1082: value => value,
      1184: value => new Date(value).toISOString()
    }
  });
  await engine.exec(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  for (const [id, accountId] of accountIds) {
    const role = id.startsWith('agent') ? 'agent' : id.startsWith('mgr') ? 'manager' : 'customer';
    await engine.query(
      'INSERT INTO users (id, name, email, role, auth_user_id) VALUES ($1, $2, $3, $4, $5)',
      [id, id, id + '@example.test', role, accountId]
    );
  }

  return {
    ...databaseQueries(engine),
    transaction: work => engine.transaction(tx => work(databaseQueries(tx))),
    close: () => engine.close()
  };
}
