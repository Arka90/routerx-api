/**
 * Multi-region probing.
 *
 * A single vantage point cannot tell "the site is down" from "the path
 * between our one worker and the site is down", so a lone failure is a
 * coin flip on whether anyone should be woken up. Checks now run from every
 * region a monitor is assigned to, each region keeps its own streak, and an
 * incident opens only once enough regions independently agree.
 */
export const up = `
CREATE TABLE regions (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing deployments run one worker with no REGION set, which reports as
-- 'default'. Seeding it keeps every current monitor scheduled.
INSERT INTO regions (code, name) VALUES ('default', 'Primary');

-- Empty means "every enabled region", so a monitor does not have to be
-- rewritten when a region is added.
ALTER TABLE monitors ADD COLUMN regions TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE probe_results ADD COLUMN region TEXT NOT NULL DEFAULT 'default';

CREATE INDEX idx_probe_results_monitor_region_created
  ON probe_results(monitor_id, region, created_at DESC);

-- How many regions must independently reach their failure threshold before an
-- incident opens. 1 preserves the previous single-vantage behaviour.
ALTER TABLE alert_policies
  ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 1
    CHECK (confirmations BETWEEN 1 AND 10);

CREATE TABLE monitor_region_state (
  monitor_id            BIGINT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  region                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'UNCONFIRMED'
                          CHECK (status IN ('UP', 'DOWN', 'DEGRADED', 'UNCONFIRMED')),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_checked_at       TIMESTAMPTZ,
  last_root_cause       TEXT,
  last_detail           TEXT,
  PRIMARY KEY (monitor_id, region)
);

-- Carry the existing single-vantage state across so nothing re-alerts on the
-- first check after the upgrade.
INSERT INTO monitor_region_state
  (monitor_id, region, status, consecutive_failures, consecutive_successes)
SELECT
  id,
  'default',
  CASE WHEN confirmed_status IN ('UP', 'DOWN', 'DEGRADED') THEN confirmed_status
       ELSE 'UNCONFIRMED' END,
  consecutive_failures,
  consecutive_successes
FROM monitors;

-- Incidents record where the failure was seen, which is the first question
-- anyone asks about a partial outage.
ALTER TABLE incidents ADD COLUMN affected_regions TEXT[] NOT NULL DEFAULT '{}';
`;
