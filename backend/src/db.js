/**
 * Database Module for Frontdesk
 * Implements SQLite DatabaseSync with schema initialization,
 * strict append-only triggers, and helper utilities.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createDatabase(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);

  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');

  // Initialize tables
  db.exec(`
    -- Config SLA Table
    CREATE TABLE IF NOT EXISTS config_sla (
      priority TEXT PRIMARY KEY,
      first_reply_minutes INTEGER NOT NULL,
      resolve_type TEXT NOT NULL,
      resolve_days INTEGER NOT NULL
    );

    -- Editable Holidays Table
    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Users Table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('agent', 'manager', 'customer')),
      created_at TEXT NOT NULL
    );

    -- Tickets Table
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES users(id),
      assigned_agent_id TEXT REFERENCES users(id),
      priority TEXT NOT NULL CHECK(priority IN ('urgent', 'medium', 'low')),
      status TEXT NOT NULL CHECK(status IN ('Open', 'In progress', 'Waiting on customer', 'Resolved', 'Closed', 'Reopened')),
      parent_ticket_id TEXT REFERENCES tickets(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      response_deadline TEXT NOT NULL,
      resolution_deadline TEXT NOT NULL,
      first_public_reply_at TEXT,
      resolved_at TEXT,
      closed_at TEXT,
      waiting_since TEXT,
      total_paused_minutes INTEGER DEFAULT 0,
      response_breached INTEGER DEFAULT 0,
      resolution_breached INTEGER DEFAULT 0
    );

    -- Messages Table (Append-Only)
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      author_id TEXT NOT NULL REFERENCES users(id),
      author_role TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('public_reply', 'internal_note')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- SLA Pause Intervals
    CREATE TABLE IF NOT EXISTS sla_pause_intervals (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      paused_at TEXT NOT NULL,
      resumed_at TEXT,
      working_minutes_paused INTEGER DEFAULT 0
    );

    -- Audit Logs (Append-Only)
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      actor_id TEXT REFERENCES users(id),
      actor_name TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    -- Database-level Immutability Triggers (NFR-3, FR-15)
    DROP TRIGGER IF EXISTS prevent_messages_update;
    CREATE TRIGGER prevent_messages_update
    BEFORE UPDATE ON messages
    BEGIN
      SELECT RAISE(FAIL, 'Messages are append-only and cannot be updated');
    END;

    DROP TRIGGER IF EXISTS prevent_messages_delete;
    CREATE TRIGGER prevent_messages_delete
    BEFORE DELETE ON messages
    BEGIN
      SELECT RAISE(FAIL, 'Messages are append-only and cannot be deleted');
    END;

    DROP TRIGGER IF EXISTS prevent_audit_logs_update;
    CREATE TRIGGER prevent_audit_logs_update
    BEFORE UPDATE ON audit_logs
    BEGIN
      SELECT RAISE(FAIL, 'Audit logs are append-only and cannot be updated');
    END;

    DROP TRIGGER IF EXISTS prevent_audit_logs_delete;
    CREATE TRIGGER prevent_audit_logs_delete
    BEFORE DELETE ON audit_logs
    BEGIN
      SELECT RAISE(FAIL, 'Audit logs are append-only and cannot be deleted');
    END;
  `);

  // Seed default SLA configs if empty
  const countSla = db.prepare('SELECT COUNT(*) as count FROM config_sla').get().count;
  if (countSla === 0) {
    const insertSla = db.prepare('INSERT INTO config_sla (priority, first_reply_minutes, resolve_type, resolve_days) VALUES (?, ?, ?, ?)');
    insertSla.run('urgent', 120, 'same_working_day', 0);
    insertSla.run('medium', 270, 'working_days', 3);
    insertSla.run('low', 540, 'working_days', 5);
  }

  // Seed default initial users if empty
  const countUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (countUsers === 0) {
    const insertUser = db.prepare('INSERT INTO users (id, name, email, role, created_at) VALUES (?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    insertUser.run('agent-1', 'Meera (Lead Agent)', 'meera@arvo.internal', 'agent', now);
    insertUser.run('agent-2', 'Rahul (Support Agent)', 'rahul@arvo.internal', 'agent', now);
    insertUser.run('agent-3', 'Priya (Support Agent)', 'priya@arvo.internal', 'agent', now);
    insertUser.run('mgr-1', 'Vikram (Support Manager)', 'vikram@arvo.internal', 'manager', now);
    insertUser.run('cust-1', 'Acme Corp (Customer)', 'contact@acmecorp.com', 'customer', now);
    insertUser.run('cust-2', 'Beta Logistics (Customer)', 'support@betalogistics.com', 'customer', now);
  }

  return db;
}

// Global default DB instance for application server
let defaultDb = null;

export function getDatabase() {
  if (!defaultDb) {
    const defaultFile = path.resolve(__dirname, '../frontdesk.sqlite');
    defaultDb = createDatabase(defaultFile);
  }
  return defaultDb;
}
