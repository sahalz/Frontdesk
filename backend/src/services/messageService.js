/**
 * Message Service for Frontdesk
 * Implements FR-8, FR-9, FR-10, FR-11, FR-12
 * Handles customer replies (clock resumption & reopen) and agent replies/notes.
 */

import { randomUUID } from 'node:crypto';
import { inTransaction } from '../db.js';
import { logAuditEvent } from '../auditLogger.js';
import { updateTicketStatus, createTicket, getHolidaysList, getTicketById } from './ticketService.js';
import { isWithinReopenWindow } from '../slaEngine.js';

export function addCustomerReply(db, input) {
  return inTransaction(db, tx => addCustomerReplyInTransaction(tx, input));
}

async function addCustomerReplyInTransaction(db, { ticketId, customerId, content }) {
  const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ? FOR UPDATE').get(ticketId);
  if (!ticket) return { notFound: true };

  const customer = await db.prepare('SELECT name FROM users WHERE id = ?').get(customerId);
  const customerName = customer ? customer.name : 'Customer';
  const now = new Date();
  const nowIso = now.toISOString();
  const holidays = await getHolidaysList(db);

  // If ticket is Closed, Section 8: "Can an auto-closed ticket be reopened? No. A new linked ticket is created."
  if (ticket.status === 'Closed') {
    const newTicket = await createTicket(db, {
      subject: `Follow-up: ${ticket.subject}`,
      description: content,
      customerId,
      priority: ticket.priority,
      parentTicketId: ticket.id
    });
    return {
      newTicketCreated: true,
      ticket: newTicket,
      message: 'Closed ticket cannot be replied to directly; created a new linked ticket.'
    };
  }

  // If ticket is Resolved, Section 8: "Does a customer reply on a Resolved ticket reopen it? Yes, within the reopen window. Afterwards it creates a new linked ticket."
  if (ticket.status === 'Resolved') {
    if (!isWithinReopenWindow(new Date(ticket.resolved_at), now, holidays)) {
      const newTicket = await createTicket(db, {
        subject: `Follow-up: ${ticket.subject}`,
        description: content,
        customerId,
        priority: ticket.priority,
        parentTicketId: ticket.id
      });
      return {
        newTicketCreated: true,
        ticket: newTicket,
        message: 'Reopen window expired (5 working days); created a new linked ticket.'
      };
    }

    // Within reopen window -> reopen ticket
    await updateTicketStatus(db, ticket.id, 'Reopened', customerId, customerName);
  }

  // If ticket was Waiting on customer, Section 3.3: "The clocks resume when the customer replies."
  if (ticket.status === 'Waiting on customer') {
    await updateTicketStatus(db, ticket.id, 'In progress', customerId, customerName);
  }

  // Insert message (Customer replies are always public_reply)
  const messageId = `msg-${randomUUID()}`;
  await db.prepare(`
    INSERT INTO messages (id, ticket_id, author_id, author_role, type, content, created_at)
    VALUES (?, ?, ?, 'customer', 'public_reply', ?, ?)
  `).run(messageId, ticketId, customerId, content, nowIso);

  // Update ticket updated_at
  await db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso, ticketId);

  await logAuditEvent(db, {
    ticketId,
    actorId: customerId,
    actorName: customerName,
    action: 'public_reply',
    details: { message_id: messageId, excerpt: content.slice(0, 100) }
  });

  return {
    success: true,
    messageId,
    ticket: await getTicketById(db, ticketId)
  };
}

export function addAgentMessage(db, input) {
  return inTransaction(db, tx => addAgentMessageInTransaction(tx, input));
}

async function addAgentMessageInTransaction(db, { ticketId, agentId, type, content }) {
  if (!['public_reply', 'internal_note'].includes(type)) {
    throw new Error("Message type must be 'public_reply' or 'internal_note'");
  }

  const ticket = await db.prepare('SELECT * FROM tickets WHERE id = ? FOR UPDATE').get(ticketId);
  if (!ticket) return { notFound: true };

  const agent = await db.prepare('SELECT name FROM users WHERE id = ?').get(agentId);
  const agentName = agent ? agent.name : 'Agent';
  const now = new Date();
  const nowIso = now.toISOString();

  // Insert message
  const messageId = `msg-${randomUUID()}`;
  await db.prepare(`
    INSERT INTO messages (id, ticket_id, author_id, author_role, type, content, created_at)
    VALUES (?, ?, ?, 'agent', ?, ?, ?)
  `).run(messageId, ticketId, agentId, type, content, nowIso);

  // FR-12: Only a public agent reply counts as the first reply for the response SLA. Internal notes do not.
  if (type === 'public_reply') {
    if (!ticket.first_public_reply_at) {
      let respBreached = ticket.response_breached;
      if (!respBreached && (ticket.waiting_since || nowIso) > ticket.response_deadline) {
        respBreached = true;
        await logAuditEvent(db, {
          ticketId,
          actorId: agentId,
          actorName: agentName,
          action: 'breach',
          details: {
            breached_clock: 'response',
            deadline: ticket.response_deadline,
            replied_at: nowIso
          }
        });
      }

      await db.prepare(`
        UPDATE tickets
        SET first_public_reply_at = ?, response_breached = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, respBreached, nowIso, ticketId);
    } else {
      await db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso, ticketId);
    }

    await logAuditEvent(db, {
      ticketId,
      actorId: agentId,
      actorName: agentName,
      action: 'public_reply',
      details: { message_id: messageId, excerpt: content.slice(0, 100) }
    });
  } else {
    // Internal note
    await db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso, ticketId);

    await logAuditEvent(db, {
      ticketId,
      actorId: agentId,
      actorName: agentName,
      action: 'internal_note',
      details: { message_id: messageId, excerpt: content.slice(0, 100) }
    });
  }

  return {
    success: true,
    messageId,
    ticket: await getTicketById(db, ticketId)
  };
}
