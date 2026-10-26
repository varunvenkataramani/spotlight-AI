#!/usr/bin/env bash
# End-to-end Gmail test: the real built app against a fake Google (scripts/test/fake-google.mjs).
# Covers connect, first scan, new mail, duplicates, a failing message, history expiry recovery,
# revoked access, reconnect, refusing a second inbox, and disconnect-and-delete.
# Expects: npm run build done, a migrated DATABASE_URL, the env vars from .env.example.
set -uo pipefail
BASE="http://localhost:3000"
FAKE="http://localhost:4010"
fails=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"; fails=$((fails + 1))
  # Also surface it as a GitHub annotation, readable without opening the log.
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Gmail e2e::$(printf '%s' "$1" | head -c 300 | tr '\n' ' ')"
  return 0
}
sql() { psql "$DATABASE_URL" -tA -c "$1"; }
tick() { curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/tick"; }

node scripts/test/fake-google.mjs > /tmp/fake-google.log 2>&1 &
FAKE_PID=$!
GOOGLE_API_BASE_OVERRIDE="$FAKE" npm start > /tmp/web-gmail.log 2>&1 &
WEB_PID=$!
trap 'kill $FAKE_PID $WEB_PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/login" && break; sleep 1; done

# A signed-in admin (the session cookie is made with the test SESSION_SECRET).
ADMIN_ID=11111111-1111-1111-1111-111111111111
sql "INSERT INTO users (id, email) VALUES ('$ADMIN_ID', 'manager@example.com') ON CONFLICT DO NOTHING" > /dev/null
SESSION="__Host-spotlight_session=$(node scripts/test/make-session.ts "$ADMIN_ID" manager@example.com)"

connect() { # $1 = code the fake Google hands back; prints the app's final redirect
  local headers loc state cookie
  headers=$(curl -s -D - -o /dev/null -H "Cookie: $SESSION" "$BASE/api/gmail/connect?scan_days=14")
  loc=$(grep -i '^location:' <<<"$headers" | tr -d '\r' | cut -d' ' -f2)
  state=$(sed -E 's/.*[?&]state=([^&]+).*/\1/' <<<"$loc")
  cookie=$(grep -i '^set-cookie: spotlight_gmail=' <<<"$headers" | tr -d '\r' | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/')
  curl -s -o /dev/null -w "%{redirect_url}" -H "Cookie: $SESSION; $cookie" "$BASE/api/gmail/callback?code=$1&state=$state"
}

# --- Pages render for a signed-in admin -----------------------------------------
for path in / /settings /mail /opportunities /review; do
  code=$(curl -s -o /tmp/page.html -w "%{http_code}" -H "Cookie: $SESSION" "$BASE$path")
  [ "$code" = "200" ] && pass "$path renders for a signed-in admin" || fail "$path answered $code"
done
grep -q "Connect Gmail" <(curl -s -H "Cookie: $SESSION" "$BASE/settings") && pass "settings offers Connect Gmail" || fail "no Connect Gmail button"

# --- Connect ----------------------------------------------------------------------
headers=$(curl -s -D - -o /dev/null "$BASE/api/gmail/connect")
grep -qi "^location: .*/login" <<<"$headers" && pass "connecting Gmail requires sign-in" || fail "connect without session not refused"

loc=$(connect good-code)
[[ "$loc" == *"/settings?gmail=connected"* ]] && pass "Gmail connects" || fail "connect ended at: $loc"
[ "$(sql "SELECT status FROM gmail_accounts")" = "connected" ] && pass "inbox stored as connected" || fail "inbox status wrong"
enc=$(sql "SELECT refresh_token_enc FROM gmail_accounts")
[[ "$enc" == v1.* && "$enc" != *fake-refresh-token* ]] && pass "refresh token is stored encrypted" || fail "refresh token not encrypted"
[ "$(sql "SELECT count(*) FROM activities WHERE kind='gmail_connected'")" = "1" ] && pass "connection is logged" || fail "no activity logged"

loc=$(curl -s -o /dev/null -w "%{redirect_url}" -H "Cookie: $SESSION" "$BASE/api/gmail/callback?code=good-code&state=forged")
[[ "$loc" == *"gmail=state_mismatch"* ]] && pass "callback with a forged state is refused" || fail "forged state: $loc"

# --- New mail arrives, first scan runs --------------------------------------------
curl -s -X POST "$FAKE/_control/new-mail" -d '{"id":"new-1"}' > /dev/null
curl -s -X POST "$FAKE/_control/new-mail" -d '{"id":"sent-1","labelIds":["SENT"]}' > /dev/null
for _ in 1 2 3 4 5 6; do
  tick > /tmp/tick.json
  [ "$(sql "SELECT count(*) FROM emails")" -ge 152 ] && break
done
grep -q '"gmail":' /tmp/tick.json && pass "tick reports Gmail work" || fail "tick: $(cat /tmp/tick.json)"
[ "$(sql "SELECT count(*) FROM emails WHERE is_historical")" = "151" ] && pass "first scan stored 151 earlier emails" \
  || fail "earlier emails stored: $(sql "SELECT count(*) FROM emails WHERE is_historical")"
[ "$(sql "SELECT count(*) FROM emails WHERE gmail_message_id='new-1' AND NOT is_historical")" = "1" ] && pass "new mail is stored and marked new" || fail "new mail missing"
[ "$(sql "SELECT count(*) FROM emails WHERE gmail_message_id='sent-1'")" = "0" ] && pass "sent mail is ignored" || fail "sent mail was stored"
[ "$(sql "SELECT initial_scan_completed_at IS NOT NULL FROM gmail_accounts")" = "t" ] && pass "first scan listing finished" || fail "scan not finished"

# --- Content is parsed correctly ---------------------------------------------------
[ "$(sql "SELECT from_email || '|' || from_name FROM emails WHERE gmail_message_id='new-1'")" = "priya@glowlabs.in|Priya Shah, Glow Labs" ] \
  && pass "sender name and address parsed" || fail "sender: $(sql "SELECT from_email, from_name FROM emails WHERE gmail_message_id='new-1'")"
sql "SELECT body_text FROM emails WHERE gmail_message_id='new-1'" | grep -q "Budget ₹75,000 for one reel" && pass "plain-text body stored" || fail "plain body wrong"
html=$(sql "SELECT subject || ' / ' || body_text FROM emails WHERE gmail_message_id='old-html'")
[[ "$html" == *"Launch event – 12 Nov"* && "$html" == *"Fee: ₹1,50,000"* && "$html" != *"x()"* ]] && pass "HTML email and encoded subject decoded" || fail "html: $html"
[ "$(sql "SELECT count(*) FROM emails WHERE body_text LIKE '%stray NUL%'")" = "150" ] && pass "emails with NUL characters are stored" || fail "NUL handling"

# --- Failures stay visible, nothing is duplicated --------------------------------------
[ "$(sql "SELECT attempts >= 1 AND last_error IS NOT NULL FROM gmail_fetch_queue WHERE gmail_message_id='old-broken'")" = "t" ] \
  && pass "a failing message stays queued with its error" || fail "failing message not tracked"
before=$(sql "SELECT count(*) FROM emails"); tick > /dev/null; tick > /dev/null
[ "$(sql "SELECT count(*) FROM emails")" = "$before" ] && pass "repeated runs store nothing twice" || fail "duplicates appeared"

# --- Gmail history expired (long outage): recovery picks up missed mail -----------------
curl -s -X POST "$FAKE/_control/expire-history" > /dev/null
curl -s -X POST "$FAKE/_control/new-mail" -d '{"id":"new-2"}' > /dev/null
tick > /dev/null; tick > /dev/null
[ "$(sql "SELECT count(*) FROM emails WHERE gmail_message_id='new-2' AND NOT is_historical")" = "1" ] && pass "mail missed during an outage is recovered" || fail "recovery failed"
[ "$(sql "SELECT history_id FROM gmail_accounts")" = "$(curl -s "$FAKE/_control/stats" | sed -E 's/.*"historyId":([0-9]+).*/\1/')" ] \
  && pass "history bookmark moved to the present" || fail "history bookmark not updated"

# --- Access revoked: inbox flagged, then reconnected ------------------------------------
curl -s -X POST "$FAKE/_control/revoke" > /dev/null
sql "UPDATE gmail_accounts SET access_token_expires_at = now()" > /dev/null
tick > /dev/null
[ "$(sql "SELECT status FROM gmail_accounts")" = "needs_reconnect" ] && pass "revoked access marks the inbox for reconnecting" || fail "status: $(sql "SELECT status FROM gmail_accounts")"
curl -s -H "Cookie: $SESSION" "$BASE/settings" | grep -q "needs reconnecting" && pass "settings shows the reconnect warning" || fail "no reconnect warning"
loc=$(connect good-code)
[[ "$loc" == *"gmail=reconnected"* ]] && pass "reconnecting works" || fail "reconnect: $loc"
[ "$(sql "SELECT status FROM gmail_accounts")" = "connected" ] && pass "inbox connected again" || fail "still not connected"
curl -s -X POST "$FAKE/_control/new-mail" -d '{"id":"new-3"}' > /dev/null
tick > /dev/null
[ "$(sql "SELECT count(*) FROM emails WHERE gmail_message_id='new-3'")" = "1" ] && pass "sync resumes after reconnecting" || fail "no sync after reconnect"

# --- Only one inbox at a time ----------------------------------------------------------
loc=$(connect other-code)
[[ "$loc" == *"gmail=other_inbox_connected"* ]] && pass "a second inbox is refused" || fail "second inbox: $loc"
[ "$(sql "SELECT email FROM gmail_accounts")" = "test.inbox@gmail.com" ] && pass "original inbox untouched" || fail "inbox changed"

# --- Disconnect and delete --------------------------------------------------------------
loc=$(curl -s -o /dev/null -w "%{redirect_url}" -X POST -H "Cookie: $SESSION" "$BASE/api/gmail/disconnect")
[[ "$loc" == *"gmail=confirm_needed"* && "$(sql "SELECT count(*) FROM gmail_accounts")" = "1" ]] && pass "disconnect needs confirmation" || fail "disconnect without confirm: $loc"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "confirm=delete" "$BASE/api/gmail/disconnect")
[[ "$code" =~ ^30 && "$(sql "SELECT count(*) FROM gmail_accounts")" = "1" ]] && pass "disconnect requires sign-in" || fail "disconnect without session answered $code"
loc=$(curl -s -o /dev/null -w "%{redirect_url}" -X POST -H "Cookie: $SESSION" -d "confirm=delete" "$BASE/api/gmail/disconnect")
[[ "$loc" == *"gmail=disconnected"* ]] && pass "disconnect completes" || fail "disconnect: $loc"
[ "$(sql "SELECT (SELECT count(*) FROM gmail_accounts) + (SELECT count(*) FROM emails) + (SELECT count(*) FROM gmail_fetch_queue)")" = "0" ] \
  && pass "every email and queued item from the inbox is deleted" || fail "data left after disconnect"
curl -s "$FAKE/_control/stats" | grep -q '"revokeCalls":1' && pass "Google access is revoked on disconnect" || fail "revoke not called"
[ "$(sql "SELECT count(*) FROM activities WHERE kind='gmail_disconnected'")" = "1" ] && pass "disconnect is logged" || fail "disconnect not logged"

echo
if [ "$fails" -ne 0 ]; then
  echo "--- web log ---"; tail -40 /tmp/web-gmail.log
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Web log::$(grep -iE 'error|fail' /tmp/web-gmail.log | tail -5 | head -c 900 | tr '\n' '|')"
  echo "--- fake google log ---"; tail -10 /tmp/fake-google.log
  echo "$fails Gmail check(s) failed."; exit 1
fi
echo "All Gmail checks passed."
