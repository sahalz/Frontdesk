# Frontdesk - Support Ticketing System

> **Designed for Arvo Systems** | Version 1.0 | Conforming strictly to SRS v1.0 (21 November 2026)

Frontdesk is a web-based support ticketing platform built to replace Arvo Systems' legacy shared spreadsheet and WhatsApp group. It tracks customer tickets, strictly enforces Response and Resolution SLAs in Indian Standard Time (IST) working hours, provides atomic concurrency guarantees for ticket assignment, guarantees customer data privacy with zero internal note leakage, and maintains an immutable audit trail.

---

## 1. Key Incident Resolutions & Architectural Highlights

* **INC-0291 (Race Conditions & Concurrent Claiming &rarr; FR-5, FR-6)**:
  * Atomic conditional claim updates at the database level (`UPDATE tickets SET assigned_agent_id = ? ... WHERE id = ? AND assigned_agent_id IS NULL`).
  * If two agents attempt to claim simultaneously, exactly one succeeds and the other receives an **HTTP 409 Conflict** response with an explicit message.
* **INC-0304 (Internal Note Leaks & Customer Privacy &rarr; FR-8, FR-10, NFR-2)**:
  * Strict database-level query isolation and dedicated customer serializers.
  * Internal notes are **never** fetched from the database for customer endpoints (eliminating application memory leak risks).
  * Automated privacy tests assert that confidential notes never appear across any customer endpoint.
  * Only public agent replies count toward fulfilling the Response SLA (FR-12).
* **INC-0318 (Audit Trail Tampering & Disputed Histories &rarr; FR-13, FR-14, FR-15, NFR-3)**:
  * All events (`ticket_creation`, `claim`, `reassignment`, `status_change`, `priority_change`, `public_reply`, `internal_note`, `pause`, `resume`, `breach`, `auto_close`, `reopen`) are permanently recorded.
  * All timestamps are generated strictly server-side in UTC.
  * Database triggers on `messages` and `audit_logs` prevent any `UPDATE` or `DELETE` operations.

---

## 2. Working Calendar & SLA Rules (SRS Section 3 & 8)

* **Working Time**: **09:30 to 18:30 IST**, Monday to Friday (9 working hours = 540 working minutes/day).
* **Timezone Standard**: Stored in UTC, computed in IST (UTC+05:30).
* **Weekend & Holiday Handling**: Saturdays, Sundays, and festival holidays stored in the editable `holidays` table are excluded from clock progression.
* **After-Hours Submission**: A ticket arriving after hours (or over a weekend) snaps its clock to 09:30 IST of the next working day.
  * *SRS Example Verified*: A ticket submitted at 18:00 Friday has 30 minutes elapsed by Monday 09:30 IST and is never marked late over the weekend.

### Priority & SLA Matrix (Configurable)
| Priority | First Reply SLA | Resolution SLA | Interpretation |
| :--- | :--- | :--- | :--- |
| **Urgent** | 2 working hours | Same working day | Resolved by 18:30 IST of the same working day (or 18:30 of next working day if submitted after hours). |
| **Medium** | 4.5 working hours | 3 working days | 27 working hours added via working calendar. |
| **Low** | 1 working day (9h) | 5 working days | 45 working hours added via working calendar. |

### SLA Pause, Auto-Close, and Reopen Rules
* **SLA Pause**: Transitioning to `Waiting on customer` freezes both the Response and Resolution clocks. The clock resumes automatically when the customer replies or when the status changes.
* **Auto-Close**: Tickets in `Waiting on customer` for **5 working days** (45 working hours) without reply are automatically marked `Closed`.
* **Reopen Window**: A customer may reopen a `Resolved` ticket within **5 working days**. 
  * Reopening continues the original SLA, excluding paused intervals.
  * Customer replies on a resolved ticket within 5 days reopen it automatically.
  * If the 5-day window has passed, or if the ticket was auto-closed, customer replies create a new linked ticket (`parent_ticket_id`).
* **Priority Changes**: Deadlines are recomputed from the original start time using the new target + cumulative paused time. If the new deadline has already elapsed, the ticket is immediately late. Downgrades **never** clear an existing breach.

---

## 3. Technology Stack

* **Backend**: Node.js (ES Modules, Express).
* **Database**:
  * **Development / Testing**: Node native `node:sqlite` (`DatabaseSync`) with SQLite triggers for zero external setup.
  * **Production**: PostgreSQL schema with PL/pgSQL triggers (`src/schema.sql`).
* **Frontend**: Vanilla HTML5, CSS3, JavaScript SPA with instant role switcher (Agent, Customer, Manager, Calendar).
* **Testing**: Node.js built-in test runner (`node --test`).

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
Run the full test suite verifying calendar math, race condition claiming, immutability, and customer privacy:
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

The test suite validates:
1. **Working Calendar Calculations (`tests/slaEngine.test.js`)**:
   * Friday 18:00 carryover across weekends (SRS 3.2 example).
   * Snapping after-hours arrivals to next working day 09:30 IST.
   * Skipping configurable festival holidays.
   * Urgent priority "Same working day" resolution vs after-hours next working day resolution.
   * Medium priority weekend spanning.
   * Priority change recalculation and breach preservation.
   * 5-working-day auto-close and reopen windows.
2. **Customer Privacy & Zero Note Leakage (`tests/privacy.test.js`)**:
   * Calls every customer-facing endpoint (`/api/customer/tickets`, `/api/customer/tickets/:id`, `/reply`) and asserts confidential agent internal notes never appear in payloads.
   * Verifies customer access control (customer 2 cannot see customer 1's tickets).
   * Verifies database triggers prevent updating or deleting `messages` and `audit_logs`.
3. **Concurrency & Race Conditions (`tests/concurrency.test.js`)**:
   * Dispatches parallel claim requests from different agents to an unassigned ticket.
   * Asserts exactly one winner (HTTP 200) and one loser receiving **HTTP 409 Conflict**.

---

## 6. Chosen Interpretations of Ambiguous Rules (Section 8)

| Question | Chosen Implementation |
| :--- | :--- |
| **Does "same working day" mean until 18:30 on the creation day?** | Yes. For tickets created within working hours (09:30-18:30 IST), deadline is 18:30 of that day. For tickets created after hours or on weekends/holidays, it means 18:30 IST of the next working day. |
| **Is "one week" 5 working days or 7 calendar days?** | 5 working days (45 working hours). |
| **Does a reopened ticket restart its SLA?** | No. It continues the original SLA, with all paused time excluded. |
| **Does a customer reply on a Resolved ticket reopen it?** | Yes, if within the 5-working-day window. Afterwards, it creates a new ticket linked to the old one (`parent_ticket_id`). |
| **Can an auto-closed ticket be reopened?** | No. Customer follow-up on an auto-closed ticket creates a new linked ticket. |

---

## 7. Short Note on Out-of-Scope Items (Section 9)

In accordance with **SRS Section 9 (Out of Scope)** and the 8-hour development budget:
* **Email Integration**: Direct inbound/outbound email parsing (SMTP/IMAP) was excluded in favor of the customer web portal.
* **External Notification Gateways**: SMS / WhatsApp / external Webhook notifications were excluded in favor of real-time server-side tracking and manager breach reports.
* **Advanced Analytics**: Replaced by clean manager KPI summary metrics and the late ticket breach report (FR-19).
