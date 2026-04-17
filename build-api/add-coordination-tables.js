import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const sql = `
CREATE TABLE IF NOT EXISTS deep_build_sibling_state (
  id BIGSERIAL PRIMARY KEY,
  parent_ticket_id TEXT,
  child_ticket_id TEXT UNIQUE NOT NULL,
  agent_id TEXT NOT NULL,
  deep_build_type TEXT,
  phase TEXT DEFAULT 'starting',
  progress_percent INTEGER DEFAULT 0,
  exposed_artifacts JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sibling_state_parent
  ON deep_build_sibling_state(parent_ticket_id)
  WHERE parent_ticket_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS build_contracts (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT UNIQUE NOT NULL,
  agents_involved TEXT[],
  shared_supabase_schema JSONB,
  shared_auth TEXT,
  api_gateway_url TEXT,
  api_conventions JSONB,
  cross_agent_dependencies JSONB,
  integration_notes TEXT[],
  coordination_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

const { error } = await supabase.rpc('exec_sql', { query: sql });
if (error) {
  console.error('Failed:', error);
  process.exit(1);
}
console.log('deep_build_sibling_state + build_contracts tables created');
