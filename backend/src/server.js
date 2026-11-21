/**
 * Frontdesk Main Application Server
 * Arvo Systems Support Ticketing System
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { configureAuth, createSupabaseAuth } from './auth.js';
import { removeExpiredCustomerSessions } from './customerAuth.js';
import { createCustomerRouter } from './routes/customerRoutes.js';
import { createAgentRouter } from './routes/agentRoutes.js';
import { createManagerRouter } from './routes/managerRoutes.js';
import { createHolidayRouter } from './routes/holidayRoutes.js';
import { createUserRouter } from './routes/userRoutes.js';
import { evaluateLiveBreaches, applyAutoClose } from './services/ticketService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(db, { auth = createSupabaseAuth() } = {}) {
  const app = express();

  app.get('/api/health', async (req, res) => {
    try {
      await db.prepare('SELECT 1 FROM config_sla LIMIT 1').get();
      res.json({ status: 'ok', service: 'Frontdesk API', version: '1.0.0', time_utc: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(express.json());
  configureAuth(app, db, auth);
  app.use('/api/customer', createCustomerRouter(db));
  app.use('/api/agent', createAgentRouter(db));
  app.use('/api/manager', createManagerRouter(db));
  app.use('/api/holidays', createHolidayRouter(db));
  app.use('/api/users', createUserRouter(db));

  // Serve static frontend assets
  const frontendPath = path.resolve(__dirname, '../../frontend');
  app.use(express.static(frontendPath));

  // Fallback to index.html for SPA
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  return app;
}

// Background scheduler for auto-close and breach monitoring
export function startBackgroundTasks(db) {
  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await evaluateLiveBreaches(db);
      await applyAutoClose(db);
      await removeExpiredCustomerSessions(db);
    } catch (err) {
      console.error('[Background Task Error]', err);
    } finally {
      running = false;
    }
  }, 60 * 1000);

  return interval;
}

// If run directly, initialize PostgreSQL before accepting requests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDatabase();
  try {
    await db.initialize();
  } catch (err) {
    await db.close();
    throw err;
  }

  const port = process.env.PORT || 3000;
  const app = createApp(db);
  const timer = startBackgroundTasks(db);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Frontdesk is listening on port ${port}`);
  });

  function shutdown() {
    clearInterval(timer);
    server.close(() => void db.close());
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
