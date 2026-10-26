-- Spotlight: background-job scheduler (run ONCE in Supabase > SQL Editor, after the first Vercel deploy)
--
-- Supabase's scheduler (pg_cron) calls the app's /api/cron/tick endpoint every minute through
-- pg_net, sending CRON_SECRET as a bearer token. The secret lives in Supabase Vault (encrypted),
-- not in the job definition.
--
-- Before running, replace the two values in CAPITALS:
--   PASTE_CRON_SECRET_HERE  -> the same CRON_SECRET you set in Vercel
--   YOUR-APP.vercel.app     -> your Vercel domain (no https://, no trailing slash)

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select vault.create_secret('PASTE_CRON_SECRET_HERE', 'spotlight_cron_secret');

select cron.schedule(
  'spotlight-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'spotlight_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Keep the scheduler's own run log small.
select cron.schedule(
  'spotlight-cron-cleanup',
  '17 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$
);

-- ---------------------------------------------------------------------------
-- Checking it works (run these separately, a couple of minutes later):
--   select jobname, schedule, active from cron.job;
--   select status_code, created from net._http_response order by created desc limit 5;   -- expect 200
--
-- Changing the secret later:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'spotlight_cron_secret'), 'NEW_SECRET');
--
-- Pausing / removing the job:
--   select cron.unschedule('spotlight-tick');
-- ---------------------------------------------------------------------------
