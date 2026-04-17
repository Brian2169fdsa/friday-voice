import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const sql = `
CREATE TABLE IF NOT EXISTS friday_deep_builds (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT UNIQUE NOT NULL,
  deep_build_type TEXT NOT NULL CHECK (deep_build_type IN ('node-service', 'python', 'frontend')),
  project_name TEXT,
  client TEXT,
  agent_owner_email TEXT,
  brief JSONB NOT NULL,
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  file_count INTEGER,
  test_passed BOOLEAN,
  repo_url TEXT,
  error_message TEXT,
  cost_estimate NUMERIC(10,4)
);

CREATE INDEX IF NOT EXISTS idx_deep_builds_status ON friday_deep_builds(status);
CREATE INDEX IF NOT EXISTS idx_deep_builds_created ON friday_deep_builds(created_at DESC);
`;

const { error } = await supabase.rpc('exec_sql', { query: sql });
if (error) {
  console.error('Failed:', error);
  process.exit(1);
}
console.log('friday_deep_builds table created');
