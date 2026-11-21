import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './testDatabase.js';
import { createApp } from '../src/server.js';
import { createTicket } from '../src/services/ticketService.js';

test('Concurrency & Claiming (FR-5, FR-6, NFR-5) - Exactly One Winner and HTTP 409 Conflict', async t => {
  const db = await createTestDatabase();
  t.after(() => db.close());
  const app = createApp(db);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // Create an unassigned ticket
    const ticket = await createTicket(db, {
      subject: 'Race condition test ticket',
      description: 'Two agents claim simultaneously',
      customerId: 'cust-1',
      priority: 'urgent'
    });

    // Both Agent 1 and Agent 2 attempt to claim at the exact same moment
    const [res1, res2] = await Promise.all([
      fetch(`${baseUrl}/api/agent/tickets/${ticket.id}/claim`, {
        method: 'POST',
        headers: { 'x-user-id': 'agent-1' }
      }),
      fetch(`${baseUrl}/api/agent/tickets/${ticket.id}/claim`, {
        method: 'POST',
        headers: { 'x-user-id': 'agent-2' }
      })
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(
      statuses,
      [200, 409],
      'Exactly one claim request must succeed (HTTP 200) and the other must receive HTTP 409'
    );

    const winnerRes = res1.status === 200 ? res1 : res2;
    const loserRes = res1.status === 409 ? res1 : res2;

    const winnerData = await winnerRes.json();
    const loserData = await loserRes.json();

    assert.equal(winnerData.success, true);
    assert.equal(loserData.error, 'Conflict');
    assert.match(loserData.message, /already been claimed/i);

    // Verify ticket in DB is assigned to the winner
    const updatedTicket = await db.prepare('SELECT assigned_agent_id FROM tickets WHERE id = ?').get(ticket.id);
    assert.ok(
      updatedTicket.assigned_agent_id === 'agent-1' || updatedTicket.assigned_agent_id === 'agent-2'
    );
  } finally {
    server.close();
  }
});
