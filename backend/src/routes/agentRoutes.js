/**
 * Agent Routes
 * Implements ticket claiming (atomic 409 conflict), reassignment,
 * messaging (notes and replies), status & priority changes.
 */

import express from 'express';
import { requireRole } from '../auth.js';
import {
  claimTicket,
  reassignTicket,
  updateTicketStatus,
  updateTicketPriority,
  getTicketById,
  evaluateLiveBreaches,
  applyAutoClose
} from '../services/ticketService.js';
import { addAgentMessage } from '../services/messageService.js';
import { serializeAgentTicket, getAgentMessages } from '../serializers.js';

export function createAgentRouter(db) {
  const router = express.Router();

  router.use(requireRole('agent', 'manager'));

  // List all tickets with SLA breach indicators
  router.get('/tickets', async (req, res) => {
    // Run live breach evaluation and auto-close check
    await evaluateLiveBreaches(db);
    await applyAutoClose(db);

    const filter = req.query.filter; // 'all', 'mine', 'unassigned', 'late', 'waiting'

    let sql = `
      SELECT t.*, 
             c.name as customer_name, c.email as customer_email,
             a.name as assigned_agent_name
      FROM tickets t
      LEFT JOIN users c ON t.customer_id = c.id
      LEFT JOIN users a ON t.assigned_agent_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (filter === 'mine') {
      sql += ' AND t.assigned_agent_id = ?';
      params.push(req.user.id);
    } else if (filter === 'unassigned') {
      sql += ' AND t.assigned_agent_id IS NULL';
    } else if (filter === 'late') {
      sql += ' AND (t.response_breached = TRUE OR t.resolution_breached = TRUE)';
    } else if (filter === 'waiting') {
      sql += " AND t.status = 'Waiting on customer'";
    }

    sql += ' ORDER BY (t.response_breached = TRUE OR t.resolution_breached = TRUE) DESC, t.created_at DESC';

    const tickets = await db.prepare(sql).all(...params);

    const enhanced = tickets.map(t => {
      const isLate = t.response_breached || t.resolution_breached;
      const isWaiting = t.status === 'Waiting on customer';
      return {
        ...serializeAgentTicket(t),
        is_late: isLate,
        is_waiting: isWaiting,
        breached_clock: isLate ? (t.response_breached && t.resolution_breached ? 'both' : (t.response_breached ? 'response' : 'resolution')) : null
      };
    });

    res.json({ tickets: enhanced });
  });

  // Ticket Detail View (Conversation, audit history, pause intervals)
  router.get('/tickets/:id', async (req, res) => {
    const ticket = await getTicketById(db, req.params.id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const messages = await getAgentMessages(db, ticket.id);
    const auditRows = await db.prepare(`
      SELECT * FROM audit_logs WHERE ticket_id = ? ORDER BY created_at ASC
    `).all(ticket.id);
    const auditLogs = auditRows.map(log => ({
      ...log,
      details: typeof log.details === 'string' ? JSON.parse(log.details) : log.details
    }));

    const pauseIntervals = await db.prepare(`
      SELECT * FROM sla_pause_intervals WHERE ticket_id = ? ORDER BY paused_at ASC
    `).all(ticket.id);

    res.json({
      ticket: serializeAgentTicket(ticket),
      messages,
      auditLogs,
      pauseIntervals
    });
  });

  // Atomic Claim Ticket (FR-5, FR-6)
  router.post('/tickets/:id/claim', async (req, res) => {
    const result = await claimTicket(db, req.params.id, req.user.id);

    if (result.notFound) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (result.conflict) {
      // FR-6: HTTP 409 with clear message
      return res.status(409).json({
        error: 'Conflict',
        message: 'This ticket has already been claimed by another agent.',
        currentAssignedAgentId: result.currentAssignedAgentId
      });
    }

    res.json({
      success: true,
      message: 'Ticket claimed successfully',
      ticket: serializeAgentTicket(result.ticket)
    });
  });

  // Reassign Ticket (FR-7)
  router.post('/tickets/:id/reassign', async (req, res) => {
    const { newAgentId } = req.body;
    if (!newAgentId) {
      return res.status(400).json({ error: 'newAgentId is required' });
    }

    const result = await reassignTicket(db, req.params.id, newAgentId, req.user.id);
    if (result.notFound) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({
      success: true,
      message: 'Ticket reassigned successfully',
      ticket: serializeAgentTicket(result.ticket)
    });
  });

  // Change Status (FR-18)
  router.post('/tickets/:id/status', async (req, res) => {
    const { status } = req.body;
    const allowed = ['Open', 'In progress', 'Waiting on customer', 'Resolved', 'Closed', 'Reopened'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }

    const result = await updateTicketStatus(db, req.params.id, status, req.user.id, req.user.name);
    if (result.notFound) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (result.error) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      ticket: serializeAgentTicket(result.ticket)
    });
  });

  // Change Priority (FR-18, Section 3.6)
  router.post('/tickets/:id/priority', async (req, res) => {
    const { priority } = req.body;
    const allowed = ['urgent', 'medium', 'low'];
    if (!allowed.includes(priority)) {
      return res.status(400).json({ error: `Invalid priority. Allowed: ${allowed.join(', ')}` });
    }

    const result = await updateTicketPriority(db, req.params.id, priority, req.user.id, req.user.name);
    if (result.notFound) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({
      success: true,
      ticket: serializeAgentTicket(result.ticket)
    });
  });

  // Add Public Reply or Internal Note (FR-8, FR-9, FR-12)
  router.post('/tickets/:id/message', async (req, res) => {
    const { type, content } = req.body;
    if (!type || !['public_reply', 'internal_note'].includes(type)) {
      return res.status(400).json({ error: "type must be 'public_reply' or 'internal_note'" });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    const result = await addAgentMessage(db, {
      ticketId: req.params.id,
      agentId: req.user.id,
      type,
      content
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({
      success: true,
      messageId: result.messageId,
      ticket: serializeAgentTicket(result.ticket)
    });
  });

  return router;
}
