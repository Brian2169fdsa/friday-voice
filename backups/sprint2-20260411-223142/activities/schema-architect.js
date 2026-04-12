import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const CLAUDE = '/usr/bin/claude';
const SCHEMA_TIMEOUT = 600000;

let AGENT_UID, AGENT_GID;
try {
  AGENT_UID = parseInt(execSync('id -u claudeagent').toString().trim());
  AGENT_GID = parseInt(execSync('id -g claudeagent').toString().trim());
} catch (e) { AGENT_UID = null; AGENT_GID = null; }

function runClaudeAgent(promptFile, agentDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c',
      CLAUDE + ' --dangerously-skip-permissions -p "$(cat ' + promptFile + ')"'
    ], {
      cwd: agentDir,
      uid: AGENT_UID, gid: AGENT_GID,
      env: { ...process.env, HOME: '/home/claudeagent', USER: 'claudeagent', CLAUDECODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Timeout ' + Math.round(timeoutMs/1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 500)));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

export async function schemaArchitectActivity(jobData, contract) {
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentDir = path.join(outputDir, 'schema');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  const ticketId = jobData.ticket_id || jobData.ticketId;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Read upstream quality signals and engagement context (REST query for initial load)
  let upstreamContext = '';
  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: signals } = await supabase
      .from('build_quality_signals')
      .select('from_agent, signal_type, confidence, payload, flags')
      .eq('ticket_id', ticketId)
      .in('signal_type', ['quality_review', 'engagement_context', 'targeted_fix_request'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (signals && signals.length > 0) {
      const lowConfidence = signals.filter(s => s.confidence < 0.75 && s.signal_type === 'quality_review');
      const fixRequests = signals.filter(s => s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-006');
      const engagementCtx = signals.find(s => s.signal_type === 'engagement_context');

      if (lowConfidence.length > 0) {
        upstreamContext += `\nIMPORTANT: Upstream agents have low confidence scores. Design defensively with extra validation and fallback handling.\n`;
      }
      if (fixRequests.length > 0) {
        upstreamContext += `\nFIX REQUESTS FROM QA:\n${fixRequests.map(f => f.payload?.fix_instructions || '').join('\n')}\n`;
      }
      if (engagementCtx) {
        upstreamContext += `\nCLIENT HISTORY CONTEXT:\n${JSON.stringify(engagementCtx.payload?.agent_instructions || {})}\n`;
      }
    }
  } catch(e) {
    console.log('[BUILD-006] Could not read upstream signals:', e.message);
  }

  // GAP A-009: Supabase Realtime blackboard — subscribe for 2s to catch any live signals
  // that arrived since the REST query above (e.g. from concurrent QA or other specialists)
  try {
    const realtimeClient = createClient(supabaseUrl, supabaseKey);
    const liveSignals = [];
    await new Promise((resolve) => {
      const channel = realtimeClient
        .channel(`schema-blackboard-${ticketId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'build_quality_signals',
          filter: `ticket_id=eq.${ticketId}`
        }, (payload) => {
          liveSignals.push(payload.new);
        })
        .subscribe();
      setTimeout(() => { channel.unsubscribe(); resolve(); }, 2000);
    });

    if (liveSignals.length > 0) {
      console.log('[BUILD-006] Realtime blackboard: received', liveSignals.length, 'live signal(s)');
      const liveFixRequests = liveSignals.filter(s =>
        s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-006'
      );
      if (liveFixRequests.length > 0) {
        upstreamContext += `\nLIVE FIX REQUESTS (Realtime):\n${liveFixRequests.map(f => f.payload?.fix_instructions || '').join('\n')}\n`;
      }
    }
  } catch(e) {
    console.log('[BUILD-006] Realtime blackboard unavailable (non-blocking):', e.message);
  }

  // Check for revision feedback from quality gate or compliance judge
  const revisionFeedback = jobData._revisionFeedback || jobData._complianceFeedback;
  if (revisionFeedback) {
    upstreamContext += `\nREVISION FEEDBACK (attempt ${jobData._revisionCount || 1}):\n`;
    if (revisionFeedback.fix_instructions) upstreamContext += revisionFeedback.fix_instructions + '\n';
    if (revisionFeedback.revisions) upstreamContext += revisionFeedback.revisions.join('\n') + '\n';
    if (revisionFeedback.gaps && revisionFeedback.gaps.length > 0) {
      upstreamContext += `\nCOMPLIANCE GAPS TO ADDRESS:\n${revisionFeedback.gaps.map(g => `- ${g.requirement}: ${g.revision_instruction || ''}`).join('\n')}\n`;
    }
  }

  const prompt = `You are BUILD-006, the Schema Architect for ManageAI FRIDAY.

Your job: Design and deploy the Supabase schema for this AI teammate build, then verify it.

## Build Context
Client: ${jobData.client || jobData.client_name}
Project: ${jobData.project_name}
Platform: ${jobData.platform || 'n8n'}
Description: ${jobData.request_description || ''}

## Full Build Contract
${contract ? JSON.stringify(contract, null, 2) : 'No contract - design schema from description above'}
${upstreamContext ? '\n## Upstream Signals & Revision Context\n' + upstreamContext : ''}

## Credentials
SUPABASE_URL: ${supabaseUrl}
SUPABASE_SERVICE_KEY: ${supabaseKey}

## Instructions

### Step 1: Design the schema
Based on the build contract, identify what tables this AI teammate needs:
- What data does it process or store?
- What does it track (jobs, results, logs, records)?
- What relationships exist between tables?

### Step 2: Deploy each table
Check if table exists first:
curl -s "${supabaseUrl}/rest/v1/{table_name}?limit=0" -H "apikey: ${supabaseKey}" -H "Authorization: Bearer ${supabaseKey}"

If 200 = exists. If error = create it using the exec_sql RPC function:
curl -s -X POST "${supabaseUrl}/rest/v1/rpc/exec_sql" \\
  -H "apikey: ${supabaseKey}" \\
  -H "Authorization: Bearer ${supabaseKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"sql": "CREATE TABLE IF NOT EXISTS table_name (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(), ...); CREATE INDEX IF NOT EXISTS idx_name ON table_name(column);"}'

IMPORTANT: The exec_sql RPC runs DDL as the postgres role via SECURITY DEFINER. It accepts a single "sql" parameter as a JSON string. You can batch multiple statements (CREATE TABLE + CREATE INDEX) in one call by separating them with semicolons. The function returns void -- a null/empty response means success. An error response means the SQL failed.

Do NOT use the Supabase management API (api.supabase.com). Do NOT try direct postgres connections. The exec_sql RPC is the only deployment method.

### Step 3: Verify each table
After creation, re-check with the REST endpoint:
curl -s "${supabaseUrl}/rest/v1/{table_name}?select=id&limit=0" -H "apikey: ${supabaseKey}" -H "Authorization: Bearer ${supabaseKey}"

If it returns 200 with [] or an empty array, the table is verified.

### Step 4: Write confirmed-schema.json to OUTPUT DIRECTORY
{
  "client": "${jobData.client || jobData.client_name}",
  "project": "${jobData.project_name}",
  "deployed_at": "<ISO timestamp>",
  "tables": [
    {
      "name": "table_name",
      "verified": true,
      "columns": [{"name": "id", "type": "uuid", "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()"}, ...],
      "indexes": ["idx_name ON table_name(column)"],
      "purpose": "What this table stores",
      "create_sql": "The full CREATE TABLE + CREATE INDEX SQL used"
    }
  ],
  "success": true,
  "notes": "Any schema decisions worth noting"
}

## Rules
- Every table MUST have: id (uuid PRIMARY KEY DEFAULT gen_random_uuid()), created_at (timestamptz DEFAULT now())
- Prefix tables with client slug to avoid conflicts (e.g. cornerstone_proposals not proposals)
- Use snake_case everywhere
- Use jsonb for flexible/nested data
- Add indexes on frequently queried columns (status, foreign keys, lookup fields)
- Add CHECK constraints for status/enum columns
- Do NOT touch tables belonging to other projects (charlie_*, friday_*, agent_messages, customer_dossiers, etc.)
- Work autonomously. Do not ask questions.
- Write confirmed-schema.json even if some tables fail -- document what succeeded and what failed.
- If exec_sql returns null/empty, that means SUCCESS. Only treat HTTP errors or JSON error responses as failures.

OUTPUT DIRECTORY: ${agentDir}`;

  const promptFile = '/tmp/friday-schema-' + jobData.job_id + '.txt';
  await fs.writeFile(promptFile, prompt);
  console.log('[BUILD-006] Starting for ' + (jobData.client || jobData.client_name) + ' / ' + jobData.project_name + (jobData._revisionCount ? ' (revision ' + jobData._revisionCount + ')' : ''));
  const t = Date.now();

  try {
    await runClaudeAgent(promptFile, agentDir, SCHEMA_TIMEOUT);
    const dur = Math.round((Date.now() - t) / 1000);
    await fs.rm(promptFile, { force: true });

    let confirmedSchema = null;
    try {
      const raw = await fs.readFile(path.join(agentDir, 'confirmed-schema.json'), 'utf8');
      confirmedSchema = JSON.parse(raw);
    } catch(e) { console.warn('[BUILD-006] Could not read confirmed-schema.json:', e.message); }

    const tableCount = confirmedSchema?.tables?.length || 0;
    const verified = confirmedSchema?.tables?.filter(t => t.verified)?.length || 0;
    console.log('[BUILD-006] Done in ' + dur + 's | Tables: ' + verified + '/' + tableCount + ' verified');

    return {
      agent_id: 'schema_architect',
      specialist: 'BUILD-006 Schema Architect',
      status: confirmedSchema?.success ? 'complete' : 'partial',
      duration: dur,
      output_subdir: 'schema',
      confirmed_schema: confirmedSchema,
      tables_deployed: verified,
      tables_total: tableCount
    };
  } catch(err) {
    const dur = Math.round((Date.now() - t) / 1000);
    console.error('[BUILD-006] Error:', err.message.slice(0, 300));
    await fs.rm(promptFile, { force: true });
    return {
      agent_id: 'schema_architect',
      specialist: 'BUILD-006 Schema Architect',
      status: 'error',
      error: err.message.slice(0, 200),
      duration: dur,
      output_subdir: 'schema',
      confirmed_schema: null,
      tables_deployed: 0,
      tables_total: 0
    };
  }
}
