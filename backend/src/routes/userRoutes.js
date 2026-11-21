/**
 * Users and Persona Switcher Routes
 */

import express from 'express';

export function createUserRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY role, name').all();
    res.json({ users });
  });

  return router;
}
