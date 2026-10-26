#!/usr/bin/env bash
# End-to-end dashboard test: real cards made by the pipeline (against a fake Claude), then every
# admin action exercised as a browser would: status, corrections, notes, snooze, review, duplicates,
# the review queue, filters, search, the board, and the guards against other sites and signed-out use.
# Expects: npm run build done, a migrated DATABASE_URL, the env vars from .env.example.
set -uo pipefail
BASE="http://localhost:3000"
FAKE="http://localhost:4020"
fails=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"; fails=$((fails + 1))
  [ -n "${GITHUB_ACTIONS:-}" ] && [ "$fails" -le 8 ] && echo "::error title=Dashboard e2e::$(printf '%s' "$1" | head -c 300 | tr '\n' ' ')"
  return 0
}
sql() { psql "$DATABASE_URL" -tA -c "$1"; }
tick() { curl -s --max-time 75 -X POST -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/cron/tick" > /dev/null; }

for _ in $(seq 1 20); do curl -s -o /dev/null "$BASE/login" || break; sleep 1; done
if curl -s -o /dev/null "$BASE/login"; then echo "FAIL  port 3000 is still in use by another server"; exit 1; fi
for _ in $(seq 1 10); do curl -s -o /dev/null "$FAKE/_control/requests" || break; sleep 1; done

node scripts/test/fake-anthropic.mjs > /tmp/fake-anthropic-dash.log 2>&1 &
FAKE_PID=$!
ANTHROPIC_API_KEY=ci-fake-key ANTHROPIC_API_BASE_OVERRIDE="$FAKE" ./node_modules/.bin/next start > /tmp/web-dash.log 2>&1 &
WEB_PID=$!
trap 'kill $FAKE_PID $WEB_PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/login" && break; sleep 1; done

# --- Fresh inbox with a few emails, sorted by the real pipeline ----------------------------------
ACC=44444444-4444-4444-4444-444444444444
sql "DELETE FROM gmail_accounts; INSERT INTO gmail_accounts (id, email, status) VALUES ('$ACC', 'actress@gmail.com', 'needs_reconnect')" > /dev/null
add() {
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -v id="$1" -v thread="$2" -v fname="$3" -v femail="$4" -v subject="$5" -v body="$6" <<'SQL'
INSERT INTO emails (gmail_account_id, gmail_message_id, gmail_thread_id, from_name, from_email, subject, snippet, body_text, received_at, is_historical)
VALUES ('44444444-4444-4444-4444-444444444444', :'id', :'thread', NULLIF(:'fname', ''), :'femail', :'subject', left(:'body', 80), :'body', now(), false);
SQL
}
add d-offer t-offer "Priya Shah, Glow Labs" priya@glowlabs.in "[case:offer] Paid reel collaboration" \
  "Hi Ananya, we would love you to create 1 Instagram reel and 2 stories for our new serum. Budget: ₹75,000 (negotiable). Usage: 3 months on our social pages. Shoot in Mumbai. Please confirm by Friday."
add d-scam t-scam "Casting Team" netflix.castings.india@gmail.com "[case:scam] Selected for lead role" \
  "Congratulations! You are selected for a lead role in a Netflix India series. Pay a registration fee of ₹5,000 within 24 hours to confirm."
add d-manual t-manual "Meera Rao" meera@raoweddings.in "[case:manual] Jaipur" "Would you make an appearance at a wedding in Jaipur on behalf of Rao Weddings? We can offer ₹2,00,000."
add d-notoffer t-notoffer "Deals" promo@deals.example.com "[case:unclear] Special for you" "Exclusive deals this week only."
tick; tick
add d-dup t-dup "Priya Shah, Glow Labs" priya@glowlabs.in "[case:dup] Diwali campaign" "Separately, we also have a serum campaign for Diwali. Budget: ₹60,000."
tick

opp_for() { sql "SELECT o.id FROM opportunities o JOIN opportunity_emails oe ON oe.opportunity_id = o.id JOIN emails e ON e.id = oe.email_id WHERE e.gmail_message_id = '$1' LIMIT 1"; }
email_id() { sql "SELECT id FROM emails WHERE gmail_message_id = '$1'"; }
OFFER=$(opp_for d-offer); SCAM=$(opp_for d-scam); DUP=$(opp_for d-dup)
[ -n "$OFFER" ] && [ -n "$SCAM" ] && [ -n "$DUP" ] && pass "pipeline made the cards to work with" || { fail "setup: offer=$OFFER scam=$SCAM dup=$DUP"; exit 1; }

ADMIN_ID=$(sql "INSERT INTO users (email, name) VALUES ('manager@example.com', 'Varun') ON CONFLICT (email) DO UPDATE SET name = 'Varun' RETURNING id")
SESSION="__Host-spotlight_session=$(node scripts/test/make-session.ts "$ADMIN_ID" manager@example.com)"
page() { curl -s --max-time 30 -H "Cookie: $SESSION" "$BASE$1"; }
# post <path> field=value ...  → prints "<status> <redirect>"
post() {
  local path="$1"; shift
  local args=()
  for kv in "$@"; do args+=(--data-urlencode "$kv"); done
  curl -s --max-time 30 -o /dev/null -w "%{http_code} %{redirect_url}" -X POST -H "Cookie: $SESSION" -H "Origin: $BASE" "${args[@]}" "$BASE$path"
}
col() { sql "SELECT $2 FROM opportunities WHERE id = '$1'"; }

# --- Detail page ----------------------------------------------------------------------------------
sql "UPDATE opportunities SET is_read = false WHERE id = '$OFFER'" > /dev/null
html=$(page "/opportunities/$OFFER")
grep -q "Glow Labs serum reel collaboration" <<<"$html" && pass "detail page shows the offer" || fail "detail page missing title"
grep -q "<mark[^>]*>Budget: ₹75,000</mark>" <<<"$html" && pass "the email's source words are highlighted" || fail "no highlighted quote"
grep -q "From the email: “Budget: ₹75,000”" <<<"$html" && pass "each detail shows the words it came from" || fail "no source line"
[ "$(col "$OFFER" is_read)" = "t" ] && pass "opening a card marks it read" || fail "not marked read"
[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Cookie: $SESSION" "$BASE/opportunities/00000000-0000-0000-0000-000000000000")" = "404" ] && pass "unknown card is a 404" || fail "unknown card not 404"
[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Cookie: $SESSION" "$BASE/opportunities/not-an-id")" = "404" ] && pass "malformed id is a 404" || fail "malformed id not 404"

# --- Status ------------------------------------------------------------------------------------------
r=$(post "/api/opportunities/$OFFER" action=status status=interested)
[[ "$r" == 303*"done=Status+set+to+Interested"* ]] && [ "$(col "$OFFER" status)" = "interested" ] && pass "status changes and says so" || fail "status: $r / $(col "$OFFER" status)"
[ "$(sql "SELECT count(*) FROM activities WHERE opportunity_id = '$OFFER' AND kind = 'status_changed' AND actor_type = 'user' AND actor_user_id = '$ADMIN_ID'")" = "1" ] \
  && pass "the change is logged with who made it" || fail "status not logged"
r=$(post "/api/opportunities/$OFFER" action=status status=maybe)
[[ "$r" == *"error="* ]] && [ "$(col "$OFFER" status)" = "interested" ] && pass "an unknown status is refused" || fail "bad status: $r"

# --- Corrections ---------------------------------------------------------------------------------------
sql "UPDATE opportunities SET unverified_fields = '{compensation}' WHERE id = '$OFFER'" > /dev/null
r=$(post "/api/opportunities/$OFFER" action=correct field=pay type=paid amount_min="1.5 lakh" amount_max= currency=INR)
[ "$(col "$OFFER" "amount_min::int || '|' || amount_max::int || '|' || compensation_status")" = "150000|150000|confirmed" ] && pass "pay corrected from '1.5 lakh'" || fail "pay: $r / $(col "$OFFER" "amount_min, amount_max")"
[ "$(col "$OFFER" "'compensation' = ANY(unverified_fields)")" = "f" ] && pass "a corrected value is no longer unverified" || fail "still unverified"
col "$OFFER" "priority_reasons::text" | grep -q "₹1,50,000" && pass "priority is recalculated after a correction" || fail "priority not rescored"
[ "$(sql "SELECT count(*) FROM corrections WHERE opportunity_id = '$OFFER' AND field_name = 'compensation' AND corrected_by = '$ADMIN_ID'")" = "1" ] && pass "the correction is recorded" || fail "no correction row"
[ "$(sql "SELECT count(*) FROM extracted_fields WHERE opportunity_id = '$OFFER' AND field_name = 'compensation' AND is_current")" = "1" ] && pass "only the corrected pay is current" || fail "pay values not superseded"
r=$(post "/api/opportunities/$OFFER" action=correct field=pay type=paid amount_min="about 50k")
[[ "$r" == *"error="*"isn"* ]] && [ "$(col "$OFFER" "amount_min::int")" = "150000" ] && pass "an unreadable amount is refused with a reason" || fail "bad amount: $r"

TOMORROW=$(TZ=Asia/Kolkata date -d tomorrow +%F)
post "/api/opportunities/$OFFER" action=correct field=reply_by value="$TOMORROW" > /dev/null
[ "$(sql "SELECT to_char(reply_by_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') FROM opportunities WHERE id = '$OFFER'")" = "$TOMORROW 23:59" ] && pass "reply-by date set to the end of that day in India" || fail "reply_by wrong"
[ "$(col "$OFFER" "next_deadline_at = reply_by_at")" = "t" ] && pass "the next deadline follows the corrected date" || fail "next deadline not updated"
[ "$(col "$OFFER" priority)" = "high" ] && pass "paid and due tomorrow is high priority" || fail "priority after date: $(col "$OFFER" priority)"

post "/api/opportunities/$OFFER" action=correct field=usage_rights value= > /dev/null
[ -z "$(col "$OFFER" usage_rights)" ] && [ "$(sql "SELECT count(*) FROM extracted_fields WHERE opportunity_id = '$OFFER' AND field_name = 'usage_rights' AND is_current")" = "0" ] \
  && pass "clearing a wrong detail removes it" || fail "usage rights not cleared"
post "/api/opportunities/$OFFER" action=correct field=deliverables value=$'- 1 Instagram reel\n- 2 stories\n3) one static post' > /dev/null
[ "$(col "$OFFER" "deliverables::text")" = '[{"item": "1 Instagram reel", "verified": true}, {"item": "2 stories", "verified": true}, {"item": "one static post", "verified": true}]' ] \
  && pass "deliverables corrected one per line" || fail "deliverables: $(col "$OFFER" "deliverables::text")"
post "/api/opportunities/$OFFER" action=correct field=category value=film_entertainment > /dev/null
[ "$(sql "SELECT c.slug FROM opportunities o JOIN categories c ON c.id = o.category_id WHERE o.id = '$OFFER'")" = "film_entertainment" ] && pass "category corrected" || fail "category"
r=$(post "/api/opportunities/$OFFER" action=correct field=title value=)
[[ "$r" == *"error="* ]] && pass "an empty title is refused" || fail "empty title accepted"
r=$(post "/api/opportunities/$OFFER" action=correct field=priority value=high)
[[ "$r" == *"error="* ]] && pass "priority can't be set by hand" || fail "priority edited directly"

# --- Notes, snooze -------------------------------------------------------------------------------------
post "/api/opportunities/$OFFER" action=note text=$'Called Priya.\nBrief coming Friday.' > /dev/null
[ "$(sql "SELECT detail->>'text' FROM activities WHERE opportunity_id = '$OFFER' AND kind = 'note'")" = $'Called Priya.\nBrief coming Friday.' ] && pass "notes keep their line breaks" || fail "note"
page "/opportunities/$OFFER" | grep -q "Brief coming Friday" && pass "notes show on the timeline" || fail "note not shown"
post "/api/opportunities/$OFFER" action=snooze days=3 > /dev/null
[ "$(col "$OFFER" "snoozed_until > now() + interval '2 days'")" = "t" ] && pass "snoozed for 3 days" || fail "snooze"
page "/" | grep -q "Glow Labs serum reel collaboration</span>" && fail "snoozed card still in Needs you now" || pass "snoozed cards leave 'Needs you now'"
post "/api/opportunities/$OFFER" action=snooze days=clear > /dev/null
[ -z "$(col "$OFFER" snoozed_until)" ] && pass "unsnooze works" || fail "unsnooze"
page "/" | grep -q "Needs you now" && pass "overview shows what needs you" || fail "overview section missing"

# --- Review: scam-like card -----------------------------------------------------------------------------
[ "$(col "$SCAM" priority)" = "needs_review" ] || fail "scam not in review to begin with"
post "/api/opportunities/$SCAM" action=review decision=genuine > /dev/null
[ "$(col "$SCAM" "review_cleared || '|' || (priority <> 'needs_review')")" = "true|true" ] && pass "a checked card leaves Needs review" || fail "review: $(col "$SCAM" "review_cleared, priority")"
col "$SCAM" "red_flags::text" | grep -q "Asks for money" && pass "its warnings stay visible" || fail "warnings lost"
post "/api/opportunities/$SCAM" action=review decision=not_relevant > /dev/null
[ "$(col "$SCAM" is_irrelevant)" = "t" ] && ! page "/opportunities" | grep -q "Lead role in a Netflix India series" && pass "not relevant hides it from the list" || fail "not relevant still listed"
[ "$(sql "SELECT count(*) FROM corrections WHERE opportunity_id = '$SCAM' AND new_value #>> '{}' = 'unrelated'")" = "1" ] && pass "and is remembered for future sorting" || fail "no correction for not relevant"
post "/api/opportunities/$SCAM" action=review decision=restore > /dev/null
[ "$(col "$SCAM" is_irrelevant)" = "f" ] && pass "it can be put back" || fail "restore"

# --- Duplicates ---------------------------------------------------------------------------------------------
[ "$(col "$DUP" possible_duplicate_of)" = "$OFFER" ] || fail "duplicate not suggested to begin with"
page "/opportunities/$DUP" | grep -q "Merge into that card" && pass "a possible duplicate offers to merge" || fail "no merge button"
post "/api/opportunities/$DUP" action=duplicate decision=dismiss > /dev/null
[ -z "$(col "$DUP" possible_duplicate_of)" ] && pass "kept separate on request" || fail "dismiss"
r=$(post "/api/opportunities/$DUP" action=duplicate decision=merge)
[[ "$r" == *"error="* ]] && pass "can't merge a card that isn't a duplicate" || fail "merge without suggestion: $r"
sql "UPDATE opportunities SET possible_duplicate_of = '$OFFER' WHERE id = '$DUP'" > /dev/null
r=$(post "/api/opportunities/$DUP" action=duplicate decision=merge)
[[ "$r" == *"/opportunities/$OFFER?"* ]] && pass "merging goes to the remaining card" || fail "merge redirect: $r"
[ "$(sql "SELECT count(*) FROM opportunities WHERE id = '$DUP'")" = "0" ] && [ "$(opp_for d-dup)" = "$OFFER" ] && pass "the duplicate's email moves to the remaining card" || fail "merge result"
[ "$(sql "SELECT count(*) FROM activities WHERE opportunity_id = '$OFFER' AND kind = 'merged'")" = "1" ] && pass "the merge is logged" || fail "merge not logged"

# --- Review queue emails --------------------------------------------------------------------------------------
MANUAL=$(email_id d-manual); NOTOFFER=$(email_id d-notoffer)
[ "$(sql "SELECT processing_state FROM emails WHERE id = '$MANUAL'")" = "needs_review" ] || fail "manual email not in review"
page "/review" | grep -q "an offer: read it again" && pass "review queue offers decisions" || fail "no review buttons"
r=$(post "/api/emails/$MANUAL" decision=offer)
[[ "$r" == *"/review?done="* ]] && [ "$(sql "SELECT processing_state || '|' || classification || '|' || classification_confidence FROM emails WHERE id = '$MANUAL'")" = "pending|new_opportunity|1.000" ] \
  && pass "'It's an offer' sends it back to be read as an offer" || fail "offer decision: $r"
tick
[ "$(sql "SELECT title FROM opportunities o JOIN opportunity_emails oe ON oe.opportunity_id = o.id WHERE oe.email_id = '$MANUAL'")" = "Wedding appearance in Jaipur" ] \
  && pass "and the AI then makes a full card from it" || fail "no card from the manual decision"
post "/api/emails/$NOTOFFER" decision=not_offer > /dev/null
[ "$(sql "SELECT processing_state || '|' || classification FROM emails WHERE id = '$NOTOFFER'")" = "processed|unrelated" ] && pass "'Not an offer' clears it from review" || fail "not offer"

# The team's decision reaches the next triage of mail from that sender.
add d-learn t-learn "Deals" offers@deals.example.com "[case:newsletter] More deals" "More deals."
tick
curl -s --max-time 10 "$FAKE/_control/requests" > /tmp/dash-requests.json
node -e '
const reqs = require("/tmp/dash-requests.json");
const r = reqs.filter((x) => x.step === "triage" && x.user.includes("More deals")).at(-1);
process.stdout.write(r && r.system.includes("Mail from deals.example.com: her team marked these as not offers.") ? "yes" : "no");
' > /tmp/learn.txt
[ "$(cat /tmp/learn.txt)" = "yes" ] && pass "her team's decisions guide future sorting" || fail "decision not in the triage prompt"

# --- Lists, search, board -------------------------------------------------------------------------------------
page "/opportunities?q=glow" | grep -q "Glow Labs serum reel collaboration" && pass "search finds by brand" || fail "search"
page "/opportunities?q=zzzz" | grep -q "Nothing matches" && pass "a search with no results says so" || fail "empty search"
[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Cookie: $SESSION" "$BASE/opportunities?q=%25_%5C%27")" = "200" ] && pass "search with % _ \\ ' is safe" || fail "search escaping"
page "/opportunities?category=film_entertainment" | grep -q "Glow Labs serum reel collaboration" && pass "category filter" || fail "category filter"
page "/opportunities?category=social_media" | grep -q "Glow Labs serum reel collaboration" && fail "category filter leaks" || pass "category filter excludes others"
board=$(page "/opportunities?view=board")
grep -q ">Considering<" <<<"$board" && grep -q "Glow Labs serum reel collaboration" <<<"$board" && pass "board view groups cards by stage" || fail "board"
page "/opportunities?show=closed" | grep -q "Glow Labs serum reel collaboration" && fail "closed filter shows open cards" || pass "closed filter"

# --- Guards -----------------------------------------------------------------------------------------------------
before=$(col "$OFFER" status)
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Cookie: $SESSION" -H "Origin: https://evil.example" --data "action=status&status=archived" "$BASE/api/opportunities/$OFFER")
[ "$code" = "403" ] && [ "$(col "$OFFER" status)" = "$before" ] && pass "a form on another site is refused" || fail "cross-origin post: $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Cookie: $SESSION" -H "Sec-Fetch-Site: cross-site" --data "action=status&status=archived" "$BASE/api/opportunities/$OFFER")
[ "$code" = "403" ] && pass "a cross-site browser request is refused" || fail "sec-fetch-site: $code"
code=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" -X POST --data "action=status&status=archived" "$BASE/api/opportunities/$OFFER")
[[ "$code" =~ ^30[0-9]\ .*/login ]] && [ "$(col "$OFFER" status)" = "$before" ] && pass "signed-out changes are refused" || fail "signed out: $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Cookie: $SESSION" -H "Origin: $BASE" --data "decision=offer" "$BASE/api/emails/not-a-uuid")
[ "$code" = "404" ] && pass "malformed email id is refused" || fail "email id: $code"
r=$(post "/api/opportunities/$OFFER" action=status status=interested back=//evil.example/x)
[[ "$r" != *"evil.example"* ]] && pass "can't be bounced to another site after a form" || fail "open redirect: $r"

echo
if [ "$fails" -ne 0 ]; then
  echo "--- web log ---"; tail -40 /tmp/web-dash.log
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Dashboard web log::$(grep -iE 'error|fail' /tmp/web-dash.log | tail -5 | head -c 900 | tr '\n' '|')"
  echo "$fails dashboard check(s) failed."; exit 1
fi
echo "All dashboard checks passed."
