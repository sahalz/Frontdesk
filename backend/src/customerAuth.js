import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const sessionLifetime = 60 * 60 * 1000;
const tokenPrefix = 'customer.';
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function isCustomerToken(token) {
  return token?.startsWith(tokenPrefix);
}

export async function registerCustomer(db, userId, password) {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt, 64, scryptOptions);
  return db.transaction(async tx => {
    const user = await tx.prepare(`
      INSERT INTO users (id, name, role)
      VALUES (?, ?, 'customer')
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `).get(userId, userId);
    if (!user) return false;

    await tx.prepare(`
      INSERT INTO customer_credentials (user_id, password_salt, password_hash)
      VALUES (?, ?, ?)
    `).run(userId, salt.toString('hex'), hash.toString('hex'));
    return true;
  });
}

export async function startCustomerSession(db, account, password) {
  const { id, name, role, password_salt: salt, password_hash: hash } = account;
  if (role !== 'customer' || !salt || !hash) return null;
  const expected = Buffer.from(hash, 'hex');
  const actual = await deriveKey(password, Buffer.from(salt, 'hex'), expected.length, scryptOptions);
  if (!timingSafeEqual(expected, actual)) return null;

  const token = tokenPrefix + randomBytes(32).toString('base64url');
  await db.prepare(`
    INSERT INTO customer_sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, NOW() + interval '1 hour')
  `).run(hashToken(token), id);

  return { token, maxAge: sessionLifetime, user: { id, name, role } };
}

export function findCustomerSession(db, token) {
  return db.prepare(`
    SELECT u.id, u.name, u.role
    FROM customer_sessions AS s
    JOIN users AS u ON u.id = s.user_id
    JOIN customer_credentials AS c ON c.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.role = 'customer' AND u.auth_user_id IS NULL
  `).get(hashToken(token));
}

export function endCustomerSession(db, token) {
  return db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function removeExpiredCustomerSessions(db) {
  return db.prepare('DELETE FROM customer_sessions WHERE expires_at <= NOW()').run();
}
