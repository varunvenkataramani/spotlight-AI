-- Reply drafts (Milestone 5b)

-- Drafting is a third kind of AI call.
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_step_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_step_check CHECK (step IN ('triage', 'extract', 'draft'));
ALTER TABLE ai_usage ADD COLUMN opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;

-- What the admin asked for, who it goes to, and what plain code flagged before anyone sends it.
ALTER TABLE drafts
  ADD COLUMN instructions text CHECK (instructions IS NULL OR length(instructions) <= 1000),
  ADD COLUMN to_email     text CHECK (to_email IS NULL OR (to_email = lower(to_email) AND to_email ~ '^[^@\s<>,;]+@[^@\s<>,;]+$')),
  ADD COLUMN thread_id    text,
  ADD COLUMN warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN ai_notes     text,
  ADD COLUMN updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT drafts_body_length CHECK (body IS NULL OR length(body) <= 20000),
  ADD CONSTRAINT drafts_subject_length CHECK (subject IS NULL OR length(subject) <= 300),
  -- A draft saved to Gmail or sent records Gmail's id for it; a sent one says to whom.
  ADD CONSTRAINT drafts_in_gmail_has_id CHECK (status <> 'saved_to_gmail' OR gmail_draft_id IS NOT NULL),
  ADD CONSTRAINT drafts_sent_has_message CHECK (status <> 'sent' OR (gmail_sent_message_id IS NOT NULL AND to_email IS NOT NULL));
CREATE INDEX drafts_opp_recent_idx ON drafts (opportunity_id, created_at DESC);

-- How replies are signed, and facts the AI may use (portfolio link, base city, languages).
INSERT INTO preferences (key, value) VALUES ('reply_signature', '""'::jsonb), ('reply_facts', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;
