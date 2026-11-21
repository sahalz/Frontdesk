# Frontdesk - Support Ticketing System

> **Designed for Arvo Systems** | Version 1.0 | Based on SRS v1.0 (21 November 2026)

Frontdesk is a web-based support ticketing platform built for Arvo Systems to replace shared spreadsheets and WhatsApp groups. It tracks customer tickets, calculates response and resolution deadlines using working hours in Indian Standard Time (IST), handles concurrent ticket claiming with conflict detection, isolates internal notes from customer views, and maintains an append-only audit trail.

---

## 1. Key Incident Resolutions & Architectural Design

* **INC-0291 (Race Conditions & Concurrent Claiming &rarr; FR-5, FR-6)**:
  * Implemented using conditional atomic updates (`UPDATE tickets SET assigned_agent_id = ? ... WHERE id = ? AND assigned_agent_id IS NULL`).
  * Concurrency tests verify that when two agents claim a ticket simultaneously, exactly one succeeds (HTTP 200) and the competing claim receives an **HTTP 409 Conflict** response with a descriptive message.
* **INC-0304 (Internal Note Isolation & Customer Privacy &rarr; FR-8, FR-10, NFR-2)**:
  * Customer-facing endpoints use separate query serializers with explicit field allowlists.
  * Internal notes are not queried in customer endpoints, preventing accidental leaks in application serialization layers.
  * Automated privacy tests call every customer-facing endpoint (`/api/customer/tickets`, `/api/customer/tickets/:id`, `/reply`) and confirm no internal note content appears in any customer response.
  * Only public agent replies satisfy the first-reply Response SLA (FR-12).
* **INC-0318 (Audit Trail Integrity &rarr; FR-13, FR-14, FR-15, NFR-3)**:
  * Event history (`ticket_creation`, `claim`, `reassignment`, `status_change`, `priority_change`, `public_reply`, `internal_note`, `pause`, `resume`, `breach`, `auto_close`, `reopen`) is recorded with server-generated UTC timestamps.
  * Database triggers on `messages` and `audit_logs` block runtime `UPDATE` and `DELETE` queries.

---

## 2. Working Calendar & SLA Rules (SRS Section 3 & 8)

* **Working Time**: **09:30 to 18:30 IST**, Monday to Friday (9 working hours = 540 working minutes/day).
* **Timezone Standard**: Stored in UTC, computed in IST (UTC+05:30).
* **Weekend & Holiday Handling**: Saturdays, Sundays, and festival holidays recorded in the editable `holidays` table are excluded from SLA elapsed time.
* **After-Hours Submission**: A ticket arriving outside business hours snaps to 09:30 IST of the next working day.
  * *SRS Example Verified in Tests*: A ticket submitted at 18:00 Friday has 30 minutes elapsed by Monday 09:30 IST and does not breach over the weekend.

### Priority & SLA Targets (Configurable)
| Priority | First Reply SLA | Resolution SLA | Rule Interpretation |
| :--- | :--- | :--- | :--- |
| **Urgent** | 2 working hours | Same working day | Resolved by 18:30 IST of creation day (or 18:30 IST of next working day if submitted after hours). |
| **Medium** | 4.5 working hours | 3 working days | 27 working hours added via working calendar. |
| **Low** | 1 working day (9h) | 5 working days | 45 working hours added via working calendar. |

### SLA Pause, Auto-Close, and Reopen Rules
* **SLA Pause**: Transitioning to `Waiting on customer` pauses both the Response and Resolution clocks. The clock resumes automatically when the customer replies or when the status changes.
* **Auto-Close**: Tickets remaining in `Waiting on customer` for **5 working days** (45 working hours) without a customer reply are automatically marked `Closed`.
* **Reopen Window & Time Exclusion in Resolved State**:
  * A customer may reopen a `Resolved` ticket within **5 working days**.
  * A customer reply on a resolved ticket within 5 days reopens it.
  * **Exclusion of Time Spent in Resolved**: If a ticket sat `Resolved` for 4 days before the customer reopened it, its original resolution deadline would have expired through no fault of the support team. To avoid penalizing agents, the working time elapsed while in `Resolved` is treated as paused working time: upon reopening, the resolution deadline is shifted forward by the exact working hours spent in `Resolved`, restoring the agent's remaining resolution time.
  * Past 5 working days, or if the ticket was auto-closed, customer replies create a new linked ticket (`parent_ticket_id`).
* **Priority Changes**: Deadlines are recomputed from the original creation time using the new target plus cumulative paused working time. If the newly computed deadline has already elapsed, the ticket is immediately flagged as late. Downgrades do not clear existing breaches.

---

## 3. Technology Stack

* **Backend**: Node.js (ES Modules, Express).
* **Database**:
  * **Development / Testing**: Node native `node:sqlite` (`DatabaseSync`) with SQLite triggers for zero external setup.
  * **Production**: PostgreSQL schema with PL/pgSQL triggers and privilege hardening (`src/schema.sql`).
* **Frontend**: Vanilla HTML5, CSS3, JavaScript SPA with instant persona switching (Agent, Customer, Manager, Calendar).
* **Testing**: Node.js test runner (`node --test`).

---

## 4. Local Setup & Execution

### Prerequisites
* Node.js v20+ (Node v22+ or v24 recommended)
* npm v10+

### Step 1: Install Dependencies
```powershell
cd backend
npm install
```

### Step 2: Run Automated Test Suites
```powershell
npm test
```

### Step 3: Start the Application
```powershell
npm start
```
The application will be live at: **http://localhost:3000**

---

## 5. Automated Test Coverage (NFR-4, NFR-5)

The automated test suite verifies:
1. **Working Calendar Calculations (`tests/slaEngine.test.js`)**:
   * Friday 18:00 carryover across weekends (SRS 3.2 example).
   * Snapping after-hours arrivals to next working day 09:30 IST.
   * Skipping configurable festival holidays.
   * Urgent priority "Same working day" resolution vs after-hours next working day resolution.
   * Medium priority weekend spanning.
   * Priority change recalculations and breach preservation.
   * 5-working-day auto-close and reopen windows.
   * Excluding time spent in `Resolved` upon reopening so valid resolution time is preserved.
2. **Customer Privacy & Data Isolation (`tests/privacy.test.js`)**:
   * Calls every customer-facing endpoint (`/api/customer/tickets`, `/api/customer/tickets/:id`, `/reply`) and asserts no note content appears in responses.
   * Confirms customer access control (Customer 2 cannot view Customer 1 tickets).
   * Verifies database triggers prevent updating or deleting rows in `messages` and `audit_logs`.
3. **Concurrency & Race Conditions (`tests/concurrency.test.js`)**:
   * Dispatches simultaneous claim requests from competing agents for an unassigned ticket.
   * Confirms a single winner (HTTP 200) and that the competing claim receives an **HTTP 409 Conflict**.

---

## 6. Interpretations of Ambiguous Rules & Boundary Decisions (Section 8)

| Question | Chosen Implementation & Rationale |
| :--- | :--- |
| **Does "same working day" mean until 18:30 on the creation day?** | Yes. For tickets created within working hours (09:30-18:30 IST), the deadline is 18:30 of that day. For tickets created after hours or on weekends/holidays, it means 18:30 IST of the next working day. |
| **Is "one week" 5 working days or 7 calendar days?** | 5 working days (45 working hours). |
| **Does a reopened ticket restart its SLA?** | No. It continues the original SLA, with all paused time excluded. Working time spent in the `Resolved` state waiting for customer confirmation is also treated as paused, shifting the resolution deadline so agents are not penalized for customer delay. |
| **Does a customer reply on a Resolved ticket reopen it?** | Yes, if within the 5-working-day window. Afterwards, it creates a new ticket linked to the old one (`parent_ticket_id`). |
| **Can an auto-closed ticket be reopened?** | No. Customer follow-up on an auto-closed ticket creates a new linked ticket. |

---

## 7. Security Boundaries & Immutability Limits

* **Database Triggers vs. Table Permissions**:
  * Database triggers block accidental or malicious application-level `UPDATE` and `DELETE` queries issued by runtime ORM or SQL statements.
  * **Limitation**: A database user with DDL or table ownership privileges (`SUPERUSER` or owner) can drop or disable triggers.
  * **Production Hardening**: True immutability requires database role separation. The application runtime should connect with a dedicated non-owner role (e.g. `frontdesk_app`) that has only `SELECT` and `INSERT` permissions on `messages` and `audit_logs`, with `UPDATE`, `DELETE`, `TRUNCATE`, and `TRIGGER` rights explicitly revoked (see SQL scripts in `src/schema.sql`).

---

## 8. Out-of-Scope Items (Section 9)

In accordance with **SRS Section 9 (Out of Scope)** and the 8-hour development budget:
* **Email Integration**: Direct inbound/outbound email parsing (SMTP/IMAP) was excluded in favor of the customer web portal.
* **External Notification Gateways**: SMS / WhatsApp / external webhook notifications were excluded in favor of real-time server tracking and manager breach reports.
* **Advanced Analytics**: Replaced by manager KPI summary metrics and the late ticket breach report (FR-19).
