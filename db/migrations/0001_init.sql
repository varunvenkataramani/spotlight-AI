-- Spotlight AI: initial schema
-- Every table in the build plan, with the rules that protect data integrity
-- enforced by the database itself (unique keys, checks, append-only log).

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE CHECK (email = lower(email)),
  name               text,
  avatar_url         text,
  role               text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  alert_channels     jsonb NOT NULL DEFAULT '{"in_app": true, "push": true, "telegram": false}'::jsonb,
  quiet_hours_start  time DEFAULT '23:00',
  quiet_hours_end    time DEFAULT '08:00',
  timezone           text NOT NULL DEFAULT 'Asia/Kolkata',
  telegram_chat_id   text,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Connected Gmail inbox (tokens are stored encrypted by the application)
-- ---------------------------------------------------------------------------

CREATE TABLE gmail_accounts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                      text NOT NULL UNIQUE CHECK (email = lower(email)),
  status                     text NOT NULL DEFAULT 'connected'
                             CHECK (status IN ('connected', 'needs_reconnect', 'revoked', 'error', 'disconnected')),
  refresh_token_enc          text,
  access_token_enc           text,
  access_token_expires_at    timestamptz,
  scopes                     text[] NOT NULL DEFAULT '{}',
  history_id                 text,
  watch_expires_at           timestamptz,
  last_synced_at             timestamptz,
  last_error                 text,
  last_error_at              timestamptz,
  initial_scan_completed_at  timestamptz,
  connected_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at               timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gmail_accounts_updated_at BEFORE UPDATE ON gmail_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Source emails: one row per Gmail message, processed exactly once
-- ---------------------------------------------------------------------------

CREATE TABLE emails (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_account_id           uuid NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  gmail_message_id           text NOT NULL,
  gmail_thread_id            text NOT NULL,
  rfc_message_id             text,
  in_reply_to                text,
  from_name                  text,
  from_email                 text,
  reply_to                   text,
  to_emails                  text[] NOT NULL DEFAULT '{}',
  cc_emails                  text[] NOT NULL DEFAULT '{}',
  subject                    text,
  snippet                    text,
  body_text                  text,
  received_at                timestamptz NOT NULL,
  gmail_labels               text[] NOT NULL DEFAULT '{}',
  has_attachments            boolean NOT NULL DEFAULT false,
  is_historical              boolean NOT NULL DEFAULT false,
  processing_state           text NOT NULL DEFAULT 'pending'
                             CHECK (processing_state IN ('pending', 'processing', 'processed', 'failed', 'needs_review', 'skipped')),
  processing_attempts        integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  processing_error           text,
  classification             text
                             CHECK (classification IN (
                               'new_opportunity', 'opportunity_update', 'negotiation_or_contract',
                               'availability_request', 'unrelated', 'newsletter_or_spam', 'suspicious', 'unclear')),
  classification_confidence  numeric(4, 3) CHECK (classification_confidence BETWEEN 0 AND 1),
  classification_reason      text,
  source_deleted_at          timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gmail_account_id, gmail_message_id)
);
CREATE INDEX emails_thread_idx ON emails (gmail_account_id, gmail_thread_id);
CREATE INDEX emails_pending_idx ON emails (processing_state) WHERE processing_state IN ('pending', 'failed');
CREATE INDEX emails_received_idx ON emails (received_at DESC);
CREATE TRIGGER emails_updated_at BEFORE UPDATE ON emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Categories (configurable: add, rename or disable without code changes)
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9_]+$'),
  name        text NOT NULL,
  description text,
  is_enabled  boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO categories (slug, name, description, sort_order) VALUES
  ('brand_collaborations', 'Brand collaborations', 'Endorsements, influencer campaigns, sponsorships and brand partnerships', 10),
  ('social_media', 'Social media', 'Instagram posts, reels, stories, content partnerships and paid promotions', 20),
  ('paid_shoots_advertising', 'Paid shoots and advertising', 'Photoshoots, TV commercials, digital ads, campaign videos and promotional shoots', 30),
  ('film_entertainment', 'Film and entertainment', 'Films, web series, OTT, television, auditions and casting calls', 40),
  ('events_appearances', 'Events and appearances', 'Guest appearances, award shows, launches, inaugurations and speaking', 50),
  ('media_publicity', 'Media and publicity', 'Interviews, podcasts, press and promotional appearances', 60),
  ('commercial_affiliate', 'Commercial and affiliate', 'Affiliate arrangements, product promotions, gifting and barter', 70),
  ('representation_partnerships', 'Representation and partnerships', 'Talent agencies, management and professional partnerships', 80),
  ('needs_review', 'Needs review', 'Relevant-looking emails that cannot yet be classified reliably', 90);

-- ---------------------------------------------------------------------------
-- Opportunities: one record per real project, however many emails it spans
-- ---------------------------------------------------------------------------

CREATE TABLE opportunities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_account_id      uuid NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  title                 text NOT NULL,
  category_id           uuid REFERENCES categories(id) ON DELETE SET NULL,
  subcategory           text,
  summary               text,
  description           text,

  sender_name           text,
  sender_email          text,
  organization          text,
  sender_role           text,
  contact_phone         text,
  contact_links         jsonb NOT NULL DEFAULT '[]'::jsonb,

  compensation_type     text NOT NULL DEFAULT 'unspecified'
                        CHECK (compensation_type IN ('paid', 'unpaid', 'barter', 'commission', 'affiliate', 'unspecified')),
  compensation_status   text NOT NULL DEFAULT 'not_disclosed'
                        CHECK (compensation_status IN ('confirmed', 'range', 'requested_rate', 'not_disclosed')),
  amount_min            numeric(14, 2) CHECK (amount_min >= 0),
  amount_max            numeric(14, 2) CHECK (amount_max >= 0),
  currency              char(3) NOT NULL DEFAULT 'INR' CHECK (currency = upper(currency)),
  payment_terms         text,
  is_negotiable         boolean,
  usage_rights          text,
  exclusivity           text,
  expenses_covered      text,
  deliverables          jsonb NOT NULL DEFAULT '[]'::jsonb,

  location              text,
  format                text NOT NULL DEFAULT 'unknown'
                        CHECK (format IN ('in_person', 'remote', 'hybrid', 'unknown')),
  event_start_at        timestamptz,
  event_end_at          timestamptz,
  reply_by_at           timestamptz,
  next_deadline_at      timestamptz,

  requested_action      text,
  next_action           text,
  missing_information   jsonb NOT NULL DEFAULT '[]'::jsonb,

  priority              text NOT NULL DEFAULT 'needs_review'
                        CHECK (priority IN ('high', 'medium', 'low', 'needs_review')),
  priority_score        integer,
  priority_reasons      jsonb NOT NULL DEFAULT '[]'::jsonb,
  red_flags             jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence            numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),

  status                text NOT NULL DEFAULT 'new'
                        CHECK (status IN (
                          'new', 'reviewed', 'interested', 'needs_information', 'reply_drafted',
                          'awaiting_my_response', 'awaiting_their_response', 'in_negotiation',
                          'confirmed', 'accepted', 'declined', 'completed', 'expired', 'archived')),
  is_irrelevant         boolean NOT NULL DEFAULT false,
  is_read               boolean NOT NULL DEFAULT false,
  snoozed_until         timestamptz,

  flagged_for_talent_at timestamptz,
  flagged_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  talent_response       text CHECK (talent_response IN ('interested', 'pass', 'questions')),
  talent_response_note  text,
  talent_responded_at   timestamptz,

  first_received_at     timestamptz,
  last_activity_at      timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  search                tsvector GENERATED ALWAYS AS (
                          to_tsvector('simple'::regconfig,
                            coalesce(title, '') || ' ' || coalesce(organization, '') || ' ' ||
                            coalesce(sender_name, '') || ' ' || coalesce(sender_email, '') || ' ' ||
                            coalesce(summary, ''))
                        ) STORED,

  CHECK (amount_max IS NULL OR amount_min IS NULL OR amount_max >= amount_min),
  CHECK (event_end_at IS NULL OR event_start_at IS NULL OR event_end_at >= event_start_at),
  CHECK (talent_response IS NULL OR talent_responded_at IS NOT NULL)
);
CREATE INDEX opportunities_status_idx ON opportunities (status);
CREATE INDEX opportunities_priority_idx ON opportunities (priority);
CREATE INDEX opportunities_deadline_idx ON opportunities (next_deadline_at) WHERE next_deadline_at IS NOT NULL;
CREATE INDEX opportunities_sender_idx ON opportunities (lower(sender_email));
CREATE INDEX opportunities_category_idx ON opportunities (category_id);
CREATE INDEX opportunities_search_idx ON opportunities USING gin (search);
CREATE TRIGGER opportunities_updated_at BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Many-to-many: one opportunity spans many emails; one email may hold several offers.
CREATE TABLE opportunity_emails (
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  email_id        uuid NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'original'
                  CHECK (role IN ('original', 'follow_up', 'change', 'contract', 'cancellation', 'other')),
  linked_by       text NOT NULL DEFAULT 'thread' CHECK (linked_by IN ('thread', 'ai_match', 'admin')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, email_id)
);
CREATE INDEX opportunity_emails_email_idx ON opportunity_emails (email_id);

-- Every extracted value keeps the exact quote it came from.
CREATE TABLE extracted_fields (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  email_id        uuid REFERENCES emails(id) ON DELETE SET NULL,
  field_name      text NOT NULL,
  value_text      text,
  value_json      jsonb,
  source_quote    text,
  is_verified     boolean NOT NULL DEFAULT false,
  confidence      numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  is_current      boolean NOT NULL DEFAULT true,
  corrected_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  corrected_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A value is "verified" only when it carries the quote it was taken from, or an admin set it.
  CHECK (NOT is_verified OR source_quote IS NOT NULL OR corrected_by IS NOT NULL)
);
CREATE INDEX extracted_fields_opp_idx ON extracted_fields (opportunity_id, field_name) WHERE is_current;

-- Admin corrections, kept to improve future classification.
CREATE TABLE corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  email_id        uuid REFERENCES emails(id) ON DELETE SET NULL,
  field_name      text NOT NULL,
  old_value       jsonb,
  new_value       jsonb,
  corrected_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX corrections_recent_idx ON corrections (created_at DESC);

-- ---------------------------------------------------------------------------
-- Activity timeline: append-only audit log
-- ---------------------------------------------------------------------------

CREATE TABLE activities (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  actor_type      text NOT NULL CHECK (actor_type IN ('system', 'ai', 'user')),
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  kind            text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_type <> 'user' OR actor_user_id IS NOT NULL)
);
CREATE INDEX activities_opp_idx ON activities (opportunity_id, created_at DESC);

CREATE OR REPLACE FUNCTION activities_append_only() RETURNS trigger AS $$
BEGIN
  -- Deleting a whole opportunity cascades to its history; that is allowed.
  IF TG_OP = 'DELETE' AND OLD.opportunity_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM opportunities WHERE id = OLD.opportunity_id) THEN
    RETURN OLD;
  END IF;
  -- Removing an admin account clears the actor reference; nothing else may change.
  IF TG_OP = 'UPDATE' AND NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
     AND (to_jsonb(NEW) - 'actor_user_id' - 'actor_type') = (to_jsonb(OLD) - 'actor_user_id' - 'actor_type') THEN
    NEW.actor_type := 'system';
    NEW.detail := OLD.detail || jsonb_build_object('former_actor_user_id', OLD.actor_user_id);
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activities is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER activities_no_update BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION activities_append_only();
CREATE TRIGGER activities_no_delete BEFORE DELETE ON activities
  FOR EACH ROW EXECUTE FUNCTION activities_append_only();

-- ---------------------------------------------------------------------------
-- Reply drafts: nothing is "sent" without a recorded human approval
-- ---------------------------------------------------------------------------

CREATE TABLE drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  reply_to_email  uuid REFERENCES emails(id) ON DELETE SET NULL,
  mode            text NOT NULL CHECK (mode IN (
                    'express_interest', 'confirm_availability', 'ask_budget', 'share_portfolio',
                    'negotiate', 'clarify', 'decline', 'follow_up', 'custom')),
  tone            text NOT NULL DEFAULT 'professional'
                  CHECK (tone IN ('professional', 'friendly', 'concise', 'assertive')),
  subject         text,
  body            text,
  gmail_draft_id  text,
  status          text NOT NULL DEFAULT 'generating'
                  CHECK (status IN ('generating', 'ready', 'saved_to_gmail', 'sent', 'failed', 'discarded')),
  error           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Snapshot of who approved, kept even if that admin account is later removed.
  approved_by_email text,
  approved_at     timestamptz,
  sent_at         timestamptz,
  gmail_sent_message_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'sent' OR (approved_by_email IS NOT NULL AND approved_at IS NOT NULL AND sent_at IS NOT NULL))
);
CREATE INDEX drafts_opp_idx ON drafts (opportunity_id);
CREATE TRIGGER drafts_updated_at BEFORE UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Reminders and notifications (de-duplicated by key)
-- ---------------------------------------------------------------------------

CREATE TABLE reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('reply_deadline', 'event', 'follow_up', 'gmail_reconnect', 'custom')),
  due_at          timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dismissed', 'cancelled')),
  dedupe_key      text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx ON reminders (due_at) WHERE status = 'pending';
CREATE TRIGGER reminders_updated_at BEFORE UPDATE ON reminders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  event_key       text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('in_app', 'push', 'telegram')),
  title           text NOT NULL,
  body            text,
  url             text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  read_at         timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_key, user_id, channel)
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  keys        jsonb NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Preferences (explicit, editable settings that steer priority)
-- ---------------------------------------------------------------------------

CREATE TABLE preferences (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO preferences (key, value) VALUES
  ('preferred_categories', '[]'::jsonb),
  ('preferred_brands', '[]'::jsonb),
  ('avoided_brands', '[]'::jsonb),
  ('preferred_locations', '[]'::jsonb),
  ('minimum_fee_inr', '{}'::jsonb),
  ('muted_senders', '[]'::jsonb),
  ('history_scan_days', '90'::jsonb);

-- ---------------------------------------------------------------------------
-- Operations: worker health
-- ---------------------------------------------------------------------------

CREATE TABLE worker_heartbeats (
  worker_id     text PRIMARY KEY,
  started_at    timestamptz NOT NULL,
  last_beat_at  timestamptz NOT NULL,
  info          jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Lock the tables away from Supabase's public API. The app connects as the
-- database owner, which is not subject to these rules; the anon and
-- authenticated API roles get no policies, so they can read nothing.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'gmail_accounts', 'emails', 'categories', 'opportunities', 'opportunity_emails',
    'extracted_fields', 'corrections', 'activities', 'drafts', 'reminders', 'notifications',
    'push_subscriptions', 'preferences', 'worker_heartbeats'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
