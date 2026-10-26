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

echo
[ "$fails" -eq 0 ] && echo "All schema checks passed." || { echo "$fails schema check(s) failed."; exit 1; }
