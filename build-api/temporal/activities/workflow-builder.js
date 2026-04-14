import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { getGraphToken, uploadFile } from './onedrive.js';
import { Context } from '@temporalio/activity';

const CLAUDE = '/usr/bin/claude';
const WORKFLOW_TIMEOUT = 1100000;

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
    const heartbeatInterval = setInterval(() => {
      try { Context.current().heartbeat('claude-code-running'); } catch(e) {}
    }, 30000);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Timeout ' + Math.round(timeoutMs/1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearInterval(heartbeatInterval);
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 500)));
    });
    proc.on('error', err => { clearInterval(heartbeatInterval); clearTimeout(timer); reject(err); });
  });
}

export async function workflowBuilderActivity(jobData, contract) {
  const startTime = Date.now();
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentDir = path.join(outputDir, 'workflows');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  const ticketId = jobData.ticket_id || jobData.ticketId;
  const n8nUrl = process.env.N8N_LOCAL_URL || 'http://localhost:5678';
  const n8nKey = process.env.N8N_API_KEY || process.env.N8N_LOCAL_API_KEY;

  // Read upstream quality signals and engagement context (REST query for initial load)
  let upstreamContext = '';
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: signals } = await supabase
      .from('build_quality_signals')
      .select('from_agent, signal_type, confidence, payload, flags')
      .eq('ticket_id', ticketId)
      .in('signal_type', ['quality_review', 'engagement_context', 'targeted_fix_request'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (signals && signals.length > 0) {
      const lowConfidence = signals.filter(s => s.confidence < 0.75 && s.signal_type === 'quality_review');
      const fixRequests = signals.filter(s => s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-002');
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
    console.log('[BUILD-002] Could not read upstream signals:', e.message);
  }

  // GAP A-009: Supabase Realtime blackboard — subscribe for 2s to catch any live signals
  try {
    const realtimeClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const liveSignals = [];
    await new Promise((resolve) => {
      const channel = realtimeClient
        .channel(`workflow-blackboard-${ticketId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'build_quality_signals',
          filter: `ticket_id=eq.${ticketId}`
        }, (payload) => {
          liveSignals.push(payload.new);
        })
        .subscribe();
      setTimeout(() => { channel.unsubscribe(); resolve(); }, 10000);
    });

    if (liveSignals.length > 0) {
      console.log('[BUILD-002] Realtime blackboard: received', liveSignals.length, 'live signal(s)');
      const liveFixRequests = liveSignals.filter(s =>
        s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-002'
      );
      if (liveFixRequests.length > 0) {
        upstreamContext += `\nLIVE FIX REQUESTS (Realtime):\n${liveFixRequests.map(f => f.payload?.fix_instructions || '').join('\n')}\n`;
      }
    }
  } catch(e) {
    console.log('[BUILD-002] Realtime blackboard unavailable (non-blocking):', e.message);
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

  const prompt = `You are BUILD-002, the Workflow Builder for ManageAI FRIDAY.

Your job: Design n8n workflows for this AI teammate, import them to n8n, activate them, smoke test the webhooks, and return a manifest.

## Build Context
Client: ${jobData.client || jobData.client_name}
Project: ${jobData.project_name}
Platform: ${jobData.platform || 'n8n'}
Description: ${jobData.request_description || ''}

## Full Build Contract
${contract ? JSON.stringify(contract, null, 2) : 'No contract - design workflows from description above'}

## Schema Context
${contract?.confirmed_schema ? 'Tables available: ' + JSON.stringify(contract.confirmed_schema.tables?.map(t => t.name)) : 'No schema deployed yet - design workflows that work with any schema'}
${upstreamContext ? '\n## Upstream Signals & Revision Context\n' + upstreamContext : ''}

## n8n Credentials
N8N_URL: ${n8nUrl}
N8N_API_KEY: ${n8nKey}

## Instructions

### Step 1: Design the workflows
Based on the build contract, identify what workflows this AI teammate needs:
- What triggers does it respond to? (webhooks, schedules, events)
- What processing steps does each workflow perform?
- What external services does it call?
- What data does it read/write from Supabase?

### Step 2: Build each workflow as n8n JSON
Create valid n8n workflow JSON for each workflow. Each workflow must have:
- A unique name prefixed with the client slug (e.g. "Cornerstone - Proposal Intake")
- A Webhook trigger node OR a Schedule trigger node
- Proper node connections
- Correct node types and parameters

### Step 3: Import each workflow to n8n
curl -s -X POST "${n8nUrl}/api/v1/workflows" \\
  -H "X-N8N-API-KEY: ${n8nKey}" \\
  -H "Content-Type: application/json" \\
  -d @workflow.json

### Step 4: Activate each workflow
curl -s -X PATCH "${n8nUrl}/api/v1/workflows/{id}" \\
  -H "X-N8N-API-KEY: ${n8nKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"active": true}'

### Step 5: Smoke test webhook workflows
For each webhook workflow, send a test POST:
curl -s -X POST "${n8nUrl}/webhook-test/{path}" \\
  -H "Content-Type: application/json" \\
  -d '{"test": true, "source": "BUILD-002 smoke test"}'

A 200 response = webhook is live. Any other response = note the error.

### Step 6: Write workflow-manifest.json to OUTPUT DIRECTORY
{
  "client": "${jobData.client || jobData.client_name}",
  "project": "${jobData.project_name}",
  "deployed_at": "<ISO timestamp>",
  "workflows": [
    {
      "name": "Workflow Name",
      "n8n_id": "abc123",
      "active": true,
      "trigger_type": "webhook|schedule|manual",
      "webhook_url": "http://5.223.79.255:5678/webhook/path (if webhook)",
      "webhook_test_result": "pass|fail|n/a",
      "nodes": ["Webhook", "HTTP Request", "Set", "Supabase"],
      "purpose": "What this workflow does"
    }
  ],
  "success": true,
  "notes": "Any decisions worth noting"
}

## Rules
- All workflows run on FRIDAY's local n8n at ${n8nUrl} -- NEVER use cloud n8n
- Webhook URLs for production use the server IP: http://5.223.79.255:5678/webhook/{path}
- Prefix all workflow names with client slug
- Use Webhook nodes (not Webhook Test) for production triggers
- Include error handling nodes where appropriate
- For Supabase operations, use HTTP Request nodes with the REST API (not a Supabase-specific node)
- Work autonomously. Do not ask questions.
- Write workflow-manifest.json even if some workflows fail -- document what succeeded and what failed.
- If you cannot determine the workflows needed from the contract, create a minimal intake webhook workflow.

OUTPUT DIRECTORY: ${agentDir}`;

  const promptFile = '/tmp/friday-workflow-' + jobData.job_id + '.txt';
  await fs.writeFile(promptFile, prompt);
  console.log('[BUILD-002] Starting for ' + (jobData.client || jobData.client_name) + ' / ' + jobData.project_name + (jobData._revisionCount ? ' (revision ' + jobData._revisionCount + ')' : ''));
  const t = Date.now();

  try {
    await runClaudeAgent(promptFile, agentDir, WORKFLOW_TIMEOUT);
    const dur = Math.round((Date.now() - t) / 1000);
    await fs.rm(promptFile, { force: true });

    let manifest = null;
    try {
      const raw = await fs.readFile(path.join(agentDir, 'workflow-manifest.json'), 'utf8');
      manifest = JSON.parse(raw);
    } catch(e) { console.warn('[BUILD-002] Could not read workflow-manifest.json:', e.message); }

    const wfCount = manifest?.workflows?.length || 0;
    const active = manifest?.workflows?.filter(w => w.active)?.length || 0;
    console.log('[BUILD-002] Done in ' + dur + 's | Workflows: ' + active + '/' + wfCount + ' active');

    // Flag zero-workflow builds as a QA concern
    let zeroWorkflowWarning = null;
    if (wfCount === 0) {
      zeroWorkflowWarning = 'BUILD-002 imported 0 workflows. No workflow files were generated or the agent failed to produce valid n8n JSON. This will likely cause QA failures in the workflow and integration test categories.';
      console.warn('[BUILD-002] WARNING: Zero workflows imported — flagging as QA concern');
    }

    const wfStatus = wfCount === 0 ? 'warning' : (manifest?.success ? 'complete' : 'partial');
    let onedriveUrl = null;
    try {
      const token = await getGraphToken();
      const fileContent = await fs.readFile(path.join(agentDir, 'workflow-manifest.json'), 'utf8');
      onedriveUrl = await uploadFile(token, `FRIDAY Builds/${(ticketId + ' - ' + (jobData.client || jobData.client_name || '')).replace(/[<>:"\\/|?*]/g, '-').trim()}/Phase 1`, 'workflow-manifest.json', fileContent, 'application/json');
      console.log('[BUILD-002] OneDrive upload:', onedriveUrl);
    } catch(upErr) { console.warn('[BUILD-002] OneDrive upload failed (non-blocking):', upErr.message); }
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-002', agent_name: 'Workflow Builder', status: wfStatus, output: { workflows_deployed: active, workflows_total: wfCount, workflow_names: manifest?.workflows?.map(w => w.name) || [], success: manifest?.success || false, zero_workflow_warning: zeroWorkflowWarning, onedrive_url: onedriveUrl }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-002] DB write failed (non-blocking):', dbErr.message); }

    return {
      agent_id: 'workflow_builder',
      specialist: 'BUILD-002 Workflow Builder',
      status: wfStatus,
      duration: dur,
      output_subdir: 'workflows',
      workflow_manifest: manifest,
      workflows_deployed: active,
      workflows_total: wfCount,
      zero_workflow_warning: zeroWorkflowWarning
    };
  } catch(err) {
    const dur = Math.round((Date.now() - t) / 1000);
    console.error('[BUILD-002] Error:', err.message.slice(0, 300));
    console.warn('[BUILD-002] WARNING: Agent failed — zero workflows will be imported');
    await fs.rm(promptFile, { force: true });

    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-002', agent_name: 'Workflow Builder', status: 'error', output: { error: err.message.slice(0, 200), workflows_deployed: 0, workflows_total: 0 }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-002] DB write failed (non-blocking):', dbErr.message); }

    return {
      agent_id: 'workflow_builder',
      specialist: 'BUILD-002 Workflow Builder',
      status: 'error',
      error: err.message.slice(0, 200),
      duration: dur,
      output_subdir: 'workflows',
      workflow_manifest: null,
      workflows_deployed: 0,
      workflows_total: 0,
      zero_workflow_warning: 'BUILD-002 agent failed: ' + err.message.slice(0, 150) + '. Zero workflows imported.'
    };
  }
}
