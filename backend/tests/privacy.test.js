import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createTicket } from '../src/services/ticketService.js';
import { addAgentMessage } from '../src/services/messageService.js';

test('Security & Privacy (NFR-2, FR-10, NFR-5) - Zero Internal Note Leakage to Customer', async () => {
  const db = createDatabase(':memory:');
  const app = createApp(db);

  // Start temporary server for HTTP calls
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Create a ticket
    const ticket = createTicket(db, {
      subject: 'Urgent system outage',
      description: 'Cannot access my account',
      customerId: 'cust-1',
      priority: 'urgent'
    });

    const TOP_SECRET_NOTE = 'CONFIDENTIAL_INTERNAL_NOTE_LEAK_DETECTION_TOKEN_XYZ123';
    const PUBLIC_REPLY = 'Hello, we are investigating your issue right away.';

    // 2. Add an internal note and a public reply as an agent
    addAgentMessage(db, {
      ticketId: ticket.id,
      agentId: 'agent-1',
      type: 'internal_note',
      content: TOP_SECRET_NOTE
    });

    addAgentMessage(db, {
      ticketId: ticket.id,
      agentId: 'agent-1',
      type: 'public_reply',
      content: PUBLIC_REPLY
    });

    // 3. Test GET /api/customer/tickets (ticket list)
    const listRes = await fetch(`${baseUrl}/api/customer/tickets`, {
      headers: { 'x-user-id': 'cust-1' }
    });
    const listBody = await listRes.text();
    assert.equal(listRes.status, 200);
    assert.equal(
      listBody.includes(TOP_SECRET_NOTE),
      false,
      'Internal note must NEVER appear in GET /api/customer/tickets'
    );

    // 4. Test GET /api/customer/tickets/:id (ticket detail)
    const detailRes = await fetch(`${baseUrl}/api/customer/tickets/${ticket.id}`, {
      headers: { 'x-user-id': 'cust-1' }
    });
    const detailData = await detailRes.json();
    assert.equal(detailRes.status, 200);

    // Assert that the public reply is present
    const hasPublicReply = detailData.messages.some(m => m.content === PUBLIC_REPLY);
    assert.equal(hasPublicReply, true, 'Public reply should be visible to customer');

    // Assert that the internal note is completely absent
    const detailBodyStr = JSON.stringify(detailData);
    assert.equal(
      detailBodyStr.includes(TOP_SECRET_NOTE),
      false,
      'Internal note must NEVER appear in GET /api/customer/tickets/:id'
    );

    // Assert message list only contains type = 'public_reply'
    for (const msg of detailData.messages) {
      assert.equal(msg.type, 'public_reply', 'Only public_reply messages can be returned to customer');
    }

    // 5. Test customer reply endpoint response
    const replyRes = await fetch(`${baseUrl}/api/customer/tickets/${ticket.id}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'cust-1'
      },
      body: JSON.stringify({ content: 'Thanks for the quick reply!' })
    });
    const replyBody = await replyRes.text();
    assert.equal(replyRes.status, 200);
    assert.equal(
      replyBody.includes(TOP_SECRET_NOTE),
      false,
      'Internal note must NEVER appear in customer reply response'
    );

    // 6. Test Customer Isolation (Customer 2 cannot see Customer 1's ticket)
    const cust2Res = await fetch(`${baseUrl}/api/customer/tickets/${ticket.id}`, {
      headers: { 'x-user-id': 'cust-2' }
    });
    assert.equal(cust2Res.status, 404, 'Customer 2 must not have access to Customer 1 ticket');

  } finally {
    server.close();
  }
});

test('Data Integrity (NFR-3, FR-15) - Database Triggers Enforce Append-Only Tables', () => {
  const db = createDatabase(':memory:');

  const ticket = createTicket(db, {
    subject: 'Audit test ticket',
    description: 'Testing immutability',
    customerId: 'cust-1'
  });

  addAgentMessage(db, {
    ticketId: ticket.id,
    agentId: 'agent-1',
    type: 'public_reply',
    content: 'Initial message'
  });

  const msg = db.prepare('SELECT id FROM messages WHERE ticket_id = ?').get(ticket.id);

  // Attempt to UPDATE message - MUST FAIL
  assert.throws(() => {
    db.prepare("UPDATE messages SET content = 'Tampered content' WHERE id = ?").run(msg.id);
  }, /Messages are append-only/);

  // Attempt to DELETE message - MUST FAIL
  assert.throws(() => {
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  }, /Messages are append-only/);

  const auditEntry = db.prepare('SELECT id FROM audit_logs WHERE ticket_id = ?').get(ticket.id);

  // Attempt to UPDATE audit_logs - MUST FAIL
  assert.throws(() => {
    db.prepare("UPDATE audit_logs SET action = 'tampered' WHERE id = ?").run(auditEntry.id);
  }, /Audit logs are append-only/);

  // Attempt to DELETE audit_logs - MUST FAIL
  assert.throws(() => {
    db.prepare('DELETE FROM audit_logs WHERE id = ?').run(auditEntry.id);
  }, /Audit logs are append-only/);
});
