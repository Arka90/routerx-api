/**
 * Public status pages and incident updates.
 *
 * The incidents table records that something broke; it has nowhere to say
 * what is being done about it. Updates give an incident a narrative, and the
 * status page is where customers read it without having an account.
 */
export const up = `
CREATE TABLE status_pages (
  id           BIGSERIAL PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  headline     TEXT,
  about        TEXT,
  support_url  TEXT,
  -- Unpublished pages 404 for the public, so a page can be assembled before
  -- anyone is pointed at it.
  published    BOOLEAN NOT NULL DEFAULT false,
  show_uptime  BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_status_pages_org ON status_pages(org_id);

CREATE TABLE status_page_monitors (
  status_page_id BIGINT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  monitor_id     BIGINT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  -- What the public sees. A monitor's URL is internal detail and often
  -- carries a health-check path nobody outside should be handed.
  display_name   TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (status_page_id, monitor_id)
);

CREATE INDEX idx_status_page_monitors_monitor ON status_page_monitors(monitor_id);

CREATE TABLE incident_updates (
  id          BIGSERIAL PRIMARY KEY,
  incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  author_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL
                CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  body        TEXT NOT NULL,
  -- An internal note stays off the status page.
  is_public   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_incident_updates_incident ON incident_updates(incident_id, created_at DESC);

CREATE TABLE status_page_subscribers (
  id                      BIGSERIAL PRIMARY KEY,
  status_page_id          BIGINT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  email                   CITEXT NOT NULL,
  -- Double opt-in: a confirmed row is one whose owner asked for it, which is
  -- also what stops the endpoint being used to mail strangers.
  confirmed_at            TIMESTAMPTZ,
  confirm_token_hash      TEXT,
  unsubscribe_token_hash  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (status_page_id, email)
);

CREATE INDEX idx_status_page_subscribers_page
  ON status_page_subscribers(status_page_id) WHERE confirmed_at IS NOT NULL;

-- Which incidents a subscriber has already been mailed about, so a restart or
-- a re-run cannot send the same announcement twice.
CREATE TABLE status_page_notifications (
  status_page_id BIGINT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  incident_id    BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event          TEXT NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (status_page_id, incident_id, event)
);
`;
