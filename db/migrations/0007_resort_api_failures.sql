-- One-off repair (27 Oct 2026): while the Claude account had no credit, every request was refused
-- and emails were set aside in Needs review as "couldn't be sorted". Those were about the account,
-- not the emails, so they go back to be sorted automatically. Admin decisions are left untouched.
UPDATE emails
SET processing_state = 'pending', processing_attempts = 0, processing_error = NULL, processing_not_before = NULL
WHERE processing_state = 'needs_review'
  AND processing_error LIKE 'Couldn''t be sorted automatically:%'
  AND NOT EXISTS (SELECT 1 FROM corrections c WHERE c.email_id = emails.id);
