-- Credibility: what Gmail itself verified about each email, and a checklist per offer.

-- Gmail's own sender checks (SPF, DKIM, DMARC) from the Authentication-Results header Google adds,
-- and whether the email came through a mailing tool (List-Unsubscribe / bulk headers).
ALTER TABLE emails
  ADD COLUMN auth jsonb,
  ADD COLUMN is_bulk boolean NOT NULL DEFAULT false;

-- The credibility checklist, worked out by plain rules after every change (see src/lib/ai/credibility.ts).
ALTER TABLE opportunities
  ADD COLUMN credibility jsonb,
  ADD CONSTRAINT opportunities_credibility_shape CHECK (
    credibility IS NULL OR (credibility->>'verdict' IN ('genuine', 'careful', 'doubtful') AND jsonb_typeof(credibility->'checks') = 'array')
  );

-- Senders an admin marked: "not genuine" ones are set aside without being sorted; trusted ones say so.
-- Each entry is "domain:example.com" or, for personal addresses, "address:someone@gmail.com".
INSERT INTO preferences (key, value) VALUES ('blocked_senders', '[]'::jsonb), ('trusted_senders', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;
