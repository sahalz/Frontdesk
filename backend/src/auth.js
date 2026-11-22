import { randomBytes } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import {
  endCustomerSession,
  findCustomerSession,
  isCustomerToken,
  registerCustomer,
  startCustomerSession
} from './customerAuth.js';

export function createSupabaseAuth({
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_PUBLISHABLE_KEY
} = {}) {
  async function request(path, { token, body } = {}) {
    if (!url || !key) return { status: 503 };
    try {
      const endpoint = new URL('/auth/v1/' + path, url);
      if (endpoint.protocol !== 'https:') return { status: 503 };

      const response = await fetch(endpoint, {
        method: body ? 'POST' : 'GET',
        headers: {
          apikey: key,
          ...(token && { Authorization: 'Bearer ' + token }),
          ...(body && { 'Content-Type': 'application/json' })
        },
        body: body && JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });
      return { status: response.status, data: response.ok ? await response.json() : null };
    } catch {
      return { status: 503 };
    }
  }

  return {
    signIn: (email, password) => request('token?grant_type=password', { body: { email, password } }),
    getUser: token => request('user', { token })
  };
}

const cookiePrefix = 'frontdesk_session_';
const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/api'
};

function readTabSession(req) {
  const sessionId = req.get('X-Frontdesk-Session');
  if (!/^[0-9a-f]{32}$/.test(sessionId || '')) return {};
  const name = cookiePrefix + sessionId;
  const token = req.get('Cookie')?.match(new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9._-]+)(?:;|$)'))?.[1];
  return { name, token };
}

function sendSession(res, user, token, maxAge) {
  const sessionId = randomBytes(16).toString('hex');
  res.cookie(cookiePrefix + sessionId, token, { ...cookieOptions, maxAge });
  return res.json({ user, sessionId });
}

export function configureAuth(app, db, auth) {
  const findUser = authId => db.prepare(
    'SELECT id, name, role FROM users WHERE auth_user_id = ?'
  ).get(authId);

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const limitAttempts = rateLimit({
    windowMs: 60_000,
    limit: 15,
    message: { error: 'Too many attempts. Try again in a minute.' }
  });

  app.post('/api/customer-accounts', limitAttempts, async (req, res) => {
    const { userId, password } = req.body || {};
    const id = typeof userId === 'string' ? userId.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(id)) {
      return res.status(400).json({ error: 'Use 3 to 64 lowercase letters, numbers, hyphens, or underscores for your user ID.' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: 'Use a password that is 6 to 128 characters long.' });
    }

    if (!await registerCustomer(db, id, password)) {
      return res.status(409).json({ error: 'That user ID is already taken.' });
    }
    res.status(201).json({ userId: id });
  });

  app.post('/api/session', limitAttempts, async (req, res) => {
    const { userId, password, role } = req.body || {};
    if (typeof userId !== 'string' || !userId.trim() || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'User ID and password are required.' });
    }

    if (role !== undefined && !['customer', 'agent', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'Choose Customer, Agent, or Manager.' });
    }

    const account = await db.prepare(
      `SELECT u.id, u.name, u.role, u.email, u.auth_user_id, c.password_salt, c.password_hash
       FROM users AS u LEFT JOIN customer_credentials AS c ON c.user_id = u.id
       WHERE u.id = ?`
    ).get(userId.trim());

    if (role !== undefined && account?.role !== role) {
      return res.status(401).json({ error: 'Invalid user ID or password for the selected role.' });
    }

    if (account?.password_hash && !account.auth_user_id) {
      if (password.length > 128) return res.status(401).json({ error: 'Invalid user ID or password.' });
      const session = await startCustomerSession(db, account, password);
      if (!session) return res.status(401).json({ error: 'Invalid user ID or password.' });

      return sendSession(res, session.user, session.token, session.maxAge);
    }

    if (!account?.auth_user_id) {
      return res.status(401).json({ error: 'Invalid user ID or password.' });
    }

    const { status, data } = await auth.signIn(account.email, password);
    if (status === 429) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    if (status >= 500) return res.status(503).json({ error: 'Sign-in is unavailable.' });
    if (!data?.access_token || data.user?.id !== account.auth_user_id) {
      return res.status(401).json({ error: 'Invalid user ID or password.' });
    }

    const user = await findUser(account.auth_user_id);
    if (user?.id !== account.id || (role !== undefined && user.role !== role)) {
      return res.status(401).json({ error: 'Invalid user ID or password.' });
    }

    return sendSession(res, user, data.access_token, data.expires_in * 1000);
  });

  app.delete('/api/session', async (req, res) => {
    const { name, token } = readTabSession(req);
    if (isCustomerToken(token)) await endCustomerSession(db, token);
    if (name) res.clearCookie(name, cookieOptions);
    res.sendStatus(204);
  });

  app.use('/api', async (req, res, next) => {
    const { token } = readTabSession(req);
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' });

    if (isCustomerToken(token)) {
      const user = await findCustomerSession(db, token);
      if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
      req.user = user;
      return next();
    }

    const { status, data } = await auth.getUser(token);
    if (status >= 500 || status === 429) return res.status(503).json({ error: 'Sign-in verification is unavailable.' });
    if (!data?.id) return res.status(401).json({ error: 'Session expired. Sign in again.' });

    const user = await findUser(data.id);
    if (!user) return res.status(403).json({ error: 'This account has no Frontdesk access.' });
    req.user = user;
    next();
  });

  app.get('/api/session', (req, res) => res.json({ user: req.user }));
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role cannot access this resource.' });
    }
    next();
  };
}
