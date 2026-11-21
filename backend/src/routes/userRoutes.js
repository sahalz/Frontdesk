/**
 * Agent assignment directory
 */

import express from 'express';
import { requireRole } from '../auth.js';

export function createUserRouter(db) {
  const router = express.Router();

  router.get('/', requireRole('agent', 'manager'), async (req, res) => {
    const users = await db.prepare("SELECT id, name, role FROM users WHERE role = 'agent' AND auth_user_id IS NOT NULL ORDER BY name").all();
    res.json({ users });
  });

  return router;
}
