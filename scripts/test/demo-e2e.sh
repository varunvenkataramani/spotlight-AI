#!/usr/bin/env bash
# End-to-end test of the public demo (DEMO_MODE=on): its own database, no Google, Gmail, Claude or
# Telegram settings. Visitors enter as one of two made-up admins and see a full set of made-up
# offers; anything that would reach the outside world is refused; resets bring the data back.
# Expects: npm run build done, and a Postgres server at DATABASE_URL (a separate demo database is made).
set -uo pipefail
BASE="http://localhost:3000"
fails=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"; fails=$((fails + 1))
  [ -n "${GITHUB_ACTIONS:-}" ] && [ "$fails" -le 8 ] && echo "::error title=Demo e2e::$(printf '%s' "$1" | head -c 300 | tr '\n' ' ')"
  return 0
}

for _ in $(seq 1 20); do curl -s -o /dev/null "$BASE/login" || break; sleep 1; done
if curl -s -o /dev/null "$BASE/login"; then echo "FAIL  port 3000 is still in use by another server"; exit 1; fi

DEMO_DB="${DATABASE_URL%/*}/demo_check"
psql "$DATABASE_URL" -q -c "DROP DATABASE IF EXISTS demo_check" -c "CREATE DATABASE demo_check" > /dev/null
DATABASE_URL="$DEMO_DB" npm run migrate > /dev/null || { echo "FAIL  demo database migration"; exit 1; }
sql() { psql "$DEMO_DB" -tA -c "$1"; }

# The demo runs without any real account settings (it refuses to start next to them).
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u TOKEN_ENCRYPTION_KEY -u ANTHROPIC_API_KEY -u TELEGRAM_BOT_TOKEN -u ADMIN_EMAILS \
  DEMO_MODE=on DATABASE_URL="$DEMO_DB" ./node_modules/.bin/next start > /tmp/web-demo.log 2>&1 &
WEB_PID=$!
trap 'kill $WEB_PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/login" && break; sleep 1; done

# --- The front door -----------------------------------------------------------------------------------
login=$(curl -s "$BASE/login")
grep -q "Enter as Kabir, her manager" <<<"$login" && grep -q "Enter as Tara, the actress" <<<"$login" && ! grep -q "Continue with Google" <<<"$login" \
  && pass "the login page offers the two demo views, not Google" || fail "demo login page: $(head -c 300 <<<"$login")"

# enter <as> [reset] → sets COOKIE (a global, so not called inside $(...)) and LAST_STATUS
COOKIE=""; LAST_STATUS=""
enter() {
  local hdrs
  hdrs=$(curl -s -D - -o /dev/null -X POST -H "Origin: $BASE" --data-urlencode "as=$1" ${2:+--data-urlencode "reset=$2"} "$BASE/api/demo/enter")
  LAST_STATUS=$(head -n1 <<<"$hdrs" | awk '{print $2}')
  COOKIE=$(grep -i '^set-cookie: __Host-spotlight_session=' <<<"$hdrs" | head -n1 | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/' | tr -d '\r')
}
page() { curl -s --max-time 30 -H "Cookie: $COOKIE" "$BASE$1"; }
post() {
  local path="$1"; shift
  local args=()
  for kv in "$@"; do args+=(--data-urlencode "$kv"); done
  curl -s --max-time 30 -o /dev/null -w "%{http_code} %{redirect_url}" -X POST -H "Cookie: $COOKIE" -H "Origin: $BASE" "${args[@]}" "$BASE$path"
}

enter manager
[ "$LAST_STATUS" = "303" ] && [ -n "$COOKIE" ] && pass "entering as the manager signs in" || fail "enter: status $LAST_STATUS, cookie '${COOKIE:0:20}'"
[ "$(sql "SELECT count(*) FROM opportunities")" = "12" ] && [ "$(sql "SELECT count(*) FROM emails")" = "17" ] \
  && pass "the first visit fills the demo with made-up offers" || fail "seed counts: $(sql "SELECT count(*) FROM opportunities") offers"
[ "$(sql "SELECT count(*) FROM opportunities WHERE priority = 'needs_review'")" = "1" ] && [ "$(sql "SELECT priority FROM opportunities WHERE title LIKE 'Lumora%'")" = "high" ] \
  && pass "the real scoring rules ranked them" || fail "priorities: $(sql "SELECT title || '=' || priority FROM opportunities")"
[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Origin: https://evil.example" -d as=manager "$BASE/api/demo/enter")" = "403" ] \
  && pass "another site can't sign a visitor in" || fail "cross-site demo entry"

LUMORA=$(sql "SELECT id FROM opportunities WHERE title LIKE 'Lumora%'")
home=$(page "/")
grep -q "Demo</span>" <<<"$home" && grep -q "Switch to Tara" <<<"$home" && pass "every page says it's the demo, with a switch" || fail "demo bar missing"
grep -q "data-stage=\"$LUMORA\"" <<<"$home" && grep -q "Her call" <<<"$home" && grep -q "The runway" <<<"$home" \
  && pass "the Stage shows the made-up offers" || fail "stage: $(grep -o 'data-stage="[^"]*"' <<<"$home" | head -3)"
page "/map" | grep -q "Saffron Thread festive campaign" && pass "the map plots them" || fail "map"
detail=$(page "/opportunities/$LUMORA")
grep -q 'id="q-1"' <<<"$detail" && grep -q "her available dates" <<<"$detail" \
  && pass "an offer shows numbered sources and its sample draft" || fail "detail page"
page "/review" | grep -q "StarPath Casting" && pass "the scam waits in To check" || fail "review page"
page "/alerts" | grep -q "Terms changed" && pass "alerts are filled in" || fail "alerts page"
page "/settings" | grep -q "Paused in the demo" && pass "settings says the background run is paused" || fail "settings page"

# --- Nothing reaches the outside world ------------------------------------------------------------------
DRAFT=$(sql "SELECT id FROM drafts WHERE status = 'ready'")
r=$(post "/api/opportunities/$LUMORA" action=draft_send draft="$DRAFT" confirm=yes)
[[ "$r" == 303*"error="*"demo"* ]] && [ "$(sql "SELECT count(*) FROM drafts WHERE status = 'sent'")" = "1" ] \
  && pass "sending is refused" || fail "send in demo: $r"
r=$(post "/api/opportunities/$LUMORA" action=draft mode=express_interest tone=friendly)
[[ "$r" == 303*"error="* ]] && [ "$(sql "SELECT count(*) FROM drafts")" = "2" ] && pass "and so is writing a new draft with Claude" || fail "draft in demo: $r"
r=$(post "/api/opportunities/$LUMORA" action=draft_save draft="$DRAFT" subject="Re: Lumora" body="Hi Ritika, edited in the demo.")
[ "$(sql "SELECT body FROM drafts WHERE id = '$DRAFT'")" = "Hi Ritika, edited in the demo." ] && pass "but drafts can be edited" || fail "edit draft: $r"
[[ "$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$BASE/api/auth/login")" == 30*"/login" ]] && pass "Google sign-in is off" || fail "auth login in demo"
[[ "$(curl -s -o /dev/null -w "%{redirect_url}" -H "Cookie: $COOKIE" "$BASE/api/gmail/connect")" == *"/settings?error="* ]] && pass "Gmail can't be connected" || fail "gmail connect in demo"
r=$(post "/api/gmail/disconnect" confirm=delete)
[[ "$r" == 303*"error="* ]] && [ "$(sql "SELECT count(*) FROM gmail_accounts")" = "1" ] && pass "or disconnected" || fail "gmail disconnect in demo: $r"
for path in /api/mcp /api/oauth/register /api/oauth/token /api/cron/tick /api/telegram/webhook; do
  [ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' "$BASE$path")" = "404" ] && pass "$path is off" || fail "$path answered in the demo"
done
[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/.well-known/oauth-authorization-server")" = "404" ] && pass "there's no connector to discover" || fail "oauth discovery in demo"
r=$(post "/api/settings" action=talent email=kabir.demo@example.com)
[[ "$r" == 303*"error="* ]] && [ "$(sql "SELECT value #>> '{}' FROM preferences WHERE key = 'talent_email'")" = "tara.demo@example.com" ] \
  && pass "who the actress is can't be changed" || fail "talent change in demo: $r"

# --- Her view, visitors' changes, and resets --------------------------------------------------------------
enter talent
home=$(page "/")
grep -q "Your call" <<<"$home" && grep -q "Waiting for your answer" <<<"$home" && grep -q "The Tide Line" <<<"$home" && grep -q "Switch to Kabir" <<<"$home" \
  && pass "Tara's view puts her decision first" || fail "talent view"
TIDE=$(sql "SELECT id FROM opportunities WHERE title LIKE 'The Tide Line%'")
post "/api/opportunities/$TIDE" action=answer answer=interested back=/ > /dev/null
[ "$(sql "SELECT talent_response FROM opportunities WHERE id = '$TIDE'")" = "interested" ] && pass "she can answer, as in the real app" || fail "answer in demo"
enter manager
[ "$(sql "SELECT talent_response FROM opportunities WHERE id = '$TIDE'")" = "interested" ] && pass "changes last while the demo is fresh" || fail "demo refilled too early"
enter manager 1
[[ "$LAST_STATUS" = "303" ]] && [ -z "$(sql "SELECT talent_response FROM opportunities WHERE title LIKE 'The Tide Line%'")" ] \
  && [ "$(sql "SELECT count(*) FROM opportunities")" = "12" ] && pass "Start over brings back the starting offers" || fail "reset"
sql "UPDATE preferences SET value = to_jsonb((now() - interval '7 hours')::text) WHERE key = 'demo_seeded_at'" > /dev/null
OLD=$(sql "SELECT id FROM opportunities WHERE title LIKE 'Lumora%'")
enter talent
[ "$(sql "SELECT id FROM opportunities WHERE title LIKE 'Lumora%'")" != "$OLD" ] && [ "$(sql "SELECT count(*) FROM opportunities")" = "12" ] \
  && pass "a stale demo refills itself for the next visitor" || fail "stale refill"
[ "$(sql "SELECT count(*) FROM users")" = "2" ] && pass "only the two made-up admins exist" || fail "users: $(sql "SELECT email FROM users")"

if [ "$fails" -gt 0 ]; then
  echo "--- web log (tail) ---"; tail -n 30 /tmp/web-demo.log
  echo "$fails demo check(s) failed"; exit 1
fi
echo "All demo checks passed"
