/**
 * Serializers and Data Isolation Layer
 * Enforces NFR-2: Customer-facing endpoints use separate serializers with an allowlist of fields.
 * Notes are NEVER fetched and filtered afterwards.
 */

// Allowlist of ticket fields visible to customers
const CUSTOMER_TICKET_FIELDS = [
  'id',
  'subject',
  'description',
  'priority',
  'status',
  'parent_ticket_id',
  'created_at',
  'updated_at'
];

/**
 * Customer ticket serializer (strict allowlist)
 */
export function serializeCustomerTicket(ticket) {
  if (!ticket) return null;
  const serialized = {};
  for (const field of CUSTOMER_TICKET_FIELDS) {
    if (field in ticket) {
      serialized[field] = ticket[field];
    }
  }
  return serialized;
}

/**
 * Direct database query for customer messages.
 * NFR-2 & FR-10: Notes are NEVER fetched and filtered afterwards.
 * Only rows with type = 'public_reply' are retrieved from the DB.
 */
export async function getCustomerMessages(db, ticketId) {
  const stmt = db.prepare(`
    SELECT m.id, m.ticket_id, m.author_id, m.author_role, m.type, m.content, m.created_at, u.name as author_name
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.ticket_id = ? AND m.type = 'public_reply'
    ORDER BY m.created_at ASC
  `);
  return await stmt.all(ticketId);
}

/**
 * Full agent message query (includes both public replies and internal notes)
 */
export async function getAgentMessages(db, ticketId) {
  const stmt = db.prepare(`
    SELECT m.id, m.ticket_id, m.author_id, m.author_role, m.type, m.content, m.created_at, u.name as author_name
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.ticket_id = ?
    ORDER BY m.created_at ASC
  `);
  return await stmt.all(ticketId);
}

/**
 * Agent & Manager ticket serializer (includes SLA deadlines and breach indicators)
 */
export function serializeAgentTicket(ticket) {
  if (!ticket) return null;
  return {
    ...ticket,
    response_breached: Boolean(ticket.response_breached),
    resolution_breached: Boolean(ticket.resolution_breached)
  };
}
