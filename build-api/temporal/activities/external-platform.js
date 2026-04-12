import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';

const CLAUDE = '/usr/bin/claude';
const EXT_TIMEOUT = 600000;
let AGENT_UID, AGENT_GID;
try {
  AGENT_UID = parseInt(execSync('id -u claudeagent').toString().trim());
  AGENT_GID = parseInt(execSync('id -g claudeagent').toString().trim());
} catch(e) { AGENT_UID = null; AGENT_GID = null; }

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

function detectPlatforms(contract, jobData) {
  const platforms = [];
  const text = JSON.stringify(contract) + ' ' + JSON.stringify(jobData);
  const lower = text.toLowerCase();
  if (lower.includes('retell')) platforms.push('retell');
  if (lower.includes('twilio')) platforms.push('twilio');
  if (lower.includes('hubspot')) platforms.push('hubspot');
  if (lower.includes('salesforce')) platforms.push('salesforce');
  if (lower.includes('stripe')) platforms.push('stripe');
  if (lower.includes('slack')) platforms.push('slack');
  if (lower.includes('teams')) platforms.push('teams');
  if (lower.includes('zendesk')) platforms.push('zendesk');
  if (lower.includes('pipedrive')) platforms.push('pipedrive');
  return platforms;
}

export async function externalPlatformActivity(jobData, contract) {
  const startTime = Date.now();
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const platforms = detectPlatforms(contract, jobData);

  if (platforms.length === 0) {
    console.log('[BUILD-007] No external platforms detected -- skipping');
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-007', agent_name: 'External Platform', status: 'skipped', output: { reason: 'No external platforms required for this build', platforms: [] }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-007] DB write failed (non-blocking):', dbErr.message); }
    return {
      agent_id: 'BUILD-007',
      specialist: 'BUILD-007 External Platform Specialist',
      status: 'skipped',
      reason: 'No external platforms required for this build',
      platforms: [],
      files_produced: []
    };
  }

  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentDir = path.join(outputDir, 'external');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  const client = jobData.client || jobData.client_name || 'Client';
  const project = jobData.project_name || 'AI Teammate';
  const build007 = contract?.BUILD_007 || {};

  const prompt = `You are BUILD-007, the External Platform Specialist for ManageAI FRIDAY.
Your job: Write all integration code to connect this AI teammate to its external platforms.

Client: ${client}
Project: ${project}
Platforms needed: ${platforms.join(', ')}
Build needs: ${JSON.stringify(build007)}
Workflow steps: ${contract?.mustNeverAsk?.workflow_steps || 'See contract'}
Data sources: ${contract?.mustNeverAsk?.data_sources || 'See contract'}

For each platform produce in ${agentDir}/:
1. {platform}-integration.js -- ESM module with initialize(), healthCheck(), handleError(), and the 3-5 core API calls this build needs. Use process.env for all credentials. Never hardcode keys.
2. platform-manifest.json -- { build_id, client, platforms_integrated, generated_at, environment_variables_needed, files_produced, integration_notes }

Env var names: RETELL_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, HUBSPOT_API_KEY, SALESFORCE_CLIENT_ID, SLACK_BOT_TOKEN, STRIPE_SECRET_KEY.

Write production-ready code. Use official Node.js SDKs where available.
After writing output: "BUILD-007 complete. Platforms: ${platforms.join(', ')}."
Do not ask questions.`;

  const promptFile = path.join(agentDir, 'prompt.txt');
  await fs.writeFile(promptFile, prompt);
  if (AGENT_UID) { try { await fs.chown(promptFile, AGENT_UID, AGENT_GID); } catch(e) {} }

  const start = Date.now();
  console.log('[BUILD-007] Starting for platforms:', platforms.join(', '));

  try {
    await runClaudeAgent(promptFile, agentDir, EXT_TIMEOUT);
    const dur = ((Date.now() - start) / 1000).toFixed(1);

    let manifest = null;
    try {
      const raw = await fs.readFile(path.join(agentDir, 'platform-manifest.json'), 'utf8');
      manifest = JSON.parse(raw);
    } catch(e) { console.warn('[BUILD-007] Could not read platform-manifest.json:', e.message); }

    const verified = [];
    for (const p of platforms) {
      try { await fs.access(path.join(agentDir, p + '-integration.js')); verified.push(p); } catch(e) {}
    }

    console.log('[BUILD-007] Done in ' + dur + 's | Platforms: ' + verified.length + '/' + platforms.length);

    const p7Status = verified.length > 0 ? 'success' : 'partial';
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-007', agent_name: 'External Platform', status: p7Status, output: { platforms, platforms_verified: verified, files_produced: verified.map(p => p + '-integration.js'), env_vars_needed: manifest?.environment_variables_needed }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-007] DB write failed (non-blocking):', dbErr.message); }

    return {
      agent_id: 'BUILD-007',
      specialist: 'BUILD-007 External Platform Specialist',
      status: p7Status,
      duration_seconds: parseFloat(dur),
      platforms,
      platforms_verified: verified,
      manifest,
      output_dir: agentDir,
      files_produced: verified.map(p => p + '-integration.js')
    };

  } catch(err) {
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    console.error('[BUILD-007] Error:', err.message.slice(0, 300));

    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-007', agent_name: 'External Platform', status: 'error', output: { error: err.message.slice(0, 200), platforms, platforms_verified: [] }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-007] DB write failed (non-blocking):', dbErr.message); }

    return {
      agent_id: 'BUILD-007',
      specialist: 'BUILD-007 External Platform Specialist',
      status: 'error',
      duration_seconds: parseFloat(dur),
      error: err.message.slice(0, 500),
      platforms,
      platforms_verified: [],
      files_produced: []
    };
  }
}
