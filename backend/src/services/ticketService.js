/**
 * Ticket Service for Frontdesk
 * Implements all SLA state machine rules, atomic operations,
 * audit logging, and edge case handling.
 */

import { randomUUID } from 'node:crypto';
import {
  calculateInitialDeadlines,
  recalculateOnPriorityChange,
  calculateElapsedWorkingMinutes,
  addWorkingMinutes,
  isAutoCloseDue,
  isWithinReopenWindow
} from '../slaEngine.js';
import { logAuditEvent } from '../auditLogger.js';

export function getHolidaysList(db) {
  const rows = db.prepare('SELECT date FROM holidays').all();
  return rows.map(r => r.date);
}

/**
 * Checks open tickets against current time to flag any new breaches.
 */
export function evaluateLiveBreaches(db, holidays = null) {
  if (!holidays) holidays = getHolidaysList(db);
  const now = new Date();
  const nowIso = now.toISOString();

  const tickets = db.prepare(`
    SELECT * FROM tickets 
    WHERE status NOT IN ('Resolved', 'Closed')
  `).all();

  for (const t of tickets) {
    let changed = false;
    let respBreached = t.response_breached === 1;
    let resBreached = t.resolution_breached === 1;

    // Check response SLA breach if no public reply yet
    if (!t.first_public_reply_at && !respBreached && nowIso > t.response_deadline) {
      respBreached = true;
      changed = true;
      logAuditEvent(db, {
        ticketId: t.id,
        action: 'breach',
        details: { breached_clock: 'response', deadline: t.response_deadline, detected_at: nowIso }
      });
    }

    // Check resolution SLA breach
    if (!resBreached && nowIso > t.resolution_deadline) {
      resBreached = true;
      changed = true;
      logAuditEvent(db, {
        ticketId: t.id,
        action: 'breach',
        details: { breached_clock: 'resolution', deadline: t.resolution_deadline, detected_at: nowIso }
      });
    }

    if (changed) {
      db.prepare(`
        UPDATE tickets 
        SET response_breached = ?, resolution_breached = ?, updated_at = ?
        WHERE id = ?
      `).run(respBreached ? 1 : 0, resBreached ? 1 : 0, nowIso, t.id);
    }
  }
}

/**
 * Applies auto-close to tickets waiting on customer for >= 5 working days.
 */
export function applyAutoClose(db) {
  const holidays = getHolidaysList(db);
  const now = new Date();
  const nowIso = now.toISOString();

  const waitingTickets = db.prepare(`
    SELECT * FROM tickets WHERE status = 'Waiting on customer' AND waiting_since IS NOT NULL
  `).all();

  const closed = [];
  for (const t of waitingTickets) {
    if (isAutoCloseDue(new Date(t.waiting_since), now, holidays)) {
      // Transition to Closed
      db.prepare(`
        UPDATE tickets
        SET status = 'Closed', closed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, t.id);

      logAuditEvent(db, {
        ticketId: t.id,
        action: 'auto_close',
        details: {
          waiting_since: t.waiting_since,
          closed_at: nowIso,
          reason: 'Customer did not reply within 5 working days'
        }
      });
      closed.push(t.id);
    }
  }
  return closed;
}

/**
 * Creates a new ticket.
 */
export function createTicket(db, {
  subject,
  description,
  customerId,
  priority = 'medium',
  parentTicketId = null
}) {
  const holidays = getHolidaysList(db);
  const now = new Date();
  const nowIso = now.toISOString();
  const ticketId = `TCK-${randomUUID().slice(0, 8).toUpperCase()}`;

  const { responseDeadline, resolutionDeadline } = calculateInitialDeadlines(now, priority, holidays);

  const stmt = db.prepare(`
    INSERT INTO tickets (
      id, subject, description, customer_id, priority, status,
      parent_ticket_id, created_at, updated_at,
      response_deadline, resolution_deadline,
      total_paused_minutes, response_breached, resolution_breached
    ) VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, 0, 0, 0)
  `);

  stmt.run(
    ticketId,
    subject,
    description,
    customerId,
    priority,
    parentTicketId,
    nowIso,
    nowIso,
    responseDeadline.toISOString(),
    resolutionDeadline.toISOString()
  );

  const customer = db.prepare('SELECT name FROM users WHERE id = ?').get(customerId);
  const customerName = customer ? customer.name : 'Customer';

  logAuditEvent(db, {
    ticketId,
    actorId: customerId,
    actorName: customerName,
    action: 'ticket_creation',
    details: {
      subject,
      priority,
      parent_ticket_id: parentTicketId,
      response_deadline: responseDeadline.toISOString(),
      resolution_deadline: resolutionDeadline.toISOString()
    }
  });

  return getTicketById(db, ticketId);
}

export function getTicketById(db, ticketId) {
  evaluateLiveBreaches(db);
  return db.prepare(`
    SELECT t.*, 
           c.name as customer_name, c.email as customer_email,
           a.name as assigned_agent_name, a.email as assigned_agent_email
    FROM tickets t
    LEFT JOIN users c ON t.customer_id = c.id
    LEFT JOIN users a ON t.assigned_agent_id = a.id
    WHERE t.id = ?
  `).get(ticketId);
}

/**
 * Claims a ticket atomically (FR-5, FR-6).
 * Exactly one succeeds; conflicting agent gets { conflict: true }.
 */
export function claimTicket(db, ticketId, agentId) {
  const nowIso = new Date().toISOString();
  const agent = db.prepare('SELECT id, name FROM users WHERE id = ?').get(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  // Atomic conditional update
  const stmt = db.prepare(`
    UPDATE tickets 
    SET assigned_agent_id = ?, status = CASE WHEN status = 'Open' THEN 'In progress' ELSE status END, updated_at = ?
    WHERE id = ? AND assigned_agent_id IS NULL
  `);

  const info = stmt.run(agentId, nowIso, ticketId);

  if (info.changes === 0) {
    // Check if it was already assigned
    const currentTicket = db.prepare('SELECT assigned_agent_id FROM tickets WHERE id = ?').get(ticketId);
    if (!currentTicket) {
      return { notFound: true };
    }
    return {
      conflict: true,
      currentAssignedAgentId: currentTicket.assigned_agent_id
    };
  }

  logAuditEvent(db, {
    ticketId,
    actorId: agentId,
    actorName: agent.name,
    action: 'claim',
    details: { claimed_by: agent.name, agent_id: agentId }
  });

  return { success: true, ticket: getTicketById(db, ticketId) };
}

/**
 * Reassigns ticket explicitly (FR-7).
 */
export function reassignTicket(db, ticketId, newAgentId, actorId) {
  const nowIso = new Date().toISOString();
  const newAgent = db.prepare('SELECT name FROM users WHERE id = ?').get(newAgentId);
  const actor = db.prepare('SELECT name FROM users WHERE id = ?').get(actorId);

  if (!newAgent) throw new Error('Target agent not found');

  const oldTicket = db.prepare('SELECT assigned_agent_id FROM tickets WHERE id = ?').get(ticketId);
  if (!oldTicket) return { notFound: true };

  db.prepare(`
    UPDATE tickets 
    SET assigned_agent_id = ?, updated_at = ?
    WHERE id = ?
  `).run(newAgentId, nowIso, ticketId);

  logAuditEvent(db, {
    ticketId,
    actorId,
    actorName: actor ? actor.name : 'System',
    action: 'reassignment',
    details: {
      from_agent_id: oldTicket.assigned_agent_id,
      to_agent_id: newAgentId,
      to_agent_name: newAgent.name
    }
  });

  return { success: true, ticket: getTicketById(db, ticketId) };
}

/**
 * Updates status and manages SLA pause/resume intervals (FR-2, 3.3).
 */
export function updateTicketStatus(db, ticketId, newStatus, actorId, actorName = 'Agent') {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return { notFound: true };

  const holidays = getHolidaysList(db);
  const now = new Date();
  const nowIso = now.toISOString();

  // Reopen check
  if (ticket.status === 'Resolved' && newStatus === 'Reopened') {
    if (!isWithinReopenWindow(new Date(ticket.resolved_at), now, holidays)) {
      return {
        error: 'Reopen window expired',
        message: 'Tickets can only be reopened within 5 working days of resolution. A new ticket must be created.'
      };
    }
  }

  // Auto-close check
  if (ticket.status === 'Closed' && newStatus === 'Reopened') {
    return {
      error: 'Cannot reopen closed ticket',
      message: 'Auto-closed tickets cannot be reopened. A new linked ticket must be created.'
    };
  }

  let totalPaused = ticket.total_paused_minutes || 0;
  let responseDeadline = new Date(ticket.response_deadline);
  let resolutionDeadline = new Date(ticket.resolution_deadline);
  let waitingSince = ticket.waiting_since;
  let resolvedAt = ticket.resolved_at;
  let closedAt = ticket.closed_at;

  // Transitioning INTO 'Waiting on customer' -> PAUSE CLOCK
  if (newStatus === 'Waiting on customer' && ticket.status !== 'Waiting on customer') {
    waitingSince = nowIso;
    const intervalId = `psi-${randomUUID()}`;
    db.prepare(`
      INSERT INTO sla_pause_intervals (id, ticket_id, paused_at)
      VALUES (?, ?, ?)
    `).run(intervalId, ticketId, nowIso);

    logAuditEvent(db, {
      ticketId,
      actorId,
      actorName,
      action: 'pause',
      details: { reason: 'Status changed to Waiting on customer', paused_at: nowIso }
    });
  }

  // Transitioning OUT of 'Waiting on customer' -> RESUME CLOCK
  if (ticket.status === 'Waiting on customer' && newStatus !== 'Waiting on customer') {
    const activeInterval = db.prepare(`
      SELECT * FROM sla_pause_intervals 
      WHERE ticket_id = ? AND resumed_at IS NULL 
      ORDER BY paused_at DESC LIMIT 1
    `).get(ticketId);

    if (activeInterval) {
      const pausedStart = new Date(activeInterval.paused_at);
      const pausedWorkingMinutes = calculateElapsedWorkingMinutes(pausedStart, now, holidays);

      db.prepare(`
        UPDATE sla_pause_intervals 
        SET resumed_at = ?, working_minutes_paused = ?
        WHERE id = ?
      `).run(nowIso, pausedWorkingMinutes, activeInterval.id);

      if (pausedWorkingMinutes > 0) {
        totalPaused += pausedWorkingMinutes;
        responseDeadline = addWorkingMinutes(responseDeadline, pausedWorkingMinutes, holidays);
        resolutionDeadline = addWorkingMinutes(resolutionDeadline, pausedWorkingMinutes, holidays);
      }

      logAuditEvent(db, {
        ticketId,
        actorId,
        actorName,
        action: 'resume',
        details: {
          resumed_at: nowIso,
          working_minutes_paused: pausedWorkingMinutes,
          new_response_deadline: responseDeadline.toISOString(),
          new_resolution_deadline: resolutionDeadline.toISOString()
        }
      });
    }
    waitingSince = null;
  }

  // Handling Resolved status
  if (newStatus === 'Resolved') {
    resolvedAt = nowIso;
    if (nowIso > ticket.resolution_deadline) {
      db.prepare('UPDATE tickets SET resolution_breached = 1 WHERE id = ?').run(ticketId);
    }
  }

  // Handling Reopened status from Resolved:
  // Exclude time spent in Resolved state (treat as paused working time) so that a ticket
  // sitting Resolved for several days before reopening is not immediately marked late.
  let resolutionBreached = ticket.resolution_breached;
  if (ticket.status === 'Resolved' && newStatus === 'Reopened') {
    if (ticket.resolved_at) {
      const resolvedStart = new Date(ticket.resolved_at);
      const resolvedWorkingMinutes = calculateElapsedWorkingMinutes(resolvedStart, now, holidays);

      const intervalId = `psi-${randomUUID()}`;
      db.prepare(`
        INSERT INTO sla_pause_intervals (id, ticket_id, paused_at, resumed_at, working_minutes_paused)
        VALUES (?, ?, ?, ?, ?)
      `).run(intervalId, ticketId, ticket.resolved_at, nowIso, resolvedWorkingMinutes);

      if (resolvedWorkingMinutes > 0) {
        totalPaused += resolvedWorkingMinutes;
        resolutionDeadline = addWorkingMinutes(resolutionDeadline, resolvedWorkingMinutes, holidays);
        if (!ticket.first_public_reply_at) {
          responseDeadline = addWorkingMinutes(responseDeadline, resolvedWorkingMinutes, holidays);
        }
      }

      // If the ticket was resolved within deadline initially, reopening with paused time excluded
      // preserves the on-time status if current time is within the new extended resolution deadline.
      if (nowIso <= resolutionDeadline.toISOString() && new Date(ticket.resolved_at) <= new Date(ticket.resolution_deadline)) {
        resolutionBreached = 0;
      }
    }
    resolvedAt = null;
  }

  // Handling Closed status
  if (newStatus === 'Closed') {
    closedAt = nowIso;
  }

  db.prepare(`
    UPDATE tickets 
    SET status = ?, 
        waiting_since = ?, 
        total_paused_minutes = ?,
        response_deadline = ?,
        resolution_deadline = ?,
        resolution_breached = ?,
        resolved_at = ?,
        closed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    newStatus,
    waitingSince,
    totalPaused,
    responseDeadline.toISOString(),
    resolutionDeadline.toISOString(),
    resolutionBreached,
    resolvedAt,
    closedAt,
    nowIso,
    ticketId
  );

  logAuditEvent(db, {
    ticketId,
    actorId,
    actorName,
    action: 'status_change',
    details: { old_status: ticket.status, new_status: newStatus }
  });

  return { success: true, ticket: getTicketById(db, ticketId) };
}

/**
 * Changes ticket priority (Section 3.6, FR-18).
 * Recomputes deadlines from original start. A downgrade never removes an existing breach.
 */
export function updateTicketPriority(db, ticketId, newPriority, actorId, actorName = 'Agent') {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return { notFound: true };

  const holidays = getHolidaysList(db);
  const now = new Date();
  const nowIso = now.toISOString();

  const recomputed = recalculateOnPriorityChange({
    createdAt: new Date(ticket.created_at),
    newPriority,
    totalPausedMinutes: ticket.total_paused_minutes || 0,
    holidays,
    currentTime: now,
    currentResponseBreached: ticket.response_breached === 1,
    currentResolutionBreached: ticket.resolution_breached === 1,
    firstPublicReplyAt: ticket.first_public_reply_at ? new Date(ticket.first_public_reply_at) : null,
    resolvedAt: ticket.resolved_at ? new Date(ticket.resolved_at) : null
  });

  db.prepare(`
    UPDATE tickets 
    SET priority = ?,
        response_deadline = ?,
        resolution_deadline = ?,
        response_breached = ?,
        resolution_breached = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    newPriority,
    recomputed.responseDeadline.toISOString(),
    recomputed.resolutionDeadline.toISOString(),
    recomputed.responseBreached ? 1 : 0,
    recomputed.resolutionBreached ? 1 : 0,
    nowIso,
    ticketId
  );

  logAuditEvent(db, {
    ticketId,
    actorId,
    actorName,
    action: 'priority_change',
    details: {
      old_priority: ticket.priority,
      new_priority: newPriority,
      response_deadline: recomputed.responseDeadline.toISOString(),
      resolution_deadline: recomputed.resolutionDeadline.toISOString(),
      response_breached: recomputed.responseBreached,
      resolution_breached: recomputed.resolutionBreached
    }
  });

  return { success: true, ticket: getTicketById(db, ticketId) };
}
