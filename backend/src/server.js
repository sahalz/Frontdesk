/**
 * Frontdesk Main Application Server
 * Arvo Systems Support Ticketing System
 */

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './db.js';
import { createCustomerRouter } from './routes/customerRoutes.js';
import { createAgentRouter } from './routes/agentRoutes.js';
import { createManagerRouter } from './routes/managerRoutes.js';
import { createHolidayRouter } from './routes/holidayRoutes.js';
import { createUserRouter } from './routes/userRoutes.js';
import { evaluateLiveBreaches, applyAutoClose } from './services/ticketService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(db = getDatabase()) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Mount API routers
  app.use('/api/customer', createCustomerRouter(db));
  app.use('/api/agent', createAgentRouter(db));
  app.use('/api/manager', createManagerRouter(db));
  app.use('/api/holidays', createHolidayRouter(db));
  app.use('/api/users', createUserRouter(db));

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'Frontdesk API',
      version: '1.0.0',
      time_utc: new Date().toISOString()
    });
  });

  // Serve static frontend assets
  const frontendPath = path.resolve(__dirname, '../../frontend');
  app.use(express.static(frontendPath));

  // Fallback to index.html for SPA
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  return app;
}

// Background scheduler for auto-close and breach monitoring
export function startBackgroundTasks(db) {
  const interval = setInterval(() => {
    try {
      evaluateLiveBreaches(db);
      applyAutoClose(db);
    } catch (err) {
      console.error('[Background Task Error]', err);
    }
  }, 60 * 1000);

  return interval;
}

// If run directly, start server
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT || 3000;
  const db = getDatabase();
  const app = createApp(db);
  const timer = startBackgroundTasks(db);

  const server = app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`Frontdesk Server running on port ${PORT}`);
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`=========================================`);
  });

  process.on('SIGINT', () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
