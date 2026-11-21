/**
 * Holiday Routes
 * Provides management of festival holidays stored in editable table (Section 3.2).
 */

import express from 'express';

export function createHolidayRouter(db) {
  const router = express.Router();

  // List holidays
  router.get('/', async (req, res) => {
    const holidays = await db.prepare('SELECT * FROM holidays ORDER BY date ASC').all();
    res.json({ holidays });
  });

  // Add holiday
  router.post('/', async (req, res) => {
    const { date, name } = req.body;
    if (!date || !name) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) and name are required' });
    }

    // Validate format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    }

    try {
      const now = new Date().toISOString();
      const stmt = db.prepare('INSERT INTO holidays (date, name, created_at) VALUES (?, ?, ?)');
      await stmt.run(date, name, now);
      res.status(201).json({ success: true, message: 'Holiday added' });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Holiday for this date already exists' });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Delete holiday
  router.delete('/:id', async (req, res) => {
    const stmt = db.prepare('DELETE FROM holidays WHERE id = ?');
    const info = await stmt.run(req.params.id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Holiday not found' });
    }
    res.json({ success: true, message: 'Holiday removed' });
  });

  return router;
}
