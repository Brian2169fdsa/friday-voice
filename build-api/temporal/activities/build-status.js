// Activities for Supabase status updates — extracted from workflow code
// because Temporal sandboxes workflows and strips Node.js globals like process.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';

export async function updateBuildStatusActivity(ticketId, status, progressPct) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY || !ticketId) return;
    await fetch(`${SUPABASE_URL}/rest/v1/friday_builds?ticket_id=eq.${ticketId}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status, progress_pct: progressPct, updated_at: new Date().toISOString() })
    });
  } catch(e) { console.error('[FRIDAY] updateBuildStatus error:', e.message); }
}

export async function supabaseLogActivity(ticketId, table, data) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ ...data, ticket_id: ticketId, created_at: new Date().toISOString() })
    });
  } catch(e) { console.error('[FRIDAY] supabaseLog error:', e.message); }
}

export async function readBlackboardActivity(ticketId) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/build_quality_signals?ticket_id=eq.${ticketId}&signal_type=in.(engagement_context,build_mode_override)&order=created_at.desc&limit=5`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    return res.ok ? await res.json() : null;
  } catch(e) {
    console.warn('[FRIDAY] readBlackboard error:', e.message);
    return null;
  }
}
