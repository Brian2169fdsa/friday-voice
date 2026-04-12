-- FRIDAY Build System Tables
-- Run via: psql $DATABASE_URL < 20260410-build-system.sql
-- OR via Supabase SQL editor
-- OR via: curl (see harden.sh for the curl command)

CREATE TABLE IF NOT EXISTS build_briefs (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id       text        UNIQUE NOT NULL,
  customer_id     text,
  client_name     text,
  brief_analysis  jsonb       DEFAULT '{}',
  brief_scoring   jsonb       DEFAULT '{}',
  success_criteria jsonb      DEFAULT '[]',
  blocking_issues jsonb       DEFAULT '[]',
  warnings        jsonb       DEFAULT '[]',
  overall_score   numeric     DEFAULT 0,
  build_ready     boolean     DEFAULT true,
  confidence      numeric     DEFAULT 1,
  analyzed_at     timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS build_agent_runs (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id      text        NOT NULL,
  agent_id       text        NOT NULL,
  agent_name     text,
  status         text        DEFAULT 'pending',
  output         jsonb       DEFAULT '{}',
  quality_report jsonb       DEFAULT '{}',
  errors         jsonb       DEFAULT '[]',
  duration_ms    integer,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz DEFAULT now(),
  UNIQUE(ticket_id, agent_id)
);

CREATE TABLE IF NOT EXISTS build_compliance_results (
  id                 uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id          text        UNIQUE NOT NULL,
  customer_id        text,
  compliance_score   numeric     DEFAULT 0,
  criteria_total     integer     DEFAULT 0,
  criteria_met       integer     DEFAULT 0,
  criteria_partial   integer     DEFAULT 0,
  criteria_failed    integer     DEFAULT 0,
  compliance_matrix  jsonb       DEFAULT '[]',
  revision_packages  jsonb       DEFAULT '[]',
  iteration          integer     DEFAULT 1,
  passed             boolean     DEFAULT false,
  judge_summary      text,
  evaluated_at       timestamptz DEFAULT now(),
  created_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS build_quality_signals (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id    text        NOT NULL,
  from_agent   text        NOT NULL,
  to_agent     text,
  signal_type  text        NOT NULL,
  confidence   numeric     DEFAULT 1,
  limitations  jsonb       DEFAULT '[]',
  assumptions  jsonb       DEFAULT '[]',
  flags        jsonb       DEFAULT '[]',
  payload      jsonb       DEFAULT '{}',
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cross_build_learnings (
  id                    uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id           text,
  pattern_type          text        NOT NULL,
  pattern_description   text,
  agent_affected        text,
  frequency             integer     DEFAULT 1,
  last_seen_ticket      text,
  improvement_applied   boolean     DEFAULT false,
  prompt_update         text,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_build_agent_runs_ticket    ON build_agent_runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_build_agent_runs_agent     ON build_agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_build_quality_signals_ticket ON build_quality_signals(ticket_id);
CREATE INDEX IF NOT EXISTS idx_build_quality_signals_from  ON build_quality_signals(from_agent);
CREATE INDEX IF NOT EXISTS idx_build_quality_signals_to    ON build_quality_signals(to_agent);
CREATE INDEX IF NOT EXISTS idx_cross_build_learnings_customer ON cross_build_learnings(customer_id);
