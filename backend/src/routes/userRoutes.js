/**
 * Users and Persona Switcher Routes
 */

import express from 'express';

export function createUserRouter(db) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const users = await db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY role, name').all();
    res.json({ users });
  });

  return router;
}
