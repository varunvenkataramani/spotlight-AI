-- AI sorting (Milestone 3)

-- Retry timing and completion for each email's AI processing.
ALTER TABLE emails
  ADD COLUMN processing_not_before timestamptz,
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN triage_category text;

CREATE INDEX emails_ai_queue_idx ON emails (is_historical, received_at)
  WHERE processing_state IN ('pending', 'failed');

-- Opportunities: where they came from, which values couldn't be checked against the email,
-- and a suggested duplicate for an admin to confirm (never merged automatically).
ALTER TABLE opportunities
  ADD COLUMN from_historical       boolean NOT NULL DEFAULT false,
  ADD COLUMN unverified_fields     text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN classification        text,
  ADD COLUMN possible_duplicate_of uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  ADD CONSTRAINT opportunities_not_own_duplicate CHECK (possible_duplicate_of IS NULL OR possible_duplicate_of <> id);

-- How much AI work was done, without any email content: for the usage figures in Settings.
CREATE TABLE ai_usage (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id       uuid REFERENCES emails(id) ON DELETE SET NULL,
  step           text NOT NULL CHECK (step IN ('triage', 'extract')),
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens  integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  ok             boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_recent_idx ON ai_usage (created_at DESC);
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
