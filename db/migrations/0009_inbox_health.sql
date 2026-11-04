-- Inbox health: knowing when Google's access will lapse, and optionally reading the Spam folder.

-- When Google last granted access (connect or reconnect). While the Google app is in Testing mode,
-- Google ends that access 7 days later, so Spotlight warns a day ahead.
ALTER TABLE gmail_accounts ADD COLUMN authorized_at timestamptz;
UPDATE gmail_accounts g
SET authorized_at = GREATEST(
  g.connected_at,
  COALESCE((SELECT max(a.created_at) FROM activities a WHERE a.kind IN ('gmail_connected', 'gmail_reconnected')), g.connected_at)
);
ALTER TABLE gmail_accounts ALTER COLUMN authorized_at SET DEFAULT now();

-- Also read the Spam folder (off unless an admin turns it on). Turning it on reads the last
-- 30 days of spam once, page by page, then new spam as it arrives.
ALTER TABLE gmail_accounts
  ADD COLUMN include_spam boolean NOT NULL DEFAULT false,
  ADD COLUMN spam_scan_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN spam_scan_page_token text,
  ADD CONSTRAINT gmail_accounts_spam_scan_needs_spam CHECK (include_spam OR (NOT spam_scan_pending AND spam_scan_page_token IS NULL));
