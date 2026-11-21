/**
 * Customer Routes
 * Strict enforcement of NFR-1 & NFR-2:
 * Customer sees ONLY their own tickets and ONLY public replies.
 */

import express from 'express';
import { requireRole } from '../auth.js';
import { createTicket, getTicketById } from '../services/ticketService.js';
import { addCustomerReply } from '../services/messageService.js';
import { serializeCustomerTicket, getCustomerMessages } from '../serializers.js';

export function createCustomerRouter(db) {
  const router = express.Router();

  router.use(requireRole('customer'));

  // Create ticket
  router.post('/tickets', async (req, res) => {
    const { subject, description, priority } = req.body;
    if (!subject || !description) {
      return res.status(400).json({ error: 'Subject and description are required' });
    }

    const ticket = await createTicket(db, {
      subject,
      description,
      customerId: req.user.id,
      priority: priority || 'medium'
    });

    res.status(201).json({
      ticket: serializeCustomerTicket(ticket)
    });
  });

  // List customer's tickets
  router.get('/tickets', async (req, res) => {
    const tickets = await db.prepare(`
      SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC
    `).all(req.user.id);

    res.json({
      tickets: tickets.map(serializeCustomerTicket)
    });
  });

  // Get single ticket details (Strict allowlist + public messages only)
  router.get('/tickets/:id', async (req, res) => {
    const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?').get(
      req.params.id,
      req.user.id
    );

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found or access denied' });
    }

    // Direct database query for public messages only
    const messages = await getCustomerMessages(db, ticket.id);

    res.json({
      ticket: serializeCustomerTicket(ticket),
      messages
    });
  });

  // Customer replies to ticket
  router.post('/tickets/:id/reply', async (req, res) => {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?').get(
      req.params.id,
      req.user.id
    );

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found or access denied' });
    }

    const result = await addCustomerReply(db, {
      ticketId: ticket.id,
      customerId: req.user.id,
      content
    });

    res.json({
      ...result,
      ticket: serializeCustomerTicket(result.ticket)
    });
  });

  return router;
}
