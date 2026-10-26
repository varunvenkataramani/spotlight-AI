#!/usr/bin/env bash
# Starts the built web app and the worker, then checks they behave.
# Expects: npm run build done, DATABASE_URL migrated, env vars from .env.example set.
set -uo pipefail
BASE="${APP_URL:-http://localhost:3000}"
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

npm run worker > /tmp/worker.log 2>&1 &
WORKER=$!
npm start > /tmp/web.log 2>&1 &
WEB=$!
trap 'kill $WORKER $WEB 2>/dev/null' EXIT

for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/login" && break; sleep 1; done

# 1. The worker checks in, and health reports both parts up.
health=""
for _ in $(seq 1 20); do
  health=$(curl -s "$BASE/api/health")
  grep -q '"ok":true' <<<"$health" && break
  sleep 1
done
grep -q '"ok":true' <<<"$health" && pass "health reports database and worker up" || fail "health: $health"

# 2. The sign-in page renders.
code=$(curl -s -o /tmp/login.html -w "%{http_code}" "$BASE/login")
[ "$code" = "200" ] && grep -q "Continue with Google" /tmp/login.html && pass "sign-in page renders" || fail "sign-in page: HTTP $code"

# 3. Private pages redirect to sign-in when there is no session.
for path in / /opportunities /review /settings; do
  loc=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$BASE$path")
  [[ "$loc" =~ ^30[0-9]\ .*/login ]] && pass "$path requires sign-in" || fail "$path is not protected: $loc"
done

# 4. A forged session cookie is not accepted.
loc=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" -H "Cookie: __Host-spotlight_session=eyJ2Ijp7ImVtYWlsIjoieEB4LmNvbSJ9LCJleHAiOjk5OTk5OTk5OTl9.forged" "$BASE/")
[[ "$loc" =~ ^30[0-9]\ .*/login ]] && pass "forged session cookie is rejected" || fail "forged cookie: $loc"

# 5. Starting sign-in sends the browser to Google with PKCE and sets the state cookie.
headers=$(curl -s -D - -o /dev/null "$BASE/api/auth/login")
grep -qi "^location: https://accounts.google.com/o/oauth2/v2/auth?.*code_challenge_method=S256" <<<"$headers" \
  && pass "sign-in redirects to Google with PKCE" || fail "sign-in redirect: $(grep -i '^location' <<<"$headers")"
grep -qi "^set-cookie: spotlight_oauth=.*HttpOnly" <<<"$headers" && pass "state cookie is httpOnly" || fail "state cookie missing"

# 6. Returning from Google without the state cookie is refused.
loc=$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE/api/auth/callback?code=x&state=y")
[[ "$loc" == *"error=state_mismatch"* ]] && pass "callback without state is refused" || fail "callback: $loc"

# 7. Sign-out only accepts POST.
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/auth/logout")
[ "$code" = "405" ] && pass "sign-out refuses GET" || fail "sign-out GET answered $code"

# 8. Security headers are present.
h=$(curl -s -D - -o /dev/null "$BASE/login")
grep -qi "^x-frame-options: DENY" <<<"$h" && pass "pages cannot be framed" || fail "X-Frame-Options missing"
grep -qi "^x-powered-by" <<<"$h" && fail "X-Powered-By header leaks" || pass "no X-Powered-By header"

echo
if [ "$fails" -ne 0 ]; then
  echo "--- worker log ---"; tail -20 /tmp/worker.log
  echo "--- web log ---"; tail -40 /tmp/web.log
  echo "$fails smoke check(s) failed."; exit 1
fi
echo "All smoke checks passed."
