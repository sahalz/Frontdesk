import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, testAuth, testSessionHeaders } from './testDatabase.js';
import { createApp } from '../src/server.js';
import { createTicket } from '../src/services/ticketService.js';
import { addAgentMessage } from '../src/services/messageService.js';

test('Security & Privacy (NFR-2, FR-10, NFR-5) - Zero Internal Note Leakage to Customer', async t => {
  const db = await createTestDatabase();
  t.after(() => db.close());
  const app = createApp(db, { auth: testAuth });

  // Start temporary server for HTTP calls
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Create a ticket
    const ticket = await createTicket(db, {
      subject: 'Urgent system outage',
      description: 'Cannot access my account',
      customerId: 'cust-1',
      priority: 'urgent'
    });

    const TOP_SECRET_NOTE = 'CONFIDENTIAL_INTERNAL_NOTE_LEAK_DETECTION_TOKEN_XYZ123';
    const PUBLIC_REPLY = 'Hello, we are investigating your issue right away.';

    // 2. Add an internal note and a public reply as an agent
    await addAgentMessage(db, {
      ticketId: ticket.id,
      agentId: 'agent-1',
      type: 'internal_note',
      content: TOP_SECRET_NOTE
    });

    await addAgentMessage(db, {
      ticketId: ticket.id,
      agentId: 'agent-1',
      type: 'public_reply',
      content: PUBLIC_REPLY
    });

    // 3. Test GET /api/customer/tickets (ticket list)
    const listRes = await fetch(`${baseUrl}/api/customer/tickets`, {
      headers: testSessionHeaders('cust-1')
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
      headers: testSessionHeaders('cust-1')
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
        ...testSessionHeaders('cust-1')
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
      headers: testSessionHeaders('cust-2')
    });
    assert.equal(cust2Res.status, 404, 'Customer 2 must not have access to Customer 1 ticket');

    for (const path of ['/api/manager/reports/summary', '/api/holidays']) {
      for (const userId of ['cust-1', 'agent-1']) {
        const response = await fetch(baseUrl + path, { headers: testSessionHeaders(userId) });
        assert.equal(response.status, 403);
      }
      const response = await fetch(baseUrl + path, { headers: testSessionHeaders('mgr-1') });
      assert.equal(response.status, 200);
    }

    const customerAgentRes = await fetch(baseUrl + '/api/agent/tickets', {
      headers: testSessionHeaders('cust-1')
    });
    assert.equal(customerAgentRes.status, 403);

    const spoofedRequest = await fetch(baseUrl + '/api/manager/reports/summary?manager_id=mgr-1', {
      headers: { 'x-user-id': 'mgr-1' }
    });
    assert.equal(spoofedRequest.status, 401);

    const signInAs = role => fetch(baseUrl + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'cust-1', password: 'fixture-password', role })
    });
    const wrongRole = await signInAs('manager');
    assert.equal(wrongRole.status, 401);
    assert.equal(wrongRole.headers.get('set-cookie'), null);
    assert.equal((await signInAs('admin')).status, 400);

    const session = await signInAs('customer');
    assert.equal(session.status, 200);
    const sessionData = await session.json();
    assert.equal(sessionData.user.role, 'customer');
    const sessionCookie = session.headers.get('set-cookie');
    assert.match(sessionCookie, /HttpOnly/i);
    const cookie = sessionCookie.split(';')[0];
    const sessionHeaders = { Cookie: cookie, 'X-Frontdesk-Session': sessionData.sessionId };

    const authenticated = await fetch(baseUrl + '/api/session', { headers: sessionHeaders });
    assert.equal((await authenticated.json()).user.id, 'cust-1');

    const signOut = await fetch(baseUrl + '/api/session', { method: 'DELETE', headers: sessionHeaders });
    assert.equal(signOut.status, 204);
    assert.match(signOut.headers.get('set-cookie'), new RegExp('^frontdesk_session_' + sessionData.sessionId + '=;'));

  } finally {
    server.close();
  }
});

test('Data Integrity (NFR-3, FR-15) - Database Triggers Enforce Append-Only Tables', async t => {
  const db = await createTestDatabase();
  t.after(() => db.close());

  const ticket = await createTicket(db, {
    subject: 'Audit test ticket',
    description: 'Testing immutability',
    customerId: 'cust-1'
  });

  await addAgentMessage(db, {
    ticketId: ticket.id,
    agentId: 'agent-1',
    type: 'public_reply',
    content: 'Initial message'
  });

  const msg = await db.prepare('SELECT id FROM messages WHERE ticket_id = ?').get(ticket.id);

  // Attempt to UPDATE message - MUST FAIL
  await assert.rejects(() => {
    return db.prepare("UPDATE messages SET content = 'Tampered content' WHERE id = ?").run(msg.id);
  }, /messages is strictly append-only/);

  // Attempt to DELETE message - MUST FAIL
  await assert.rejects(() => {
    return db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  }, /messages is strictly append-only/);

  const auditEntry = await db.prepare('SELECT id FROM audit_logs WHERE ticket_id = ?').get(ticket.id);

  // Attempt to UPDATE audit_logs - MUST FAIL
  await assert.rejects(() => {
    return db.prepare("UPDATE audit_logs SET action = 'tampered' WHERE id = ?").run(auditEntry.id);
  }, /audit_logs is strictly append-only/);

  // Attempt to DELETE audit_logs - MUST FAIL
  await assert.rejects(() => {
    return db.prepare('DELETE FROM audit_logs WHERE id = ?').run(auditEntry.id);
  }, /audit_logs is strictly append-only/);
});

test('Self-registration creates a customer session using only a user ID and password', async t => {
  const db = await createTestDatabase();
  t.after(() => db.close());
  const server = createApp(db, { auth: testAuth }).listen(0);
  t.after(() => server.close());
  const baseUrl = 'http://localhost:' + server.address().port;

  function post(path, body) {
    return fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  const credentials = { userId: 'new-customer', password: 'test12' };
  assert.equal((await post('/api/customer-accounts', { ...credentials, password: 'test1' })).status, 400);
  const created = await post('/api/customer-accounts', { ...credentials, role: 'manager' });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { userId: credentials.userId });
  assert.equal((await post('/api/customer-accounts', credentials)).status, 409);
  assert.equal((await post('/api/customer-accounts', { ...credentials, userId: 'agent-1' })).status, 409);

  const account = await db.prepare('SELECT role, email, auth_user_id FROM users WHERE id = ?').get(credentials.userId);
  assert.deepEqual(account, { role: 'customer', email: null, auth_user_id: null });

  const wrongPassword = await post('/api/session', { ...credentials, password: 'wrong-password' });
  assert.equal(wrongPassword.status, 401);

  const wrongRole = await post('/api/session', { ...credentials, role: 'agent' });
  assert.equal(wrongRole.status, 401);
  assert.equal(wrongRole.headers.get('set-cookie'), null);

  const signedIn = await post('/api/session', { ...credentials, role: 'customer' });
  assert.equal(signedIn.status, 200);
  const customerSession = await signedIn.json();
  assert.equal(customerSession.user.role, 'customer');
  const customerCookie = signedIn.headers.get('set-cookie').split(';')[0];

  const agentLogin = await post('/api/session', { userId: 'agent-1', password: 'fixture-password', role: 'agent' });
  assert.equal(agentLogin.status, 200);
  const agentSession = await agentLogin.json();
  assert.equal(agentSession.user.role, 'agent');
  assert.notEqual(agentSession.sessionId, customerSession.sessionId);
  const agentCookie = agentLogin.headers.get('set-cookie').split(';')[0];

  // Browser tabs share the cookie jar. Each tab selects its own session.
  const cookieJar = agentCookie + '; ' + customerCookie;
  const agentHeaders = { Cookie: cookieJar, 'X-Frontdesk-Session': agentSession.sessionId };
  const headers = { Cookie: cookieJar, 'X-Frontdesk-Session': customerSession.sessionId };
  assert.equal((await fetch(baseUrl + '/api/session', { headers: { Cookie: cookieJar } })).status, 401);
  const agentTickets = await fetch(baseUrl + '/api/agent/tickets', { headers: agentHeaders });
  assert.equal(agentTickets.status, 200);
  const tickets = await fetch(baseUrl + '/api/customer/tickets', { headers });
  assert.equal(tickets.status, 200);
  assert.deepEqual(await tickets.json(), { tickets: [] });

  const staffRoute = await fetch(baseUrl + '/api/agent/tickets', { headers });
  assert.equal(staffRoute.status, 403);

  const signedOut = await fetch(baseUrl + '/api/session', { method: 'DELETE', headers });
  assert.equal(signedOut.status, 204);
  assert.equal((await fetch(baseUrl + '/api/session', { headers })).status, 401);
  const remaining = await fetch(baseUrl + '/api/session', { headers: agentHeaders });
  assert.equal(remaining.status, 200);
  assert.equal((await remaining.json()).user.id, 'agent-1');
});
