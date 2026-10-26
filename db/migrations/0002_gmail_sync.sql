-- Gmail sync (Milestone 2)

-- First-scan progress and sync health on the connected inbox.
ALTER TABLE gmail_accounts
  ADD COLUMN google_subject       text,
  ADD COLUMN scan_days            integer NOT NULL DEFAULT 14 CHECK (scan_days BETWEEN 1 AND 3650),
  ADD COLUMN scan_after           timestamptz,
  ADD COLUMN scan_page_token      text,
  ADD COLUMN scan_listed          integer NOT NULL DEFAULT 0 CHECK (scan_listed >= 0),
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0);

-- Only one inbox is connected at a time; switching inboxes means disconnecting first.
CREATE UNIQUE INDEX gmail_accounts_one_active ON gmail_accounts ((true)) WHERE status <> 'disconnected';

ALTER TABLE emails ADD COLUMN attachment_names text[] NOT NULL DEFAULT '{}';

-- Messages waiting to be fetched. A message that keeps failing stays here, visible,
-- instead of being dropped (attempts stops counting at the limit the code sets).
CREATE TABLE gmail_fetch_queue (
  gmail_account_id  uuid NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  gmail_message_id  text NOT NULL,
  is_historical     boolean NOT NULL,
  source            text NOT NULL CHECK (source IN ('initial_scan', 'history', 'recovery')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error        text,
  not_before        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gmail_account_id, gmail_message_id)
);
CREATE INDEX gmail_fetch_queue_due_idx ON gmail_fetch_queue (is_historical, not_before);
ALTER TABLE gmail_fetch_queue ENABLE ROW LEVEL SECURITY;
