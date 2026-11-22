/**
 * Frontdesk Frontend Client Application
 * Supports Agent, Customer, Manager, and Calendar management views.
 */

const API_BASE = '';
const sessionStorageKey = 'frontdesk.sessionId';

function tabFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  const sessionId = sessionStorage.getItem(sessionStorageKey);
  if (sessionId) headers.set('X-Frontdesk-Session', sessionId);
  return fetch(url, { ...options, headers });
}

// Opening a copy of a tab can copy sessionStorage. The original tab owns its session.
async function claimTabSession(sessionId) {
  if (!navigator.locks) return true;
  return new Promise((resolve, reject) => {
    navigator.locks.request('frontdesk-session-' + sessionId, { ifAvailable: true }, lock => {
      resolve(Boolean(lock));
      if (lock) return new Promise(() => {});
    }).catch(reject);
  });
}

let currentUser = null;
const roleViews = {
  customer: ['customer'],
  agent: ['agent'],
  manager: ['manager', 'agent', 'holidays']
};
let currentTicketId = null;
let currentAgentFilter = 'all';

// Formatting utilities
function formatIst(isoString) {
  if (!isoString) return '--';
  const d = new Date(isoString);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }) + ' IST';
}

function updateIstClock() {
  const clockEl = document.getElementById('istClock');
  if (clockEl) {
    const now = new Date();
    clockEl.textContent = 'IST: ' + now.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }
}
setInterval(updateIstClock, 1000);
updateIstClock();

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('signInForm').addEventListener('submit', signIn);
  document.getElementById('signInRoles').addEventListener('change', () => {
    document.getElementById('signInPassword').value = '';
    document.getElementById('signInStatus').textContent = '';
    updateSignInRole();
  });
  updateSignInRole();
  document.getElementById('customerSignupForm').addEventListener('submit', signUpCustomer);
  document.getElementById('showCustomerSignup').addEventListener('click', () => showSignup(true));
  document.getElementById('showSignIn').addEventListener('click', () => showSignup(false));
  document.getElementById('signOut').addEventListener('click', signOut);
  updateComposerStyle();

  try {
    const sessionId = sessionStorage.getItem(sessionStorageKey);
    if (!sessionId) return;
    if (!await claimTabSession(sessionId)) {
      sessionStorage.removeItem(sessionStorageKey);
      return;
    }
    const response = await tabFetch('/api/session');
    if (response.status === 401) {
      sessionStorage.removeItem(sessionStorageKey);
      return;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    await openPortal(data.user);
  } catch (error) {
    document.getElementById('signInStatus').textContent = error.message;
  }
});

function selectedSignInRole() {
  return document.querySelector('input[name="signInRole"]:checked').value;
}

function updateSignInRole() {
  const role = selectedSignInRole();
  const roleName = role[0].toUpperCase() + role.slice(1);
  document.getElementById('signInHeading').textContent = roleName + ' sign in';
  document.getElementById('showCustomerSignup').hidden = role !== 'customer';
}

function showSignup(show) {
  const signInForm = document.getElementById('signInForm');
  const signupForm = document.getElementById('customerSignupForm');
  signInForm.hidden = show;
  signupForm.hidden = !show;
  document.getElementById('signInRoles').hidden = show;
  if (show) document.getElementById('signInHeading').textContent = 'Create customer account';
  else updateSignInRole();
  document.getElementById('signInStatus').textContent = '';
  document.getElementById('signupStatus').textContent = '';
  (show ? signInForm : signupForm).elements.password.value = '';
  (show ? signupForm : signInForm).elements.userId.focus();
}

async function signUpCustomer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById('signupStatus');
  button.disabled = true;
  status.textContent = '';

  try {
    const response = await fetch('/api/customer-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: form.elements.userId.value, password: form.elements.password.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create the account.');
    form.reset();
    showSignup(false);
    const signInForm = document.getElementById('signInForm');
    signInForm.elements.userId.value = data.userId;
    document.getElementById('signInStatus').textContent = 'Account created. Enter your password to sign in.';
    signInForm.elements.password.focus();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function signIn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const status = document.getElementById('signInStatus');
  const roles = document.getElementById('signInRoles');
  const role = selectedSignInRole();
  button.disabled = true;
  roles.disabled = true;
  status.textContent = '';

  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: form.elements.userId.value,
        password: form.elements.password.value,
        role
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    sessionStorage.setItem(sessionStorageKey, data.sessionId);
    await claimTabSession(data.sessionId);
    form.reset();
    await openPortal(data.user);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    roles.disabled = false;
  }
}

async function signOut() {
  try {
    const response = await tabFetch('/api/session', { method: 'DELETE' });
    if (!response.ok) throw new Error('Sign-out failed. Try again.');
    sessionStorage.removeItem(sessionStorageKey);
    window.location.reload();
  } catch (error) {
    alert(error.message);
  }
}

async function portalFetch(url, options) {
  const response = await tabFetch(url, options);
  if (response.status === 401) {
    sessionStorage.removeItem(sessionStorageKey);
    window.location.reload();
  }
  return response;
}

async function openPortal(user) {
  if (roleViews[user.role].includes('agent')) {
    const response = await portalFetch('/api/users');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    const select = document.getElementById('dtReassignSelect');
    select.replaceChildren(new Option('Reassign to...', ''));
    for (const agent of data.users) {
      select.add(new Option(agent.name, agent.id));
    }
  }

  currentUser = user;
  document.getElementById('signInPanel').hidden = true;
  document.getElementById('portal').hidden = false;
  document.getElementById('sessionControls').hidden = false;
  document.getElementById('signedInName').textContent = user.name;
  switchRoleView(roleViews[user.role][0]);
}

function switchRoleView(viewName) {
  const allowed = roleViews[currentUser?.role] || [];
  if (!allowed.includes(viewName)) return;

  ['agent', 'customer', 'manager', 'holidays'].forEach(v => {
    const section = document.getElementById(`${v}View`);
    const tab = document.getElementById(`nav-${v}`);
    if (section) section.classList.toggle('active', v === viewName);
    if (tab) {
      tab.hidden = !allowed.includes(v);
      tab.classList.toggle('active', v === viewName);
    }
  });

  loadActiveRoleView();
}

function loadActiveRoleView() {
  const activeSection = document.querySelector('.view-section.active');
  if (!activeSection) return;

  if (activeSection.id === 'agentView') {
    loadAgentTickets();
  } else if (activeSection.id === 'customerView') {
    loadCustomerTickets();
  } else if (activeSection.id === 'managerView') {
    loadManagerReport();
  } else if (activeSection.id === 'holidaysView') {
    loadHolidays();
  }
}

/* =====================================================================
 * AGENT PORTAL LOGIC
 * ===================================================================== */

function filterAgentTickets(filter) {
  currentAgentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  loadAgentTickets();
}

async function loadAgentTickets() {
  if (!['agent', 'manager'].includes(currentUser?.role)) return;
  const listEl = document.getElementById('ticketsList');
  listEl.innerHTML = '<div class="loading">Refreshing tickets...</div>';

  try {
    const res = await portalFetch(`${API_BASE}/api/agent/tickets?filter=${currentAgentFilter}`);
    const data = await res.json();
    const tickets = data.tickets || [];

    document.getElementById('ticketCountBadge').textContent = tickets.length;

    if (tickets.length === 0) {
      listEl.innerHTML = '<div class="empty-detail">No tickets found for current filter.</div>';
      return;
    }

    listEl.innerHTML = tickets.map(t => {
      const isLate = t.is_late;
      const isWaiting = t.is_waiting;

      let badges = `<span class="badge badge-${t.priority}">${t.priority}</span>`;
      badges += ` <span class="badge">${t.status}</span>`;

      if (isLate) {
        const breachText = t.breached_clock === 'both' ? 'SLA BREACH (RESP+RES)' : (t.breached_clock === 'response' ? 'RESP SLA BREACH' : 'RES SLA BREACH');
        badges += ` <span class="badge badge-late">⚠️ ${breachText}</span>`;
      }
      if (isWaiting) {
        badges += ` <span class="badge badge-waiting">⏳ WAITING ON CUSTOMER</span>`;
      }

      return `
        <div class="ticket-item ${t.id === currentTicketId ? 'active' : ''}" onclick="selectAgentTicket('${t.id}')">
          <div class="ticket-item-top">
            <span class="ticket-id-tag">${t.id}</span>
            <span style="font-size: 0.75rem; color: #64748b;">${t.assigned_agent_name ? t.assigned_agent_name : 'Unassigned'}</span>
          </div>
          <div class="ticket-item-title">${escapeHtml(t.subject)}</div>
          <div class="badge-row">${badges}</div>
          <div class="ticket-item-bottom" style="margin-top: 0.5rem;">
            <span>${escapeHtml(t.customer_name || 'Customer')}</span>
            <span>Created ${formatIst(t.created_at)}</span>
          </div>
        </div>
      `;
    }).join('');

    // If current ticket is still in view, reload its detail
    if (currentTicketId) {
      selectAgentTicket(currentTicketId);
    }
  } catch (err) {
    console.error('Failed to load agent tickets:', err);
    listEl.innerHTML = `<div class="empty-detail">Error: ${err.message}</div>`;
  }
}

async function selectAgentTicket(ticketId) {
  if (!['agent', 'manager'].includes(currentUser?.role)) return;
  currentTicketId = ticketId;
  const placeholder = document.getElementById('detailPlaceholder');
  const content = document.getElementById('detailContent');

  try {
    const res = await portalFetch(`${API_BASE}/api/agent/tickets/${ticketId}`);
    if (!res.ok) throw new Error('Ticket not found');
    const data = await res.json();
    const t = data.ticket;

    placeholder.style.display = 'none';
    content.style.display = 'block';

    // Populate header & meta
    document.getElementById('dtId').textContent = t.id;
    document.getElementById('dtSubject').textContent = t.subject;
    document.getElementById('dtCustomer').textContent = `${t.customer_name || 'Customer'}${t.customer_email ? ' (' + t.customer_email + ')' : ''}`;
    document.getElementById('dtAssignee').textContent = t.assigned_agent_name ? `${t.assigned_agent_name}` : '⚠️ Unassigned';
    document.getElementById('dtCreated').textContent = formatIst(t.created_at);
    document.getElementById('dtResponseDeadline').textContent = `${formatIst(t.response_deadline)} ${t.first_public_reply_at ? ' (Met at ' + formatIst(t.first_public_reply_at) + ')' : ''}`;
    document.getElementById('dtResolutionDeadline').textContent = `${formatIst(t.resolution_deadline)} ${t.resolved_at ? ' (Resolved at ' + formatIst(t.resolved_at) + ')' : ''}`;
    document.getElementById('dtTotalPaused').textContent = `${t.total_paused_minutes || 0} working mins`;

    // Badges
    const statusBadge = document.getElementById('dtStatusBadge');
    statusBadge.textContent = t.status;

    const prioBadge = document.getElementById('dtPriorityBadge');
    prioBadge.className = `badge badge-${t.priority}`;
    prioBadge.textContent = t.priority;

    const lateBadge = document.getElementById('dtLateBadge');
    if (t.response_breached || t.resolution_breached) {
      lateBadge.style.display = 'inline-block';
      lateBadge.textContent = t.response_breached && t.resolution_breached ? 'LATE (BOTH BREACHED)' : (t.response_breached ? 'LATE (RESPONSE BREACH)' : 'LATE (RESOLUTION BREACH)');
    } else {
      lateBadge.style.display = 'none';
    }

    // Controls
    document.getElementById('dtStatusSelect').value = t.status;
    document.getElementById('dtPrioritySelect').value = t.priority;

    // Claim button visibility
    const claimBtn = document.getElementById('btnClaim');
    if (t.assigned_agent_id) {
      claimBtn.textContent = 'Claimed by ' + (t.assigned_agent_id === currentUser.id ? 'You' : t.assigned_agent_name);
      claimBtn.disabled = true;
    } else {
      claimBtn.textContent = '⚡ Claim Ticket';
      claimBtn.disabled = false;
    }

    // Render Conversation Thread
    const threadEl = document.getElementById('threadMessages');
    threadEl.innerHTML = `
      <div class="message-card public-reply" style="background:#f1f5f9; border-left: 4px solid #64748b;">
        <div class="message-header">
          <span class="message-author">${escapeHtml(t.customer_name || 'Customer')} (Original Ticket Description)</span>
          <span style="font-size:0.75rem;">${formatIst(t.created_at)}</span>
        </div>
        <div class="message-content">${escapeHtml(t.description)}</div>
      </div>
    `;

    (data.messages || []).forEach(m => {
      const isInternal = m.type === 'internal_note';
      threadEl.innerHTML += `
        <div class="message-card ${isInternal ? 'internal-note' : 'public-reply'}">
          <div class="message-header">
            <div>
              <span class="message-author">${escapeHtml(m.author_name || m.author_role)}</span>
              <span class="message-type-badge ${isInternal ? 'note-tag' : 'public-tag'}">
                ${isInternal ? '🔒 Internal Note (Agent Only)' : '💬 Public Reply'}
              </span>
            </div>
            <span>${formatIst(m.created_at)}</span>
          </div>
          <div class="message-content">${escapeHtml(m.content)}</div>
        </div>
      `;
    });

    // Render Audit Trail
    const auditEl = document.getElementById('auditLogList');
    auditEl.innerHTML = (data.auditLogs || []).map(a => `
      <div class="audit-entry">
        <span class="audit-time">${formatIst(a.created_at)}</span>
        <span class="audit-actor">${escapeHtml(a.actor_name || 'System')}:</span>
        <span><strong>${escapeHtml(a.action)}</strong> ${a.details ? escapeHtml(JSON.stringify(a.details)) : ''}</span>
      </div>
    `).join('');

  } catch (err) {
    console.error('Failed to load ticket details:', err);
    alert('Failed to load ticket: ' + err.message);
  }
}

async function claimCurrentTicket() {
  if (!currentTicketId || !currentUser) return;

  try {
    const res = await portalFetch(`${API_BASE}/api/agent/tickets/${currentTicketId}/claim`, {
      method: 'POST',
    });

    const data = await res.json();

    if (res.status === 409) {
      alert(`⚠️ CONFLICT (HTTP 409): ${data.message}`);
    } else if (!res.ok) {
      alert(`Error: ${data.error || 'Failed to claim'}`);
    } else {
      alert('Ticket claimed successfully!');
    }

    loadAgentTickets();
    selectAgentTicket(currentTicketId);
  } catch (err) {
    alert('Claim failed: ' + err.message);
  }
}

async function reassignCurrentTicket(newAgentId) {
  if (!newAgentId || !currentTicketId) return;

  try {
    const res = await portalFetch(`${API_BASE}/api/agent/tickets/${currentTicketId}/reassign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ newAgentId })
    });

    if (!res.ok) throw new Error((await res.json()).error);
    alert('Ticket reassigned successfully.');
    loadAgentTickets();
    selectAgentTicket(currentTicketId);
  } catch (err) {
    alert('Reassign failed: ' + err.message);
  }
}

async function changeTicketStatus(status) {
  if (!currentTicketId) return;

  try {
    const res = await portalFetch(`${API_BASE}/api/agent/tickets/${currentTicketId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`Status update failed: ${data.message || data.error}`);
    }

    loadAgentTickets();
    selectAgentTicket(currentTicketId);
  } catch (err) {
    alert('Status update failed: ' + err.message);
  }
}

async function changeTicketPriority(priority) {
  if (!currentTicketId) return;

  try {
    const res = await portalFetch(`${API_BASE}/api/agent/tickets/${currentTicketId}/priority`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ priority })
    });

    if (!res.ok) throw new Error((await res.json()).error);
    loadAgentTickets();
    selectAgentTicket(currentTicketId);
  } catch (err) {
    alert('Priority change failed: ' + err.message);
  }
}

function updateComposerStyle() {
  const type = document.querySelector('input[name="msgType"]:checked')?.value || 'public_reply';
  const textarea = document.getElementById('composerText');
  const btn = document.getElementById('btnSendMessage');
  const hint = document.getElementById('composerHint');

  if (type === 'internal_note') {
    textarea.style.backgroundColor = '#fffbeb';
    textarea.placeholder = 'Type internal note (agents & managers only; never visible to customer)...';
    btn.textContent = '🔒 Post Internal Note';
    hint.textContent = '🔒 Strictly internal (never visible to customer, does not satisfy response SLA)';
  } else {
    textarea.style.backgroundColor = 'white';
    textarea.placeholder = 'Type your public response to the customer...';
    btn.textContent = '💬 Send Public Reply';
    hint.textContent = '💬 Visible to customer & satisfies Response SLA';
  }
}

async function submitAgentMessage() {
  const textEl = document.getElementById('composerText');
  const content = textEl.value.trim();
  const type = document.querySelector('input[name="msgType"]:checked')?.value || 'public_reply';

  if (!content) {
    alert('Please enter a message.');
    return;
  }

  try {
    const res = await portalFetch(`${API_BASE}/api/agent/tickets/${currentTicketId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type, content })
    });

    if (!res.ok) throw new Error((await res.json()).error);
    textEl.value = '';
    loadAgentTickets();
    selectAgentTicket(currentTicketId);
  } catch (err) {
    alert('Message post failed: ' + err.message);
  }
}

/* =====================================================================
 * CUSTOMER VIEW LOGIC
 * ===================================================================== */

let currentCustomerTicketId = null;

async function handleCustomerSubmit(event) {
  event.preventDefault();
  if (!currentUser) return;

  const subject = document.getElementById('ticketSubject').value.trim();
  const priority = document.getElementById('ticketPriority').value;
  const description = document.getElementById('ticketDescription').value.trim();

  try {
    const res = await portalFetch(`${API_BASE}/api/customer/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ subject, priority, description })
    });

    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();
    alert(`Ticket #${data.ticket.id} created successfully!`);

    document.getElementById('newTicketForm').reset();
    loadCustomerTickets();
    selectCustomerTicket(data.ticket.id);
  } catch (err) {
    alert('Ticket submission failed: ' + err.message);
  }
}

async function loadCustomerTickets() {
  if (!['customer'].includes(currentUser?.role)) return;
  const listEl = document.getElementById('customerTicketList');
  listEl.innerHTML = '<div class="loading">Loading your tickets...</div>';

  try {
    const res = await portalFetch(`${API_BASE}/api/customer/tickets`);
    const data = await res.json();
    const tickets = data.tickets || [];

    if (tickets.length === 0) {
      listEl.innerHTML = '<div class="empty-detail">You have not submitted any tickets yet.</div>';
      return;
    }

    listEl.innerHTML = tickets.map(t => `
      <div class="ticket-item ${t.id === currentCustomerTicketId ? 'active' : ''}" onclick="selectCustomerTicket('${t.id}')">
        <div class="ticket-item-top">
          <span class="ticket-id-tag">${t.id}</span>
          <span class="badge badge-${t.priority}">${t.priority}</span>
        </div>
        <div class="ticket-item-title">${escapeHtml(t.subject)}</div>
        <div class="ticket-item-bottom">
          <span class="badge">${t.status}</span>
          <span>${formatIst(t.created_at)}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="empty-detail">Error: ${err.message}</div>`;
  }
}

async function selectCustomerTicket(ticketId) {
  if (!['customer'].includes(currentUser?.role)) return;
  currentCustomerTicketId = ticketId;
  const card = document.getElementById('customerDetailCard');
  const placeholder = document.getElementById('customerDetailPlaceholder');

  try {
    const res = await portalFetch(`${API_BASE}/api/customer/tickets/${ticketId}`);
    if (!res.ok) throw new Error('Ticket not found');
    const data = await res.json();
    const t = data.ticket;

    placeholder.style.display = 'none';
    card.style.display = 'block';

    document.getElementById('custDetailId').textContent = t.id;
    document.getElementById('custDetailSubject').textContent = t.subject;
    document.getElementById('custDetailStatus').textContent = t.status;
    document.getElementById('custDetailDesc').textContent = t.description;

    // Show reopen prompt if Resolved
    const reopenNotice = document.getElementById('custReopenNotice');
    if (t.status === 'Resolved') {
      reopenNotice.style.display = 'flex';
    } else {
      reopenNotice.style.display = 'none';
    }

    // Render Messages (Strictly public replies only)
    const msgsEl = document.getElementById('custMessagesList');
    if (data.messages.length === 0) {
      msgsEl.innerHTML = '<p style="color:#64748b; font-size: 0.85rem;">No replies from support yet. We will notify you once an agent responds.</p>';
    } else {
      msgsEl.innerHTML = data.messages.map(m => `
        <div class="message-card public-reply">
          <div class="message-header">
            <span class="message-author">${escapeHtml(m.author_name || (m.author_role === 'agent' ? 'Support Agent' : 'You'))}</span>
            <span>${formatIst(m.created_at)}</span>
          </div>
          <div class="message-content">${escapeHtml(m.content)}</div>
        </div>
      `).join('');
    }
  } catch (err) {
    alert('Failed to load ticket: ' + err.message);
  }
}

async function submitCustomerReply() {
  if (!currentCustomerTicketId) return;
  const content = document.getElementById('custReplyText').value.trim();
  if (!content) return;

  try {
    const res = await portalFetch(`${API_BASE}/api/customer/tickets/${currentCustomerTicketId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content })
    });

    const data = await res.json();
    if (data.newTicketCreated) {
      alert(`Note: ${data.message}. Opened new ticket #${data.ticket.id}`);
      currentCustomerTicketId = data.ticket.id;
    }

    document.getElementById('custReplyText').value = '';
    loadCustomerTickets();
    selectCustomerTicket(currentCustomerTicketId);
  } catch (err) {
    alert('Reply submission failed: ' + err.message);
  }
}

async function customerReopenTicket() {
  if (!currentCustomerTicketId) return;
  const content = prompt('Please explain why you want to reopen this ticket:');
  if (!content) return;

  try {
    const res = await portalFetch(`${API_BASE}/api/customer/tickets/${currentCustomerTicketId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: `[Customer Reopen Request] ${content}` })
    });

    const data = await res.json();
    if (data.newTicketCreated) {
      alert(`5-day window expired: ${data.message}. Created new ticket #${data.ticket.id}`);
      currentCustomerTicketId = data.ticket.id;
    } else {
      alert('Ticket has been reopened successfully!');
    }

    loadCustomerTickets();
    selectCustomerTicket(currentCustomerTicketId);
  } catch (err) {
    alert('Reopen failed: ' + err.message);
  }
}

/* =====================================================================
 * MANAGER REPORTING LOGIC (FR-19)
 * ===================================================================== */

async function loadManagerReport() {
  if (!['manager'].includes(currentUser?.role)) return;
  const container = document.getElementById('lateTicketsTableContainer');
  container.innerHTML = '<div class="loading">Generating SLA report...</div>';

  try {
    // 1. Fetch Summary KPIs
    const sumRes = await portalFetch(`${API_BASE}/api/manager/reports/summary`);
    const summary = await sumRes.json();
    if (!sumRes.ok) throw new Error(summary.error);
    document.getElementById('kpiTotal').textContent = summary.total_tickets || 0;
    document.getElementById('kpiOpen').textContent = summary.open_tickets || 0;
    document.getElementById('kpiWaiting').textContent = summary.waiting_on_customer || 0;
    document.getElementById('kpiLate').textContent = summary.late_tickets || 0;

    // 2. Fetch Late Tickets Report
    const lateRes = await portalFetch(`${API_BASE}/api/manager/reports/late-tickets`);
    const data = await lateRes.json();
    if (!lateRes.ok) throw new Error(data.error);
    const list = data.report || [];

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-detail" style="padding: 2rem; color: #10b981;">🎉 Excellent! Zero tickets have breached SLA targets.</div>';
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Ticket ID</th>
            <th>Subject</th>
            <th>Customer</th>
            <th>Assigned Agent</th>
            <th>Priority</th>
            <th>Breached Clock</th>
            <th>Working Time Paused</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(r => `
            <tr>
              <td><span class="ticket-id-tag">${r.ticket.id}</span></td>
              <td><strong>${escapeHtml(r.ticket.subject)}</strong></td>
              <td>${escapeHtml(r.ticket.customer_name || 'Customer')}</td>
              <td>${escapeHtml(r.ticket.assigned_agent_name || 'Unassigned')}</td>
              <td><span class="badge badge-${r.ticket.priority}">${r.ticket.priority}</span></td>
              <td><span class="badge badge-late">${r.breached_clock.toUpperCase()}</span></td>
              <td>${r.total_paused_minutes} mins</td>
              <td><button class="btn btn-secondary" onclick="viewLateHistory('${r.ticket.id}')">View Audit</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<div class="empty-detail">Error: ${err.message}</div>`;
  }
}

function viewLateHistory(ticketId) {
  switchRoleView('agent');
  selectAgentTicket(ticketId);
}

/* =====================================================================
 * HOLIDAYS CALENDAR LOGIC
 * ===================================================================== */

async function loadHolidays() {
  if (!['manager'].includes(currentUser?.role)) return;
  const listEl = document.getElementById('holidaysList');
  try {
    const res = await portalFetch(`${API_BASE}/api/holidays`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const holidays = data.holidays || [];

    if (holidays.length === 0) {
      listEl.innerHTML = '<p style="color:#64748b;">No festival holidays configured yet. Add upcoming holidays below.</p>';
      return;
    }

    listEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Holiday Name</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${holidays.map(h => `
            <tr>
              <td><strong>${h.date}</strong></td>
              <td>${escapeHtml(h.name)}</td>
              <td><button class="btn btn-secondary" onclick="deleteHoliday(${h.id})">Delete</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    listEl.innerHTML = `<p>Error loading holidays: ${err.message}</p>`;
  }
}

async function handleAddHoliday(event) {
  event.preventDefault();
  if (currentUser?.role !== 'manager') return;
  const date = document.getElementById('holidayDate').value;
  const name = document.getElementById('holidayName').value.trim();

  try {
    const res = await portalFetch(`${API_BASE}/api/holidays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, name })
    });

    if (!res.ok) throw new Error((await res.json()).error);
    document.getElementById('addHolidayForm').reset();
    loadHolidays();
  } catch (err) {
    alert('Failed to add holiday: ' + err.message);
  }
}

async function deleteHoliday(id) {
  if (currentUser?.role !== 'manager') return;
  if (!confirm('Remove this holiday from the working calendar?')) return;
  try {
    const res = await portalFetch(`${API_BASE}/api/holidays/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    loadHolidays();
  } catch (err) {
    alert('Failed to delete holiday: ' + err.message);
  }
}

// Security HTML escaper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
