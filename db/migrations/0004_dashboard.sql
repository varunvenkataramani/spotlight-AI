-- Dashboard (Milestone 4)

-- An admin checked a flagged offer and confirmed it's genuine: its warnings stay visible,
-- but it no longer sits in Needs review.
ALTER TABLE opportunities ADD COLUMN review_cleared boolean NOT NULL DEFAULT false;

-- Corrections can hold words from an email, so they go when their email or opportunity goes
-- (for example on "Disconnect and delete data"), instead of lingering with the links cleared.
ALTER TABLE corrections
  DROP CONSTRAINT corrections_opportunity_id_fkey,
  DROP CONSTRAINT corrections_email_id_fkey,
  ADD CONSTRAINT corrections_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
  ADD CONSTRAINT corrections_email_id_fkey FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
  ADD CONSTRAINT corrections_has_target CHECK (opportunity_id IS NOT NULL OR email_id IS NOT NULL);

-- Fast lookups for the overview's "recent changes" and the timeline.
CREATE INDEX activities_recent_kind_idx ON activities (kind, created_at DESC);
