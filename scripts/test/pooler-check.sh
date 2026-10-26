#!/usr/bin/env bash
# Runs Spotlight through PgBouncer in transaction mode, the way Supabase's transaction pooler
# works in production, and checks that nothing depends on session state:
# migrations, the scheduled run and its lock, and pages all work, and no lock is left behind.
# Expects: npm run build done; DATABASE_URL pointing straight at Postgres (not the pooler);
# pgbouncer installed. Uses port 6432 for the pooler.
set -uo pipefail
fails=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"; fails=$((fails + 1))
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Pooler check::$(printf '%s' "$1" | head -c 300 | tr '\n' ' ')"
  return 0
}
DIRECT="$DATABASE_URL"
direct() { psql "$DIRECT" -tA -c "$1"; }

# Postgres URL parts for the PgBouncer config.
read -r PGU PGP PGH PGPORT PGDB < <(node -e '
const u = new URL(process.argv[1]);
console.log([decodeURIComponent(u.username), decodeURIComponent(u.password), u.hostname, u.port || "5432", u.pathname.slice(1)].join(" "));
' "$DIRECT")

WORK=$(mktemp -d)
cat > "$WORK/userlist.txt" <<EOF
"$PGU" "$PGP"
EOF
cat > "$WORK/pgbouncer.ini" <<EOF
[databases]
$PGDB = host=$PGH port=$PGPORT dbname=$PGDB user=$PGU password=$PGP

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = plain
auth_file = $WORK/userlist.txt
pool_mode = transaction
default_pool_size = 4
max_client_conn = 200
ignore_startup_parameters = extra_float_digits,options
logfile = $WORK/pgbouncer.log
pidfile = $WORK/pgbouncer.pid
EOF
pgbouncer -d "$WORK/pgbouncer.ini" || { echo "FAIL  pgbouncer didn't start"; exit 1; }
trap 'kill "$(cat "$WORK/pgbouncer.pid" 2>/dev/null)" 2>/dev/null; kill $WEB 2>/dev/null' EXIT
POOLED="postgresql://$PGU:$PGP@127.0.0.1:6432/$PGDB"
for _ in $(seq 1 20); do psql "$POOLED" -tAc "select 1" > /dev/null 2>&1 && break; sleep 0.5; done
[ "$(psql "$POOLED" -tAc 'select 1' 2>/dev/null)" = "1" ] && pass "PgBouncer is running in transaction mode" || { fail "can't connect through PgBouncer: $(tail -5 "$WORK/pgbouncer.log")"; exit 1; }

# 1. Migrations through the pooler (already applied, so this must report up to date and leave no lock).
out=$(DATABASE_URL="$POOLED" npm run -s migrate 2>&1)
grep -q "Database is up to date." <<<"$out" && pass "migrations run through the transaction pooler" || fail "migrate via pooler: $out"
[ "$(direct "select count(*) from pg_locks where locktype = 'advisory'")" = "0" ] && pass "migrations leave no lock behind" || fail "advisory lock left by migrations"

# 2. The app and its scheduled runs through the pooler.
for _ in $(seq 1 20); do curl -s -o /dev/null http://localhost:3000/login || break; sleep 1; done
DATABASE_URL="$POOLED" ./node_modules/.bin/next start > "$WORK/web.log" 2>&1 &
WEB=$!
for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:3000/login && break; sleep 1; done
tick() { curl -s --max-time 75 -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick; }

r1=$(tick); r2=$(tick)
grep -q '"ran":true' <<<"$r1" && grep -q '"ran":true' <<<"$r2" && pass "back-to-back scheduled runs both run" || fail "ticks: $r1 / $r2"
[ "$(direct "select count(*) from pg_locks where locktype = 'advisory'")" = "0" ] && pass "the scheduled run leaves no lock behind" || fail "advisory lock leaked by the scheduled run"

# Overlapping runs: exactly one works while the other is told a run is in progress, or both finish cleanly in turn.
tick > "$WORK/t1" & P1=$!
tick > "$WORK/t2"
wait $P1
grep -q '"ran":' "$WORK/t1" && grep -q '"ran":' "$WORK/t2" && pass "overlapping runs don't error through the pooler" || fail "overlap: $(cat "$WORK/t1") / $(cat "$WORK/t2")"
[ "$(direct "select count(*) from pg_locks where locktype = 'advisory'")" = "0" ] && pass "and still leave no lock behind" || fail "lock leaked after overlap"

health=$(curl -s http://localhost:3000/api/health)
grep -q '"ok":true' <<<"$health" && pass "health is fine through the pooler" || fail "health: $health"
code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login)
[ "$code" = "200" ] && pass "pages render through the pooler" || fail "login page: $code"

echo
if [ "$fails" -ne 0 ]; then
  echo "--- web log ---"; tail -30 "$WORK/web.log"
  echo "--- pgbouncer log ---"; tail -20 "$WORK/pgbouncer.log"
  echo "$fails pooler check(s) failed."; exit 1
fi
echo "All pooler checks passed."
