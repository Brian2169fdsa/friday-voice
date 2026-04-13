import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { getGraphToken, uploadFile } from './onedrive.js';

const execFileAsync = promisify(execFile);
const CLAUDE = '/usr/bin/claude';
const TEMPORAL_TIMEOUT = 1200000; // 20 min

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
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Timeout ' + Math.round(timeoutMs/1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 500)));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

export async function temporalSpecialistActivity(jobData, contract) {
  const startTime = Date.now();
  const ticketId = jobData.ticket_id || jobData.ticketId;
  const clientSlug = (jobData.client || jobData.client_name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const projectSlug = (jobData.project_name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const namespace = `${clientSlug}-${projectSlug}`;
  const orchestrationDecision = jobData.orchestrationDecision || {};
  const taskQueue = orchestrationDecision.temporal_task_queue || `${clientSlug}-tasks`;
  const workerPm2Name = `temporal-worker-${clientSlug}`;

  const outputDir = `/tmp/friday-temporal-${jobData.job_id}`;
  const agentDir = path.join(outputDir, 'temporal');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  console.log(`[BUILD-014] Starting Temporal Specialist for ${clientSlug} | namespace: ${namespace}`);

  const temporalWorkflows = orchestrationDecision.temporal_workflows || [];
  const workflowNames = temporalWorkflows.map(w => w.name || 'unnamed-workflow');
  const primaryWorkflow = workflowNames[0] || `${clientSlug}-main`;

  const prompt = `You are BUILD-014, the Temporal Specialist for ManageAI FRIDAY.

Your job: Build a complete, isolated Temporal worker environment for this client. Generate all files in the output directory.

## Build Context
Client: ${jobData.client || jobData.client_name}
Client Slug: ${clientSlug}
Project: ${jobData.project_name}
Namespace: ${namespace}
Task Queue: ${taskQueue}
Temporal Server: localhost:7233

## Orchestration Decision
${JSON.stringify(orchestrationDecision, null, 2)}

## Build Contract
${JSON.stringify(contract || jobData.buildContract || {}, null, 2).slice(0, 3000)}

## What to Build

Generate these files in ${agentDir}/:

### 1. workflows/${primaryWorkflow}.js
A complete Temporal workflow function (ESM) for the primary workflow.
- Import proxyActivities from @temporalio/workflow
- Define all activity stubs with proper timeouts and retry policies
- Long-running activities must use heartbeat (30s interval)
- Export the workflow function by name matching the filename (camelCase)

### 2. activities/main-activities.js
Activities that back the workflows:
- Each activity calls the relevant Supabase API or n8n webhook
- All activities have: startToCloseTimeout, heartbeat support
- Export all activity functions
- Use process.env for SUPABASE_URL, N8N_URL, ANTHROPIC_API_KEY

### 3. worker.js
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities/main-activities.js';
const connection = await NativeConnection.connect({ address: 'localhost:7233' });
const worker = await Worker.create({
  connection,
  namespace: '${namespace}',
  taskQueue: '${taskQueue}',
  workflowsPath: new URL('./workflows/${primaryWorkflow}.js', import.meta.url).pathname,
  activities,
});
console.log('[${clientSlug}] Temporal worker started | namespace: ${namespace}');
await worker.run();

### 4. client.js
Export helper functions:
- startWorkflow(workflowType, args, workflowId) — starts a workflow, returns handle
- signalWorkflow(workflowId, signalName, payload) — sends a signal
- getWorkflowStatus(workflowId) — returns workflow status
Use: import { Client, Connection } from '@temporalio/client';
Namespace: ${namespace}, Server: localhost:7233

### 5. ecosystem.config.cjs
module.exports = { apps: [{ name: '${workerPm2Name}', script: 'worker.js', cwd: '${agentDir}', interpreter: 'node', env: { NODE_ENV: 'production' } }] };

## Rules
- All .js files must be valid ESM (import/export syntax)
- Use localhost:7233 as Temporal server address
- Namespace: ${namespace}, Task queue: ${taskQueue}
- Every activity: retry policy maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2
- Long-running activities: call context.heartbeat() every 30 seconds
- Do NOT hardcode credentials — use process.env
- Work autonomously. Write all files.
- After writing: "BUILD-014 complete. Files: [list]"

OUTPUT DIRECTORY: ${agentDir}`;

  const promptFile = `/tmp/friday-temporal14-${jobData.job_id}.txt`;
  await fs.writeFile(promptFile, prompt);

  let filesGenerated = 0;
  let claudeError = null;

  try {
    await runClaudeAgent(promptFile, agentDir, TEMPORAL_TIMEOUT);
    await fs.rm(promptFile, { force: true });

    try {
      const entries = await fs.readdir(agentDir);
      filesGenerated = entries.length;
    } catch(e) {}
    console.log(`[BUILD-014] Claude Code complete | Files generated: ${filesGenerated}`);
  } catch(e) {
    claudeError = e.message.slice(0, 300);
    console.error('[BUILD-014] Claude Code error (continuing):', claudeError);
    await fs.rm(promptFile, { force: true }).catch(() => {});
  }

  // Register namespace on local Temporal server
  try {
    const { Client, Connection } = await import('@temporalio/client');
    const conn = await Connection.connect({ address: 'localhost:7233' });
    const client = new Client({ connection: conn, namespace: 'default' });
    await client.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: { seconds: 604800 }
    });
    console.log(`[BUILD-014] Namespace registered: ${namespace}`);
    await conn.close();
  } catch(e) {
    console.warn('[BUILD-014] Namespace registration (may already exist):', e.message.slice(0, 150));
  }

  // Deploy PM2 worker
  let pm2Status = 'skipped';
  try {
    const ecosystemPath = path.join(agentDir, 'ecosystem.config.cjs');
    await fs.access(ecosystemPath);
    await execFileAsync('pm2', ['start', ecosystemPath], { timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    const { stdout } = await execFileAsync('pm2', ['list', '--no-color'], { timeout: 10000 });
    pm2Status = stdout.includes(workerPm2Name) ? 'running' : 'not-found';
    console.log(`[BUILD-014] PM2 status for ${workerPm2Name}: ${pm2Status}`);
  } catch(e) {
    pm2Status = 'error: ' + e.message.slice(0, 100);
    console.warn('[BUILD-014] PM2 deploy failed (non-blocking):', e.message.slice(0, 150));
  }

  // Smoke test — attempt to connect and start a test workflow
  let smokeTestPassed = false;
  try {
    const { Client, Connection } = await import('@temporalio/client');
    const conn = await Connection.connect({ address: 'localhost:7233' });
    const client = new Client({ connection: conn, namespace });
    const handle = await client.workflow.start(primaryWorkflow.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), {
      taskQueue,
      workflowId: `smoke-${ticketId}-${Date.now()}`,
      args: [{ test: true }]
    });
    await new Promise(r => setTimeout(r, 10000));
    try { await handle.terminate('smoke test complete'); } catch(_) {}
    smokeTestPassed = true;
    console.log(`[BUILD-014] Smoke test passed`);
    await conn.close();
  } catch(e) {
    console.warn('[BUILD-014] Smoke test failed (non-blocking):', e.message.slice(0, 150));
  }

  // Upload worker.js to OneDrive
  let onedriveUrl = null;
  try {
    const token = await getGraphToken();
    const workerContent = await fs.readFile(path.join(agentDir, 'worker.js'), 'utf8');
    onedriveUrl = await uploadFile(token, `ManageAI/Builds/${ticketId}/phase1/temporal`, 'worker.js', workerContent, 'application/javascript');
    console.log('[BUILD-014] OneDrive upload:', onedriveUrl);
  } catch(upErr) { console.warn('[BUILD-014] OneDrive upload failed (non-blocking):', upErr.message); }

  const durationMs = Date.now() - startTime;
  const output = {
    namespace,
    temporal_server: 'localhost:7233',
    task_queue: taskQueue,
    workflows_deployed: workflowNames,
    worker_pm2_name: workerPm2Name,
    pm2_status: pm2Status,
    smoke_test_passed: smokeTestPassed,
    files_generated: filesGenerated,
    onedrive_url: onedriveUrl,
    ...(claudeError ? { claude_error: claudeError } : {})
  };

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        ticket_id: ticketId,
        agent_id: 'BUILD-014',
        agent_name: 'Temporal Specialist',
        status: claudeError ? 'partial' : 'complete',
        output,
        duration_ms: durationMs,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString()
      })
    });
  } catch(dbErr) { console.warn('[BUILD-014] DB write failed (non-blocking):', dbErr.message); }

  return {
    agent_id: 'BUILD-014',
    status: claudeError ? 'partial' : 'complete',
    namespace,
    task_queue: taskQueue,
    worker_pm2_name: workerPm2Name,
    smoke_test_passed: smokeTestPassed,
    files_generated: filesGenerated,
    onedrive_url: onedriveUrl
  };
}
