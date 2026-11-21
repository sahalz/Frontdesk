/**
 * Audit Logger Module for Frontdesk
 * Records immutable events with server-generated UTC timestamps.
 */

import { randomUUID } from 'node:crypto';

export async function logAuditEvent(db, {
  ticketId,
  actorId = null,
  actorName = 'System',
  action,
  details = {}
}) {
  const id = `aud-${randomUUID()}`;
  // FR-14: Server-generated UTC timestamp
  const createdAt = new Date().toISOString();
  const detailsJson = JSON.stringify(details);

  const stmt = db.prepare(`
    INSERT INTO audit_logs (id, ticket_id, actor_id, actor_name, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  await stmt.run(id, ticketId, actorId, actorName, action, detailsJson, createdAt);
  return { id, ticketId, actorId, actorName, action, details, createdAt };
}
