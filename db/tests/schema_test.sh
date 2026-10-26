#!/usr/bin/env bash
# Checks the safety rules the database enforces on its own.
# Usage: DATABASE_URL=postgres://... bash db/tests/schema_test.sh
# Runs against a FRESH database that has had db/migrations applied.
set -u
P="psql ${DATABASE_URL:?set DATABASE_URL} -tA -q"
fails=0

check() {
  local desc="$1" sql="$2" want="$3" out r
  if out=$($P -v ON_ERROR_STOP=1 -c "$sql" 2>&1); then r=ok; else r=error; fi
  if [ "$r" = "$want" ] && ! grep -q "could not connect\|Connection refused" <<<"$out"; then
    echo "PASS  $desc"
  else
    echo "FAIL  $desc -> $out"; fails=$((fails + 1))
  fi
}

U=00000000-0000-0000-0000-000000000001
A=00000000-0000-0000-0000-0000000000a1
O=00000000-0000-0000-0000-0000000000b1

$P -v ON_ERROR_STOP=1 -c "
insert into users(id,email) values ('$U','a@x.com');
insert into gmail_accounts(id,email) values ('$A','test@gmail.com');
insert into emails(gmail_account_id,gmail_message_id,gmail_thread_id,received_at) values ('$A','m1','t1',now());
insert into opportunities(id,gmail_account_id,title,organization) values ('$O','$A','Skincare reel','Glow Labs');
insert into activities(opportunity_id,actor_type,kind) values ('$O','system','created');
insert into activities(opportunity_id,actor_type,actor_user_id,kind) values ('$O','user','$U','status_changed');" \
  || { echo "FAIL  could not load fixtures"; exit 1; }

check "same Gmail message cannot be stored twice" "insert into emails(gmail_account_id,gmail_message_id,gmail_thread_id,received_at) values ('$A','m1','t1',now())" error
check "email addresses must be lowercase" "insert into users(email) values ('B@X.com')" error
check "activity log cannot be edited" "update activities set kind='x'" error
check "activity log cannot be deleted" "delete from activities" error
check "draft cannot be sent without approval" "insert into drafts(opportunity_id,mode,status,sent_at) values ('$O','decline','sent',now())" error
check "draft sent with approval is accepted" "insert into drafts(opportunity_id,mode,status,sent_at,approved_by,approved_by_email,approved_at) values ('$O','decline','sent',now(),'$U','a@x.com',now())" ok
check "budget max below min is rejected" "update opportunities set amount_min=50000, amount_max=10000" error
check "unknown status is rejected" "update opportunities set status='maybe'" error
check "verified field needs a source quote" "insert into extracted_fields(opportunity_id,field_name,value_text,is_verified) values ('$O','budget','75000',true)" error
check "duplicate notification is refused" "insert into notifications(user_id,event_key,channel,title) values ('$U','new:1','push','x'),('$U','new:1','push','x')" error
check "search finds an opportunity by brand" "select 1/(count(*))::int from opportunities where search @@ plainto_tsquery('simple','glow')" ok
check "removing an admin keeps their history" "delete from users where id='$U'" ok
check "history is re-labelled as system after admin removal" "select 1/(count(*))::int from activities where kind='status_changed' and actor_type='system' and detail ? 'former_actor_user_id'" ok
check "deleting an opportunity removes its history" "delete from opportunities" ok
check "no orphaned history is left" "select 1/(1-count(*))::int from activities" ok

# Gmail sync (0002)
check "only one inbox can be connected at a time" "insert into gmail_accounts(email) values ('second@gmail.com')" error
check "a message is queued only once" "insert into gmail_fetch_queue(gmail_account_id,gmail_message_id,is_historical,source) values ('$A','q1',true,'initial_scan'),('$A','q1',false,'history')" error
check "queue accepts a message" "insert into gmail_fetch_queue(gmail_account_id,gmail_message_id,is_historical,source) values ('$A','q1',true,'initial_scan')" ok
check "disconnecting deletes everything from that inbox" "delete from gmail_accounts where id='$A'" ok
check "no emails remain after disconnect" "select 1/(1-count(*))::int from emails" ok
check "no queued messages remain after disconnect" "select 1/(1-count(*))::int from gmail_fetch_queue" ok
check "a new inbox can connect after disconnect" "insert into gmail_accounts(email) values ('client@gmail.com')" ok

# AI sorting (0003)
NEWACC=$($P -c "select id from gmail_accounts where email='client@gmail.com'")
check "an opportunity can't be its own duplicate" "insert into opportunities(id,gmail_account_id,title) values ('00000000-0000-0000-0000-0000000000d1','$NEWACC','x'); update opportunities set possible_duplicate_of=id where id='00000000-0000-0000-0000-0000000000d1'" error
check "AI usage records only known steps" "insert into ai_usage(step,model,ok) values ('summarise','m',true)" error
check "AI usage can't have negative token counts" "insert into ai_usage(step,model,input_tokens,ok) values ('triage','m',-1,true)" error
check "AI usage records a valid call" "insert into ai_usage(step,model,input_tokens,output_tokens,ok) values ('triage','claude-haiku-5-5',120,8,true)" ok

# Dashboard (0004)
check "a correction must belong to something" "insert into corrections(field_name, new_value) values ('title', '\"x\"')" error
check "a correction on an email is accepted" "insert into gmail_accounts(id,email,status) values ('00000000-0000-0000-0000-0000000000a9','third@gmail.com','disconnected'); insert into emails(id,gmail_account_id,gmail_message_id,gmail_thread_id,received_at) values ('00000000-0000-0000-0000-0000000000e9','00000000-0000-0000-0000-0000000000a9','c1','c1',now()); insert into corrections(email_id, field_name, new_value) values ('00000000-0000-0000-0000-0000000000e9','classification','\"unrelated\"')" ok
check "deleting an inbox deletes its corrections too" "delete from gmail_accounts where id='00000000-0000-0000-0000-0000000000a9'" ok
check "no correction is left behind" "select 1/(1-count(*))::int from corrections" ok
check "opportunities start not review-cleared" "insert into opportunities(gmail_account_id,title) values ('$NEWACC','y'); select 1/(count(*) filter (where not review_cleared))::int from opportunities" ok

# Alerts (0005)
U2=00000000-0000-0000-0000-000000000002
U3=00000000-0000-0000-0000-000000000003
$P -c "insert into users(id,email) values ('$U2','m@x.com'),('$U3','s@x.com')" > /dev/null
check "alert choices only take known values" "update users set alert_types = '{\"new_offers\": \"loud\"}' where id='$U2'" error
check "alert choices accept 'all'" "update users set alert_types = alert_types || '{\"new_offers\": \"all\"}' where id='$U2'" ok
check "a Telegram chat belongs to one admin" "update users set telegram_chat_id='555' where id='$U2'; update users set telegram_chat_id='555' where id='$U3'" error
check "a link code must expire" "update users set telegram_link_hash='abc', telegram_link_expires_at=null where id='$U3'" error
check "notification retries are bounded" "insert into notifications(user_id,event_key,channel,title,attempts) values ('$U2','r:1','telegram','x',11)" error
check "a sent notification records when" "insert into notifications(user_id,event_key,channel,title,status) values ('$U2','r:2','telegram','x','sent')" error
check "a pending Telegram notification with buttons is accepted" "insert into notifications(user_id,event_key,channel,kind,title,actions) values ('$U2','flag:1','telegram','flag','x','[{\"label\":\"Pass\",\"data\":\"a:1:p\"}]')" ok
check "her answer needs the offer to have been put to her" "insert into opportunities(gmail_account_id,title,talent_response,talent_responded_at) values ('$NEWACC','z','pass',now())" error
check "her answer on a flagged offer is accepted" "insert into opportunities(id,gmail_account_id,title,flagged_for_talent_at,talent_response,talent_responded_at) values ('00000000-0000-0000-0000-0000000000f1','$NEWACC','z',now(),'pass',now())" ok
check "a reminder someone set records who" "insert into reminders(opportunity_id,kind,due_at,dedupe_key) values ('00000000-0000-0000-0000-0000000000f1','custom',now(),'custom:a')" error
check "reminder notes stay short" "insert into reminders(opportunity_id,kind,due_at,dedupe_key,created_by,note) values ('00000000-0000-0000-0000-0000000000f1','custom',now(),'custom:b','$U2',repeat('x',301))" error
check "a reminder for one admin is accepted" "insert into reminders(opportunity_id,kind,due_at,dedupe_key,created_by,for_user,note) values ('00000000-0000-0000-0000-0000000000f1','custom',now(),'custom:c','$U2','$U2','Call Priya')" ok
check "removing an admin removes their reminders" "delete from users where id='$U2'; select 1/(1-count(*))::int from reminders" ok
check "a Telegram update is handled once" "insert into telegram_updates(update_id) values (77),(77)" error
check "the actress choice starts empty" "select 1/(count(*))::int from preferences where key='talent_email' and value='null'::jsonb" ok

echo
[ "$fails" -eq 0 ] && echo "All schema checks passed." || { echo "$fails schema check(s) failed."; exit 1; }
