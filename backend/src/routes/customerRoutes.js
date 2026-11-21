/**
 * Customer Routes
 * Strict enforcement of NFR-1 & NFR-2:
 * Customer sees ONLY their own tickets and ONLY public replies.
 */

import express from 'express';
import { createTicket, getTicketById } from '../services/ticketService.js';
import { addCustomerReply } from '../services/messageService.js';
import { serializeCustomerTicket, getCustomerMessages } from '../serializers.js';

export function createCustomerRouter(db) {
  const router = express.Router();

  // Authentication/Customer identification middleware
  router.use((req, res, next) => {
    const customerId = req.headers['x-user-id'] || req.query.customer_id;
    if (!customerId) {
      return res.status(401).json({ error: 'Customer identification required (x-user-id header)' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(customerId);
    if (!user || user.role !== 'customer') {
      return res.status(403).json({ error: 'Unauthorized: valid customer role required' });
    }
    req.customer = user;
    next();
  });

  // Create ticket
  router.post('/tickets', (req, res) => {
    const { subject, description, priority } = req.body;
    if (!subject || !description) {
      return res.status(400).json({ error: 'Subject and description are required' });
    }

    const ticket = createTicket(db, {
      subject,
      description,
      customerId: req.customer.id,
      priority: priority || 'medium'
    });

    res.status(201).json({
      ticket: serializeCustomerTicket(ticket)
    });
  });

  // List customer's tickets
  router.get('/tickets', (req, res) => {
    const tickets = db.prepare(`
      SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC
    `).all(req.customer.id);

    res.json({
      tickets: tickets.map(serializeCustomerTicket)
    });
  });

  // Get single ticket details (Strict allowlist + public messages only)
  router.get('/tickets/:id', (req, res) => {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?').get(
      req.params.id,
      req.customer.id
    );

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found or access denied' });
    }

    // Direct database query for public messages only
    const messages = getCustomerMessages(db, ticket.id);

    res.json({
      ticket: serializeCustomerTicket(ticket),
      messages
    });
  });

  // Customer replies to ticket
  router.post('/tickets/:id/reply', (req, res) => {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?').get(
      req.params.id,
      req.customer.id
    );

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found or access denied' });
    }

    const result = addCustomerReply(db, {
      ticketId: ticket.id,
      customerId: req.customer.id,
      content
    });

    res.json({
      ...result,
      ticket: serializeCustomerTicket(result.ticket)
    });
  });

  return router;
}
