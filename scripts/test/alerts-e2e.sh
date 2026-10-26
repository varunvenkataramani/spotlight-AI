#!/usr/bin/env bash
# End-to-end alerts test, against a fake Telegram and a fake phone push service that decrypts
# every message like a phone would: settings, linking Telegram, phone subscriptions, alerts from
# the scheduled run (new offers, deadlines, changed terms, reminders), quiet hours, "flag for her"
# with answers from Telegram buttons and from Spotlight, retries, blocked bots, and the guards.
# Expects: npm run build done, a migrated DATABASE_URL, the env vars from .env.example, and jq.
set -uo pipefail
BASE="http://localhost:3000"
TG="http://localhost:4040"
PUSH="http://localhost:4041"
TOKEN="123456789:AAH-test-token-abcdefghijklmnopqrstuv"
fails=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"; fails=$((fails + 1))
  [ -n "${GITHUB_ACTIONS:-}" ] && [ "$fails" -le 8 ] && echo "::error title=Alerts e2e::$(printf '%s' "$1" | head -c 300 | tr '\n' ' ')"
  return 0
}
sql() { psql "$DATABASE_URL" -tA -c "$1"; }
tick() { curl -s --max-time 75 -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/tick" > /dev/null; }
tg() { curl -s "$TG/_control/calls"; }
tgcount() { tg | jq "[.[] | select($1)] | length"; }
sent_to() { tgcount ".method == \"sendMessage\" and (.body.chat_id|tostring) == \"$1\" and (.body.text|contains(\"$2\"))"; }

for _ in $(seq 1 20); do curl -s -o /dev/null "$BASE/login" || break; sleep 1; done
if curl -s -o /dev/null "$BASE/login"; then echo "FAIL  port 3000 is still in use by another server"; exit 1; fi

node scripts/test/fake-telegram.mjs > /tmp/fake-telegram.log 2>&1 &
TG_PID=$!
node scripts/test/fake-push.mjs > /tmp/fake-push.log 2>&1 &
PUSH_PID=$!
TELEGRAM_BOT_TOKEN="$TOKEN" TELEGRAM_API_BASE="$TG" PUSH_TEST_ORIGINS="$PUSH" ./node_modules/.bin/next start > /tmp/web-alerts.log 2>&1 &
WEB_PID=$!
trap 'kill $TG_PID $PUSH_PID $WEB_PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/login" && curl -s -o /dev/null "$TG/_control/calls" && curl -s -o /dev/null "$PUSH/_control/received" && break; sleep 1; done

# --- A clean slate: two admins, an inbox that isn't syncing, no alerts ------------------------------------
ACC=55555555-5555-5555-5555-555555555555
sql "DELETE FROM gmail_accounts; DELETE FROM notifications; DELETE FROM push_subscriptions; DELETE FROM telegram_updates; DELETE FROM reminders;
     UPDATE preferences SET value = 'null' WHERE key IN ('talent_email', 'telegram_bot_username');
     INSERT INTO gmail_accounts (id, email, status) VALUES ('$ACC', 'actress@gmail.com', 'disconnected');
     INSERT INTO users (email, name) VALUES ('manager@example.com', 'Varun'), ('actress@example.com', 'Ananya')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name;
     UPDATE users SET telegram_chat_id = NULL, telegram_link_hash = NULL, telegram_link_expires_at = NULL,
       alert_types = DEFAULT, alert_channels = DEFAULT, quiet_hours_start = '00:00', quiet_hours_end = '00:00'" > /dev/null
M_ID=$(sql "SELECT id FROM users WHERE email = 'manager@example.com'")
A_ID=$(sql "SELECT id FROM users WHERE email = 'actress@example.com'")
M_SESSION="__Host-spotlight_session=$(node scripts/test/make-session.ts "$M_ID" manager@example.com)"
A_SESSION="__Host-spotlight_session=$(node scripts/test/make-session.ts "$A_ID" actress@example.com)"
page() { curl -s --max-time 30 -H "Cookie: $1" "$BASE$2"; }
# post <session> <path> field=value ...  → prints "<status> <redirect>"
post() {
  local session="$1" path="$2"; shift 2
  local args=()
  for kv in "$@"; do args+=(--data-urlencode "$kv"); done
  curl -s --max-time 30 -o /dev/null -w "%{http_code} %{redirect_url}" -X POST -H "Cookie: $session" -H "Origin: $BASE" "${args[@]}" "$BASE$path"
}
pushapi() { curl -s --max-time 30 -w " %{http_code}" -X POST -H "Cookie: $1" -H "Origin: $BASE" -H "Content-Type: application/json" --data "$2" "$BASE/api/push"; }
UPD=6000
hook() { UPD=$((UPD + 1)); curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "X-Telegram-Bot-Api-Secret-Token: $SECRET" --data "$(printf "$1" "$UPD")" "$BASE/api/telegram/webhook"; }
mkopp() { # id title priority [reply_by sql]
  sql "INSERT INTO opportunities (id, gmail_account_id, title, organization, priority, status, compensation_type, compensation_status, amount_min, amount_max, currency, reply_by_at, first_received_at)
       VALUES ('$1', '$ACC', '$2', 'Glow Labs', '$3', 'new', 'paid', 'confirmed', 75000, 75000, 'INR', ${4:-NULL}, now())" > /dev/null
}

# --- Settings and choosing who the actress is ----------------------------------------------------------------
html=$(page "$M_SESSION" /settings)
grep -q "Connect Telegram" <<<"$html" && grep -q "Which admin is the actress?" <<<"$html" && grep -q "Phone and browser notifications" <<<"$html" \
  && pass "Settings shows the alert controls" || fail "settings page missing alert controls"
O1=aaaaaaaa-0000-0000-0000-000000000001
mkopp "$O1" "Serum reel" high "now() + interval '20 hours'"
r=$(post "$M_SESSION" "/api/opportunities/$O1" action=flag)
[[ "$r" == *"error=Choose+who+the+actress+is"* ]] && pass "flagging asks who the actress is first" || fail "flag without talent: $r"
r=$(post "$M_SESSION" /api/settings action=talent email=stranger@example.com)
[[ "$r" == *"error=Choose+one+of+the+two+admins"* ]] && pass "only an admin can be chosen as the actress" || fail "bad talent: $r"
r=$(post "$M_SESSION" /api/settings action=talent email=actress@example.com)
[[ "$r" == 303*"done=Saved"* ]] && [ "$(sql "SELECT value #>> '{}' FROM preferences WHERE key = 'talent_email'")" = "actress@example.com" ] \
  && pass "the actress is chosen in Settings" || fail "set talent: $r"

# --- Linking Telegram ----------------------------------------------------------------------------------------------
r=$(post "$A_SESSION" /api/settings action=telegram_connect)
CODE=$(sed -n 's|.*https://t.me/SpotlightTestBot?start=\([A-Za-z0-9_-]*\).*|\1|p' <<<"$r")
[ -n "$CODE" ] && pass "Connect Telegram opens the bot with a one-time code" || fail "telegram connect: $r"
SECRET=$(tg | jq -r '[.[] | select(.method == "setWebhook")][0].body.secret_token')
HOOK_URL=$(tg | jq -r '[.[] | select(.method == "setWebhook")][0].body.url')
[ "$HOOK_URL" = "$BASE/api/telegram/webhook" ] && [ -n "$SECRET" ] && [ "$SECRET" != "null" ] && pass "Telegram is told where to send taps, with a secret" || fail "setWebhook: $HOOK_URL"
[ "$(sql "SELECT count(*) FROM users WHERE telegram_link_hash = '$CODE'")" = "0" ] && pass "only the code's hash is stored" || fail "link code stored in clear"

code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" --data '{"update_id":1}' "$BASE/api/telegram/webhook")
[ "$code" = "401" ] && pass "webhook calls without Telegram's secret are refused" || fail "no secret: $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "X-Telegram-Bot-Api-Secret-Token: wrong" --data '{"update_id":1}' "$BASE/api/telegram/webhook")
[ "$code" = "401" ] && pass "and with a wrong secret" || fail "wrong secret: $code"

START='{"update_id":%s,"message":{"message_id":1,"chat":{"id":9001,"type":"private"},"text":"/start '"$CODE"'"}}'
[ "$(hook "$START")" = "200" ] && [ "$(sql "SELECT telegram_chat_id FROM users WHERE id = '$A_ID'")" = "9001" ] \
  && pass "pressing Start links her chat" || fail "link: $(sql "SELECT telegram_chat_id FROM users WHERE id = '$A_ID'")"
[ "$(sent_to 9001 "Connected. Spotlight alerts for actress@example.com")" = "1" ] && pass "the bot confirms in the chat" || fail "no confirmation message"
before=$(tgcount '.method == "sendMessage"')
UPD=$((UPD - 1)); hook "$START" > /dev/null
[ "$(tgcount '.method == "sendMessage"')" = "$before" ] && pass "a repeated update from Telegram is handled once" || fail "replayed update handled twice"
hook "$START" > /dev/null
[ "$(sent_to 9001 "That link has expired or was already used")" = "1" ] && pass "a link code works only once" || fail "code reused"

r=$(post "$M_SESSION" /api/settings action=telegram_connect)
MCODE=$(sed -n 's|.*start=\([A-Za-z0-9_-]*\).*|\1|p' <<<"$r")
hook '{"update_id":%s,"message":{"message_id":1,"chat":{"id":9002,"type":"private"},"text":"/start '"$MCODE"'"}}' > /dev/null
[ "$(sql "SELECT telegram_chat_id FROM users WHERE id = '$M_ID'")" = "9002" ] && pass "the manager links his own chat" || fail "manager link"
hook '{"update_id":%s,"message":{"message_id":1,"chat":{"id":-100,"type":"group"},"text":"/start '"$MCODE"'"}}' > /dev/null
[ "$(tgcount '.method == "sendMessage" and (.body.chat_id|tostring) == "-100"')" = "0" ] && pass "group chats are ignored" || fail "bot answered in a group"

# --- Phone notifications ------------------------------------------------------------------------------------------
SUB=$(curl -s "$PUSH/_control/new?id=m1")
r=$(pushapi "$M_SESSION" "{\"action\":\"subscribe\",\"subscription\":$SUB}")
[[ "$r" == *" 200" ]] && [ "$(sql "SELECT count(*) FROM push_subscriptions WHERE user_id = '$M_ID' AND server_key IS NOT NULL")" = "1" ] \
  && pass "a phone subscribes to notifications" || fail "subscribe: $r"
r=$(pushapi "$M_SESSION" '{"action":"subscribe","subscription":{"endpoint":"https://evil.example/x","keys":{"p256dh":"x","auth":"y"}}}')
[[ "$r" == *"isn't supported"*" 400" ]] && pass "only real push services are accepted" || fail "evil endpoint: $r"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Cookie: $M_SESSION" -H "Origin: $BASE" --data "action=subscribe" "$BASE/api/push")
[ "$code" = "415" ] && pass "the push route only takes JSON" || fail "form post to push: $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Cookie: $M_SESSION" -H "Origin: https://evil.example" -H "Content-Type: application/json" --data '{}' "$BASE/api/push")
[ "$code" = "403" ] && pass "the push route refuses other sites" || fail "cross-site push: $code"

# --- New offer and a reply due: alerts on every channel, once -----------------------------------------------------
tick
for u in "$M_ID" "$A_ID"; do
  [ "$(sql "SELECT count(*) FROM notifications WHERE user_id = '$u' AND channel = 'in_app' AND event_key IN ('new_offer:$O1') ")" = "1" ] || fail "in-app new offer missing for $u"
  [ "$(sql "SELECT count(*) FROM notifications WHERE user_id = '$u' AND channel = 'in_app' AND event_key LIKE 'reply_due:$O1:%'")" = "1" ] || fail "in-app reply due missing for $u"
done
pass "both admins see the new offer and the reply due in Spotlight"
[ "$(sent_to 9001 "New high-priority offer")" = "1" ] && [ "$(sent_to 9002 "New high-priority offer")" = "1" ] && pass "both get it in Telegram" || fail "telegram new offer: $(tg | jq -c '[.[] | select(.method=="sendMessage") | .body.text]')"
tg | jq -e '[.[] | select(.method == "sendMessage" and (.body.text|contains("New high-priority offer")))][0].body.text | contains("Serum reel · Glow Labs\nPay: ₹75,000")' > /dev/null \
  && pass "the Telegram message says what, who and the pay" || fail "telegram text"
[ "$(sent_to 9001 "Reply due within a day")" = "1" ] && pass "and the reply due within a day" || fail "telegram reply due"
got=$(curl -s "$PUSH/_control/received" | jq -c '[.[] | select(.id == "m1")]')
jq -e 'any(.[]; .ok and .payload.title == "New high-priority offer" and .payload.url == "/opportunities/'"$O1"'")' <<<"$got" > /dev/null \
  && pass "the phone receives it, encrypted and signed correctly" || fail "push: $got"
jq -e 'all(.[]; .ok)' <<<"$got" > /dev/null && pass "every push was signed and decryptable" || fail "push problem: $got"
[ "$(sql "SELECT count(*) FROM notifications WHERE channel <> 'in_app' AND status <> 'sent'")" = "0" ] && pass "every delivery is marked sent" || fail "unsent: $(sql "SELECT channel, status, error FROM notifications WHERE channel <> 'in_app' AND status <> 'sent'")"
n_before=$(sql "SELECT count(*) FROM notifications"); m_before=$(tgcount '.method == "sendMessage"')
tick
[ "$(sql "SELECT count(*) FROM notifications")" = "$n_before" ] && [ "$(tgcount '.method == "sendMessage"')" = "$m_before" ] && pass "the next run doesn't repeat anything" || fail "repeated alerts"

# --- Quiet hours ----------------------------------------------------------------------------------------------------
sql "UPDATE users SET quiet_hours_start = ((now() AT TIME ZONE 'Asia/Kolkata') - interval '1 hour')::time,
                      quiet_hours_end = ((now() AT TIME ZONE 'Asia/Kolkata') + interval '1 hour')::time WHERE id = '$M_ID'" > /dev/null
O2=aaaaaaaa-0000-0000-0000-000000000002
mkopp "$O2" "Diwali campaign" high
tick
[ "$(sql "SELECT status FROM notifications WHERE user_id = '$M_ID' AND channel = 'push' AND event_key = 'new_offer:$O2' AND deliver_after > now() + interval '30 minutes'")" = "pending" ] \
  && pass "in quiet hours, phone notifications wait until they end" || fail "quiet push: $(sql "SELECT status, deliver_after FROM notifications WHERE user_id = '$M_ID' AND channel = 'push' AND event_key = 'new_offer:$O2'")"
tg | jq -e '[.[] | select(.method == "sendMessage" and .body.chat_id == "9002" and (.body.text|contains("Diwali")))][0].body.disable_notification == true' > /dev/null \
  && tg | jq -e '[.[] | select(.method == "sendMessage" and .body.chat_id == "9001" and (.body.text|contains("Diwali")))][0].body.disable_notification == false' > /dev/null \
  && pass "Telegram still arrives in quiet hours, silently, only for whoever is in them" || fail "telegram quiet hours"
sql "UPDATE users SET quiet_hours_start = '00:00', quiet_hours_end = '00:00' WHERE id = '$M_ID'" > /dev/null

# --- Flag for her, answered with a Telegram button --------------------------------------------------------------------
r=$(post "$M_SESSION" "/api/opportunities/$O1" action=flag "note=Good brand, fair fee")
[[ "$r" == 303*"done=Sent+to+her"* ]] && [ -n "$(sql "SELECT flagged_for_talent_at FROM opportunities WHERE id = '$O1'")" ] && pass "flag for her" || fail "flag: $r"
tick
ASK=$(tg | jq -c '[.[] | select(.method == "sendMessage" and (.body.text|contains("Your call")))]')
[ "$(jq 'length' <<<"$ASK")" = "1" ] && [ "$(jq -r '.[0].body.chat_id' <<<"$ASK")" = "9001" ] && pass "only she is asked" || fail "flag messages: $ASK"
[ "$(jq -c '[.[0].body.reply_markup.inline_keyboard[0][] | .callback_data]' <<<"$ASK")" = "[\"a:$O1:i\",\"a:$O1:p\",\"a:$O1:q\"]" ] \
  && pass "with Interested, Pass and Questions buttons" || fail "buttons: $(jq -c '.[0].body.reply_markup' <<<"$ASK")"
jq -e '.[0].body.text | contains("Varun: “Good brand, fair fee”")' <<<"$ASK" > /dev/null && pass "and the manager's note" || fail "flag note missing"
[ "$(sql "SELECT count(*) FROM notifications WHERE event_key LIKE 'flag:$O1:%' AND user_id = '$M_ID'")" = "0" ] && pass "the manager doesn't get his own question" || fail "flag sent to manager"

TAP='{"update_id":%s,"callback_query":{"id":"cb-'$UPD'","data":"a:'"$O1"':i","message":{"message_id":7,"chat":{"id":9001,"type":"private"}}}}'
hook "$TAP" > /dev/null
[ "$(sql "SELECT talent_response || ' ' || status FROM opportunities WHERE id = '$O1'")" = "interested interested" ] && pass "her tap saves Interested and moves the card to Interested" || fail "tap: $(sql "SELECT talent_response, status FROM opportunities WHERE id = '$O1'")"
[ "$(sql "SELECT count(*) FROM activities WHERE opportunity_id = '$O1' AND kind = 'her_answer' AND actor_user_id = '$A_ID' AND detail->>'via' = 'telegram'")" = "1" ] && pass "logged as her answer, from Telegram" || fail "answer activity"
[ "$(tgcount '.method == "answerCallbackQuery" and .body.text == "Saved: Interested"')" = "1" ] && [ "$(tgcount '.method == "editMessageReplyMarkup" and (.body.reply_markup.inline_keyboard[0][0].text|contains("Interested"))')" = "1" ] \
  && pass "Telegram confirms and the buttons change to her answer" || fail "tap confirmation"
[ "$(sql "SELECT count(*) FROM opportunities WHERE id = '$O1' AND status IN ('accepted', 'confirmed')")" = "0" ] && pass "nothing is accepted for her" || fail "auto-accepted"
tick
[ "$(sent_to 9002 "She said: Interested")" = "1" ] && [ "$(sent_to 9001 "She said")" = "0" ] && pass "her answer reaches the manager" || fail "answer alert"

hook '{"update_id":%s,"callback_query":{"id":"cb-x","data":"a:'"$O1"':p","message":{"message_id":7,"chat":{"id":7777,"type":"private"}}}}' > /dev/null
[ "$(tgcount '.method == "answerCallbackQuery" and .body.callback_query_id == "cb-x" and (.body.text|contains("isn'"'"'t connected"))')" = "1" ] \
  && [ "$(sql "SELECT talent_response FROM opportunities WHERE id = '$O1'")" = "interested" ] && pass "taps from an unlinked chat do nothing" || fail "unlinked tap"
hook '{"update_id":%s,"callback_query":{"id":"cb-y","data":"a:nope:i","message":{"message_id":7,"chat":{"id":9001,"type":"private"}}}}' > /dev/null
[ "$(tgcount '.method == "answerCallbackQuery" and .body.callback_query_id == "cb-y" and .body.text == "That button no longer works."')" = "1" ] && pass "forged button data is refused" || fail "bad data"

# --- Questions, asked in Telegram ------------------------------------------------------------------------------------
post "$M_SESSION" "/api/opportunities/$O1" action=flag > /dev/null
[ -z "$(sql "SELECT talent_response FROM opportunities WHERE id = '$O1'")" ] && pass "asking again clears her earlier answer" || fail "re-flag"
hook '{"update_id":%s,"callback_query":{"id":"cb-q","data":"a:'"$O1"':q","message":{"message_id":8,"chat":{"id":9001,"type":"private"}}}}' > /dev/null
tg | jq -e '[.[] | select(.method == "sendMessage" and .body.chat_id == 9001 and (.body.text|contains("What would you like to ask")))][0].body.reply_markup.force_reply == true' > /dev/null \
  && pass "Questions asks her to type the question" || fail "question prompt"
hook '{"update_id":%s,"message":{"message_id":9,"chat":{"id":9001,"type":"private"},"text":"Is travel covered?"}}' > /dev/null
[ "$(sql "SELECT talent_response || ': ' || talent_response_note FROM opportunities WHERE id = '$O1'")" = "questions: Is travel covered?" ] && pass "her question is saved on the offer" || fail "question: $(sql "SELECT talent_response, talent_response_note FROM opportunities WHERE id = '$O1'")"
tick
[ "$(sent_to 9002 "Is travel covered?")" = "1" ] && pass "and sent to the manager" || fail "question alert"
hook '{"update_id":%s,"message":{"message_id":10,"chat":{"id":9001,"type":"private"},"text":"hello"}}' > /dev/null
[ "$(sql "SELECT talent_response_note FROM opportunities WHERE id = '$O1'")" = "Is travel covered?" ] && [ "$(sent_to 9001 "use the buttons under it")" -ge 1 ] \
  && pass "later messages don't overwrite it" || fail "stray message changed the answer"

# --- Answering in Spotlight ------------------------------------------------------------------------------------------
O3=aaaaaaaa-0000-0000-0000-000000000003
mkopp "$O3" "Wedding appearance" medium
post "$M_SESSION" "/api/opportunities/$O3" action=flag > /dev/null
html=$(page "$A_SESSION" /)
grep -q "Your call" <<<"$html" && grep -q "Wedding appearance" <<<"$html" && grep -q "Waiting for your answer" <<<"$html" && pass "her overview shows what's waiting for her" || fail "overview for her"
grep -q "Her call" <<<"$(page "$M_SESSION" /)" && pass "the manager's overview shows her calls" || fail "overview for manager"
r=$(post "$A_SESSION" "/api/opportunities/$O3" action=answer answer=pass back=/)
[[ "$r" == 303*"done=Saved"* ]] && [ "$(sql "SELECT talent_response || ' ' || status FROM opportunities WHERE id = '$O3'")" = "pass new" ] \
  && pass "she answers Pass in Spotlight; the status is left for the team" || fail "web answer: $r"
r=$(post "$M_SESSION" "/api/opportunities/$O2" action=answer answer=interested)
[[ "$r" == *"error=This+offer+isn"* ]] && pass "an offer that wasn't put to her can't be answered" || fail "answer unflagged: $r"
r=$(post "$A_SESSION" "/api/opportunities/$O3" action=answer answer=maybe)
[[ "$r" == *"error=Choose+Interested"* ]] && pass "unknown answers are refused" || fail "bad answer: $r"
html=$(page "$M_SESSION" "/opportunities/$O3")
grep -q "She said: Pass" <<<"$html" && grep -q "Reminders" <<<"$html" && pass "the detail page shows her answer and reminders" || fail "detail page"
r=$(post "$M_SESSION" "/api/opportunities/$O3" action=unflag)
[[ "$r" == 303* ]] && [ -z "$(sql "SELECT flagged_for_talent_at FROM opportunities WHERE id = '$O3'")" ] && pass "the question to her can be withdrawn" || fail "unflag: $r"

# --- Reminders -------------------------------------------------------------------------------------------------------
TOMORROW=$(TZ=Asia/Kolkata date -d tomorrow +%F)
YESTERDAY=$(TZ=Asia/Kolkata date -d yesterday +%F)
r=$(post "$M_SESSION" "/api/opportunities/$O2" action=remind day="$YESTERDAY" time=10:00)
[[ "$r" == *"error=Pick+a+time+later+than+now"* ]] && pass "reminders must be in the future" || fail "past reminder: $r"
r=$(post "$M_SESSION" "/api/opportunities/$O2" action=remind day="$TOMORROW" time=10:00 "note=Call Priya" who=me)
[[ "$r" == 303*"done=Reminder+set+for"* ]] && pass "a reminder is set" || fail "reminder: $r"
[ "$(sql "SELECT to_char(due_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') FROM reminders WHERE opportunity_id = '$O2' AND note = 'Call Priya'")" = "10:00" ] && pass "at 10:00 India time" || fail "reminder time"
sql "UPDATE reminders SET due_at = now() - interval '1 minute' WHERE note = 'Call Priya'" > /dev/null
tick
[ "$(sent_to 9002 "Reminder: Call Priya")" = "1" ] && [ "$(sent_to 9001 "Reminder: Call Priya")" = "0" ] && pass "it goes off for whoever set it, once" || fail "reminder delivery"
[ "$(sql "SELECT status FROM reminders WHERE note = 'Call Priya'")" = "sent" ] && pass "and is marked as gone off" || fail "reminder status"
post "$M_SESSION" "/api/opportunities/$O2" action=remind day="$TOMORROW" time=18:30 "note=Check contract" who=both > /dev/null
RID=$(sql "SELECT id FROM reminders WHERE note = 'Check contract'")
r=$(post "$M_SESSION" "/api/opportunities/$O2" action=cancel_reminder reminder="$RID")
[[ "$r" == 303*"done=Reminder+cancelled"* ]] && [ "$(sql "SELECT status FROM reminders WHERE id = '$RID'")" = "cancelled" ] && pass "a reminder can be cancelled" || fail "cancel: $r"
r=$(post "$M_SESSION" "/api/opportunities/$O2" action=cancel_reminder reminder="$RID")
[[ "$r" == *"error="* ]] && pass "but only once" || fail "double cancel: $r"

# --- Their email changes the terms ----------------------------------------------------------------------------------
E1=$(sql "INSERT INTO emails (gmail_account_id, gmail_message_id, gmail_thread_id, from_email, subject, received_at, is_historical) VALUES ('$ACC', 'chg-1', 't-1', 'priya@glowlabs.in', 'Update', now(), false) RETURNING id" | head -1)
EH=$(sql "INSERT INTO emails (gmail_account_id, gmail_message_id, gmail_thread_id, from_email, subject, received_at, is_historical) VALUES ('$ACC', 'old-1', 't-1', 'priya@glowlabs.in', 'Old', now() - interval '30 days', true) RETURNING id" | head -1)
sql "INSERT INTO activities (opportunity_id, actor_type, kind, detail) VALUES
       ('$O1', 'system', 'email_received', '{\"emailId\": \"$E1\"}'),
       ('$O1', 'ai', 'change_detected', '{\"emailId\": \"$E1\", \"field\": \"compensation\", \"from\": \"₹75,000\", \"to\": \"₹90,000\"}'),
       ('$O2', 'system', 'email_received', '{\"emailId\": \"$EH\"}')" > /dev/null
tick
[ "$(sent_to 9002 "They changed the terms")" = "1" ] && tg | jq -e '[.[] | select(.method == "sendMessage" and (.body.text|contains("They changed the terms")))][0].body.text | contains("Pay: ₹75,000 → ₹90,000")' > /dev/null \
  && pass "a changed fee is announced once, saying what changed" || fail "change alert: $(tg | jq -c '[.[] | select(.method=="sendMessage") | .body.text] | .[-3:]')"
[ "$(sql "SELECT count(*) FROM notifications WHERE event_key = 'email:$EH:$O2'")" = "0" ] && pass "old mail from the first scan isn't announced" || fail "historical email alerted"

# --- Retries and a blocked bot ------------------------------------------------------------------------------------------
curl -s -X POST "$TG/_control/fail?count=1" > /dev/null
O4=aaaaaaaa-0000-0000-0000-000000000004
mkopp "$O4" "Retry offer" high
tick
[ "$(sql "SELECT count(*) FROM notifications WHERE event_key = 'new_offer:$O4' AND channel = 'telegram' AND status = 'pending' AND attempts = 1 AND error LIKE 'Telegram:%'")" = "1" ] \
  && pass "a failed Telegram send waits to be retried" || fail "retry state: $(sql "SELECT status, attempts, error FROM notifications WHERE event_key = 'new_offer:$O4' AND channel = 'telegram'")"
sql "UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE event_key = 'new_offer:$O4'" > /dev/null
tick
[ "$(sql "SELECT count(*) FROM notifications WHERE event_key = 'new_offer:$O4' AND channel = 'telegram' AND status = 'sent'")" = "2" ] && pass "and is sent on the retry" || fail "retry didn't send"
sql "UPDATE users SET telegram_chat_id = '403403' WHERE id = '$A_ID'" > /dev/null
O5=aaaaaaaa-0000-0000-0000-000000000005
mkopp "$O5" "Blocked offer" high
tick
[ "$(sql "SELECT status FROM notifications WHERE event_key = 'new_offer:$O5' AND user_id = '$A_ID' AND channel = 'telegram'")" = "failed" ] \
  && [ -z "$(sql "SELECT telegram_chat_id FROM users WHERE id = '$A_ID'")" ] && pass "a blocked bot fails clearly and unlinks the chat" || fail "blocked bot"
sql "UPDATE users SET telegram_chat_id = '9001' WHERE id = '$A_ID'" > /dev/null

SUB2=$(curl -s "$PUSH/_control/new?id=gone-1" | jq -c '.endpoint = "http://localhost:4041/push/gone-1"')
pushapi "$M_SESSION" "{\"action\":\"subscribe\",\"subscription\":$SUB2}" > /dev/null
O6=aaaaaaaa-0000-0000-0000-000000000006
mkopp "$O6" "Push offer" high
tick
[ "$(sql "SELECT count(*) FROM push_subscriptions WHERE endpoint LIKE '%gone-1'")" = "0" ] && [ "$(sql "SELECT status FROM notifications WHERE event_key = 'new_offer:$O6' AND user_id = '$M_ID' AND channel = 'push'")" = "sent" ] \
  && pass "an expired phone subscription is removed; the others still get it" || fail "gone subscription"

# --- Test alert, Alerts page, unread badge ----------------------------------------------------------------------------------
r=$(post "$M_SESSION" /api/settings action=test)
[[ "$r" == 303*"done=Test+sent+to"*"Spotlight"* ]] && [[ "$r" == *"Telegram"* ]] && [[ "$r" == *"phone"* ]] && pass "a test alert reaches every channel at once" || fail "test alert: $r"
[ "$(sent_to 9002 "Test alert from Spotlight")" = "1" ] && pass "including Telegram" || fail "test alert telegram"
[ "$(sql "SELECT count(*) FROM notifications WHERE user_id = '$M_ID' AND kind = 'test' AND status = 'sent'")" = "3" ] && pass "and is delivered on all three" || fail "test alert statuses: $(sql "SELECT channel, status, error FROM notifications WHERE kind = 'test'")"
grep -q '<span class="sr-only"> unread</span>' <<<"$(page "$M_SESSION" /opportunities)" && pass "the sidebar shows unread alerts" || fail "no unread badge"
html=$(page "$M_SESSION" /alerts)
grep -q "New high-priority offer" <<<"$html" && grep -q "Serum reel" <<<"$html" && pass "the Alerts page lists them" || fail "alerts page"
[ "$(sql "SELECT count(*) FROM notifications WHERE user_id = '$M_ID' AND channel = 'in_app' AND read_at IS NULL")" = "0" ] && pass "opening it marks them read" || fail "not marked read"
html=$(page "$M_SESSION" /settings)
grep -q "Connected to @SpotlightTestBot" <<<"$html" && grep -q "On for 1 device" <<<"$html" && grep -q "Recent deliveries" <<<"$html" && pass "Settings shows what's connected" || fail "settings status"

# --- Choosing what to hear about ----------------------------------------------------------------------------------------------
r=$(post "$M_SESSION" /api/settings action=alerts new_offers=off deadlines=on changes=on telegram=on push=on quiet_start=23:00 quiet_end=08:00)
[[ "$r" == 303*"done=Saved.+Phones+stay+quiet+from+23%3A00+to+08%3A00"* ]] && [ "$(sql "SELECT alert_types->>'new_offers' || ' ' || (alert_types->>'nudges') FROM users WHERE id = '$M_ID'")" = "off false" ] \
  && pass "alert choices are saved" || fail "save alerts: $r / $(sql "SELECT alert_types FROM users WHERE id = '$M_ID'")"
r=$(post "$M_SESSION" /api/settings action=alerts new_offers=all quiet_start=11pm quiet_end=08:00)
[[ "$r" == *"error=Pick+a+time"* ]] && pass "bad quiet hours are refused" || fail "bad quiet hours: $r"
O7=aaaaaaaa-0000-0000-0000-000000000007
mkopp "$O7" "Muted offer" high
tick
[ "$(sql "SELECT count(*) FROM notifications WHERE event_key = 'new_offer:$O7' AND user_id = '$M_ID'")" = "0" ] && [ "$(sql "SELECT count(*) FROM notifications WHERE event_key = 'new_offer:$O7' AND user_id = '$A_ID'")" -ge 1 ] \
  && pass "turning new offers off stops them for him only" || fail "muted new offers"

# --- Disconnecting, and the guards --------------------------------------------------------------------------------------------
r=$(post "$M_SESSION" /api/settings action=telegram_disconnect)
[[ "$r" == 303*"done=Telegram+disconnected"* ]] && [ -z "$(sql "SELECT telegram_chat_id FROM users WHERE id = '$M_ID'")" ] && pass "Telegram can be disconnected in Settings" || fail "disconnect: $r"
hook '{"update_id":%s,"message":{"message_id":11,"chat":{"id":9001,"type":"private"},"text":"/stop"}}' > /dev/null
[ -z "$(sql "SELECT telegram_chat_id FROM users WHERE id = '$A_ID'")" ] && [ "$(sent_to 9001 "Disconnected")" = "1" ] && pass "or with /stop in the chat" || fail "/stop"
r=$(pushapi "$M_SESSION" "{\"action\":\"unsubscribe\",\"endpoint\":$(jq '.endpoint' <<<"$SUB")}")
[[ "$r" == *" 200" ]] && [ "$(sql "SELECT count(*) FROM push_subscriptions WHERE user_id = '$M_ID'")" = "0" ] && pass "phone notifications can be turned off" || fail "unsubscribe: $r"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Cookie: $M_SESSION" -H "Origin: https://evil.example" --data "action=talent&email=" "$BASE/api/settings")
[ "$code" = "403" ] && [ "$(sql "SELECT value #>> '{}' FROM preferences WHERE key = 'talent_email'")" = "actress@example.com" ] && pass "settings refuse other sites" || fail "cross-site settings: $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST --data "action=talent&email=" "$BASE/api/settings")
[[ "$code" == 30* ]] && [ "$(sql "SELECT value #>> '{}' FROM preferences WHERE key = 'talent_email'")" = "actress@example.com" ] && pass "and signed-out requests" || fail "signed-out settings: $code"

# --- Nothing private in the logs ------------------------------------------------------------------------------------------------
if grep -q -e "Is travel covered" -e "Good brand" -e "$TOKEN" -e "Glow Labs" -e "$SECRET" /tmp/web-alerts.log; then
  fail "the server log contains alert text or a secret"
else
  pass "the server log has no alert text, token or secret"
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "--- web log ---"; tail -40 /tmp/web-alerts.log
  echo "--- telegram calls (methods) ---"; tg | jq -c '[.[] | .method]'
  echo "$fails alert check(s) failed."; exit 1
fi
echo "All alert checks passed."
