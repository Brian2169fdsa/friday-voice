import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const sql = `
ALTER TABLE friday_deep_builds
  ADD COLUMN IF NOT EXISTS parent_ticket_id TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'primary';

CREATE INDEX IF NOT EXISTS idx_deep_builds_parent
  ON friday_deep_builds(parent_ticket_id)
  WHERE parent_ticket_id IS NOT NULL;
`;

const { error } = await supabase.rpc('exec_sql', { query: sql });
if (error) {
  console.error('Failed:', error);
  process.exit(1);
}
console.log('parent_ticket_id + role columns added to friday_deep_builds');
