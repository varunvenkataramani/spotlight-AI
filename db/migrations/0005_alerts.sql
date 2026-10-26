-- Alerts, reminders and "flag for her" (Milestone 5)

-- Which alerts each admin wants. Channels already live in users.alert_channels.
--   new_offers: 'high' (high-priority offers only), 'all', or 'off'
ALTER TABLE users
  ADD COLUMN alert_types jsonb NOT NULL
    DEFAULT '{"new_offers": "high", "deadlines": true, "changes": true, "nudges": true}'::jsonb,
  -- Telegram linking: a one-time code (only its hash is stored) that the bot receives as /start <code>.
  ADD COLUMN telegram_link_hash text,
  ADD COLUMN telegram_link_expires_at timestamptz,
  ADD COLUMN telegram_linked_at timestamptz,
  -- After she taps "Questions" in Telegram, her next message is saved as her question for this offer.
  ADD COLUMN telegram_awaiting_opportunity uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  ADD COLUMN telegram_awaiting_until timestamptz,
  ADD CONSTRAINT users_new_offers_choice CHECK (alert_types->>'new_offers' IN ('high', 'all', 'off')),
  ADD CONSTRAINT users_link_code_expires CHECK (telegram_link_hash IS NULL OR telegram_link_expires_at IS NOT NULL);
-- One Telegram chat belongs to one admin, so a tap in that chat is always attributed correctly.
CREATE UNIQUE INDEX users_telegram_chat_unique ON users (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
CREATE UNIQUE INDEX users_telegram_link_unique ON users (telegram_link_hash) WHERE telegram_link_hash IS NOT NULL;

-- Delivery: when a message may go out (quiet hours delay phone notifications), retries, and
-- the buttons a Telegram message carries.
ALTER TABLE notifications
  ADD COLUMN kind text NOT NULL DEFAULT 'general',
  ADD COLUMN deliver_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT notifications_attempts_bounded CHECK (attempts BETWEEN 0 AND 10),
  ADD CONSTRAINT notifications_sent_has_time CHECK (status <> 'sent' OR sent_at IS NOT NULL);
CREATE INDEX notifications_outbox_idx ON notifications (deliver_after) WHERE status = 'pending';

-- Which server key a phone subscribed with; if that key changes, the subscription is dropped.
ALTER TABLE push_subscriptions
  ADD COLUMN server_key text,
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Reminders an admin sets on an offer: for one admin or both, with a short note.
ALTER TABLE reminders
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN for_user uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN note text CHECK (note IS NULL OR length(note) <= 300),
  ADD CONSTRAINT reminders_custom_has_creator CHECK (kind <> 'custom' OR created_by IS NOT NULL);

-- Her answer only exists for an offer that was put to her.
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_response_needs_flag CHECK (talent_response IS NULL OR flagged_for_talent_at IS NOT NULL),
  ADD CONSTRAINT opportunities_response_note_length CHECK (talent_response_note IS NULL OR length(talent_response_note) <= 1000);
CREATE INDEX opportunities_flagged_idx ON opportunities (flagged_for_talent_at) WHERE flagged_for_talent_at IS NOT NULL;

-- Telegram can deliver the same update twice; each is handled once.
CREATE TABLE telegram_updates (
  update_id    bigint PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telegram_updates ENABLE ROW LEVEL SECURITY;

-- Which admin is the actress (her account gets "flag for her" questions). Set in Settings.
INSERT INTO preferences (key, value) VALUES ('talent_email', 'null'::jsonb) ON CONFLICT (key) DO NOTHING;
