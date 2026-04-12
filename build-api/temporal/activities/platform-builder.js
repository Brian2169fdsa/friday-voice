import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { getGraphToken, uploadFile } from './onedrive.js';
import { Context } from '@temporalio/activity';

const CLAUDE = '/usr/bin/claude';
const DEPLOY_TIMEOUT = 900000;

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
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Timeout ' + Math.round(timeoutMs/1000) + 's')); }, timeoutMs);
    proc.on('close', code => {
      clearInterval(heartbeatInterval);
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Exit ' + code + ': ' + stderr.slice(0, 500)));
    });
    proc.on('error', err => { clearInterval(heartbeatInterval); clearTimeout(timer); reject(err); });
  });
}

export async function platformBuilderActivity(jobData, contract, buildOutputs) {
  const startTime = Date.now();
  const outputDir = '/tmp/friday-temporal-' + jobData.job_id;
  const agentDir = path.join(outputDir, 'platform');
  await fs.mkdir(agentDir, { recursive: true });
  if (AGENT_UID) { try { await fs.chown(agentDir, AGENT_UID, AGENT_GID); } catch(e) {} }

  const ticketId = jobData.ticket_id || jobData.ticketId;
  const githubToken = process.env.GITHUB_TOKEN;
  const githubOrg = process.env.GITHUB_ORG || '';

  const clientSlug = (jobData.client || jobData.client_name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const projectSlug = (jobData.project_name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const repoName = clientSlug + '-' + projectSlug;

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
      const fixRequests = signals.filter(s => s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-005');
      const engagementCtx = signals.find(s => s.signal_type === 'engagement_context');

      if (lowConfidence.length > 0) {
        upstreamContext += `\nIMPORTANT: Upstream agents have low confidence scores. Deploy defensively and verify all operations.\n`;
      }
      if (fixRequests.length > 0) {
        upstreamContext += `\nFIX REQUESTS FROM QA:\n${fixRequests.map(f => f.payload?.fix_instructions || '').join('\n')}\n`;
      }
      if (engagementCtx) {
        upstreamContext += `\nCLIENT HISTORY CONTEXT:\n${JSON.stringify(engagementCtx.payload?.agent_instructions || {})}\n`;
      }
    }
  } catch(e) {
    console.log('[BUILD-005] Could not read upstream signals:', e.message);
  }

  // GAP A-009: Supabase Realtime blackboard — subscribe for 2s to catch any live signals
  try {
    const realtimeClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const liveSignals = [];
    await new Promise((resolve) => {
      const channel = realtimeClient
        .channel(`platform-blackboard-${ticketId}`)
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
      console.log('[BUILD-005] Realtime blackboard: received', liveSignals.length, 'live signal(s)');
      const liveFixRequests = liveSignals.filter(s =>
        s.signal_type === 'targeted_fix_request' && s.to_agent === 'BUILD-005'
      );
      if (liveFixRequests.length > 0) {
        upstreamContext += `\nLIVE FIX REQUESTS (Realtime):\n${liveFixRequests.map(f => f.payload?.fix_instructions || '').join('\n')}\n`;
      }
    }
  } catch(e) {
    console.log('[BUILD-005] Realtime blackboard unavailable (non-blocking):', e.message);
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

  const prompt = `You are BUILD-005, the Platform Builder for ManageAI FRIDAY.

Your job: Create a GitHub repo for this build, push all code files, and prepare the deployment configuration.

## Build Context
Client: ${jobData.client || jobData.client_name}
Project: ${jobData.project_name}
Repo Name: ${repoName}
Platform: ${jobData.platform || 'n8n'}
Description: ${jobData.request_description || ''}

## Build Contract
${contract ? JSON.stringify(contract, null, 2) : 'No contract provided'}

## Credentials
GITHUB_TOKEN: ${githubToken}
${githubOrg ? 'GITHUB_ORG: ' + githubOrg : 'No org -- create under authenticated user account'}
${upstreamContext ? '\n## Upstream Signals & Revision Context\n' + upstreamContext : ''}

## Source Files
The build output directory is: ${outputDir}
Look for code files in these subdirectories:
- ${outputDir}/ (root level files)
- ${outputDir}/workflow/ (n8n workflow JSONs)
- ${outputDir}/schema/ (confirmed-schema.json)

List all files in the output directory first to understand what was built.

## Instructions

### Step 1: Identify the GitHub user
curl -s -H "Authorization: token ${githubToken}" "https://api.github.com/user" | grep -o '"login":"[^"]*"'

Use the login value as OWNER for all subsequent API calls.

### Step 2: Create the GitHub repository
Check if repo exists:
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token ${githubToken}" "https://api.github.com/repos/OWNER/${repoName}"

If 404, create it:
curl -s -X POST -H "Authorization: token ${githubToken}" -H "Content-Type: application/json" \\
  "https://api.github.com/${githubOrg ? 'orgs/' + githubOrg + '/repos' : 'user/repos'}" \\
  -d '{"name": "${repoName}", "description": "AI Teammate: ${jobData.project_name} for ${jobData.client || jobData.client_name}", "private": true, "auto_init": true}'

### Step 3: Push code files using the Contents API
For each file, base64 encode and push:
CONTENT=$(base64 -w0 filepath)
curl -s -X PUT -H "Authorization: token ${githubToken}" -H "Content-Type: application/json" \\
  "https://api.github.com/repos/OWNER/${repoName}/contents/{filepath}" \\
  -d '{"message": "Deploy: {filepath}", "content": "'$CONTENT'"}'

Files to push: any .js, .json, .md, .html files from the output directory.
Skip files > 1MB. Skip node_modules.

### Step 4: Create ecosystem.config.cjs
Generate and push a PM2 config:

module.exports = {
  apps: [{
    name: '${repoName}',
    script: 'server.js',
    cwd: '/opt/${repoName}',
    env: {
      PORT: 3100,
      NODE_ENV: 'production'
    }
  }]
};

### Step 5: Create README.md
Generate and push a README with project name, client, description, and setup instructions.

### Step 6: Write deployment-manifest.json to OUTPUT DIRECTORY
{
  "client": "${jobData.client || jobData.client_name}",
  "project": "${jobData.project_name}",
  "repo_name": "${repoName}",
  "repo_url": "https://github.com/OWNER/${repoName}",
  "repo_private": true,
  "deployed_at": "<ISO timestamp>",
  "files_pushed": ["list of files pushed"],
  "pm2_config": {
    "name": "${repoName}",
    "port": 3100
  },
  "success": true,
  "notes": "Any deployment decisions"
}

## Rules
- Repository MUST be private
- Use the GitHub Contents API for all file operations (not git clone)
- Base64 encode all file contents before pushing
- Skip binary files and files > 1MB
- Do NOT deploy or start PM2 processes -- just create the repo and push code
- Work autonomously. Do not ask questions.
- Write deployment-manifest.json even if some operations fail.

OUTPUT DIRECTORY: ${agentDir}`;

  const promptFile = '/tmp/friday-platform-' + jobData.job_id + '.txt';
  await fs.writeFile(promptFile, prompt);
  console.log('[BUILD-005] Starting for ' + (jobData.client || jobData.client_name) + ' / ' + jobData.project_name + (jobData._revisionCount ? ' (revision ' + jobData._revisionCount + ')' : ''));
  const t = Date.now();

  try {
    await runClaudeAgent(promptFile, agentDir, DEPLOY_TIMEOUT);
    const dur = Math.round((Date.now() - t) / 1000);
    await fs.rm(promptFile, { force: true });

    let manifest = null;
    try {
      const raw = await fs.readFile(path.join(agentDir, 'deployment-manifest.json'), 'utf8');
      manifest = JSON.parse(raw);
    } catch(e) { console.warn('[BUILD-005] Could not read deployment-manifest.json:', e.message); }

    const filesPushed = manifest?.files_pushed?.length || 0;
    console.log('[BUILD-005] Done in ' + dur + 's | Files pushed: ' + filesPushed + ' | Repo: ' + (manifest?.repo_url || 'unknown'));

    const p5Status = manifest?.success ? 'complete' : 'partial';
    let onedriveUrl = null;
    try {
      const token = await getGraphToken();
      const fileContent = await fs.readFile(path.join(agentDir, 'deployment-manifest.json'), 'utf8');
      onedriveUrl = await uploadFile(token, `ManageAI/Builds/${ticketId}/phase1/platform`, 'deployment-manifest.json', fileContent, 'application/json');
      console.log('[BUILD-005] OneDrive upload:', onedriveUrl);
    } catch(upErr) { console.warn('[BUILD-005] OneDrive upload failed (non-blocking):', upErr.message); }
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-005', agent_name: 'Platform Builder', status: p5Status, output: { repo_url: manifest?.repo_url, repo_name: manifest?.repo_name, files_pushed: filesPushed, success: manifest?.success || false, notes: manifest?.notes?.slice(0, 200), onedrive_url: onedriveUrl }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-005] DB write failed (non-blocking):', dbErr.message); }

    return {
      agent_id: 'platform_builder',
      specialist: 'BUILD-005 Platform Builder',
      status: p5Status,
      duration: dur,
      output_subdir: 'platform',
      deployment_manifest: manifest,
      repo_url: manifest?.repo_url || null,
      files_pushed: filesPushed
    };
  } catch(err) {
    const dur = Math.round((Date.now() - t) / 1000);
    console.error('[BUILD-005] Error:', err.message.slice(0, 300));
    await fs.rm(promptFile, { force: true });

    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/build_agent_runs`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ ticket_id: ticketId, agent_id: 'BUILD-005', agent_name: 'Platform Builder', status: 'error', output: { error: err.message.slice(0, 200), files_pushed: 0, repo_url: null }, duration_ms: Date.now() - startTime, started_at: new Date(startTime).toISOString(), completed_at: new Date().toISOString() })
      });
    } catch(dbErr) { console.warn('[BUILD-005] DB write failed (non-blocking):', dbErr.message); }

    return {
      agent_id: 'platform_builder',
      specialist: 'BUILD-005 Platform Builder',
      status: 'error',
      error: err.message.slice(0, 200),
      duration: dur,
      output_subdir: 'platform',
      deployment_manifest: null,
      repo_url: null,
      files_pushed: 0
    };
  }
}
