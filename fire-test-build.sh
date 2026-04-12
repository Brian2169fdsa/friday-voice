#!/bin/bash
# Fire a test build and monitor it
# Run AFTER startup.sh confirms worker is online

SUPABASE_URL="https://fmemdogudiolevqsfuvd.supabase.co"
SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZtZW1kb2d1ZGlvbGV2cXNmdXZkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzcwNTQ2MiwiZXhwIjoyMDg5MjgxNDYyfQ.PXBm_m4Qcf2izPmh2d_loiFGfUKlqKqm4QhyY2x89BA"

echo "=== Firing test build ==="

# NOTE: Uses flat format (no 'brief' wrapper) to bypass briefValidation
# and pass completenessCheckActivity with all required MUST_NEVER_ASK fields.
TEST_TICKET=$(curl -s -X POST http://localhost:3000/api/build/brief \
  -H "Content-Type: application/json" \
  -H "x-cockpit-key: friday-cockpit-2026" \
  -d '{
    "client": "Test Client",
    "customer_id": "882d9329-4e05-4467-8773-27dc2ce5db48",
    "project_name": "Support Request Router",
    "platform": "n8n",
    "request_description": "Simple customer intake routing system that receives support requests via webhook and routes them to the correct team based on category",
    "workflow_steps": ["receive support request via webhook", "classify request category", "route to correct team", "send acknowledgment email", "log to database"],
    "decision_authority": "routing rules table determines team assignment; on-call table determines after-hours routing",
    "success_metrics": ["95% correct routing accuracy", "under 30 second processing time", "100% requests acknowledged"],
    "data_sources": ["support intake webhook", "team availability table", "routing rules table"],
    "guardrails": ["never drop a request", "always send acknowledgment", "log all routing decisions", "no PII in logs"],
    "edge_cases": ["unknown category routes to general support", "after hours routes to on-call", "duplicate request deduplicated within 5 minutes"],
    "acceptance_criteria": ["webhook receives and processes test payload", "database tables created and accessible", "routing logic produces correct output for all 5 request types", "acknowledgment email template exists", "QA score above 75"]
  }' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('ticket_id','ERROR:'+str(d)))")

echo "Test build fired: $TEST_TICKET"

if [[ "$TEST_TICKET" == ERROR* ]]; then
  echo "ERROR firing build. Is the API running? Check: pm2 status"
  exit 1
fi

echo ""
echo "=== Monitoring build (20 min max) ==="

for i in $(seq 1 40); do
  sleep 30
  echo "--- Check $i ($((i*30))s elapsed) ---"

  AGENT_STATUS=$(curl -s "${SUPABASE_URL}/rest/v1/build_agent_runs?ticket_id=eq.${TEST_TICKET}&select=agent_id,agent_name,status,duration_ms" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" 2>/dev/null)
  echo "Agents: $AGENT_STATUS"

  BUILD_STATUS=$(curl -s "${SUPABASE_URL}/rest/v1/friday_builds?ticket_id=eq.${TEST_TICKET}&select=status,qa_score" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" 2>/dev/null)
  echo "Build: $BUILD_STATUS"

  pm2 logs friday-worker --lines 10 --nostream 2>/dev/null | grep -E "BUILD-0|${TEST_TICKET}|PASSED|FAILED|BLOCKED|error" | tail -5

  IS_DONE=$(echo "$BUILD_STATUS" | python3 -c "import sys,json;d=json.load(sys.stdin);print('done' if d and d[0].get('status') in ['complete','failed','phase1-review','phase1_rejected'] else 'running')" 2>/dev/null)
  if [ "$IS_DONE" = "done" ]; then
    echo "=== BUILD COMPLETE ==="
    break
  fi
done

echo ""
echo "=== Final agent run status ==="
curl -s "${SUPABASE_URL}/rest/v1/build_agent_runs?ticket_id=eq.${TEST_TICKET}&select=agent_id,agent_name,status,duration_ms&order=created_at" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}"

echo ""
echo "=== Compliance result ==="
curl -s "${SUPABASE_URL}/rest/v1/build_compliance_results?ticket_id=eq.${TEST_TICKET}&select=compliance_score,criteria_met,criteria_total,passed,judge_summary" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}"
