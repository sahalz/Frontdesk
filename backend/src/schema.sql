-- Frontdesk PostgreSQL Production Schema
-- Designed for Arvo Systems Support Ticketing System (SRS v1.0)

-- SLA Targets Configuration Table
CREATE TABLE IF NOT EXISTS config_sla (
    priority VARCHAR(20) PRIMARY KEY,
    first_reply_minutes INTEGER NOT NULL,
    resolve_type VARCHAR(30) NOT NULL, -- 'same_working_day' or 'working_days'
    resolve_days INTEGER NOT NULL
);

INSERT INTO config_sla (priority, first_reply_minutes, resolve_type, resolve_days) VALUES
    ('urgent', 120, 'same_working_day', 0),
    ('medium', 270, 'working_days', 3),
    ('low', 540, 'working_days', 5)
ON CONFLICT (priority) DO NOTHING;

-- Editable Holidays Table
CREATE TABLE IF NOT EXISTS holidays (
    id SERIAL PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Users Table (Agents, Managers, Customers)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(32) NOT NULL CHECK (role IN ('agent', 'manager', 'customer')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_unique ON users (auth_user_id);

-- Self-registered customers use a user ID without an email address.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

CREATE TABLE IF NOT EXISTS customer_credentials (
    user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS customer_sessions_expiry ON customer_sessions (expires_at);
ALTER TABLE customer_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;

-- Tickets Table
CREATE TABLE IF NOT EXISTS tickets (
    id VARCHAR(64) PRIMARY KEY,
    subject VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    customer_id VARCHAR(64) NOT NULL REFERENCES users(id),
    assigned_agent_id VARCHAR(64) REFERENCES users(id),
    priority VARCHAR(20) NOT NULL CHECK (priority IN ('urgent', 'medium', 'low')),
    status VARCHAR(32) NOT NULL CHECK (status IN ('Open', 'In progress', 'Waiting on customer', 'Resolved', 'Closed', 'Reopened')),
    parent_ticket_id VARCHAR(64) REFERENCES tickets(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    response_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    resolution_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    first_public_reply_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    closed_at TIMESTAMP WITH TIME ZONE,
    waiting_since TIMESTAMP WITH TIME ZONE,
    total_paused_minutes INTEGER DEFAULT 0,
    response_breached BOOLEAN DEFAULT FALSE,
    resolution_breached BOOLEAN DEFAULT FALSE
);

-- Messages Table (Append-Only)
CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(64) PRIMARY KEY,
    ticket_id VARCHAR(64) NOT NULL REFERENCES tickets(id),
    author_id VARCHAR(64) NOT NULL REFERENCES users(id),
    author_role VARCHAR(32) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('public_reply', 'internal_note')),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- SLA Pause Intervals (for accurate recomputations)
CREATE TABLE IF NOT EXISTS sla_pause_intervals (
    id VARCHAR(64) PRIMARY KEY,
    ticket_id VARCHAR(64) NOT NULL REFERENCES tickets(id),
    paused_at TIMESTAMP WITH TIME ZONE NOT NULL,
    resumed_at TIMESTAMP WITH TIME ZONE,
    working_minutes_paused INTEGER DEFAULT 0
);

-- Audit Log Table (Append-Only)
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    ticket_id VARCHAR(64) NOT NULL REFERENCES tickets(id),
    actor_id VARCHAR(64) REFERENCES users(id),
    actor_name VARCHAR(255),
    action VARCHAR(64) NOT NULL,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Immutability Enforcement (NFR-3, FR-15)
CREATE OR REPLACE FUNCTION prevent_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is strictly append-only. Modification and deletion are prohibited by policy.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_messages_update ON messages;
CREATE TRIGGER trg_prevent_messages_update
BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS trg_prevent_messages_delete ON messages;
CREATE TRIGGER trg_prevent_messages_delete
BEFORE DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS trg_prevent_audit_logs_update ON audit_logs;
CREATE TRIGGER trg_prevent_audit_logs_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS trg_prevent_audit_logs_delete ON audit_logs;
CREATE TRIGGER trg_prevent_audit_logs_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_modification();

-- -----------------------------------------------------------------------------
-- Production Hardening: Role-Based Privilege Revocation (NFR-3)
-- -----------------------------------------------------------------------------
-- While triggers prevent application-level UPDATE and DELETE statements in runtime queries,
-- a database role with DDL or table ownership privileges could theoretically drop or disable
-- triggers.
-- For defense-in-depth, configure a dedicated application runtime role (e.g. frontdesk_app)
-- that explicitly lacks UPDATE, DELETE, and TRIGGER rights on append-only tables:
--
-- CREATE ROLE frontdesk_app WITH LOGIN PASSWORD 'change_this_in_production';
-- GRANT CONNECT ON DATABASE frontdesk_db TO frontdesk_app;
-- GRANT USAGE ON SCHEMA public TO frontdesk_app;
--
-- GRANT SELECT, INSERT, UPDATE ON tickets, sla_pause_intervals, config_sla, holidays TO frontdesk_app;
-- GRANT SELECT, INSERT ON messages, audit_logs TO frontdesk_app;
--
-- Explicitly ensure UPDATE and DELETE privileges are revoked:
-- REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON messages FROM frontdesk_app;
-- REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON audit_logs FROM frontdesk_app;
-- -----------------------------------------------------------------------------
