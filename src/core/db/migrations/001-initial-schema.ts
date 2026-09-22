/**
 * Initial Postgres schema.
 *
 * Migrations are TypeScript modules exporting SQL rather than .sql files on
 * disk: `tsc` does not copy non-TS assets into dist/, so a .sql file would
 * compile fine locally and then be missing inside the Docker image.
 *
 * Statuses and roles are TEXT with CHECK constraints rather than Postgres
 * enums. Adding a value to an enum needs ALTER TYPE and cannot run inside the
 * same transaction as the rest of a migration on older servers; a CHECK is
 * just a constraint swap.
 */
export const up = `
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------

CREATE TABLE users (
  id          BIGSERIAL PRIMARY KEY,
  email       CITEXT UNIQUE NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_codes_user ON otp_codes(user_id);

-- Sessions are now server-side records, not just a signed claim. The JWT
-- carries the session id, so revoking a row logs that device out
-- immediately instead of leaving a valid token alive for its full 7 days.
CREATE TABLE sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT UNIQUE NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------

CREATE TABLE organizations (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX idx_org_members_user ON org_members(user_id);

CREATE TABLE org_invites (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       CITEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  token_hash  TEXT NOT NULL,
  invited_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live invite per address per org. Re-inviting replaces rather than
-- stacking, so a revoked invite cannot be resurrected by a stale link.
CREATE UNIQUE INDEX idx_org_invites_pending
  ON org_invites(org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX idx_org_invites_email ON org_invites(email) WHERE accepted_at IS NULL;

-- ---------------------------------------------------------------
-- Monitors
-- ---------------------------------------------------------------

CREATE TABLE monitors (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name                  TEXT,
  url                   TEXT NOT NULL,

  -- Request shape. A monitor used to be a bare GET; "returns 200 but renders
  -- an error page" is the outage people actually get burned by, so the check
  -- can now assert on method, status and body content.
  method                TEXT NOT NULL DEFAULT 'GET'
                          CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  request_headers       JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_body          TEXT,
  expected_status_codes INTEGER[] NOT NULL DEFAULT '{}',
  -- No user-supplied regex on purpose. The worker runs checks with
  -- concurrency 1, so one catastrophically backtracking pattern against an
  -- attacker-influenced response body would stall monitoring for every
  -- customer, not just the one who wrote it.
  assertion_type        TEXT NOT NULL DEFAULT 'none'
                          CHECK (assertion_type IN ('none', 'contains', 'not_contains', 'json_path')),
  assertion_value       TEXT,
  timeout_ms            INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  follow_redirects      BOOLEAN NOT NULL DEFAULT true,

  interval_seconds      INTEGER NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 30 AND 3600),
  paused                BOOLEAN NOT NULL DEFAULT false,

  confirmed_status      TEXT NOT NULL DEFAULT 'UNCONFIRMED'
                          CHECK (confirmed_status IN ('UP', 'DOWN', 'DEGRADED', 'UNCONFIRMED', 'MAINTENANCE')),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,

  tls_expiry_at         TIMESTAMPTZ,
  tls_alerted_days      INTEGER[] NOT NULL DEFAULT '{}',

  in_maintenance        BOOLEAN NOT NULL DEFAULT false,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Same URL with a different method is a legitimately different check.
  UNIQUE (org_id, url, method)
);

CREATE INDEX idx_monitors_org ON monitors(org_id);

CREATE TABLE probe_results (
  id               BIGSERIAL PRIMARY KEY,
  monitor_id       BIGINT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  dns              INTEGER,
  tcp              INTEGER,
  tls              INTEGER,
  ttfb             INTEGER,
  status           TEXT NOT NULL,
  http_status_code INTEGER,
  root_cause       TEXT,
  failure_detail   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_probe_results_monitor_created
  ON probe_results(monitor_id, created_at DESC);

CREATE TABLE incidents (
  id               BIGSERIAL PRIMARY KEY,
  monitor_id       BIGINT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL,
  resolved_at      TIMESTAMPTZ,
  duration_seconds INTEGER,
  root_cause       TEXT,
  failure_detail   TEXT,
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  last_notified_at TIMESTAMPTZ,
  notify_count     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one open incident per monitor, enforced by the database rather than
-- by a read-then-write in the worker that two probes could interleave on.
CREATE UNIQUE INDEX idx_incidents_one_open
  ON incidents(monitor_id)
  WHERE resolved_at IS NULL;

CREATE INDEX idx_incidents_monitor_started
  ON incidents(monitor_id, started_at DESC);

CREATE TABLE maintenance_windows (
  id          BIGSERIAL PRIMARY KEY,
  monitor_id  BIGINT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX idx_maintenance_monitor ON maintenance_windows(monitor_id);

-- ---------------------------------------------------------------
-- Alerting
-- ---------------------------------------------------------------

CREATE TABLE notification_channels (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('email', 'slack', 'discord', 'webhook')),
  name        TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_channels_org ON notification_channels(org_id);

CREATE TABLE monitor_channels (
  monitor_id BIGINT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, channel_id)
);

CREATE INDEX idx_monitor_channels_channel ON monitor_channels(channel_id);

-- Thresholds used to be module-level constants applied to every monitor.
CREATE TABLE alert_policies (
  monitor_id         BIGINT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  failure_threshold  INTEGER NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 10),
  recovery_threshold INTEGER NOT NULL DEFAULT 2 CHECK (recovery_threshold BETWEEN 1 AND 10),
  -- "Alive but dying slowly" was advertised and never implemented: the
  -- worker's failure branch only matched DOWN, so a SLOW verdict fell through
  -- to the success path and nobody was ever told.
  alert_on_slow      BOOLEAN NOT NULL DEFAULT false,
  slow_threshold_ms  INTEGER NOT NULL DEFAULT 1500 CHECK (slow_threshold_ms BETWEEN 100 AND 60000),
  -- NULL means "tell me once and stay quiet until it recovers".
  renotify_minutes   INTEGER CHECK (renotify_minutes IS NULL OR renotify_minutes BETWEEN 5 AND 1440),
  muted_until        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alert_deliveries (
  id           BIGSERIAL PRIMARY KEY,
  monitor_id   BIGINT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  incident_id  BIGINT REFERENCES incidents(id) ON DELETE SET NULL,
  channel_id   BIGINT REFERENCES notification_channels(id) ON DELETE SET NULL,
  channel_type TEXT NOT NULL,
  event        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_deliveries_monitor_created
  ON alert_deliveries(monitor_id, created_at DESC);
`;
