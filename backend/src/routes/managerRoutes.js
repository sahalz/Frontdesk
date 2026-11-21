/**
 * Manager Reporting Routes
 * Implements FR-19: A basic report lists late tickets with the breached clock,
 * time paused and the relevant history.
 */

import express from 'express';
import { evaluateLiveBreaches } from '../services/ticketService.js';
import { serializeAgentTicket } from '../serializers.js';

export function createManagerRouter(db) {
  const router = express.Router();

  // Manager auth check
  router.use(async (req, res, next) => {
    const userId = req.headers['x-user-id'] || req.query.manager_id;
    if (!userId) {
      return res.status(401).json({ error: 'Manager identification required' });
    }
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized: manager role required' });
    }
    req.manager = user;
    next();
  });

  // Late tickets report (FR-19)
  router.get('/reports/late-tickets', async (req, res) => {
    await evaluateLiveBreaches(db);

    const lateTickets = await db.prepare(`
      SELECT t.*, 
             c.name as customer_name, c.email as customer_email,
             a.name as assigned_agent_name
      FROM tickets t
      LEFT JOIN users c ON t.customer_id = c.id
      LEFT JOIN users a ON t.assigned_agent_id = a.id
      WHERE t.response_breached = TRUE OR t.resolution_breached = TRUE
      ORDER BY t.created_at DESC
    `).all();

    const report = await Promise.all(lateTickets.map(async t => {
      // Determine which clock breached
      let breachedClock = 'none';
      if (t.response_breached && t.resolution_breached) breachedClock = 'both';
      else if (t.response_breached) breachedClock = 'response';
      else if (t.resolution_breached) breachedClock = 'resolution';

      // Fetch audit history
      const historyRows = await db.prepare(`
        SELECT id, actor_name, action, details, created_at 
        FROM audit_logs 
        WHERE ticket_id = ? 
        ORDER BY created_at ASC
      `).all(t.id);
      const history = historyRows.map(h => ({
        ...h,
        details: typeof h.details === 'string' ? JSON.parse(h.details) : h.details
      }));

      // Fetch pause intervals
      const pauses = await db.prepare(`
        SELECT * FROM sla_pause_intervals 
        WHERE ticket_id = ? 
        ORDER BY paused_at ASC
      `).all(t.id);

      return {
        ticket: serializeAgentTicket(t),
        breached_clock: breachedClock,
        total_paused_minutes: t.total_paused_minutes || 0,
        pause_intervals: pauses,
        history
      };
    }));

    res.json({
      generated_at: new Date().toISOString(),
      late_tickets_count: report.length,
      report
    });
  });

  // Overall system summary
  router.get('/reports/summary', async (req, res) => {
    await evaluateLiveBreaches(db);

    const total = (await db.prepare('SELECT CAST(COUNT(*) AS INTEGER) AS count FROM tickets').get()).count;
    const open = (await db.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM tickets WHERE status IN ('Open', 'In progress', 'Reopened')").get()).count;
    const waiting = (await db.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM tickets WHERE status = 'Waiting on customer'").get()).count;
    const resolved = (await db.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM tickets WHERE status = 'Resolved'").get()).count;
    const closed = (await db.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM tickets WHERE status = 'Closed'").get()).count;
    const late = (await db.prepare('SELECT CAST(COUNT(*) AS INTEGER) AS count FROM tickets WHERE response_breached = TRUE OR resolution_breached = TRUE').get()).count;

    res.json({
      total_tickets: total,
      open_tickets: open,
      waiting_on_customer: waiting,
      resolved_tickets: resolved,
      closed_tickets: closed,
      late_tickets: late
    });
  });

  return router;
}
