#!/usr/bin/env bash
# Starts the built web app and checks it behaves, including the scheduled-run endpoint.
# Expects: npm run build done, DATABASE_URL migrated, env vars from .env.example set.
set -uo pipefail
BASE="${APP_URL:-http://localhost:3000}"
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

npm start > /tmp/web.log 2>&1 &
WEB=$!
trap 'kill $WEB 2>/dev/null' EXIT

for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/login" && break; sleep 1; done

# 1. Before any scheduled run, health says background jobs haven't started.
health=$(curl -s "$BASE/api/health")
grep -q '"scheduler":"never_seen"' <<<"$health" && pass "health reports scheduler not yet run" || fail "health before tick: $health"

# 2. The scheduled-run endpoint refuses callers without the exact secret.
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/cron/tick")
[ "$code" = "401" ] && pass "tick without secret is refused" || fail "tick without secret answered $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer wrong-secret-wrong-secret-wrong-secret" "$BASE/api/cron/tick")
[ "$code" = "401" ] && pass "tick with wrong secret is refused" || fail "tick with wrong secret answered $code"

# 3. With the secret it runs, and health then reports everything up.
tick=$(curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/tick")
grep -q '"ran":true' <<<"$tick" && pass "tick with secret runs" || fail "tick: $tick"
health=$(curl -s "$BASE/api/health")
grep -q '"ok":true' <<<"$health" && pass "health reports database and scheduler up" || fail "health after tick: $health"

# 4. Overlapping runs are prevented by the lock (both succeed or one is skipped; none errors).
curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/tick" > /tmp/tick1 &
P1=$!
r2=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/tick")
wait $P1
r1=$(cat /tmp/tick1)
[ "$r1" = "200" ] && [ "$r2" = "200" ] && pass "concurrent ticks don't error" || fail "concurrent ticks answered $r1 and $r2"

# 5. The sign-in page renders.
code=$(curl -s -o /tmp/login.html -w "%{http_code}" "$BASE/login")
[ "$code" = "200" ] && grep -q "Continue with Google" /tmp/login.html && pass "sign-in page renders" || fail "sign-in page: HTTP $code"

# 6. Private pages redirect to sign-in when there is no session.
for path in / /opportunities /review /settings; do
  loc=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$BASE$path")
  [[ "$loc" =~ ^30[0-9]\ .*/login ]] && pass "$path requires sign-in" || fail "$path is not protected: $loc"
done

# 7. A forged session cookie is not accepted.
loc=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" -H "Cookie: __Host-spotlight_session=eyJ2Ijp7ImVtYWlsIjoieEB4LmNvbSJ9LCJleHAiOjk5OTk5OTk5OTl9.forged" "$BASE/")
[[ "$loc" =~ ^30[0-9]\ .*/login ]] && pass "forged session cookie is rejected" || fail "forged cookie: $loc"

# 8. Starting sign-in sends the browser to Google with PKCE and sets the state cookie.
headers=$(curl -s -D - -o /dev/null "$BASE/api/auth/login")
grep -qi "^location: https://accounts.google.com/o/oauth2/v2/auth?.*code_challenge_method=S256" <<<"$headers" \
  && pass "sign-in redirects to Google with PKCE" || fail "sign-in redirect: $(grep -i '^location' <<<"$headers")"
grep -qi "^set-cookie: spotlight_oauth=.*HttpOnly" <<<"$headers" && pass "state cookie is httpOnly" || fail "state cookie missing"

# 9. Returning from Google without the state cookie is refused.
loc=$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE/api/auth/callback?code=x&state=y")
[[ "$loc" == *"error=state_mismatch"* ]] && pass "callback without state is refused" || fail "callback: $loc"

# 10. Sign-out only accepts POST.
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/auth/logout")
[ "$code" = "405" ] && pass "sign-out refuses GET" || fail "sign-out GET answered $code"

# 11. Security headers are present.
h=$(curl -s -D - -o /dev/null "$BASE/login")
grep -qi "^x-frame-options: DENY" <<<"$h" && pass "pages cannot be framed" || fail "X-Frame-Options missing"
grep -qi "^x-powered-by" <<<"$h" && fail "X-Powered-By header leaks" || pass "no X-Powered-By header"

echo
if [ "$fails" -ne 0 ]; then
  echo "--- web log ---"; tail -40 /tmp/web.log
  echo "$fails smoke check(s) failed."; exit 1
fi
echo "All smoke checks passed."
