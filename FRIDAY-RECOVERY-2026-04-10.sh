#!/bin/bash
# FRIDAY FULL RECOVERY — 2026-04-10
# Run as root. Fixes PM2 daemon, systemd service, Supabase tables, then fires live test build.
# Usage: bash /opt/manageai/FRIDAY-RECOVERY-2026-04-10.sh

set -e
LOGFILE="/opt/manageai/recovery-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOGFILE") 2>&1
echo "=== FRIDAY Recovery $(date) ==="

# ── STEP 1: Fix systemd service (PM2_HOME mismatch) ──────────────────────────
echo ""
echo "--- Step 1: Fix pm2-root.service ---"
cat > /etc/systemd/system/pm2-root.service << 'EOF'
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=claudeagent
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
Environment=PM2_HOME=/home/claudeagent/.pm2
PIDFile=/home/claudeagent/.pm2/pm2.pid
Restart=on-failure

ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
echo "systemd service fixed: User=claudeagent, PM2_HOME=/home/claudeagent/.pm2"

# ── STEP 2: Start PM2 as claudeagent ─────────────────────────────────────────
echo ""
echo "--- Step 2: Start PM2 ---"
su - claudeagent -c '
  export HOME=/home/claudeagent
  export PM2_HOME=/home/claudeagent/.pm2
  # Try resurrect from saved dump first; fall back to starting fresh
  pm2 resurrect 2>/dev/null || pm2 start /opt/manageai/ecosystem.config.js --update-env
  sleep 5
  pm2 save
  pm2 status
'

# ── STEP 3: Verify services responding ───────────────────────────────────────
echo ""
echo "--- Step 3: Verify API ---"
sleep 5
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null || echo "000")
echo "API health check: HTTP $HTTP_STATUS"
if [ "$HTTP_STATUS" = "000" ] || [ "$HTTP_STATUS" = "503" ]; then
  echo "API not responding yet — waiting 10 more seconds..."
  sleep 10
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null || echo "000")
  echo "API health check (retry): HTTP $HTTP_STATUS"
fi

# ── STEP 4: Load Supabase env ─────────────────────────────────────────────────
echo ""
echo "--- Step 4: Supabase tables ---"
SUPABASE_URL="https://fmemdogudiolevqsfuvd.supabase.co"
SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZtZW1kb2d1ZGlvbGV2cXNmdXZkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzcwNTQ2MiwiZXhwIjoyMDg5MjgxNDYyfQ.PXBm_m4Qcf2izPmh2d_loiFGfUKlqKqm4QhyY2x89BA"

check_or_create_table() {
  local TABLE="$1"
  local DDL="$2"
  RESP=$(curl -s "${SUPABASE_URL}/rest/v1/${TABLE}?select=count&limit=1" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  if echo "$RESP" | grep -q '"code"'; then
    echo "  Creating table: $TABLE"
    curl -s -X POST "${SUPABASE_URL}/rest/v1/rpc/exec_sql" \
      -H "apikey: ${SUPABASE_SERVICE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"sql\": \"$DDL\"}"
    echo ""
  else
    echo "  OK: $TABLE"
  fi
}

check_or_create_table "build_briefs" \
  "CREATE TABLE IF NOT EXISTS build_briefs (ticket_id text PRIMARY KEY, customer_id text, client_name text, brief_analysis jsonb, brief_scoring jsonb, success_criteria jsonb DEFAULT '[]'::jsonb, blocking_issues jsonb DEFAULT '[]'::jsonb, warnings jsonb DEFAULT '[]'::jsonb, overall_score numeric, build_ready boolean, confidence numeric, analyzed_at timestamptz, created_at timestamptz DEFAULT now())"

check_or_create_table "build_agent_runs" \
  "CREATE TABLE IF NOT EXISTS build_agent_runs (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, ticket_id text, agent_id text, agent_name text, status text, started_at timestamptz, duration_ms integer, output jsonb, completed_at timestamptz, created_at timestamptz DEFAULT now(), UNIQUE(ticket_id, agent_id))"

check_or_create_table "build_quality_signals" \
  "CREATE TABLE IF NOT EXISTS build_quality_signals (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, ticket_id text, from_agent text, to_agent text, signal_type text, confidence numeric, flags jsonb, payload jsonb, created_at timestamptz DEFAULT now())"

check_or_create_table "build_compliance_results" \
  "CREATE TABLE IF NOT EXISTS build_compliance_results (ticket_id text PRIMARY KEY, customer_id text, compliance_score numeric, criteria_total integer, criteria_met integer, criteria_partial integer, criteria_failed integer, compliance_matrix jsonb DEFAULT '[]'::jsonb, revision_packages jsonb DEFAULT '[]'::jsonb, passed boolean, judge_summary text, evaluated_at timestamptz, created_at timestamptz DEFAULT now())"

check_or_create_table "cross_build_learnings" \
  "CREATE TABLE IF NOT EXISTS cross_build_learnings (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, customer_id text, pattern_type text, pattern_description text, agent_affected text, frequency integer DEFAULT 1, improvement_applied boolean DEFAULT false, last_seen_ticket text, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now())"

# ── STEP 5: Fire test build ───────────────────────────────────────────────────
echo ""
echo "--- Step 5: Fire test build ---"
TEST_RESP=$(curl -s -X POST http://localhost:3000/api/build/brief \
  -H "Content-Type: application/json" \
  -H "x-cockpit-key: friday-cockpit-2026" \
  -d '{
    "client": "Test Client FRIDAY Assessment",
    "customer_id": "882d9329-4e05-4467-8773-27dc2ce5db48",
    "primary_objective": "Simple customer intake routing system that receives support requests and routes them to the correct team based on category",
    "workflow_steps": ["receive support request via webhook", "classify request category", "route to correct team", "send acknowledgment email", "log to database"],
    "success_metrics": ["95% correct routing accuracy", "under 30 second processing time", "100% requests acknowledged"],
    "data_sources": ["support intake form webhook", "team availability table", "routing rules table"],
    "guardrails": ["never drop a request", "always send acknowledgment", "log all routing decisions", "no PII in logs"],
    "edge_cases": ["unknown category routes to general support", "after hours routes to on-call", "duplicate request deduplicated within 5 minutes"],
    "acceptance_criteria": ["webhook receives and processes test payload", "database tables created and accessible", "routing logic produces correct output for all 5 request types", "acknowledgment email template exists", "QA score above 75"],
    "decision_authority": "Routing decisions are made automatically by the system based on category classification",
    "current_state": "Currently using manual email routing with no automation"
  }')
echo "API response: $TEST_RESP"
TEST_TICKET=$(echo "$TEST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ticket_id','ERROR'))" 2>/dev/null || echo "PARSE_ERROR")
echo "Ticket ID: $TEST_TICKET"

if [[ "$TEST_TICKET" == ERROR* ]] || [[ "$TEST_TICKET" == PARSE* ]]; then
  echo "ERROR: Build did not start. Check API logs:"
  su - claudeagent -c 'pm2 logs manageai-build-api --lines 30 --nostream' 2>/dev/null
  exit 1
fi

# ── STEP 6: Monitor build (20 min max) ───────────────────────────────────────
echo ""
echo "--- Step 6: Monitor build $TEST_TICKET ---"

for i in $(seq 1 40); do
  sleep 30
  echo ""
  echo "=== Poll $i | $((i*30))s elapsed | $(date +%H:%M:%S) ==="

  AGENT_RUNS=$(curl -s \
    "${SUPABASE_URL}/rest/v1/build_agent_runs?ticket_id=eq.${TEST_TICKET}&select=agent_id,agent_name,status,duration_ms&order=created_at" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  echo "Agents: $AGENT_RUNS"

  SIGNALS=$(curl -s \
    "${SUPABASE_URL}/rest/v1/build_quality_signals?ticket_id=eq.${TEST_TICKET}&select=from_agent,to_agent,signal_type,confidence&order=created_at" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  echo "Signals: $SIGNALS"

  COMPLIANCE=$(curl -s \
    "${SUPABASE_URL}/rest/v1/build_compliance_results?ticket_id=eq.${TEST_TICKET}&select=compliance_score,criteria_met,criteria_total,passed" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  echo "Compliance: $COMPLIANCE"

  BUILD_ROW=$(curl -s \
    "${SUPABASE_URL}/rest/v1/friday_builds?ticket_id=eq.${TEST_TICKET}&select=status,qa_score" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  echo "Build: $BUILD_ROW"

  su - claudeagent -c 'pm2 logs friday-worker --lines 15 --nostream' 2>/dev/null \
    | grep -E "BUILD-0|PASSED|FAILED|BLOCKED|error|Error|compliance|security|deployment|quality" \
    | tail -10

  # Break when compliance judge has run (last agent before phase1 review)
  if echo "$COMPLIANCE" | grep -q '"compliance_score"'; then
    echo ""
    echo "=== COMPLIANCE JUDGE COMPLETE — PHASE 1 DONE ==="
    break
  fi

  BUILD_STATUS=$(echo "$BUILD_ROW" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d[0].get('status','') if d else '')" 2>/dev/null || echo "")
  if [[ "$BUILD_STATUS" =~ (complete|failed|phase1|rejected) ]]; then
    echo "=== BUILD TERMINAL STATUS: $BUILD_STATUS ==="
    break
  fi
done

# ── STEP 7: Final report ──────────────────────────────────────────────────────
echo ""
echo "=== FINAL REPORT ==="

echo ""
echo "AGENT RUNS:"
curl -s \
  "${SUPABASE_URL}/rest/v1/build_agent_runs?ticket_id=eq.${TEST_TICKET}&select=agent_id,agent_name,status,duration_ms&order=created_at" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  | python3 -c "
import sys,json
data=json.load(sys.stdin)
for r in data:
    ms = r.get('duration_ms') or 0
    print(f'  {r[\"agent_id\"]:12} {r[\"agent_name\"]:30} {r[\"status\"]:10} {ms}ms')
" 2>/dev/null

echo ""
echo "QUALITY SIGNALS:"
curl -s \
  "${SUPABASE_URL}/rest/v1/build_quality_signals?ticket_id=eq.${TEST_TICKET}&select=from_agent,to_agent,signal_type,confidence&order=created_at" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  | python3 -c "
import sys,json
data=json.load(sys.stdin)
for s in data:
    ta = s.get('to_agent') or '*'
    print(f'  {s[\"from_agent\"]:12} -> {ta:15} {s[\"signal_type\"]:30} conf={s.get(\"confidence\",0):.2f}')
" 2>/dev/null

echo ""
echo "COMPLIANCE:"
curl -s \
  "${SUPABASE_URL}/rest/v1/build_compliance_results?ticket_id=eq.${TEST_TICKET}&select=compliance_score,criteria_met,criteria_total,passed,judge_summary" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  | python3 -c "
import sys,json
data=json.load(sys.stdin)
if data:
    r=data[0]
    print(f'  Score: {r.get(\"compliance_score\",0)}% | Criteria: {r.get(\"criteria_met\",0)}/{r.get(\"criteria_total\",0)} | Passed: {r.get(\"passed\")}')
    print(f'  Summary: {(r.get(\"judge_summary\") or \"\")[:200]}')
else:
    print('  No compliance result')
" 2>/dev/null

echo ""
echo "PM2 STATUS:"
su - claudeagent -c 'pm2 status' 2>/dev/null

echo ""
echo "WORKER TAIL:"
su - claudeagent -c 'pm2 logs friday-worker --lines 30 --nostream' 2>/dev/null \
  | grep -E "BUILD-0|PASSED|FAILED|BLOCKED|error|Error" | tail -20

echo ""
echo "=== ASSESSMENT COMPLETE — Log: $LOGFILE ==="
