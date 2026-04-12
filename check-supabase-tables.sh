#!/bin/bash
# Check and create missing Supabase tables for FRIDAY build system
# Run: bash /opt/manageai/check-supabase-tables.sh

SUPABASE_URL="https://fmemdogudiolevqsfuvd.supabase.co"
SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZtZW1kb2d1ZGlvbGV2cXNmdXZkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzcwNTQ2MiwiZXhwIjoyMDg5MjgxNDYyfQ.PXBm_m4Qcf2izPmh2d_loiFGfUKlqKqm4QhyY2x89BA"

echo "=== Checking Supabase tables ==="

for TABLE in build_briefs build_agent_runs build_quality_signals build_compliance_results cross_build_learnings; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "${SUPABASE_URL}/rest/v1/${TABLE}?select=count" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")

  if [ "$STATUS" = "200" ]; then
    echo "OK: ${TABLE} exists"
  else
    echo "MISSING (HTTP ${STATUS}): ${TABLE} - creating..."

    case $TABLE in
      build_briefs)
        SQL='CREATE TABLE IF NOT EXISTS build_briefs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id text UNIQUE NOT NULL, customer_id uuid, client_name text, brief_analysis jsonb DEFAULT '"'"'{}'"'"', brief_scoring jsonb DEFAULT '"'"'{}'"'"', success_criteria jsonb DEFAULT '"'"'[]'"'"', blocking_issues jsonb DEFAULT '"'"'[]'"'"', warnings jsonb DEFAULT '"'"'[]'"'"', overall_score numeric DEFAULT 0, build_ready boolean DEFAULT true, confidence numeric DEFAULT 0, analyzed_at timestamptz, created_at timestamptz DEFAULT now());'
        ;;
      build_agent_runs)
        SQL='CREATE TABLE IF NOT EXISTS build_agent_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id text NOT NULL, agent_id text NOT NULL, agent_name text, status text DEFAULT '"'"'running'"'"', output jsonb, duration_ms integer, started_at timestamptz DEFAULT now(), completed_at timestamptz, created_at timestamptz DEFAULT now(), UNIQUE(ticket_id, agent_id));'
        ;;
      build_quality_signals)
        SQL='CREATE TABLE IF NOT EXISTS build_quality_signals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id text NOT NULL, from_agent text NOT NULL, to_agent text, signal_type text NOT NULL, confidence numeric DEFAULT 0, flags jsonb DEFAULT '"'"'[]'"'"', payload jsonb DEFAULT '"'"'{}'"'"', created_at timestamptz DEFAULT now());'
        ;;
      build_compliance_results)
        SQL='CREATE TABLE IF NOT EXISTS build_compliance_results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id text UNIQUE NOT NULL, customer_id uuid, compliance_score numeric DEFAULT 0, criteria_total integer DEFAULT 0, criteria_met integer DEFAULT 0, criteria_partial integer DEFAULT 0, criteria_failed integer DEFAULT 0, compliance_matrix jsonb DEFAULT '"'"'[]'"'"', revision_packages jsonb DEFAULT '"'"'[]'"'"', passed boolean DEFAULT false, judge_summary text, evaluated_at timestamptz, created_at timestamptz DEFAULT now());'
        ;;
      cross_build_learnings)
        SQL='CREATE TABLE IF NOT EXISTS cross_build_learnings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, pattern_type text NOT NULL, pattern_description text, agent_affected text, frequency integer DEFAULT 1, improvement_applied boolean DEFAULT false, last_seen_ticket text, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());'
        ;;
    esac

    RESULT=$(curl -s -X POST "${SUPABASE_URL}/rest/v1/rpc/exec_sql" \
      -H "apikey: ${SUPABASE_SERVICE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"sql\": \"${SQL}\"}")
    echo "  Create result: ${RESULT}"
  fi
done

echo ""
echo "=== Done ==="
